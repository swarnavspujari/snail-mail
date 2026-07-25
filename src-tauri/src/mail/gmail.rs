//! Minimal Gmail REST client: exactly the calls Snail Mail needs, nothing more.
use crate::mail::oauth;
use crate::secrets;
use crate::types::*;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// Gmail returns message/attachment bytes as base64url. Most parts are unpadded
/// but some carry '=' padding, on which the old `URL_SAFE_NO_PAD` engine errored
/// — silently dropping the body via `decode(..).ok()?`. This engine decodes
/// either way (padding-indifferent) and encodes with padding.
const B64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub struct GmailSession {
    #[allow(dead_code)] // kept for multi-account support (P1)
    pub email: String,
    client_id: String,
    client_secret: String,
    refresh_token: String,
    access_token: Option<(String, Instant)>,
    label_ids: std::collections::HashMap<String, String>, // name -> id
}

impl GmailSession {
    /// Rebuild a session from keychain material (None if not connected).
    pub fn from_keychain(email: String) -> Option<Self> {
        let refresh_token = secrets::get(&secrets::gmail_refresh_entry(&email))
            .or_else(|| secrets::get(secrets::GMAIL_REFRESH_TOKEN_LEGACY))?;
        Some(Self {
            email,
            client_id: secrets::get(secrets::GMAIL_CLIENT_ID)?,
            client_secret: secrets::get(secrets::GMAIL_CLIENT_SECRET)?,
            refresh_token,
            access_token: None,
            label_ids: Default::default(),
        })
    }

    pub fn new_connected(email: String, access_token: String, expires_in: i64) -> Option<Self> {
        let refresh_token = secrets::get(&secrets::gmail_refresh_entry(&email))?;
        Some(Self {
            email,
            client_id: secrets::get(secrets::GMAIL_CLIENT_ID)?,
            client_secret: secrets::get(secrets::GMAIL_CLIENT_SECRET)?,
            refresh_token,
            access_token: Some((
                access_token,
                Instant::now() + Duration::from_secs(expires_in.max(60) as u64 - 60),
            )),
            label_ids: Default::default(),
        })
    }

    /// List every label as (id, name), refreshing the in-memory name→id map.
    /// Sync persists these so opaque ids resolve to names on read.
    pub async fn list_labels(
        &mut self,
        http: &reqwest::Client,
    ) -> Result<Vec<(String, String)>, String> {
        let v = self.get_json(http, &format!("{BASE}/labels")).await?;
        let mut out = vec![];
        if let Some(arr) = v["labels"].as_array() {
            for l in arr {
                if let (Some(n), Some(id)) = (l["name"].as_str(), l["id"].as_str()) {
                    self.label_ids.insert(n.to_string(), id.to_string());
                    out.push((id.to_string(), n.to_string()));
                }
            }
        }
        Ok(out)
    }

    /// Resolve a label name to its Gmail id, creating the label if needed.
    /// System labels (INBOX, UNREAD, STARRED, IMPORTANT) are their own ids.
    pub async fn ensure_label_id(
        &mut self,
        http: &reqwest::Client,
        name: &str,
    ) -> Result<String, String> {
        if name.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
            return Ok(name.to_string());
        }
        if self.label_ids.is_empty() {
            self.list_labels(http).await?;
        }
        if let Some(id) = self.label_ids.get(name) {
            return Ok(id.clone());
        }
        let v = self
            .post_json(
                http,
                &format!("{BASE}/labels"),
                json!({ "name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show" }),
            )
            .await?;
        let id = v["id"].as_str().ok_or("label create returned no id")?.to_string();
        self.label_ids.insert(name.to_string(), id.clone());
        Ok(id)
    }

    /// A fresh bearer token for callers that issue their own requests (the
    /// calendar fetch resolves it once, then hits N calendars concurrently).
    pub(crate) async fn bearer(&mut self, http: &reqwest::Client) -> Result<String, String> {
        self.token(http).await
    }

    async fn token(&mut self, http: &reqwest::Client) -> Result<String, String> {
        if let Some((tok, until)) = &self.access_token {
            if Instant::now() < *until {
                return Ok(tok.clone());
            }
        }
        let (tok, expires_in) = oauth::refresh_access_token(
            http,
            &self.client_id,
            &self.client_secret,
            &self.refresh_token,
        )
        .await?;
        self.access_token = Some((
            tok.clone(),
            Instant::now() + Duration::from_secs(expires_in.max(60) as u64 - 60),
        ));
        Ok(tok)
    }

    /// Drop the cached access token so the next token() call must go through
    /// a refresh. A Google-side revoke invalidates the access token
    /// immediately but our cache thinks it's valid for up to an hour — the
    /// 401-retry path below forces the refresh, and the refresh's
    /// `invalid_grant` is what mark_auth_lost classifies on, so a dead grant
    /// surfaces in seconds instead of at cache expiry.
    pub(crate) fn invalidate_access_token(&mut self) {
        self.access_token = None;
    }

    pub(crate) async fn get_json(&mut self, http: &reqwest::Client, url: &str) -> Result<Value, String> {
        let mut tok = self.token(http).await?;
        let mut auth_retried = false;
        for attempt in 0..3u32 {
            let resp = http
                .get(url)
                .bearer_auth(&tok)
                .send()
                .await
                .map_err(|_| "Gmail request failed (network)".to_string())?;
            let status = resp.status();
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            if status.as_u16() == 401 && !auth_retried {
                // Token rejected before its cached expiry (server-side revoke,
                // password change): force ONE refresh and retry. If the grant
                // is dead the refresh returns `invalid_grant`, which the
                // caller classifies.
                auth_retried = true;
                self.invalidate_access_token();
                tok = self.token(http).await?;
                continue;
            }
            if !status.is_success() {
                // Preserve the response body — Google puts the actionable reason
                // (accessNotConfigured, insufficient scope, …) there, and callers
                // classify on it. Read it BEFORE returning (can't .json() after).
                let body = resp.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(500).collect();
                return Err(format!("Gmail API error ({status}): {snippet}"));
            }
            return resp
                .json()
                .await
                .map_err(|_| "Gmail returned an unexpected response".to_string());
        }
        Err("Gmail API rate-limited; try again shortly".to_string())
    }

    async fn post_json(
        &mut self,
        http: &reqwest::Client,
        url: &str,
        body: Value,
    ) -> Result<Value, String> {
        let mut tok = self.token(http).await?;
        let mut auth_retried = false;
        for attempt in 0..3u32 {
            let resp = http
                .post(url)
                .bearer_auth(&tok)
                .json(&body)
                .send()
                .await
                .map_err(|_| "Gmail request failed (network)".to_string())?;
            let status = resp.status();
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            if status.as_u16() == 401 && !auth_retried {
                // See get_json: one forced refresh so a revoked grant
                // classifies now, not at access-token expiry.
                auth_retried = true;
                self.invalidate_access_token();
                tok = self.token(http).await?;
                continue;
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(500).collect();
                return Err(format!("Gmail API error ({status}): {snippet}"));
            }
            return resp
                .json()
                .await
                .map_err(|_| "Gmail returned an unexpected response".to_string());
        }
        Err("Gmail API rate-limited; try again shortly".to_string())
    }

    pub async fn profile_email(http: &reqwest::Client, access_token: &str) -> Result<String, String> {
        let resp = http
            .get(format!("{BASE}/profile"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| "could not fetch the Gmail profile".to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Gmail profile error ({})", resp.status()));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        v["emailAddress"]
            .as_str()
            .map(str::to_string)
            .ok_or("profile had no email".to_string())
    }

    /// (thread_id, history_id) pairs for a query, following nextPageToken
    /// until `max_total` threads or the listing ends.
    pub async fn list_thread_ids_paged(
        &mut self,
        http: &reqwest::Client,
        query: &str,
        max_total: usize,
    ) -> Result<Vec<(String, String)>, String> {
        let mut out: Vec<(String, String)> = vec![];
        let mut page_token: Option<String> = None;
        loop {
            let mut url = format!(
                "{BASE}/threads?maxResults=100&q={}",
                url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
            );
            if let Some(t) = &page_token {
                url.push_str(&format!("&pageToken={t}"));
            }
            let v = self.get_json(http, &url).await?;
            if let Some(arr) = v["threads"].as_array() {
                for t in arr {
                    if let Some(id) = t["id"].as_str() {
                        out.push((
                            id.to_string(),
                            t["historyId"].as_str().unwrap_or_default().to_string(),
                        ));
                    }
                }
            }
            page_token = v["nextPageToken"].as_str().map(str::to_string);
            if page_token.is_none() || out.len() >= max_total {
                break;
            }
        }
        out.truncate(max_total);
        Ok(out)
    }

    /// One listing page: (thread_id, history_id) pairs plus the nextPageToken
    /// (None = listing exhausted). Unlike list_thread_ids_paged, the paging
    /// state crosses the call boundary — the resumable history crawl persists
    /// the token between beats.
    pub async fn list_threads_page(
        &mut self,
        http: &reqwest::Client,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<(Vec<(String, String)>, Option<String>), String> {
        let mut url = format!(
            "{BASE}/threads?maxResults=100&q={}",
            url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
        );
        if let Some(t) = page_token {
            url.push_str(&format!("&pageToken={t}"));
        }
        let v = self.get_json(http, &url).await?;
        let mut out: Vec<(String, String)> = vec![];
        if let Some(arr) = v["threads"].as_array() {
            for t in arr {
                if let Some(id) = t["id"].as_str() {
                    out.push((
                        id.to_string(),
                        t["historyId"].as_str().unwrap_or_default().to_string(),
                    ));
                }
            }
        }
        Ok((out, v["nextPageToken"].as_str().map(str::to_string)))
    }

    /// The account's current profile (email + latest historyId) — the
    /// baseline for incremental sync.
    pub async fn profile(&mut self, http: &reqwest::Client) -> Result<Value, String> {
        self.get_json(http, &format!("{BASE}/profile")).await
    }

    /// One page of users.history.list since `start_history_id`. A 404 means
    /// the id expired (server keeps ~a week) — callers fall back to a full
    /// reconcile.
    pub async fn history_page(
        &mut self,
        http: &reqwest::Client,
        start_history_id: &str,
        page_token: Option<&str>,
    ) -> Result<Value, String> {
        let mut url = format!("{BASE}/history?startHistoryId={start_history_id}&maxResults=100");
        if let Some(t) = page_token {
            url.push_str(&format!("&pageToken={t}"));
        }
        self.get_json(http, &url).await
    }

    pub async fn get_thread_full(
        &mut self,
        http: &reqwest::Client,
        id: &str,
    ) -> Result<Value, String> {
        self.get_json(http, &format!("{BASE}/threads/{id}?format=full")).await
    }

    pub async fn modify_thread(
        &mut self,
        http: &reqwest::Client,
        id: &str,
        add: &[&str],
        remove: &[&str],
    ) -> Result<(), String> {
        self.post_json(
            http,
            &format!("{BASE}/threads/{id}/modify"),
            json!({ "addLabelIds": add, "removeLabelIds": remove }),
        )
        .await
        .map(|_| ())
    }

    /// Move a thread to Gmail's Trash (recoverable server-side for 30 days).
    pub async fn trash_thread(&mut self, http: &reqwest::Client, id: &str) -> Result<(), String> {
        self.post_json(http, &format!("{BASE}/threads/{id}/trash"), json!({}))
            .await
            .map(|_| ())
    }

    pub async fn untrash_thread(&mut self, http: &reqwest::Client, id: &str) -> Result<(), String> {
        self.post_json(http, &format!("{BASE}/threads/{id}/untrash"), json!({}))
            .await
            .map(|_| ())
    }

    pub async fn send(
        &mut self,
        http: &reqwest::Client,
        raw_rfc822: &str,
        thread_id: Option<&str>,
    ) -> Result<(), String> {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_rfc822.as_bytes());
        let mut body = json!({ "raw": raw });
        if let Some(tid) = thread_id {
            body["threadId"] = json!(tid);
        }
        self.post_json(http, &format!("{BASE}/messages/send"), body)
            .await
            .map(|_| ())
    }

    pub async fn get_attachment_bytes(
        &mut self,
        http: &reqwest::Client,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, String> {
        let v = self
            .get_json(
                http,
                &format!("{BASE}/messages/{message_id}/attachments/{attachment_id}"),
            )
            .await?;
        let data = v["data"].as_str().ok_or("attachment had no data")?;
        B64URL
            .decode(data)
            .map_err(|_| "attachment data was not valid base64".to_string())
    }
}

/// Large text bodies sometimes arrive with an empty `body.data` and the bytes
/// behind `body.attachmentId` (no filename, no Content-ID). The sync parser only
/// reads `body.data`, so those messages render blank / fall back to nothing.
/// Fetch the bytes for any such text/html or text/plain part and inline them as
/// base64url `body.data`, so the normal parser captures them as the body.
///
/// Runs on the sync path (async, has the session); capped so a runaway body
/// can't stall a sync. Best-effort: parts that fail to fetch stay empty and heal
/// later via the on-open body refetch.
pub async fn hydrate_body_data(
    http: &reqwest::Client,
    session: &mut GmailSession,
    thread_json: &mut Value,
) {
    // Gmail's per-message ceiling is ~25 MB, so hydrating up to it means any
    // body that fits in a message hydrates in full — no more messages persisting
    // empty because their (large) HTML body lived behind body.attachmentId and
    // tripped a smaller cap. Bodies larger than this are vanishingly rare; the
    // reading pane shows a terminal "open in Gmail" for them instead of a spinner.
    const MAX_BODY_BYTES: usize = 25_000_000;
    let Some(messages) = thread_json["messages"].as_array_mut() else {
        return;
    };
    for msg in messages.iter_mut() {
        let mid = msg["id"].as_str().unwrap_or_default().to_string();
        if mid.is_empty() {
            continue;
        }
        let mut paths: Vec<(Vec<usize>, String)> = vec![];
        collect_body_att_paths(&msg["payload"], &[], &mut paths);
        for (path, att_id) in paths {
            let Ok(bytes) = session.get_attachment_bytes(http, &mid, &att_id).await else {
                continue;
            };
            if bytes.is_empty() || bytes.len() > MAX_BODY_BYTES {
                continue;
            }
            // navigate to the part by child-index path and inline the bytes
            let mut cur = &mut msg["payload"];
            for idx in &path {
                cur = &mut cur["parts"][*idx];
            }
            cur["body"]["data"] = Value::String(B64URL.encode(&bytes));
        }
    }
}

/// Depth-first collect (path-of-child-indices, attachmentId) for text/html or
/// text/plain body parts whose `body.data` is empty but that carry an
/// `attachmentId` — i.e. the message body lives behind an attachment fetch.
fn collect_body_att_paths(part: &Value, prefix: &[usize], out: &mut Vec<(Vec<usize>, String)>) {
    let mime = part["mimeType"].as_str().unwrap_or_default();
    let filename = part["filename"].as_str().unwrap_or_default();
    let has_cid = header(part, "Content-ID").or_else(|| header(part, "Content-Id")).is_some();
    let is_body = filename.is_empty() && !has_cid && (mime == "text/html" || mime == "text/plain");
    // Calendar invites whose ICS rides only as an attachment (invite.ics with
    // no inline data) hydrate too, so the invite parse sees the payload —
    // but only plausibly-sized ones (the part's declared size is known here;
    // walk_parts would discard an oversized payload after the download).
    let is_ics = is_ics_mime(mime, filename)
        && part["body"]["size"].as_i64().unwrap_or(0) <= MAX_ICS_BYTES as i64;
    let data_empty = part["body"]["data"].as_str().map(str::is_empty).unwrap_or(true);
    if (is_body || is_ics) && data_empty {
        if let Some(att_id) = part["body"]["attachmentId"].as_str() {
            out.push((prefix.to_vec(), att_id.to_string()));
        }
    }
    if let Some(children) = part["parts"].as_array() {
        for (i, child) in children.iter().enumerate() {
            let mut p = prefix.to_vec();
            p.push(i);
            collect_body_att_paths(child, &p, out);
        }
    }
}

// ------------------------------------------------------------- MIME parsing

pub struct ParsedMessage {
    pub message: Message,
    pub rfc_message_id: Option<String>,
    pub list_unsubscribe: Option<String>,
    /// (meta, gmail attachment id, Content-ID without angle brackets)
    pub attachments: Vec<(Attachment, Option<String>, Option<String>)>,
    pub label_ids: Vec<String>,
    /// Raw iCalendar payload when the message carries one (invite mail).
    pub ics: Option<String>,
}

/// Pick the actionable target out of a List-Unsubscribe header:
/// prefers an https URL, falls back to a mailto address.
pub fn parse_unsubscribe_target(header: &str) -> Option<(String, String)> {
    let mut mailto = None;
    for token in header.split(',') {
        let t = token.trim().trim_start_matches('<').trim_end_matches('>');
        if t.starts_with("https://") {
            return Some(("opened".into(), t.to_string()));
        }
        if let Some(addr) = t.strip_prefix("mailto:") {
            let addr = addr.split('?').next().unwrap_or(addr);
            mailto.get_or_insert(addr.to_string());
        }
    }
    mailto.map(|m| ("mailto".into(), m))
}

fn header<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    payload["headers"].as_array()?.iter().find_map(|h| {
        if h["name"].as_str()?.eq_ignore_ascii_case(name) {
            h["value"].as_str()
        } else {
            None
        }
    })
}

fn parse_address(raw: &str) -> (String, String) {
    // "Name <addr>" | "addr"
    if let Some(start) = raw.find('<') {
        let name = raw[..start].trim().trim_matches('"').to_string();
        let addr = raw[start + 1..].trim_end_matches('>').trim().to_string();
        let name = if name.is_empty() { addr.clone() } else { name };
        (name, addr)
    } else {
        (raw.trim().to_string(), raw.trim().to_string())
    }
}

fn split_addresses(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| parse_address(s).1)
        .filter(|s| !s.is_empty())
        .collect()
}

fn decode_body(part: &Value) -> Option<String> {
    let data = part["body"]["data"].as_str().filter(|s| !s.is_empty())?;
    let bytes = B64URL.decode(data).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

/// Crude but dependable HTML→text for the reading pane fallback.
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_style_or_script = false;
    let lower = html.to_ascii_lowercase();
    for (i, c) in html.char_indices() {
        let rest = &lower[i..]; // char_indices of the ASCII-lowered twin align byte-for-byte
        if !in_tag && (rest.starts_with("<style") || rest.starts_with("<script")) {
            in_style_or_script = true;
        }
        if in_style_or_script && (rest.starts_with("</style>") || rest.starts_with("</script>")) {
            in_style_or_script = false;
        }
        if c == '<' {
            in_tag = true;
            if rest.starts_with("<br") || rest.starts_with("<p") || rest.starts_with("<div") {
                out.push('\n');
            }
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag && !in_style_or_script {
            out.push(c);
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    // collapse blank-line runs
    let mut result = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            blank += 1;
            if blank <= 1 {
                result.push('\n');
            }
        } else {
            blank = 0;
            result.push_str(t);
            result.push('\n');
        }
    }
    result.trim().to_string()
}

// filename, mime, size, attachment_id, content_id
type RawAtt = (String, String, i64, String, Option<String>);

/// Calendar-object MIME types (invites): the bare text/calendar alternative
/// part and the invite.ics attachment flavor.
fn is_ics_mime(mime: &str, filename: &str) -> bool {
    mime == "text/calendar"
        || mime == "application/ics"
        || filename.to_ascii_lowercase().ends_with(".ics")
}

const MAX_ICS_BYTES: usize = 131_072;

fn walk_parts(
    part: &Value,
    text: &mut Option<String>,
    html: &mut Option<String>,
    atts: &mut Vec<RawAtt>,
    ics: &mut Option<String>,
) {
    let mime = part["mimeType"].as_str().unwrap_or_default();
    let filename = part["filename"].as_str().unwrap_or_default();
    // Invite payload: capture the first calendar object regardless of whether
    // it's the alternative part or the .ics attachment (hydrate_body_data
    // inlines attachment-backed copies before this parse runs on sync).
    if ics.is_none() && is_ics_mime(mime, filename) {
        if let Some(data) = decode_body(part) {
            if !data.trim().is_empty() && data.len() <= MAX_ICS_BYTES {
                *ics = Some(data);
            }
        }
    }
    // Content-ID marks inline images referenced as cid: from the HTML body —
    // those often have empty filenames, so check it alongside filename.
    let content_id = header(part, "Content-ID")
        .or_else(|| header(part, "Content-Id"))
        .map(|s| s.trim_start_matches('<').trim_end_matches('>').to_string());
    if !filename.is_empty() || content_id.is_some() {
        if let Some(att_id) = part["body"]["attachmentId"].as_str() {
            atts.push((
                filename.to_string(),
                mime.to_string(),
                part["body"]["size"].as_i64().unwrap_or(0),
                att_id.to_string(),
                content_id,
            ));
        }
    } else if mime == "text/plain" && text.is_none() {
        *text = decode_body(part);
    } else if mime == "text/html" && html.is_none() {
        *html = decode_body(part);
    }
    if let Some(children) = part["parts"].as_array() {
        for child in children {
            walk_parts(child, text, html, atts, ics);
        }
    }
}

pub fn parse_gmail_message(msg: &Value, thread_id: &str) -> ParsedMessage {
    let payload = &msg["payload"];
    let id = msg["id"].as_str().unwrap_or_default().to_string();
    let label_ids: Vec<String> = msg["labelIds"]
        .as_array()
        .map(|a| a.iter().filter_map(|l| l.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let (from_name, from_addr) = parse_address(header(payload, "From").unwrap_or_default());
    let to = split_addresses(header(payload, "To").unwrap_or_default());
    let cc = split_addresses(header(payload, "Cc").unwrap_or_default());
    let subject = header(payload, "Subject").unwrap_or_default().to_string();
    let rfc_message_id = header(payload, "Message-ID")
        .or_else(|| header(payload, "Message-Id"))
        .map(str::to_string);
    let list_unsubscribe = header(payload, "List-Unsubscribe").map(str::to_string);
    let date = msg["internalDate"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    let mut text = None;
    let mut html = None;
    let mut raw_atts = vec![];
    let mut ics = None;
    walk_parts(payload, &mut text, &mut html, &mut raw_atts, &mut ics);
    let body_text = text
        .clone()
        .or_else(|| html.as_deref().map(strip_html))
        .unwrap_or_default();

    let attachments = raw_atts
        .into_iter()
        .enumerate()
        .map(|(i, (filename, mime, size, att_id, content_id))| {
            (
                Attachment {
                    id: format!("{id}-a{}", i + 1),
                    message_id: id.clone(),
                    filename,
                    mime_type: mime,
                    size_bytes: size,
                },
                Some(att_id),
                content_id,
            )
        })
        .collect();

    ParsedMessage {
        list_unsubscribe,
        ics,
        message: Message {
            id: id.clone(),
            thread_id: thread_id.to_string(),
            from: from_addr,
            from_name,
            to,
            cc,
            subject,
            snippet: msg["snippet"].as_str().unwrap_or_default().to_string(),
            body_text,
            body_html: html,
            date,
            unread: label_ids.iter().any(|l| l == "UNREAD"),
            attachments: vec![],
        },
        rfc_message_id,
        attachments,
        label_ids,
    }
}

/// Build the outgoing RFC 822 message for messages.send. Plain text always;
/// optional HTML alternative (multipart/alternative) and base64 attachments
/// (multipart/mixed around everything).
pub fn build_rfc822(
    from: &str,
    mail: &OutgoingMail,
    in_reply_to: Option<&str>,
) -> String {
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S +0000");
    let mut headers = vec![
        format!("From: {from}"),
        format!("To: {}", mail.to.join(", ")),
    ];
    if !mail.cc.is_empty() {
        headers.push(format!("Cc: {}", mail.cc.join(", ")));
    }
    // Gmail derives recipients from the raw message and strips Bcc from the
    // delivered copies, so a header is all that's needed to blind-copy.
    if !mail.bcc.is_empty() {
        headers.push(format!("Bcc: {}", mail.bcc.join(", ")));
    }
    headers.push(format!("Subject: {}", mail.subject.replace(['\r', '\n'], " ")));
    headers.push(format!("Date: {date}"));
    if let Some(irt) = in_reply_to {
        headers.push(format!("In-Reply-To: {irt}"));
        headers.push(format!("References: {irt}"));
    }
    headers.push("MIME-Version: 1.0".to_string());

    let body = body_section(mail);
    if mail.attachments.is_empty() {
        return format!("{}\r\n{}", headers.join("\r\n"), body);
    }

    let boundary = format!("zbmix{:016x}", chrono::Utc::now().timestamp_millis());
    headers.push(format!("Content-Type: multipart/mixed; boundary=\"{boundary}\""));
    let mut out = format!("{}\r\n\r\n", headers.join("\r\n"));
    out.push_str(&format!("--{boundary}\r\n{body}\r\n"));
    for att in &mail.attachments {
        let name = att.filename.replace(['"', '\r', '\n'], "_");
        let mime: String = att
            .mime_type
            .chars()
            .filter(|c| c.is_ascii_graphic() && *c != '"')
            .collect();
        let mime = if mime.is_empty() { "application/octet-stream".to_string() } else { mime };
        out.push_str(&format!(
            "--{boundary}\r\nContent-Type: {mime}; name=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"{name}\"\r\n\r\n"
        ));
        // RFC 2045 caps encoded lines at 76 chars
        for chunk in att.data_base64.as_bytes().chunks(76) {
            out.push_str(&String::from_utf8_lossy(chunk));
            out.push_str("\r\n");
        }
    }
    out.push_str(&format!("--{boundary}--\r\n"));
    out
}

/// The message body as a MIME section (headers + blank line + content):
/// text/plain alone, or a multipart/alternative with the HTML variant.
fn body_section(mail: &OutgoingMail) -> String {
    match &mail.body_html {
        None => format!(
            "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}",
            mail.body_text
        ),
        Some(html) => {
            let boundary = format!("zbalt{:016x}", chrono::Utc::now().timestamp_millis() ^ 0x5a5a);
            format!(
                "Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\r\n\
                 --{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}\r\n\
                 --{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}\r\n\
                 --{boundary}--\r\n",
                mail.body_text, html
            )
        }
    }
}
