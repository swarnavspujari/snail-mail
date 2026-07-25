//! OS-keychain storage (Windows Credential Manager via the `keyring` crate).
//! Every secret Snail Mail holds lives here: AI keys and Gmail OAuth material.
//! Values never appear in logs, errors, or the SQLite file.

const SERVICE: &str = "SnailMail";
/// Pre-rename service names, newest first. Secrets are read from these as a
/// fallback and copied forward on first access, so installs from any earlier
/// brand keep their tokens + AI keys.
const LEGACY_SERVICES: [&str; 2] = ["FissionMail", "ZenBoxMail"];

pub const AI_CLAUDE: &str = "ai:claude";
pub const AI_OPENAI: &str = "ai:openai";
pub const AI_NIM: &str = "ai:nim";
pub const GMAIL_CLIENT_ID: &str = "gmail:client_id";
pub const GMAIL_CLIENT_SECRET: &str = "gmail:client_secret";
/// BYO Unsplash Access Key — overrides the baked one when present.
pub const UNSPLASH_ACCESS_KEY: &str = "unsplash:access_key";
/// v0.1 single-account name; kept as a read fallback.
pub const GMAIL_REFRESH_TOKEN_LEGACY: &str = "gmail:refresh_token";

/// Every entry name that is NOT derived from an account address. `purge` walks
/// this list, so a new secret is only ever one edit away from being erasable —
/// and forgetting to add one here is the difference between "uninstalled" and
/// "your API key is still in Credential Manager".
pub const ALL_FIXED_ENTRIES: [&str; 7] = [
    AI_CLAUDE,
    AI_OPENAI,
    AI_NIM,
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    UNSPLASH_ACCESS_KEY,
    GMAIL_REFRESH_TOKEN_LEGACY,
];

/// The primary service plus every legacy one, i.e. every place on this machine
/// a Snail Mail secret can be hiding.
pub fn all_services() -> Vec<&'static str> {
    std::iter::once(SERVICE).chain(LEGACY_SERVICES).collect()
}

pub fn gmail_refresh_entry(email: &str) -> String {
    format!("gmail:refresh_token:{email}")
}

pub fn ai_key_entry(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some(AI_CLAUDE),
        "openai" => Some(AI_OPENAI),
        "nim" => Some(AI_NIM),
        _ => None,
    }
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|_| "keychain unavailable".to_string())
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?
        .set_password(value)
        .map_err(|_| "could not write to the OS keychain".to_string())
}

pub fn get(name: &str) -> Option<String> {
    chain_get(SERVICE, &LEGACY_SERVICES, name)
}

pub fn delete(name: &str) {
    chain_delete(SERVICE, &LEGACY_SERVICES, name);
}

/// Delete `name` everywhere and report which services actually held it.
/// Unlike `delete`, this probes first, so an erase/uninstall can tell the user
/// what was really in Credential Manager instead of what it tried. `dry_run`
/// probes only — the answer is identical, nothing is removed.
pub fn purge_entry(name: &str, dry_run: bool) -> Vec<&'static str> {
    let mut hit = vec![];
    for svc in all_services() {
        let Ok(e) = keyring::Entry::new(svc, name) else { continue };
        if e.get_password().is_err() {
            continue;
        }
        hit.push(svc);
        if !dry_run {
            let _ = e.delete_credential();
        }
    }
    hit
}

/// Delete `name` from the primary AND every legacy service. Deleting only the
/// primary is not enough: chain_get's copy-forward would resurrect a
/// surviving legacy copy on the next read — observed post-rebrand, where
/// disconnect deleted the SnailMail token entry and the (revoked) FissionMail
/// copy kept coming back as a permanently-failing session.
fn chain_delete(primary: &str, legacy: &[&str], name: &str) {
    for svc in std::iter::once(primary).chain(legacy.iter().copied()) {
        if let Ok(e) = keyring::Entry::new(svc, name) {
            let _ = e.delete_credential();
        }
    }
}

/// Read `name` from `primary`, else from each legacy service in order; a
/// legacy hit is copied forward to `primary` so the next read is direct.
fn chain_get(primary: &str, legacy: &[&str], name: &str) -> Option<String> {
    if let Ok(e) = keyring::Entry::new(primary, name) {
        if let Ok(v) = e.get_password() {
            return Some(v);
        }
    }
    for svc in legacy {
        if let Ok(old) = keyring::Entry::new(svc, name) {
            if let Ok(v) = old.get_password() {
                if let Ok(e) = keyring::Entry::new(primary, name) {
                    let _ = e.set_password(&v);
                }
                return Some(v);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{chain_delete, chain_get};

    /// Real OS-keychain entries under throwaway service names, wiped before
    /// and after each test so nothing lingers in Credential Manager.
    struct Scratch(&'static [&'static str], &'static str);
    impl Scratch {
        fn new(services: &'static [&'static str], name: &'static str) -> Self {
            let s = Scratch(services, name);
            s.wipe();
            s
        }
        fn wipe(&self) {
            for svc in self.0 {
                if let Ok(e) = keyring::Entry::new(svc, self.1) {
                    let _ = e.delete_credential();
                }
            }
        }
        fn set(&self, svc: &str, value: &str) {
            keyring::Entry::new(svc, self.1).unwrap().set_password(value).unwrap();
        }
        fn get(&self, svc: &str) -> Option<String> {
            keyring::Entry::new(svc, self.1).ok()?.get_password().ok()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            self.wipe();
        }
    }

    const NEW: &str = "SnailHopTestNew";
    const MID: &str = "SnailHopTestMid";
    const OLD: &str = "SnailHopTestOld";

    // Writes to the real OS credential store. Headless Linux CI has no
    // org.freedesktop.secrets provider, so set_password errors there; these
    // run on Windows and macOS dev machines (and any Linux desktop with a
    // keyring). The read-only absent_everywhere_is_none case stays enabled
    // everywhere — it tolerates a missing store by design.
    #[cfg_attr(target_os = "linux", ignore = "needs an OS keychain (no secret service on headless CI)")]
    #[test]
    fn primary_wins_when_present_everywhere() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:primary");
        s.set(NEW, "new-v");
        s.set(MID, "mid-v");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:primary").as_deref(), Some("new-v"));
    }

    // Writes to the real OS credential store. Headless Linux CI has no
    // org.freedesktop.secrets provider, so set_password errors there; these
    // run on Windows and macOS dev machines (and any Linux desktop with a
    // keyring). The read-only absent_everywhere_is_none case stays enabled
    // everywhere — it tolerates a missing store by design.
    #[cfg_attr(target_os = "linux", ignore = "needs an OS keychain (no secret service on headless CI)")]
    #[test]
    fn legacy_hit_is_returned_and_copied_forward() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:copy-fwd");
        s.set(OLD, "old-v");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:copy-fwd").as_deref(), Some("old-v"));
        // migrated: the next read finds it under the primary service
        assert_eq!(s.get(NEW).as_deref(), Some("old-v"));
    }

    // Writes to the real OS credential store. Headless Linux CI has no
    // org.freedesktop.secrets provider, so set_password errors there; these
    // run on Windows and macOS dev machines (and any Linux desktop with a
    // keyring). The read-only absent_everywhere_is_none case stays enabled
    // everywhere — it tolerates a missing store by design.
    #[cfg_attr(target_os = "linux", ignore = "needs an OS keychain (no secret service on headless CI)")]
    #[test]
    fn newer_legacy_service_wins_over_older() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:order");
        s.set(MID, "mid-v");
        s.set(OLD, "old-v");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:order").as_deref(), Some("mid-v"));
    }

    #[test]
    fn absent_everywhere_is_none() {
        let _s = Scratch::new(&[NEW, MID, OLD], "t:absent");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:absent"), None);
    }

    // Writes to the real OS credential store. Headless Linux CI has no
    // org.freedesktop.secrets provider, so set_password errors there; these
    // run on Windows and macOS dev machines (and any Linux desktop with a
    // keyring). The read-only absent_everywhere_is_none case stays enabled
    // everywhere — it tolerates a missing store by design.
    #[cfg_attr(target_os = "linux", ignore = "needs an OS keychain (no secret service on headless CI)")]
    #[test]
    fn delete_removes_every_service_copy_so_nothing_resurrects() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:del-all");
        s.set(NEW, "new-v");
        s.set(MID, "mid-v");
        s.set(OLD, "old-v");
        chain_delete(NEW, &[MID, OLD], "t:del-all");
        assert_eq!(s.get(NEW), None);
        assert_eq!(s.get(MID), None);
        assert_eq!(s.get(OLD), None);
        // and a chained read can no longer copy anything forward
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:del-all"), None);
    }
}
