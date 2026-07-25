//! sqlite-vec plumbing: one embedding per message in `mail_vec` (vec0),
//! bookkept by the plain `vec_meta` table. Producers L2-normalize every
//! vector, so vec0's cosine distance ranks like similarity. Writes are
//! DELETE-then-INSERT: stable sqlite-vec (0.1.9) has no upsert.
use rusqlite::{params, Connection};

/// f32 slice → the little-endian blob sqlite-vec binds as a query/row vector.
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

pub fn insert(
    conn: &Connection,
    message_id: &str,
    thread_id: &str,
    account_id: &str,
    model: &str,
    embedding: &[f32],
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO vec_meta (message_id, thread_id, account_id, model) VALUES (?1,?2,?3,?4)
         ON CONFLICT(message_id) DO UPDATE SET model = excluded.model",
        params![message_id, thread_id, account_id, model],
    )
    .map_err(|e| e.to_string())?;
    let rowid: i64 = conn
        .query_row("SELECT vec_rowid FROM vec_meta WHERE message_id = ?1", params![message_id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM mail_vec WHERE rowid = ?1", params![rowid])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO mail_vec (rowid, embedding) VALUES (?1, ?2)",
        params![rowid, vec_to_blob(embedding)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bookkeeping-only row for a message deliberately not embedded (demo text
/// with no concept words) so `missing` stops offering it. Only the fixture
/// embedder ever skips, so this is demo-only.
#[cfg(feature = "demo-fixtures")]
pub fn mark_skipped(
    conn: &Connection,
    message_id: &str,
    thread_id: &str,
    account_id: &str,
    model: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO vec_meta (message_id, thread_id, account_id, model) VALUES (?1,?2,?3,?4)",
        params![message_id, thread_id, account_id, model],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Messages of `account_id` with no vec_meta row yet — newest first (recent
/// mail is what users search). Text is subject + body clipped to 2000 chars
/// (the model truncates at 512 tokens anyway; the clip keeps tokenization
/// cheap). Hidden (trash/spam) threads are skipped; un-hiding surfaces them
/// here again on a later beat.
pub fn missing(
    conn: &Connection,
    account_id: &str,
    limit: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.thread_id, substr(m.subject || char(10) || m.body_text, 1, 2000)
             FROM messages m
             JOIN threads t ON t.id = m.thread_id
             LEFT JOIN vec_meta vm ON vm.message_id = m.id
             WHERE t.account_id = ?1 AND t.hidden IS NULL AND vm.message_id IS NULL
             ORDER BY m.date DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn count_missing(conn: &Connection, account_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         LEFT JOIN vec_meta vm ON vm.message_id = m.id
         WHERE t.account_id = ?1 AND t.hidden IS NULL AND vm.message_id IS NULL",
        params![account_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Test-only assertion helper — no production caller since the demo embedder
/// moved behind the feature, but sync/store tests both read it.
#[allow(dead_code)]
pub fn count_embedded(conn: &Connection, account_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM vec_meta WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Drop a thread's vectors (thread deleted, or its bodies healed and it must
/// re-embed — the next beat's `missing` pass picks it back up).
pub fn delete_thread_vectors(conn: &Connection, thread_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM mail_vec WHERE rowid IN (SELECT vec_rowid FROM vec_meta WHERE thread_id = ?1)",
        params![thread_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM vec_meta WHERE thread_id = ?1", params![thread_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Message-level KNN over-fetch: threads have several messages, other
/// accounts' rows are filtered after the scan, and narrowing (dates/people)
/// trims further — so ask vec0 for far more than the thread limit.
const KNN_K: usize = 240;

/// Nearest threads to `qvec` for this account, best (smallest cosine
/// distance over any message) first, honoring the plan's date window and
/// people narrowing exactly like the lexical leg. Only the ORDER matters to
/// the RRF fusion downstream, so plain SearchResults come back.
pub fn knn_threads(
    conn: &Connection,
    qvec: &[f32],
    account_id: &str,
    plan: &crate::search::SearchPlan,
    limit: usize,
) -> Result<Vec<crate::types::SearchResult>, String> {
    use rusqlite::types::Value;
    let mut sql = String::from(
        "SELECT vm.thread_id, t.subject, t.snippet, t.last_date, MIN(v.distance) AS d
         FROM (SELECT rowid, distance FROM mail_vec WHERE embedding MATCH ? AND k = ?) v
         JOIN vec_meta vm ON vm.vec_rowid = v.rowid
         JOIN threads t ON t.id = vm.thread_id
         WHERE vm.account_id = ? AND t.hidden IS NULL",
    );
    let mut params_v: Vec<Value> = vec![
        Value::Blob(vec_to_blob(qvec)),
        Value::Integer(KNN_K as i64),
        Value::Text(account_id.to_string()),
    ];
    if let Some(ms) = plan.after {
        sql.push_str(" AND t.last_date >= ?");
        params_v.push(Value::Integer(ms));
    }
    if let Some(ms) = plan.before {
        sql.push_str(" AND t.last_date < ?");
        params_v.push(Value::Integer(ms));
    }
    for p in &plan.people {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
               AND (m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\'
                    OR m.to_addrs LIKE ? ESCAPE '\\' OR m.cc_addrs LIKE ? ESCAPE '\\'))",
        );
        let pat = super::like_pattern(p);
        for _ in 0..4 {
            params_v.push(Value::Text(pat.clone()));
        }
    }
    sql.push_str(" GROUP BY vm.thread_id ORDER BY d ASC LIMIT ?");
    params_v.push(Value::Integer(limit as i64));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_v), |r| {
            Ok(crate::types::SearchResult {
                thread_id: r.get(0)?,
                subject: r.get(1)?,
                snippet: r.get(2)?,
                last_date: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// mail_vec rows are only comparable to queries embedded by the SAME model.
/// On a tag change (local↔remote flip, model bump) wipe every non-demo
/// vector so the backfill rebuilds; demo fixtures keep their hand vectors.
/// Returns true when a wipe happened.
pub fn ensure_model_tag(conn: &Connection, tag: &str) -> Result<bool, String> {
    let current: Option<String> = super::get_json(conn, "embed_model");
    if current.as_deref() == Some(tag) {
        return Ok(false);
    }
    conn.execute(
        "DELETE FROM mail_vec WHERE rowid IN (SELECT vec_rowid FROM vec_meta WHERE model <> 'demo')",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM vec_meta WHERE model <> 'demo'", [])
        .map_err(|e| e.to_string())?;
    super::set_json(conn, "embed_model", &tag.to_string())?;
    Ok(true)
}
