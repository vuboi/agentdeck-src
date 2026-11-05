//! What the Preview agent learned about the pages of a site, kept in the project it works on:
//! `<project>/.agentdeck/ui-memory/<site>.json`. Every project has its own memory and nothing is kept in AgentDeck
//! itself, so a new session in the project finds controls through `browser_recall` instead of a screenshot or a scan.
//!
//! A dev server on `localhost` (any port) is the site `local` of its project. Elements seen by `browser_elements` and
//! `browser_find` are stored on the way; `browser_remember` keeps the steps that reached a goal.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

const DIR: &str = ".agentdeck/ui-memory";
const MAX_ELEMENTS: usize = 1500;
const MAX_RECIPES: usize = 200;
const MAX_FILE: usize = 2 * 1024 * 1024;
const MAX_STEPS: usize = 40;
/// Elements kept from one scan of a page.
const MAX_SEEN: usize = 200;
const WEEK_MS: u64 = 7 * 24 * 3600 * 1000;
const STOP: [&str; 21] = [
    "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "at", "it", "be", "by",
    "va", "la", "cua", "cho", "cac", "mot",
];

/// One read-modify-write at a time: two agents of one project would otherwise lose each other's elements.
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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Element {
    pub selector: String,
    pub name: String,
    pub kind: String,
    /// The page it was seen on, ids turned into `:id` (`/orders/:id/edit`).
    pub path_key: String,
    pub seen: u64,
    /// Actions on it that worked, and that failed (the selector no longer matched).
    pub ok: u64,
    pub fail: u64,
    pub last_seen: u64,
    pub last_ok: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Recipe {
    pub goal: String,
    pub steps: Vec<String>,
    pub seen: u64,
    pub ok: u64,
    pub fail: u64,
    pub last_used: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteMemory {
    pub version: u32,
    pub site: String,
    pub elements: Vec<Element>,
    pub recipes: Vec<Recipe>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as u64)
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
fn broken(ok: u64, fail: u64) -> bool {
    fail >= 3 && fail > ok
}

fn element_words(element: &Element) -> Vec<String> {
    let kind: String = element
        .kind
        .chars()
        .map(|c| if c.is_ascii_alphabetic() { c } else { ' ' })
        .collect();
    words(&format!("{} {kind}", element.name))
}

/// How well a stored element answers a query: every query word it has counts, a word at the start of its name more,
/// the page the agent is on more, and what was seen and worked often a little more. 0 means it does not answer.
pub fn score_element(element: &Element, query: &[String], path_key: Option<&str>) -> f64 {
    if query.is_empty() || broken(element.ok, element.fail) {
        return 0.0;
    }
    let own = element_words(element);
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

/// `<root>/.agentdeck/ui-memory/<site>.json`, refused when it would leave the project folder.
fn file_for(root: &Path, site: &str) -> Result<PathBuf, String> {
    let safe = !site.is_empty()
        && site.len() <= 100
        && !site.starts_with('.')
        && !site.contains("..")
        && site
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    if !safe {
        return Err("invalid site name".into());
    }
    Ok(root.join(DIR).join(format!("{site}.json")))
}

/// The memory of one site, empty when there is none yet. A file that is not valid JSON is set aside (`.bad-<time>`)
/// and the memory starts again, so one broken write never blocks the agent.
fn load(root: &Path, site: &str) -> Result<SiteMemory, String> {
    let path = file_for(root, site)?;
    let empty = SiteMemory {
        version: 1,
        site: site.to_string(),
        ..Default::default()
    };
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
        Err(error) => return Err(error.to_string()),
    };
    match serde_json::from_str::<SiteMemory>(&text) {
        Ok(mut memory) => {
            memory.site = site.to_string();
            Ok(memory)
        }
        Err(_) => {
            let _ = fs::rename(&path, path.with_extension(format!("json.bad-{}", now_ms())));
            Ok(empty)
        }
    }
}

/// Drops what is least worth keeping: long broken elements, then over the limits the least proven and oldest first.
fn prune(memory: &mut SiteMemory, now: u64) {
    memory.elements.retain(|element| {
        !(broken(element.ok, element.fail) && now.saturating_sub(element.last_seen) > WEEK_MS)
    });
    if memory.elements.len() > MAX_ELEMENTS {
        memory.elements.sort_by_key(|element| {
            (
                element.ok >= 3 && !broken(element.ok, element.fail),
                element.last_seen,
            )
        });
        let excess = memory.elements.len() - MAX_ELEMENTS;
        memory.elements.drain(..excess);
    }
    if memory.recipes.len() > MAX_RECIPES {
        memory
            .recipes
            .sort_by_key(|recipe| (recipe.fail <= recipe.ok, recipe.last_used));
        let excess = memory.recipes.len() - MAX_RECIPES;
        memory.recipes.drain(..excess);
    }
}

fn save(root: &Path, memory: &mut SiteMemory) -> Result<(), String> {
    let path = file_for(root, &memory.site)?;
    let folder = path.parent().ok_or("invalid memory path")?;
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_folder = folder.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_folder.starts_with(&canonical_root) {
        return Err("ui memory folder escapes the project folder".into());
    }
    // Kept out of the project's git by a `.gitignore` of its own, so the project's root `.gitignore` is never edited.
    // One the user changed is left as it is.
    let ignore = folder.join(".gitignore");
    if !ignore.exists() {
        crate::plans::atomic_write(
            &ignore,
            "# AgentDeck's memory of the Preview pages of this project.\n*\n",
        )?;
    }
    memory.version = 1;
    prune(memory, now_ms());
    // Sorted so a project that keeps this file in git sees small diffs.
    memory
        .elements
        .sort_by(|a, b| (&a.path_key, &a.selector).cmp(&(&b.path_key, &b.selector)));
    memory.recipes.sort_by(|a, b| a.goal.cmp(&b.goal));
    let mut text = serde_json::to_string_pretty(memory).map_err(|e| e.to_string())?;
    while text.len() > MAX_FILE && !memory.elements.is_empty() {
        memory.elements.sort_by_key(|element| element.last_seen);
        let drop = (memory.elements.len() / 10).max(1);
        memory.elements.drain(..drop);
        text = serde_json::to_string_pretty(memory).map_err(|e| e.to_string())?;
    }
    crate::plans::atomic_write(&path, &text)
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
    let mut memory = load(root, &site)?;
    let now = now_ms();
    let mut kept = 0;
    for element in elements.iter().take(MAX_SEEN) {
        if element.selector.trim().is_empty() {
            continue;
        }
        kept += 1;
        match memory
            .elements
            .iter_mut()
            .find(|known| known.path_key == page && known.selector == element.selector)
        {
            Some(known) => {
                known.seen += 1;
                known.last_seen = now;
                known.name = element.name.clone();
                known.kind = element.kind.clone();
            }
            None => memory.elements.push(Element {
                selector: element.selector.clone(),
                name: element.name.clone(),
                kind: element.kind.clone(),
                path_key: page.clone(),
                seen: 1,
                last_seen: now,
                ..Default::default()
            }),
        }
    }
    if kept > 0 {
        save(root, &mut memory)?;
    }
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
    let mut memory = load(root, &site)?;
    let now = now_ms();
    let key = goal.to_lowercase();
    match memory
        .recipes
        .iter_mut()
        .find(|recipe| recipe.goal.to_lowercase() == key)
    {
        Some(recipe) => {
            recipe.goal = goal.to_string();
            recipe.steps = steps;
            recipe.seen += 1;
            recipe.last_used = now;
        }
        None => memory.recipes.push(Recipe {
            goal: goal.to_string(),
            steps,
            seen: 1,
            last_used: now,
            ..Default::default()
        }),
    }
    save(root, &mut memory)?;
    Ok(true)
}

/// The elements and recipes of the site of `url` that best answer `query` (the current page's own first), in the shape
/// `page_memory::format_recall` reads.
pub fn recall(root: &Path, url: &str, query: &str, limit: usize) -> Result<Value, String> {
    let site = site_key(url).unwrap_or_default();
    let query_words = words(query);
    if site.is_empty() || query_words.is_empty() {
        return Ok(json!({ "site": site, "query": query, "hits": [], "recipes": [] }));
    }
    let memory = {
        let _guard = LOCK.lock().map_err(|_| "ui memory is busy")?;
        load(root, &site)?
    };
    let page = path_key(url);
    let mut hits: Vec<(f64, &Element)> = memory
        .elements
        .iter()
        .map(|element| (score_element(element, &query_words, Some(&page)), element))
        .filter(|(score, _)| *score > 0.0)
        .collect();
    hits.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut recipes: Vec<(f64, &Recipe)> = memory
        .recipes
        .iter()
        .map(|recipe| (score_recipe(recipe, &query_words), recipe))
        .filter(|(score, _)| *score > 0.0)
        .collect();
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
    fn temp() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "agentdeck-ui-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("temp root");
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
        assert!(root.join(".agentdeck/ui-memory/local.json").is_file());
        let ignore =
            fs::read_to_string(root.join(".agentdeck/ui-memory/.gitignore")).expect("gitignore");
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
        let _ = fs::remove_dir_all(root);
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
        let _ = fs::remove_dir_all(a);
        let _ = fs::remove_dir_all(b);
    }

    #[test]
    fn a_broken_file_is_set_aside_and_the_memory_starts_again() {
        let root = temp();
        let folder = root.join(DIR);
        fs::create_dir_all(&folder).expect("folder");
        fs::write(folder.join("local.json"), "{ not json").expect("broken file");
        let found = recall(&root, "http://localhost/", "anything", 8).expect("recall");
        assert_eq!(found["hits"].as_array().map(Vec::len), Some(0));
        let set_aside = fs::read_dir(&folder).expect("list").flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("local.json.bad-")
        });
        assert!(set_aside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pruning_keeps_proven_elements_and_drops_the_oldest() {
        let mut memory = SiteMemory {
            version: 1,
            site: "local".into(),
            ..Default::default()
        };
        for index in 0..(MAX_ELEMENTS + 100) {
            let mut item = stored(&format!("e{index}"), "button", "/");
            item.last_seen = index as u64 + 1;
            if index == 0 {
                item.ok = 5;
            }
            memory.elements.push(item);
        }
        prune(&mut memory, (MAX_ELEMENTS + 200) as u64);
        assert_eq!(memory.elements.len(), MAX_ELEMENTS);
        assert!(memory.elements.iter().any(|item| item.name == "e0"));
        assert!(!memory.elements.iter().any(|item| item.name == "e1"));
    }

    #[test]
    fn a_site_name_cannot_leave_the_memory_folder() {
        let root = temp();
        assert!(file_for(&root, "../x").is_err());
        assert!(file_for(&root, ".hidden").is_err());
        assert!(file_for(&root, "Shop.com").is_err());
        assert!(file_for(&root, "shop.com").is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
