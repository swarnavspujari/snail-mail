//! Daily Unsplash photo for empty inbox / empty split rest states.
//!
//! Follows the Unsplash API guidelines: the UI hotlinks the returned
//! `urls.regular` (its `ixid` intact), attribution links carry the
//! utm_source/utm_medium referral params, and `links.download_location` is
//! GET-triggered the first time a photo is actually shown. One API fetch per
//! 24h; a local token bucket refuses more than 50 requests in any hour.
//! The Access Key never leaves the Rust core: baked at build time via
//! `option_env!` (CI secret), overridable by a user key in the OS keychain.
use crate::store;
use crate::types::DailyPhoto;
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// SNAIL_* is the name the workflow sets. The FISSION_* arm is kept only so a
// locally-exported legacy env still builds — it was once justified as
// "keeps the existing CI repo secret working", but no such secret ever existed,
// which is precisely how an empty key shipped unnoticed.
// `present` collapses a set-but-empty build env to None — CI renders a missing
// `${{ secrets.X }}` as "", and Some("") would defeat the keychain fallback
// below and send Unsplash an empty key (a 401, and no daily photo, silently).
pub const BAKED_ACCESS_KEY: Option<&str> =
    match crate::present(option_env!("SNAIL_UNSPLASH_ACCESS_KEY")) {
        Some(v) => Some(v),
        None => crate::present(option_env!("FISSION_UNSPLASH_ACCESS_KEY")),
    };

pub const KV_PHOTO: &str = "unsplash:daily";
const KV_HOURLY: &str = "unsplash:hourly";
pub const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
const HOURLY_CAP: usize = 50;
// Unsplash's API terms require every photo/photographer link to carry the
// app's own utm_source. This still said `fission_mail` two rebrands later, so
// every attribution link credited an application name that no longer exists —
// which is both wrong for the photographer and out of step with the registered
// app. Must match the Unsplash application's name, not the repo or the binary.
const UTM: &str = "utm_source=snail_mail&utm_medium=referral";

/// Cached photo + whether its download event already fired.
#[derive(Serialize, Deserialize, Clone)]
pub struct CachedPhoto {
    pub photo: DailyPhoto,
    pub download_triggered: bool,
}

/// User keychain key wins; else the baked build-time key.
pub fn access_key() -> Option<String> {
    crate::secrets::get(crate::secrets::UNSPLASH_ACCESS_KEY)
        .filter(|k| !k.trim().is_empty())
        .or_else(|| BAKED_ACCESS_KEY.map(str::to_string))
}

/// Local rate cap: true when another API request is allowed right now.
/// Trivially satisfied by the once-daily cadence, but guarded anyway.
pub fn take_rate_token(conn: &Connection, now_ms: i64) -> bool {
    let mut stamps: Vec<i64> = store::get_json(conn, KV_HOURLY).unwrap_or_default();
    stamps.retain(|t| now_ms - *t < HOUR_MS);
    if stamps.len() >= HOURLY_CAP {
        return false;
    }
    stamps.push(now_ms);
    let _ = store::set_json(conn, KV_HOURLY, &stamps);
    true
}

/// One random calm landscape, high content filter, with attribution links
/// (utm-tagged) and a best-effort offline byte cache as a data: URI.
pub async fn fetch_daily(
    http: &reqwest::Client,
    key: &str,
    now_ms: i64,
) -> Result<DailyPhoto, String> {
    let resp = http
        .get("https://api.unsplash.com/photos/random")
        .query(&[
            ("orientation", "landscape"),
            ("content_filter", "high"),
            ("query", "calm nature landscape"),
        ])
        .header("Authorization", format!("Client-ID {key}"))
        .header("Accept-Version", "v1")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        // never echo the body — it could include request identifiers
        return Err(format!("Unsplash API error ({})", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;

    // hotlink URL straight from the API (keeps the required ixid param)
    let url = v["urls"]["regular"]
        .as_str()
        .ok_or("Unsplash response had no image url")?
        .to_string();

    // best-effort offline fallback: the empty state should stay calm even
    // without a network, so cache the bytes alongside the hotlink
    let cached_data_uri = match http.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            let ct = r
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            match r.bytes().await {
                Ok(b) if b.len() <= 5_000_000 => Some(format!(
                    "data:{ct};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&b)
                )),
                _ => None,
            }
        }
        _ => None,
    };

    Ok(DailyPhoto {
        url,
        blur_hash: v["blur_hash"].as_str().map(str::to_string),
        author_name: v["user"]["name"].as_str().unwrap_or("Unknown").to_string(),
        author_link: v["user"]["links"]["html"]
            .as_str()
            .map(|s| format!("{s}?{UTM}")),
        photo_link: v["links"]["html"].as_str().map(|s| format!("{s}?{UTM}")),
        download_location: v["links"]["download_location"].as_str().map(str::to_string),
        cached_data_uri,
        fetched_at: now_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::UTM;

    /// Unsplash's API terms require attribution links to carry the app's own
    /// utm_source. This string said `fission_mail` through two rebrands — it
    /// is exactly the kind of literal nobody re-reads, and it is only visible
    /// in a query string on a photographer's profile link, so nothing surfaces
    /// it. Pinned to the current brand.
    #[test]
    fn attribution_credits_the_current_brand() {
        assert!(UTM.contains("utm_source=snail_mail"), "stale utm_source: {UTM}");
        assert!(UTM.contains("utm_medium=referral"));
        for dead in ["fission", "zenbox"] {
            assert!(!UTM.to_lowercase().contains(dead), "retired brand in {UTM}");
        }
    }
}
