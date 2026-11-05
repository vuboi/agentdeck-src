//! What the Preview agent learned about the pages of a site, kept in the project it works on:
//! `<project>/.agentdeck/ui-memory/memory.db` (SQLite, plan storage-sqlite P2). Every project has its own memory and
//! nothing is kept in AgentDeck's own folders, so a new session in the project finds controls through `browser_recall`
//! instead of a screenshot or a scan.
//!
//! A dev server on `localhost` (any port) is the site `local` of its project. Elements seen by `browser_elements` and
//! `browser_find` are stored on the way; `browser_remember` keeps the steps that reached a goal. The JSON files of the
//! first version (`<site>.json`) are imported once and renamed `*.json.imported`.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use ag_adapters::codec;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

const DIR: &str = ".agentdeck/ui-memory";
const FILE: &str = "memory.db";
/// Per site.
const MAX_ELEMENTS: i64 = 1500;
/// Per site.
const MAX_RECIPES: i64 = 200;
const MAX_STEPS: usize = 40;
/// Elements kept from one scan of a page.
const MAX_SEEN: usize = 200;
/// Candidates read from the word index for one query.
const MAX_CANDIDATES: usize = 400;
const WEEK_MS: i64 = 7 * 24 * 3600 * 1000;
const STOP: [&str; 21] = [
    "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "at", "it", "be", "by",
    "va", "la", "cua", "cho", "cac", "mot",
];

const SCHEMA_1: &str = "
CREATE TABLE elements (
    id INTEGER PRIMARY KEY,
    site TEXT NOT NULL,
    path_key TEXT NOT NULL,
    selector TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1,
    ok INTEGER NOT NULL DEFAULT 0,
    fail INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL,
    last_ok INTEGER NOT NULL DEFAULT 0,
    UNIQUE (site, path_key, selector)
);
CREATE INDEX elements_site_seen ON elements (site, last_seen);
CREATE TABLE element_words (
    word TEXT NOT NULL,
    site TEXT NOT NULL,
    element_id INTEGER NOT NULL REFERENCES elements (id) ON DELETE CASCADE,
    PRIMARY KEY (site, word, element_id)
) WITHOUT ROWID;
CREATE INDEX element_words_id ON element_words (element_id);
CREATE TABLE recipes (
    id INTEGER PRIMARY KEY,
    site TEXT NOT NULL,
    goal_key TEXT NOT NULL,
    goal TEXT NOT NULL,
    steps BLOB NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1,
    ok INTEGER NOT NULL DEFAULT 0,
    fail INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL,
    UNIQUE (site, goal_key)
);
CREATE TABLE recipe_words (
    word TEXT NOT NULL,
    site TEXT NOT NULL,
    recipe_id INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    PRIMARY KEY (site, word, recipe_id)
) WITHOUT ROWID;
CREATE INDEX recipe_words_id ON recipe_words (recipe_id);
";

const MIGRATIONS: &[&str] = &[SCHEMA_1];

/// Serialises the read-modify-write of the database: two agents of one project must not lose each other's rows.
static LOCK: Mutex<()> = Mutex::new(());

/// One thing that can be clicked or filled in on a page, as the agent found it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct PageElement {
    /// CSS selector that found it, the steadiest one the page offered (an id, a test id, an aria-label…).
    pub selector: String,
    /// What it shows or is called: the text, label or placeholder.
    pub name: String,
    /// `button`, `a`, `input[text]`, `div(tab)`…
    pub kind: String,
}

/// A stored element, as scoring reads it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Element {
    pub selector: String,
    pub name: String,
    pub kind: String,
    /// The page it was seen on, ids turned into `:id` (`/orders/:id/edit`).
    pub path_key: String,
    pub seen: i64,
    /// Actions on it that worked, and that failed (the selector no longer matched).
    pub ok: i64,
    pub fail: i64,
    pub last_seen: i64,
    pub last_ok: i64,
}

/// Steps that worked for a goal, as scoring reads them.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Recipe {
    pub goal: String,
    pub steps: Vec<String>,
    pub seen: i64,
    pub ok: i64,
    pub fail: i64,
    pub last_used: i64,
}

/// The first version's file, `<site>.json`: read only to import it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LegacySite {
    site: String,
    elements: Vec<Element>,
    recipes: Vec<Recipe>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

/// The host and path of an http(s) address, without user info, port, query or fragment.
fn host_and_path(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .map_or(authority, |close| &authority[..=close])
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    let tail = &rest[end..];
    let path = tail
        .split(['?', '#'])
        .next()
        .filter(|path| !path.is_empty())
        .unwrap_or("/");
    Some((host.to_ascii_lowercase(), path.to_string()))
}

/// The site a page belongs to within its project: `local` for a dev server on this computer (its port changes from one
/// run to the next), otherwise the host without `www.`. `None` for what is not a web page.
pub fn site_key(url: &str) -> Option<String> {
    let (host, _) = host_and_path(url)?;
    if host.is_empty() {
        return None;
    }
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") || host.ends_with(".localhost")
    {
        return Some("local".into());
    }
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let safe: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe = safe.trim_matches(['.', '-']).to_string();
    (!safe.is_empty() && safe.len() <= 100).then_some(safe)
}

fn percent_decoded(part: &str) -> String {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_hex(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && is_hex(part))
}

/// The page's path with what changes from one record to the next turned into `:id`: numbers, UUIDs, long hex or mixed
/// ids.
pub fn path_key(url: &str) -> String {
    let Some((_, path)) = host_and_path(url) else {
        return "/".into();
    };
    let parts: Vec<String> = path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let decoded = percent_decoded(part);
            let id = decoded.chars().all(|c| c.is_ascii_digit())
                || is_uuid(&decoded)
                || (decoded.len() >= 16 && is_hex(&decoded))
                || (decoded.chars().count() >= 10
                    && decoded.chars().any(|c| c.is_ascii_digit())
                    && decoded.chars().any(|c| c.is_ascii_alphabetic())
                    && !decoded.contains(['-', '_', ' ']));
            if id {
                ":id".to_string()
            } else {
                decoded.to_lowercase()
            }
        })
        .collect();
    format!("/{}", parts.join("/"))
}

/// Lower case, accents off, split on anything that is not a letter or digit; short and filler words dropped; at most 12.
pub fn words(text: &str) -> Vec<String> {
    let plain: String = text
        .nfd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .map(|c| if matches!(c, 'đ' | 'Đ') { 'd' } else { c })
        .flat_map(char::to_lowercase)
        .collect();
    let mut out: Vec<String> = Vec::new();
    for word in plain.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())) {
        if word.len() < 2 || STOP.contains(&word) || out.iter().any(|seen| seen == word) {
            continue;
        }
        out.push(word.to_string());
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// Failed more often than it worked, at least three times: no longer offered.
fn broken(ok: i64, fail: i64) -> bool {
    fail >= 3 && fail > ok
}

/// The words an element is found by: its name and its kind (letters only).
fn element_words(name: &str, kind: &str) -> Vec<String> {
    let kind: String = kind
        .chars()
        .map(|c| if c.is_ascii_alphabetic() { c } else { ' ' })
        .collect();
    words(&format!("{name} {kind}"))
}

/// How well a stored element answers a query: every query word it has counts, a word at the start of its name more,
/// the page the agent is on more, and what was seen and worked often a little more. 0 means it does not answer.
pub fn score_element(element: &Element, query: &[String], path_key: Option<&str>) -> f64 {
    if query.is_empty() || broken(element.ok, element.fail) {
        return 0.0;
    }
    let own = element_words(&element.name, &element.kind);
    let name = element.name.to_lowercase();
    let mut score = 0.0;
    let mut hits = 0;
    for word in query {
        if !own.contains(word) {
            continue;
        }
        hits += 1;
        score += if name.starts_with(word.as_str()) {
            3.0
        } else {
            2.0
        };
    }
    if hits == 0 {
        return 0.0;
    }
    if hits == query.len() {
        score += 4.0;
    }
    if path_key.is_some_and(|key| key == element.path_key) {
        score += 3.0;
    }
    score + (((element.seen + 1) as f64).log2() / 2.0).min(2.0) + (element.ok as f64 * 0.5).min(2.0)
}

pub fn score_recipe(recipe: &Recipe, query: &[String]) -> f64 {
    if recipe.fail > recipe.ok {
        return 0.0;
    }
    let own = words(&recipe.goal);
    let hits = query.iter().filter(|word| own.contains(word)).count();
    if hits == 0 {
        return 0.0;
    }
    hits as f64 * 2.0
        + if hits == query.len() { 4.0 } else { 0.0 }
        + (((recipe.seen + 1) as f64).log2() / 2.0).min(2.0)
}

/// The project's memory database, created with its own `.gitignore` (so the memory stays out of the project's git,
/// and the project's root `.gitignore` is never edited). Old JSON files of the site are imported once.
fn open(root: &Path) -> Result<Connection, String> {
    if !root.is_dir() {
        return Err("the project folder does not exist".into());
    }
    let folder = root.join(DIR);
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let ignore = folder.join(".gitignore");
    if !ignore.exists() {
        crate::plans::atomic_write(
            &ignore,
            "# AgentDeck's memory of the Preview pages of this project.\n*\n",
        )?;
    }
    // Journal `DELETE`: no `-wal`/`-shm` files appear in the project folder.
    let mut conn = crate::sqlite::open(
        &folder.join(FILE),
        crate::sqlite::Journal::Delete,
        MIGRATIONS,
    )?;
    import_legacy(&mut conn, &folder)?;
    Ok(conn)
}

/// Imports `<site>.json` files of the first version, once each: a file that does not parse is left as it is.
fn import_legacy(conn: &mut Connection, folder: &Path) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(legacy) = serde_json::from_str::<LegacySite>(&text) else {
            continue;
        };
        let site = if legacy.site.is_empty() {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_string()
        } else {
            legacy.site.clone()
        };
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        for element in &legacy.elements {
            let path_key = if element.path_key.is_empty() {
                "/".to_string()
            } else {
                element.path_key.clone()
            };
            insert_element(&tx, &site, &path_key, element)?;
        }
        for recipe in &legacy.recipes {
            insert_recipe(
                &tx,
                &site,
                &recipe.goal,
                &recipe.steps,
                recipe.seen,
                recipe.ok,
                recipe.fail,
                recipe.last_used,
            )?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        let _ = std::fs::rename(&path, path.with_extension("json.imported"));
    }
    Ok(())
}

fn insert_element(
    tx: &rusqlite::Transaction,
    site: &str,
    path_key: &str,
    element: &Element,
) -> Result<(), String> {
    let added = tx
        .execute(
            "INSERT INTO elements (site, path_key, selector, name, kind, seen, ok, fail, last_seen, last_ok)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (site, path_key, selector) DO NOTHING",
            params![
                site,
                path_key,
                element.selector,
                element.name,
                element.kind,
                element.seen.max(1),
                element.ok,
                element.fail,
                element.last_seen,
                element.last_ok,
            ],
        )
        .map_err(|error| error.to_string())?;
    if added == 1 {
        let id = tx.last_insert_rowid();
        insert_words(tx, site, id, &element.name, &element.kind)?;
    }
    Ok(())
}

fn insert_words(
    tx: &rusqlite::Transaction,
    site: &str,
    element_id: i64,
    name: &str,
    kind: &str,
) -> Result<(), String> {
    for word in element_words(name, kind) {
        tx.execute(
            "INSERT OR IGNORE INTO element_words (word, site, element_id) VALUES (?1, ?2, ?3)",
            params![word, site, element_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_recipe(
    tx: &rusqlite::Transaction,
    site: &str,
    goal: &str,
    steps: &[String],
    seen: i64,
    ok: i64,
    fail: i64,
    last_used: i64,
) -> Result<(), String> {
    let goal = goal.trim();
    let goal_key = goal.to_lowercase();
    let blob = codec::encode_keep(&steps.to_vec())?;
    tx.execute(
        "INSERT INTO recipes (site, goal_key, goal, steps, seen, ok, fail, last_used)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (site, goal_key) DO UPDATE SET
            goal = excluded.goal, steps = excluded.steps, seen = recipes.seen + 1, last_used = excluded.last_used",
        params![site, goal_key, goal, blob, seen.max(1), ok, fail, last_used.max(now_ms())],
    )
    .map_err(|error| error.to_string())?;
    let id: i64 = tx
        .query_row(
            "SELECT id FROM recipes WHERE site = ?1 AND goal_key = ?2",
            params![site, goal_key],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM recipe_words WHERE recipe_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    for word in words(goal) {
        tx.execute(
            "INSERT OR IGNORE INTO recipe_words (word, site, recipe_id) VALUES (?1, ?2, ?3)",
            params![word, site, id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Forgets what is broken for a week, then the least proven and oldest beyond the limit of the site.
fn prune_site(tx: &rusqlite::Transaction, site: &str, now: i64) -> Result<(), String> {
    let err = |error: rusqlite::Error| error.to_string();
    tx.execute(
        "DELETE FROM elements WHERE site = ?1 AND fail >= 3 AND fail > ok AND last_seen < ?2",
        params![site, now - WEEK_MS],
    )
    .map_err(err)?;
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM elements WHERE site = ?1",
            [site],
            |row| row.get(0),
        )
        .map_err(err)?;
    if count > MAX_ELEMENTS {
        // Unproven elements go first (false sorts before true), then the oldest.
        tx.execute(
            "DELETE FROM elements WHERE id IN (
                SELECT id FROM elements WHERE site = ?1
                ORDER BY (ok >= 3 AND NOT (fail >= 3 AND fail > ok)) ASC, last_seen ASC
                LIMIT ?2)",
            params![site, count - MAX_ELEMENTS],
        )
        .map_err(err)?;
    }
    let recipes: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM recipes WHERE site = ?1",
            [site],
            |row| row.get(0),
        )
        .map_err(err)?;
    if recipes > MAX_RECIPES {
        tx.execute(
            "DELETE FROM recipes WHERE id IN (
                SELECT id FROM recipes WHERE site = ?1
                ORDER BY (fail <= ok) ASC, last_used ASC
                LIMIT ?2)",
            params![site, recipes - MAX_RECIPES],
        )
        .map_err(err)?;
    }
    Ok(())
}

/// Keeps the elements seen on one page; one already known is seen once more.
pub fn remember_elements(
    root: &Path,
    url: &str,
    elements: &[PageElement],
) -> Result<usize, String> {
    let Some(site) = site_key(url) else {
        return Ok(0);
    };
    let page = path_key(url);
    let _guard = LOCK.lock().map_err(|_| "ui memory is busy")?;
    let mut conn = open(root)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let now = now_ms();
    let mut kept = 0;
    for element in elements.iter().take(MAX_SEEN) {
        if element.selector.trim().is_empty() {
            continue;
        }
        kept += 1;
        let known: Option<(i64, String, String)> = tx
            .query_row(
                "SELECT id, name, kind FROM elements WHERE site = ?1 AND path_key = ?2 AND selector = ?3",
                params![site, page, element.selector],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        match known {
            Some((id, name, kind)) => {
                tx.execute(
                    "UPDATE elements SET seen = seen + 1, last_seen = ?1, name = ?2, kind = ?3 WHERE id = ?4",
                    params![now, element.name, element.kind, id],
                )
                .map_err(|error| error.to_string())?;
                if name != element.name || kind != element.kind {
                    tx.execute("DELETE FROM element_words WHERE element_id = ?1", [id])
                        .map_err(|error| error.to_string())?;
                    insert_words(&tx, &site, id, &element.name, &element.kind)?;
                }
            }
            None => {
                let fresh = Element {
                    selector: element.selector.clone(),
                    name: element.name.clone(),
                    kind: element.kind.clone(),
                    path_key: page.clone(),
                    seen: 1,
                    last_seen: now,
                    ..Default::default()
                };
                insert_element(&tx, &site, &page, &fresh)?;
            }
        }
    }
    if kept > 0 {
        prune_site(&tx, &site, now)?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(kept)
}

/// Keeps the steps that worked for a goal on a site; the same goal again replaces its steps and is seen once more.
pub fn remember_recipe(
    root: &Path,
    url: &str,
    goal: &str,
    steps: &[String],
) -> Result<bool, String> {
    let Some(site) = site_key(url) else {
        return Ok(false);
    };
    let goal = goal.trim();
    let steps: Vec<String> = steps
        .iter()
        .map(|step| step.trim().to_string())
        .filter(|step| !step.is_empty())
        .take(MAX_STEPS)
        .collect();
    if goal.is_empty() || steps.is_empty() {
        return Ok(false);
    }
    let _guard = LOCK.lock().map_err(|_| "ui memory is busy")?;
    let mut conn = open(root)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    insert_recipe(&tx, &site, goal, &steps, 1, 0, 0, now_ms())?;
    prune_site(&tx, &site, now_ms())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

/// Candidate ids that share a word of the query with the site, read from the word index.
fn candidates(
    conn: &Connection,
    table: &str,
    site: &str,
    words: &[String],
    limit: usize,
) -> Result<Vec<i64>, String> {
    let marks = vec!["?"; words.len()].join(", ");
    let sql = format!(
        "SELECT DISTINCT {id} FROM {table} WHERE site = ?1 AND word IN ({marks}) LIMIT {limit}",
        id = if table == "element_words" {
            "element_id"
        } else {
            "recipe_id"
        },
    );
    let mut values: Vec<String> = vec![site.to_string()];
    values.extend(words.iter().cloned());
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// The elements and recipes of the site of `url` that best answer `query` (the current page's own first), in the shape
/// `page_memory::format_recall` reads.
pub fn recall(root: &Path, url: &str, query: &str, limit: usize) -> Result<Value, String> {
    let site = site_key(url).unwrap_or_default();
    let query_words = words(query);
    if site.is_empty() || query_words.is_empty() {
        return Ok(json!({ "site": site, "query": query, "hits": [], "recipes": [] }));
    }
    let _guard = LOCK.lock().map_err(|_| "ui memory is busy")?;
    let conn = open(root)?;
    let page = path_key(url);
    let err = |error: rusqlite::Error| error.to_string();

    let mut hits: Vec<(f64, Element)> = Vec::new();
    for id in candidates(&conn, "element_words", &site, &query_words, MAX_CANDIDATES)? {
        let element = conn
            .query_row(
                "SELECT selector, name, kind, path_key, seen, ok, fail, last_seen, last_ok FROM elements WHERE id = ?1",
                [id],
                |row| {
                    Ok(Element {
                        selector: row.get(0)?,
                        name: row.get(1)?,
                        kind: row.get(2)?,
                        path_key: row.get(3)?,
                        seen: row.get(4)?,
                        ok: row.get(5)?,
                        fail: row.get(6)?,
                        last_seen: row.get(7)?,
                        last_ok: row.get(8)?,
                    })
                },
            )
            .map_err(err)?;
        let score = score_element(&element, &query_words, Some(&page));
        if score > 0.0 {
            hits.push((score, element));
        }
    }
    hits.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut recipes: Vec<(f64, Recipe)> = Vec::new();
    for id in candidates(&conn, "recipe_words", &site, &query_words, 100)? {
        let (goal, blob, seen, ok, fail, last_used): (String, Vec<u8>, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT goal, steps, seen, ok, fail, last_used FROM recipes WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .map_err(err)?;
        let steps: Vec<String> = codec::decode(&blob)?;
        let recipe = Recipe {
            goal,
            steps,
            seen,
            ok,
            fail,
            last_used,
        };
        let score = score_recipe(&recipe, &query_words);
        if score > 0.0 {
            recipes.push((score, recipe));
        }
    }
    recipes.sort_by(|a, b| b.0.total_cmp(&a.0));

    Ok(json!({
        "site": site,
        "query": query,
        "hits": hits.iter().take(limit).map(|(_, element)| json!({
            "selector": element.selector,
            "name": element.name,
            "kind": element.kind,
            "seen": element.seen,
            "pathKey": element.path_key,
        })).collect::<Vec<_>>(),
        "recipes": recipes.iter().take(3).map(|(_, recipe)| json!({
            "goal": recipe.goal,
            "steps": recipe.steps,
        })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn temp() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "agentdeck-ui-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }
    fn element(selector: &str, name: &str, kind: &str) -> PageElement {
        PageElement {
            selector: selector.into(),
            name: name.into(),
            kind: kind.into(),
        }
    }
    fn stored(name: &str, kind: &str, path_key: &str) -> Element {
        Element {
            selector: format!("#{name}"),
            name: name.into(),
            kind: kind.into(),
            path_key: path_key.into(),
            seen: 1,
            ..Default::default()
        }
    }

    #[test]
    fn a_site_is_local_for_a_dev_server_and_the_host_otherwise() {
        assert_eq!(
            site_key("http://localhost:5173/x").as_deref(),
            Some("local")
        );
        assert_eq!(site_key("http://127.0.0.1:4301/").as_deref(), Some("local"));
        assert_eq!(site_key("http://[::1]:3000/").as_deref(), Some("local"));
        assert_eq!(site_key("http://app.localhost/").as_deref(), Some("local"));
        assert_eq!(
            site_key("https://www.GitHub.com/a?b#c").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            site_key("https://user:pw@shop.com:8443/").as_deref(),
            Some("shop.com")
        );
        assert_eq!(site_key("file:///C:/x.html"), None);
        assert_eq!(site_key("not a url"), None);
    }

    #[test]
    fn a_page_is_named_by_its_path_with_the_ids_taken_out() {
        assert_eq!(
            path_key("https://shop.com/orders/42/edit?tab=2"),
            "/orders/:id/edit"
        );
        assert_eq!(
            path_key("https://shop.com/u/550e8400-e29b-41d4-a716-446655440000/files"),
            "/u/:id/files"
        );
        assert_eq!(path_key("https://shop.com/p/a8f3k29xq1"), "/p/:id");
        assert_eq!(path_key("https://shop.com/h/0123456789abcdef0"), "/h/:id");
        assert_eq!(path_key("https://shop.com/Sign-In"), "/sign-in");
        assert_eq!(path_key("https://shop.com"), "/");
        assert_eq!(path_key("https://shop.com/T%C3%A0i"), "/tài");
    }

    #[test]
    fn words_ignore_case_accents_and_filler() {
        assert_eq!(
            words("Đăng nhập vào the Tài khoản"),
            vec!["dang", "nhap", "vao", "tai", "khoan"]
        );
        assert_eq!(words("Sign in, sign IN!"), vec!["sign"]);
        assert!(words("x").is_empty());
        assert_eq!(words("Xuất báo cáo"), vec!["xuat", "bao", "cao"]);
    }

    #[test]
    fn an_element_answers_the_words_it_has_the_page_it_is_on_first() {
        let login = stored("Sign in", "button", "/login");
        let signup = stored("Sign up free", "button", "/signup");
        let query = words("sign in");
        assert!(
            score_element(&login, &query, Some("/login"))
                > score_element(&signup, &query, Some("/login"))
        );
        assert_eq!(score_element(&signup, &words("checkout"), None), 0.0);
        let mut again = login.clone();
        again.seen = 2;
        assert!(score_element(&again, &query, None) > score_element(&login, &query, None));
        let mut worked = login.clone();
        worked.ok = 2;
        assert!(score_element(&worked, &query, None) > score_element(&login, &query, None));
        let mut failing = login.clone();
        failing.fail = 3;
        assert_eq!(score_element(&failing, &query, None), 0.0);
    }

    #[test]
    fn a_recipe_is_found_by_the_words_of_its_goal() {
        let recipe = Recipe {
            goal: "Export the sales report".into(),
            steps: vec!["open Reports".into(), "click Export".into()],
            seen: 1,
            ..Default::default()
        };
        assert!(score_recipe(&recipe, &words("export report")) > 0.0);
        assert_eq!(score_recipe(&recipe, &words("sign in")), 0.0);
    }

    #[test]
    fn elements_and_recipes_are_kept_in_the_project_and_recalled() {
        let root = temp();
        let url = "http://localhost:5173/reports/42";
        let seen = [
            element("button[aria-label=\"Export\"]", "Export", "button"),
            element("#search", "Search", "input[text]"),
            element("", "no selector", "div"),
        ];
        assert_eq!(remember_elements(&root, url, &seen).expect("store"), 2);
        assert_eq!(remember_elements(&root, url, &seen[..1]).expect("again"), 1);
        let folder = root.join(DIR);
        assert!(folder.join(FILE).is_file());
        let ignore = std::fs::read_to_string(folder.join(".gitignore")).expect("gitignore");
        assert!(ignore.lines().any(|line| line == "*"));
        let steps = vec![
            "click \"Export\"".to_string(),
            "click \"CSV\" (#csv)".to_string(),
        ];
        assert!(remember_recipe(&root, url, "Export report CSV", &steps).expect("recipe"));
        assert!(remember_recipe(&root, url, "export report csv", &steps).expect("recipe again"));

        let found = recall(&root, "http://127.0.0.1:9999/reports/7", "export", 8).expect("recall");
        assert_eq!(found["site"], "local");
        assert_eq!(
            found["hits"][0]["selector"],
            "button[aria-label=\"Export\"]"
        );
        assert_eq!(found["hits"][0]["seen"], 2);
        assert_eq!(found["hits"][0]["pathKey"], "/reports/:id");
        assert_eq!(found["recipes"].as_array().map(Vec::len), Some(1));
        assert_eq!(found["recipes"][0]["goal"], "export report csv");
        assert_eq!(found["recipes"][0]["steps"][1], "click \"CSV\" (#csv)");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn two_projects_on_localhost_keep_separate_memories() {
        let (a, b) = (temp(), temp());
        remember_elements(
            &a,
            "http://localhost:3000/",
            &[element("#only-a", "Only A", "button")],
        )
        .expect("store a");
        let found = recall(&b, "http://localhost:4000/", "only", 8).expect("recall b");
        assert_eq!(found["hits"].as_array().map(Vec::len), Some(0));
        let _ = std::fs::remove_dir_all(a);
        let _ = std::fs::remove_dir_all(b);
    }

    #[test]
    fn the_first_version_json_is_imported_once() {
        let root = temp();
        let folder = root.join(DIR);
        std::fs::create_dir_all(&folder).expect("folder");
        std::fs::write(
            folder.join("local.json"),
            r##"{"version":1,"site":"local","elements":[{"selector":"#save","name":"Save","kind":"button","pathKey":"/edit","seen":4,"ok":3,"fail":0,"lastSeen":1,"lastOk":1}],"recipes":[{"goal":"save edit","steps":["click Save (#save)"],"seen":1,"ok":1,"fail":0,"lastUsed":1}]}"##,
        )
        .expect("legacy file");
        let found = recall(&root, "http://localhost:5173/edit", "save", 8).expect("recall");
        assert_eq!(found["hits"][0]["selector"], "#save");
        assert_eq!(found["hits"][0]["seen"], 4);
        assert_eq!(found["recipes"][0]["goal"], "save edit");
        assert!(folder.join("local.json.imported").is_file());
        assert!(!folder.join("local.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_legacy_file_that_does_not_parse_is_left_alone() {
        let root = temp();
        let folder = root.join(DIR);
        std::fs::create_dir_all(&folder).expect("folder");
        std::fs::write(folder.join("local.json"), "{ not json").expect("broken");
        let found = recall(&root, "http://localhost/", "anything", 8).expect("recall");
        assert_eq!(found["hits"].as_array().map(Vec::len), Some(0));
        assert!(folder.join("local.json").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_site_keeps_its_limit_and_its_proven_elements() {
        let root = temp();
        let url = "http://localhost:5173/list";
        let mut proven_seen = false;
        for call in 0..9 {
            let batch: Vec<PageElement> = (0..200)
                .map(|index| {
                    element(
                        &format!("#e{call}-{index}"),
                        &format!("Item {call} {index}"),
                        "button",
                    )
                })
                .collect();
            remember_elements(&root, url, &batch).expect("store");
            if call == 0 {
                let conn = open(&root).expect("open");
                conn.execute("UPDATE elements SET ok = 5 WHERE selector = '#e0-0'", [])
                    .expect("prove");
                proven_seen = true;
            }
        }
        assert!(proven_seen);
        let conn = open(&root).expect("open");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM elements WHERE site = 'local'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert!(count <= MAX_ELEMENTS, "{count}");
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM elements WHERE selector = '#e0-0'",
                [],
                |row| row.get(0),
            )
            .expect("proven");
        assert_eq!(kept, 1, "a proven element is not the first to go");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_names_of_a_stored_element_are_searchable_after_a_rename() {
        let root = temp();
        let url = "http://localhost:5173/a";
        remember_elements(&root, url, &[element("#x", "Old label", "button")]).expect("first");
        remember_elements(&root, url, &[element("#x", "New label", "button")]).expect("renamed");
        let found = recall(&root, url, "new label", 8).expect("recall");
        assert_eq!(found["hits"][0]["name"], "New label");
        let old = recall(&root, url, "old", 8).expect("recall old");
        assert_eq!(old["hits"].as_array().map(Vec::len), Some(0));
        let _ = std::fs::remove_dir_all(root);
    }
}
