//! The on-disk attachment cache: `<app-cache>/attachments/`.
//!
//! `open_attachment` has to hand the OS a real file with the sender's real
//! filename, so the bytes get decrypted out of SQLite and written here. Two
//! problems came with that, and both are fixed in this module:
//!
//! 1. **Collisions.** The old layout was one flat directory keyed by a
//!    sanitized filename, so every `invoice.pdf` on the machine was the same
//!    file — opening one attachment silently overwrote another, and removing an
//!    account deleted a name a different account still pointed at. Entries are
//!    now keyed by attachment id (`<message-id>-a<n>`, unique and already
//!    validated as a safe path component by `valid_id`) with the real filename
//!    *inside* that directory. The user still sees `invoice.pdf`.
//!
//! 2. **Unbounded growth.** Nothing ever deleted a cached attachment. A prune
//!    runs once at boot: anything past `MAX_AGE` goes, and if the cache is
//!    still over `MAX_BYTES` the oldest entries go until it is not.
//!
//! Nothing here is authoritative — every byte can be re-derived from the
//! mailbox — so the prune is free to be aggressive and every failure is
//! non-fatal.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Cached attachments older than this are dropped at boot regardless of size.
/// Long enough to survive a working week of re-opening the same file, short
/// enough that a decrypted attachment is not sitting on disk indefinitely.
pub const MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Ceiling for the whole cache. Past this the oldest entries are evicted until
/// the total fits — attachments are capped at 25 MB each, so this is roughly a
/// dozen big ones or hundreds of ordinary ones.
pub const MAX_BYTES: u64 = 256 * 1024 * 1024;

/// The cache root. Callers pass Tauri's `app_cache_dir()`.
pub fn root(cache_dir: &Path) -> PathBuf {
    cache_dir.join("attachments")
}

/// Write one attachment into the cache and return its path, replacing any
/// previous copy of the same attachment (a re-download after
/// `refetch_message_body`, say, where the sender's filename may have changed).
///
/// `attachment_id` has already been through `valid_id` (alphanumerics, `-`,
/// `_`, ≤128 chars) so it cannot escape the cache root; `filename` is
/// sanitized here because it comes straight from the sender.
pub fn put(
    root: &Path,
    attachment_id: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let dir = root.join(attachment_id);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(filename));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Drop specific attachments — what account removal calls, now that an entry
/// belongs to exactly one attachment and can be deleted without asking whether
/// another account happens to share the filename.
pub fn forget(root: &Path, attachment_ids: &[String]) {
    for id in attachment_ids {
        let _ = std::fs::remove_dir_all(root.join(id));
    }
}

/// A sender-supplied filename reduced to something safe to write. Kept
/// byte-for-byte identical to the pre-existing rule so cache entries written by
/// older builds still resolve to the same name.
pub fn safe_name(filename: &str) -> String {
    let safe: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ".contains(c) { c } else { '_' })
        .collect();
    if safe.trim().is_empty() {
        "attachment".into()
    } else {
        safe
    }
}

/// What a prune pass did. Logged, not surfaced — this is housekeeping.
#[derive(Default, Debug, PartialEq)]
pub struct Pruned {
    pub entries: usize,
    pub bytes: u64,
    /// Total size left behind.
    pub remaining: u64,
}

struct Entry {
    path: PathBuf,
    bytes: u64,
    /// Newest mtime in the entry — "when was this last written".
    touched: SystemTime,
}

/// Apply the age + size policy to the cache root. Safe to call on a missing
/// directory (a fresh install has never opened an attachment).
pub fn prune(root: &Path, max_age: Duration, max_bytes: u64) -> Pruned {
    let now = SystemTime::now();
    let mut entries: Vec<Entry> = vec![];
    let Ok(dir) = std::fs::read_dir(root) else { return Pruned::default() };
    for e in dir.flatten() {
        let path = e.path();
        let (bytes, touched) = measure(&path);
        entries.push(Entry { path, bytes, touched });
    }

    let mut out = Pruned::default();
    let drop = |e: &Entry, out: &mut Pruned| {
        let res = if e.path.is_dir() {
            std::fs::remove_dir_all(&e.path)
        } else {
            std::fs::remove_file(&e.path)
        };
        if res.is_ok() {
            out.entries += 1;
            out.bytes += e.bytes;
            true
        } else {
            false
        }
    };

    // 1. Age. Anything whose mtime we cannot read is treated as ancient — an
    //    unreadable entry is not one worth keeping.
    let mut kept: Vec<Entry> = vec![];
    for e in entries.drain(..) {
        let age = now.duration_since(e.touched).unwrap_or(Duration::ZERO);
        if age > max_age {
            if !drop(&e, &mut out) {
                kept.push(e);
            }
        } else {
            kept.push(e);
        }
    }

    // 2. Size, oldest first.
    let mut total: u64 = kept.iter().map(|e| e.bytes).sum();
    if total > max_bytes {
        kept.sort_by_key(|e| e.touched);
        let mut survivors = vec![];
        for e in kept.drain(..) {
            if total > max_bytes && drop(&e, &mut out) {
                total -= e.bytes;
            } else {
                survivors.push(e);
            }
        }
        kept = survivors;
    }
    out.remaining = kept.iter().map(|e| e.bytes).sum();
    out
}

/// Size and newest mtime of a cache entry — a directory in the current layout,
/// a bare file in the pre-collision-fix one. Old flat-layout files age out
/// through the same policy instead of being special-cased.
fn measure(path: &Path) -> (u64, SystemTime) {
    let Ok(meta) = std::fs::metadata(path) else { return (0, SystemTime::UNIX_EPOCH) };
    if !meta.is_dir() {
        return (meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    }
    let mut bytes = 0;
    let mut touched = SystemTime::UNIX_EPOCH;
    if let Ok(dir) = std::fs::read_dir(path) {
        for e in dir.flatten() {
            if let Ok(m) = e.metadata() {
                bytes += m.len();
                if let Ok(t) = m.modified() {
                    touched = touched.max(t);
                }
            }
        }
    }
    (bytes, touched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "snail-attach-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn age(path: &Path, secs: u64) {
        let when = SystemTime::now() - Duration::from_secs(secs);
        // Set every file in the entry, since `measure` reads the files.
        let touch = |p: &Path| {
            if let Ok(f) = std::fs::File::options().write(true).open(p) {
                let _ = f.set_modified(when);
            }
        };
        if path.is_dir() {
            for e in std::fs::read_dir(path).unwrap().flatten() {
                touch(&e.path());
            }
        } else {
            touch(path);
        }
    }

    /// The whole point of the id-keyed layout: two attachments called
    /// invoice.pdf are two files, not one.
    #[test]
    fn same_filename_from_two_attachments_does_not_collide() {
        let root = tmp("collide");
        let a = put(&root, "msg1-a1", "invoice.pdf", b"FIRST").unwrap();
        let b = put(&root, "msg2-a1", "invoice.pdf", b"SECOND-LONGER").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&a).unwrap(), b"FIRST");
        assert_eq!(std::fs::read(&b).unwrap(), b"SECOND-LONGER");
        // and the user still sees the sender's filename
        assert_eq!(a.file_name().unwrap(), "invoice.pdf");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn hostile_filenames_stay_inside_the_cache() {
        let root = tmp("hostile");
        let p = put(&root, "msg1-a1", "../../../etc/passwd", b"x").unwrap();
        assert!(p.starts_with(root.join("msg1-a1")), "{}", p.display());
        // The separators are what matter, not the dots: `.._.._.._etc_passwd`
        // is a perfectly safe *filename*. Assert there is no traversal
        // COMPONENT and that the name is a single path segment.
        assert!(
            !p.components().any(|c| c == std::path::Component::ParentDir),
            "{}",
            p.display()
        );
        assert_eq!(p.parent().unwrap(), root.join("msg1-a1"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_nameless_attachment_still_gets_a_file() {
        let root = tmp("empty-name");
        // sanitizes to whitespace → the fallback name
        assert_eq!(put(&root, "a-a1", "   ", b"x").unwrap().file_name().unwrap(), "attachment");
        assert_eq!(put(&root, "b-a1", "", b"x").unwrap().file_name().unwrap(), "attachment");
        // sanitizes to something non-empty → kept as-is, still one segment
        let p = put(&root, "c-a1", "///", b"x").unwrap();
        assert_eq!(p.file_name().unwrap(), "___");
        assert_eq!(p.parent().unwrap(), root.join("c-a1"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn re_putting_replaces_the_previous_filename() {
        let root = tmp("replace");
        put(&root, "msg1-a1", "old.pdf", b"x").unwrap();
        put(&root, "msg1-a1", "new.pdf", b"y").unwrap();
        let names: Vec<String> = std::fs::read_dir(root.join("msg1-a1"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["new.pdf".to_string()], "stale name left behind");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_drops_old_entries_and_keeps_fresh_ones() {
        let root = tmp("age");
        put(&root, "old-a1", "a.pdf", &vec![0u8; 100]).unwrap();
        put(&root, "new-a1", "b.pdf", &vec![0u8; 100]).unwrap();
        age(&root.join("old-a1"), 60 * 60 * 24 * 30);
        let out = prune(&root, MAX_AGE, MAX_BYTES);
        assert_eq!(out.entries, 1);
        assert!(!root.join("old-a1").exists());
        assert!(root.join("new-a1").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_evicts_oldest_first_until_under_the_cap() {
        let root = tmp("size");
        for (i, id) in ["e1", "e2", "e3", "e4"].iter().enumerate() {
            put(&root, id, "f.bin", &vec![0u8; 1000]).unwrap();
            // e1 oldest … e4 newest, all well inside MAX_AGE
            age(&root.join(id), (4 - i as u64) * 60);
        }
        // cap fits two entries
        let out = prune(&root, MAX_AGE, 2000);
        assert_eq!(out.entries, 2, "should evict exactly enough");
        assert!(!root.join("e1").exists(), "oldest goes first");
        assert!(!root.join("e2").exists());
        assert!(root.join("e3").exists(), "newest survive");
        assert!(root.join("e4").exists());
        assert!(out.remaining <= 2000);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_sweeps_flat_layout_leftovers() {
        let root = tmp("flat");
        std::fs::create_dir_all(&root).unwrap();
        // what pre-fix builds wrote: a bare file in the cache root
        let stale = root.join("invoice.pdf");
        std::fs::write(&stale, vec![0u8; 50]).unwrap();
        age(&stale, 60 * 60 * 24 * 30);
        let out = prune(&root, MAX_AGE, MAX_BYTES);
        assert_eq!(out.entries, 1);
        assert!(!stale.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_on_a_missing_cache_is_a_no_op() {
        let root = tmp("missing").join("never-created");
        assert_eq!(prune(&root, MAX_AGE, MAX_BYTES), Pruned::default());
    }

    #[test]
    fn forget_removes_only_the_named_entries() {
        let root = tmp("forget");
        put(&root, "keep-a1", "a.pdf", b"x").unwrap();
        put(&root, "gone-a1", "a.pdf", b"y").unwrap();
        forget(&root, &["gone-a1".to_string(), "never-existed-a9".to_string()]);
        assert!(root.join("keep-a1").exists());
        assert!(!root.join("gone-a1").exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
