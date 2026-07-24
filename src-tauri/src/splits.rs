//! Split-inbox query language: a small Gmail-style boolean grammar
//! (`from:`/`to:`/`subject:`/`label:`, quoted phrases, AND/OR/parens) plus the
//! classifier that assigns every thread a home split at sync time. This is the
//! single matcher — the TS mirror in src/lib/split-query.ts exists only for
//! the browser-demo mock backend, and both are held together by the shared
//! conformance fixtures in fixtures/split-query-cases.json.

use crate::types::{Split, SplitRule};

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Or(Vec<Node>),
    And(Vec<Node>),
    Term { field: Field, value: String },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Field {
    From,
    To,
    Subject,
    Label,
    /// Bare term with no operator — subject or any person on the thread.
    Any,
}

// ---------------------------------------------------------------- tokenize

#[derive(Debug, PartialEq)]
enum Tok {
    L,
    R,
    Word(String),
}

/// Whitespace splits, quotes glue (kept in the word so the parser can tell a
/// quoted value from an operator), parens are their own tokens even when
/// hugging a word.
fn tokenize(q: &str) -> Result<Vec<Tok>, String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_q = false;
    for c in q.chars() {
        match c {
            '"' => {
                in_q = !in_q;
                cur.push('"');
            }
            '(' | ')' if !in_q => {
                if !cur.is_empty() {
                    out.push(Tok::Word(std::mem::take(&mut cur)));
                }
                out.push(if c == '(' { Tok::L } else { Tok::R });
            }
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() {
                    out.push(Tok::Word(std::mem::take(&mut cur)));
                }
            }
            c => cur.push(c),
        }
    }
    if in_q {
        return Err("unclosed quote".into());
    }
    if !cur.is_empty() {
        out.push(Tok::Word(cur));
    }
    Ok(out)
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').trim().to_string()
}

// ------------------------------------------------------------------ parse

/// Parse a split definition. `Ok(None)` = empty query = the catch-all.
pub fn parse(q: &str) -> Result<Option<Node>, String> {
    let toks = tokenize(q)?;
    if toks.is_empty() {
        return Ok(None);
    }
    let mut pos = 0;
    let node = parse_or(&toks, &mut pos)?;
    if pos != toks.len() {
        return Err("unexpected ')' — check your parentheses".into());
    }
    Ok(Some(node))
}

fn is_kw(t: Option<&Tok>, kw: &str) -> bool {
    matches!(t, Some(Tok::Word(w)) if w.eq_ignore_ascii_case(kw))
}

fn parse_or(toks: &[Tok], pos: &mut usize) -> Result<Node, String> {
    let mut nodes = vec![parse_and(toks, pos)?];
    while is_kw(toks.get(*pos), "or") {
        *pos += 1;
        nodes.push(parse_and(toks, pos)?);
    }
    Ok(if nodes.len() == 1 { nodes.pop().unwrap() } else { Node::Or(nodes) })
}

fn parse_and(toks: &[Tok], pos: &mut usize) -> Result<Node, String> {
    let mut nodes = vec![parse_primary(toks, pos)?];
    loop {
        match toks.get(*pos) {
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("and") => {
                *pos += 1;
                nodes.push(parse_primary(toks, pos)?);
            }
            // adjacency = AND, Gmail-style: `from:acme.com subject:board`
            Some(Tok::Word(w)) if !w.eq_ignore_ascii_case("or") => {
                nodes.push(parse_primary(toks, pos)?);
            }
            Some(Tok::L) => {
                nodes.push(parse_primary(toks, pos)?);
            }
            _ => break,
        }
    }
    Ok(if nodes.len() == 1 { nodes.pop().unwrap() } else { Node::And(nodes) })
}

fn parse_primary(toks: &[Tok], pos: &mut usize) -> Result<Node, String> {
    match toks.get(*pos) {
        Some(Tok::L) => {
            *pos += 1;
            let node = parse_or(toks, pos)?;
            match toks.get(*pos) {
                Some(Tok::R) => {
                    *pos += 1;
                    Ok(node)
                }
                _ => Err("missing ')'".into()),
            }
        }
        Some(Tok::Word(w)) => {
            *pos += 1;
            term(w)
        }
        _ => Err("incomplete query — a term is missing".into()),
    }
}

fn term(word: &str) -> Result<Node, String> {
    // Operator detection runs on the raw word so `"re: hello"` (quoted) stays
    // a bare term while `from:x` splits. AND/OR arriving here means a trailing
    // operator — parse_primary consumed it as a term-to-be.
    if word.eq_ignore_ascii_case("and") || word.eq_ignore_ascii_case("or") {
        return Err(format!("'{word}' needs something on both sides"));
    }
    if !word.starts_with('"') {
        if let Some((op, rest)) = word.split_once(':') {
            if !op.is_empty() && op.chars().all(|c| c.is_ascii_alphabetic()) {
                let field = match op.to_ascii_lowercase().as_str() {
                    "from" => Some(Field::From),
                    "to" => Some(Field::To),
                    "subject" => Some(Field::Subject),
                    "label" => Some(Field::Label),
                    _ => None,
                };
                let Some(field) = field else {
                    return Err(format!(
                        "unsupported operator '{op}:' — splits understand from:, to:, subject:, label:"
                    ));
                };
                let value = unquote(rest).to_lowercase();
                if value.is_empty() {
                    return Err(format!("'{op}:' needs a value"));
                }
                return Ok(Node::Term { field, value });
            }
        }
    }
    let value = unquote(word).to_lowercase();
    if value.is_empty() {
        return Err("empty term".into());
    }
    Ok(Node::Term { field: Field::Any, value })
}

// ------------------------------------------------------------------ match

/// Everything the matcher looks at. Senders/recipients are participant
/// strings — `Name <email>` or a bare address.
pub struct Facts<'a> {
    pub senders: &'a [String],
    pub recipients: &'a [String],
    pub subject: &'a str,
    pub labels: &'a [String],
}

fn split_participant(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if let (Some(i), true) = (raw.find('<'), raw.ends_with('>')) {
        let name = raw[..i].trim().to_lowercase();
        let email = raw[i + 1..raw.len() - 1].trim().to_lowercase();
        (name, email)
    } else {
        (String::new(), raw.to_lowercase())
    }
}

/// Needle semantics (the fix for `from:thriftytraveler.com` matching nothing):
/// contains '@' → exact address; contains '.' → the ADDRESS domain equals it
/// or is a subdomain of it (display names never satisfy a domain needle);
/// bare word → substring of the address or the display name.
fn person_matches(raw: &str, needle: &str) -> bool {
    let (name, email) = split_participant(raw);
    if needle.contains('@') {
        email == needle
    } else if needle.contains('.') {
        match email.split_once('@') {
            Some((_, dom)) => dom == needle || dom.ends_with(&format!(".{needle}")),
            None => false,
        }
    } else {
        email.contains(needle) || name.contains(needle)
    }
}

fn ci_contains(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(needle)
}

pub fn matches(node: &Node, f: &Facts) -> bool {
    match node {
        Node::Or(ns) => ns.iter().any(|n| matches(n, f)),
        Node::And(ns) => ns.iter().all(|n| matches(n, f)),
        Node::Term { field, value } => match field {
            Field::From => f.senders.iter().any(|p| person_matches(p, value)),
            Field::To => f.recipients.iter().any(|p| person_matches(p, value)),
            Field::Subject => ci_contains(f.subject, value),
            // substring, not exact: keeps legacy `contains` semantics and lets
            // `label:promotions` reach CATEGORY_PROMOTIONS.
            Field::Label => f.labels.iter().any(|l| ci_contains(l, value)),
            Field::Any => {
                ci_contains(f.subject, value)
                    || f.senders.iter().any(|p| ci_contains(p, value))
                    || f.recipients.iter().any(|p| ci_contains(p, value))
            }
        },
    }
}

// --------------------------------------------------------------- classify

/// One split compiled for classification. A split whose saved query no longer
/// parses (shouldn't happen — save validates) compiles to never-matching
/// rather than poisoning classification.
pub struct SplitSpec {
    pub id: String,
    pub node: Option<Node>,
    pub also_show: bool,
    pub catch_all: bool,
}

/// Splits visible to `account`, in settings order, parsed once.
pub fn compile(splits: &[Split], account: &str) -> Vec<SplitSpec> {
    splits
        .iter()
        .filter(|s| s.account_id.as_deref().map_or(true, |a| a == account))
        .map(|s| {
            let trimmed = s.query.trim();
            let (node, catch_all) = if trimmed.is_empty() {
                (None, true)
            } else {
                match parse(trimmed) {
                    Ok(n) => (n, false),
                    Err(_) => (None, false), // unparseable → never matches
                }
            };
            SplitSpec { id: s.id.clone(), node, also_show: s.also_show, catch_all }
        })
        .collect()
}

/// First matching split (settings order) is home; the catch-all takes the
/// rest. A home split with `also_show` additionally surfaces the thread where
/// it would otherwise have landed — the next matching split, else the
/// catch-all (with default ordering that is Important-or-Other, Superhuman's
/// semantics).
pub fn classify(specs: &[SplitSpec], f: &Facts) -> (String, Vec<String>) {
    let catch_all =
        || specs.iter().find(|s| s.catch_all).map(|s| s.id.clone()).unwrap_or_else(|| "other".into());
    for (i, s) in specs.iter().enumerate() {
        let Some(node) = &s.node else { continue };
        if matches(node, f) {
            let mut also = vec![];
            if s.also_show {
                let target = specs[i + 1..]
                    .iter()
                    .find(|x| x.node.as_ref().is_some_and(|n| matches(n, f)))
                    .map(|x| x.id.clone())
                    .unwrap_or_else(catch_all);
                if target != s.id {
                    also.push(target);
                }
            }
            return (s.id.clone(), also);
        }
    }
    (catch_all(), vec![])
}

// -------------------------------------------------------------- migration

/// v0.23: the old structured rules become a query string. Unknown legacy
/// fields fall back to `from` (the old Rust matcher's own fallback).
pub fn query_from_rules(rules: &[SplitRule], op: &str) -> String {
    let joiner = if op == "and" { " AND " } else { " OR " };
    rules
        .iter()
        .filter(|r| !r.contains.trim().is_empty())
        .map(|r| {
            let field = match r.field.as_str() {
                "to" | "subject" | "label" => r.field.as_str(),
                _ => "from",
            };
            let v = r.contains.trim().replace('"', "");
            if v.chars().any(|c| c.is_whitespace()) {
                format!("{field}:\"{v}\"")
            } else {
                format!("{field}:{v}")
            }
        })
        .collect::<Vec<_>>()
        .join(joiner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(id: &str, query: &str, account_id: Option<&str>, also_show: bool) -> Split {
        Split {
            id: id.into(),
            name: id.into(),
            builtin: id == "important" || id == "other",
            query: query.into(),
            account_id: account_id.map(|s| s.to_string()),
            also_show,
            hide_when_empty: false,
            rules: vec![],
            op: "or".into(),
        }
    }

    fn facts<'a>(
        senders: &'a [String],
        recipients: &'a [String],
        subject: &'a str,
        labels: &'a [String],
    ) -> Facts<'a> {
        Facts { senders, recipients, subject, labels }
    }

    // ---- shared conformance fixtures (also run by src/lib/split-query.test.ts)

    #[derive(serde::Deserialize)]
    struct FixThread {
        id: String,
        subject: String,
        participants: Vec<String>,
        recipients: Vec<String>,
        labels: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    struct FixCase {
        name: String,
        query: String,
        #[serde(default)]
        matches: Vec<String>,
        #[serde(default)]
        error: bool,
    }
    #[derive(serde::Deserialize)]
    struct Fixtures {
        threads: Vec<FixThread>,
        cases: Vec<FixCase>,
    }

    #[test]
    fn conformance_fixtures() {
        let fx: Fixtures =
            serde_json::from_str(include_str!("../../fixtures/split-query-cases.json")).unwrap();
        for case in &fx.cases {
            let parsed = parse(&case.query);
            if case.error {
                assert!(parsed.is_err(), "case '{}' should fail to parse", case.name);
                continue;
            }
            let node = parsed
                .unwrap_or_else(|e| panic!("case '{}' failed to parse: {e}", case.name))
                .expect("non-empty query");
            let mut got: Vec<&str> = fx
                .threads
                .iter()
                .filter(|t| {
                    matches(
                        &node,
                        &facts(&t.participants, &t.recipients, &t.subject, &t.labels),
                    )
                })
                .map(|t| t.id.as_str())
                .collect();
            let mut want: Vec<&str> = case.matches.iter().map(|s| s.as_str()).collect();
            got.sort();
            want.sort();
            assert_eq!(got, want, "case '{}' (query: {})", case.name, case.query);
        }
    }

    // ---- classification

    #[test]
    fn first_match_wins_and_catch_all_takes_the_rest() {
        let splits = vec![
            split("travel", "from:thriftytraveler.com", None, false),
            split("important", "label:IMPORTANT", None, false),
            split("other", "", None, false),
        ];
        let specs = compile(&splits, "a@b.com");
        let senders = vec!["Thrifty Traveler <deals@thriftytraveler.com>".to_string()];
        let labels = vec!["IMPORTANT".to_string()];
        // matches travel AND important — travel is first, so travel is home
        let (home, also) = classify(&specs, &facts(&senders, &[], "sale", &labels));
        assert_eq!(home, "travel");
        assert!(also.is_empty());
        // matches nothing → catch-all
        let plain = vec!["Bob <bob@plain.io>".to_string()];
        let (home, _) = classify(&specs, &facts(&plain, &[], "hi", &[]));
        assert_eq!(home, "other");
    }

    #[test]
    fn also_show_surfaces_where_it_would_otherwise_land() {
        let splits = vec![
            split("travel", "from:thriftytraveler.com", None, true),
            split("important", "label:IMPORTANT", None, false),
            split("other", "", None, false),
        ];
        let specs = compile(&splits, "a@b.com");
        let senders = vec!["Thrifty Traveler <deals@thriftytraveler.com>".to_string()];
        // IMPORTANT-labeled → also shows in important
        let labels = vec!["IMPORTANT".to_string()];
        let (home, also) = classify(&specs, &facts(&senders, &[], "sale", &labels));
        assert_eq!((home.as_str(), also), ("travel", vec!["important".to_string()]));
        // unlabeled → also shows in the catch-all
        let (home, also) = classify(&specs, &facts(&senders, &[], "sale", &[]));
        assert_eq!((home.as_str(), also), ("travel", vec!["other".to_string()]));
    }

    #[test]
    fn account_scoping_filters_splits() {
        let splits = vec![
            split("work", "from:acme.com", Some("work@x.com"), false),
            split("other", "", None, false),
        ];
        let senders = vec!["Maya <maya@acme.com>".to_string()];
        let f = facts(&senders, &[], "hi", &[]);
        let (home, _) = classify(&compile(&splits, "work@x.com"), &f);
        assert_eq!(home, "work");
        // a different account never sees the scoped split
        let (home, _) = classify(&compile(&splits, "personal@x.com"), &f);
        assert_eq!(home, "other");
    }

    #[test]
    fn unparseable_saved_query_never_matches() {
        let splits = vec![
            split("broken", "has:attachment", None, false),
            split("other", "", None, false),
        ];
        let senders = vec!["A <a@b.com>".to_string()];
        let (home, _) = classify(&compile(&splits, "x@y.com"), &facts(&senders, &[], "s", &[]));
        assert_eq!(home, "other");
    }

    // ---- migration

    #[test]
    fn legacy_rules_become_a_query() {
        let rules = vec![
            SplitRule { field: "from".into(), contains: "acme.com".into() },
            SplitRule { field: "subject".into(), contains: "board deck".into() },
        ];
        assert_eq!(query_from_rules(&rules, "or"), "from:acme.com OR subject:\"board deck\"");
        assert_eq!(query_from_rules(&rules, "and"), "from:acme.com AND subject:\"board deck\"");
        // the old builtin Important
        let imp = vec![SplitRule { field: "label".into(), contains: "IMPORTANT".into() }];
        assert_eq!(query_from_rules(&imp, "or"), "label:IMPORTANT");
        // unknown field falls back to from (the old matcher's own fallback)
        let odd = vec![SplitRule { field: "weird".into(), contains: "x".into() }];
        assert_eq!(query_from_rules(&odd, "or"), "from:x");
        // migrated queries must round-trip through the parser
        assert!(parse(&query_from_rules(&rules, "or")).unwrap().is_some());
    }
}
