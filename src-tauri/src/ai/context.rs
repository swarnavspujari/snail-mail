//! The Context Assembler: full thread + attachments + Knowledge Base →
//! one system prompt and one user message, under a character budget
//! (~4 chars/token). Oldest quoted material is truncated first.
use crate::ai::attachments;
use crate::mail::gmail::GmailSession;
use crate::store;
use crate::types::*;
use rusqlite::Connection;

// ≈ 25k tokens of context — comfortable for every supported model.
const TOTAL_BUDGET: usize = 100_000;
const KB_BUDGET: usize = 12_000;
const THREAD_BUDGET: usize = 56_000;
const ATTACH_BUDGET_EACH: usize = 12_000;
const ATTACH_BUDGET_TOTAL: usize = 24_000;
const MAX_IMAGES: usize = 3;
const MAX_IMAGE_BYTES: i64 = 3_500_000;

pub struct AssembledContext {
    pub system: String,
    pub user_text: String,
    /// (media type, base64 data) — only sent to multimodal providers.
    pub images: Vec<(String, String)>,
}

fn cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[… truncated …]", &s[..end])
}

/// Remove ">"-quoted trails — the oldest text in a message — keeping the
/// first few quoted lines for context.
fn strip_quoted(body: &str) -> String {
    let mut out = vec![];
    let mut quoted_kept = 0;
    for line in body.lines() {
        if line.trim_start().starts_with('>') {
            quoted_kept += 1;
            if quoted_kept > 4 {
                continue;
            }
        }
        out.push(line);
    }
    out.join("\n")
}

pub fn build_system(kb: &KnowledgeBase, account_email: &str) -> String {
    let mut s = String::new();
    s.push_str(
        "You are the email-drafting engine inside Snail Mail. You write on behalf of the user, \
         in their voice, ready to send. Output ONLY the email body — no subject line, no preamble, \
         no markdown fences, no commentary. Match the thread's language and formality.\n",
    );
    s.push_str(&format!("The user's email address is {account_email}.\n"));
    if !kb.instructions.trim().is_empty() {
        s.push_str("\n## The user's standing instructions (always follow these)\n");
        s.push_str(&cap(&kb.instructions, KB_BUDGET / 2));
        s.push('\n');
    }
    if !kb.snippets.is_empty() {
        s.push_str("\n## Reusable snippets (weave in when relevant)\n");
        for sn in kb.snippets.iter().take(12) {
            s.push_str(&format!("### {}\n{}\n", sn.title, cap(&sn.body, 2_000)));
        }
    }
    if !kb.voice_examples.is_empty() {
        s.push_str("\n## Examples of how the user writes (mimic this voice)\n");
        for ex in kb.voice_examples.iter().take(6) {
            s.push_str(&format!("### {}\n{}\n", ex.title, cap(&ex.body, 3_000)));
        }
    }
    s
}

struct AttachmentRow {
    filename: String,
    mime: String,
    size: i64,
    remote_id: Option<String>,
    message_id: String,
    cached_text: Option<String>,
}

/// Assemble everything for a draft/ask request. `sessions` holds live Gmail
/// sessions per account (enables attachment fetches for real threads).
/// `global_db` carries the app-wide rows (Knowledge Base, accounts); `db` is
/// the thread's account file.
pub async fn assemble(
    global_db: &std::sync::Mutex<Connection>,
    db: &std::sync::Mutex<Connection>,
    http: &reqwest::Client,
    sessions: &tokio::sync::Mutex<std::collections::HashMap<String, GmailSession>>,
    req: &DraftRequest,
    multimodal: bool,
) -> Result<AssembledContext, String> {
    let (kb, account) = {
        let conn = global_db.lock().unwrap();
        (store::get_kb(&conn), store::active_account(&conn))
    };
    let (thread_account, messages, att_rows) = {
        let conn = db.lock().unwrap();
        let thread_account = req
            .thread_id
            .as_ref()
            .and_then(|id| store::account_of_thread(&conn, id));
        let messages = match &req.thread_id {
            Some(id) => store::get_messages(&conn, id)?,
            None => vec![],
        };
        let mut att_rows: Vec<AttachmentRow> = vec![];
        for m in &messages {
            for a in &m.attachments {
                let (remote_id, cached): (Option<String>, Option<String>) = conn
                    .query_row(
                        "SELECT remote_id, text_content FROM attachments WHERE id = ?1",
                        [a.id.as_str()],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap_or((None, None));
                att_rows.push(AttachmentRow {
                    filename: a.filename.clone(),
                    mime: a.mime_type.clone(),
                    size: a.size_bytes,
                    remote_id,
                    message_id: a.message_id.clone(),
                    cached_text: cached,
                });
            }
        }
        (thread_account, messages, att_rows)
    };

    let system = build_system(&kb, &account.email);

    // ---- thread transcript: newest messages get budget first ----
    let mut per_message: Vec<String> = vec![];
    let mut used = 0usize;
    for (idx, m) in messages.iter().enumerate().rev() {
        let newest = idx + 1 == messages.len();
        let mut body = m.body_text.clone();
        if !newest {
            body = strip_quoted(&body); // oldest quoted trails go first
        }
        let remaining = THREAD_BUDGET.saturating_sub(used);
        if remaining < 400 {
            per_message.push(format!(
                "[{} earlier message(s) omitted for length]",
                idx + 1
            ));
            break;
        }
        let msg_cap = if newest { remaining } else { remaining.min(6_000) };
        let entry = format!(
            "From: {} <{}>\nDate: {}\nTo: {}\n\n{}",
            m.from_name,
            m.from,
            chrono::DateTime::from_timestamp_millis(m.date)
                .map(|d| d.to_rfc2822())
                .unwrap_or_default(),
            m.to.join(", "),
            cap(&body, msg_cap),
        );
        used += entry.len();
        per_message.push(entry);
    }
    per_message.reverse();

    // ---- attachments ----
    let mut attachment_sections: Vec<String> = vec![];
    let mut images: Vec<(String, String)> = vec![];
    let mut att_used = 0usize;
    for row in &att_rows {
        // images → multimodal blocks
        if attachments::is_image(&row.mime) {
            if multimodal && images.len() < MAX_IMAGES && row.size <= MAX_IMAGE_BYTES {
                if let Some(bytes) = fetch_bytes(http, sessions, thread_account.as_deref(), row).await {
                    use base64::Engine;
                    images.push((
                        row.mime.clone(),
                        base64::engine::general_purpose::STANDARD.encode(&bytes),
                    ));
                    continue;
                }
            }
            attachment_sections.push(format!(
                "[Image attachment: {} ({}, {} bytes) — not passed to this model]",
                row.filename, row.mime, row.size
            ));
            continue;
        }
        // text-bearing formats
        if att_used >= ATTACH_BUDGET_TOTAL {
            attachment_sections.push(format!(
                "[Attachment {} skipped — context budget reached]",
                row.filename
            ));
            continue;
        }
        let text = if let Some(t) = &row.cached_text {
            Some(t.clone())
        } else if let Some(bytes) =
            fetch_bytes(http, sessions, thread_account.as_deref(), row).await
        {
            attachments::extract_text(&row.filename, &row.mime, &bytes)
        } else {
            None
        };
        match text {
            Some(t) if !t.trim().is_empty() => {
                let capped = cap(&t, ATTACH_BUDGET_EACH.min(ATTACH_BUDGET_TOTAL - att_used));
                att_used += capped.len();
                attachment_sections.push(format!(
                    "--- Attachment: {} ({}) ---\n{}",
                    row.filename, row.mime, capped
                ));
            }
            _ => attachment_sections.push(format!(
                "[Attachment: {} ({}, {} bytes) — content not extractable]",
                row.filename, row.mime, row.size
            )),
        }
    }

    // ---- final user message ----
    let mut user = String::new();
    if !per_message.is_empty() {
        user.push_str("## The email thread (oldest first)\n\n");
        user.push_str(&per_message.join("\n\n---\n\n"));
        user.push('\n');
    }
    if !attachment_sections.is_empty() {
        user.push_str("\n## Attachments\n\n");
        user.push_str(&attachment_sections.join("\n\n"));
        user.push('\n');
    }
    match &req.existing_text {
        Some(existing) if !existing.trim().is_empty() => {
            user.push_str("\n## Current draft (rewrite this)\n\n");
            user.push_str(&cap(existing, 12_000));
            user.push_str(&format!(
                "\n\n## Edit instruction\n\n{}\n\nRewrite the current draft applying the instruction. Output only the full revised body.",
                req.instruction
            ));
        }
        _ => {
            user.push_str(&format!("\n## Task\n\n{}\n", req.instruction));
        }
    }

    Ok(AssembledContext {
        system: cap(&system, TOTAL_BUDGET / 4),
        user_text: cap(&user, TOTAL_BUDGET),
        images,
    })
}

async fn fetch_bytes(
    http: &reqwest::Client,
    sessions: &tokio::sync::Mutex<std::collections::HashMap<String, GmailSession>>,
    account: Option<&str>,
    row: &AttachmentRow,
) -> Option<Vec<u8>> {
    let remote_id = row.remote_id.as_ref()?;
    if row.size > 8_000_000 {
        return None;
    }
    let mut guard = sessions.lock().await;
    let s = guard.get_mut(account?)?;
    s.get_attachment_bytes(http, &row.message_id, remote_id).await.ok()
}
