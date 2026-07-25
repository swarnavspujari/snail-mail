pub mod calendar;
pub mod drive;
pub mod gmail;
pub mod ics;
/// Demo fixtures. Compiled only with the `demo-fixtures` feature — shipped
/// desktop builds contain no fake mail, accounts or events.
#[cfg(feature = "demo-fixtures")]
pub mod mock;
pub mod oauth;
pub mod people;
pub mod render;
pub mod sync;

/// Turn a raw Google API 403 into actionable, feature-specific guidance.
/// A 403 has (at least) three distinct causes; the response body (preserved
/// by gmail::get_json and friends) tells them apart. Messages keep distinct
/// substrings ("enable" vs "reconnect") so UIs can style the guidance.
/// Non-403 errors pass through unchanged.
pub fn classify_google_error(e: &str, api_name: &str, feature: &str) -> String {
    if !e.contains("(403") {
        return e.to_string();
    }
    let api_disabled = e.contains("accessNotConfigured")
        || e.contains("has not been used in project")
        || e.contains("SERVICE_DISABLED");
    let scope_missing = e.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
        || e.contains("insufficientPermissions")
        || e.contains("insufficient");
    let storage_full =
        e.contains("storageQuotaExceeded") || e.contains("teamDriveFileLimitExceeded");
    if storage_full {
        return format!(
            "{feature}: your Google storage is full — free up space at one.google.com/storage and try again."
        );
    }
    if api_disabled {
        format!(
            "The {api_name} isn't enabled for this app's Google Cloud project. \
             Enable it at console.cloud.google.com → APIs & Services → Library → \
             {api_name} → Enable, then try again."
        )
    } else if scope_missing {
        format!(
            "{feature} access wasn't granted for this account — reconnect Gmail in \
             Settings → Account and check every box on Google's consent screen."
        )
    } else {
        format!(
            "{feature} access was denied (403). If you just turned on the API, wait a \
             minute and try again."
        )
    }
}
