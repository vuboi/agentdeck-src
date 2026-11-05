use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;
use unicode_normalization::UnicodeNormalization;

const WRITE_DIR: &str = "docs/plans";
const MAX_BODY: usize = 256 * 1024;

const TOOLS: [&str; 4] = ["plan_list", "plan_read", "plan_write", "plan_step"];
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    pub id: String,
    pub path: String,
    pub title: String,
    pub status: String,
    pub agent: String,
    pub chat: String,
    pub source: String,
    pub created: String,
    pub updated: String,
    pub done: usize,
    pub total: usize,
    pub read_only: bool,
}

#[derive(Clone, Debug)]
pub struct WriteReq {
    pub title: String,
    pub body: String,
    pub status: Option<String>,
    pub id: Option<String>,
    pub agent: String,
    pub chat: String,
    pub source: String,
    pub base_updated: Option<String>,
}

#[derive(Clone, Debug)]
pub enum StepRef {
    Number(usize),
    Text(String),
}

#[derive(Default)]
struct FrontMatter {
    keys: Vec<(String, String)>,
    body: String,
}

fn now() -> String {
    format_system_time(SystemTime::now())
}

fn file_time(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(format_system_time)
        .unwrap_or_else(|| format_system_time(UNIX_EPOCH))
}

fn format_system_time(time: SystemTime) -> String {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let days = millis.div_euclid(86_400_000);
    let day_millis = millis.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let hour = day_millis / 3_600_000;
    let minute = day_millis % 3_600_000 / 60_000;
    let second = day_millis % 60_000 / 1_000;
    let ms = day_millis % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

fn timestamp_millis(value: &str) -> Option<i128> {
    if let Ok(epoch_ms) = value.parse::<i128>() {
        return Some(epoch_ms);
    }
    let (date, time_and_zone) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    let zone_at = time_and_zone
        .find(['Z', '+', '-'])
        .unwrap_or(time_and_zone.len());
    let (clock, zone) = time_and_zone.split_at(zone_at);
    let mut clock_parts = clock.split(':');
    let hour = clock_parts.next()?.parse::<i64>().ok()?;
    let minute = clock_parts.next()?.parse::<i64>().ok()?;
    let seconds = clock_parts.next()?;
    let (second, fraction) = seconds.split_once('.').unwrap_or((seconds, "0"));
    let second = second.parse::<i64>().ok()?;
    let fractional_ms = format!("{fraction:0<3}")
        .chars()
        .take(3)
        .collect::<String>()
        .parse::<i64>()
        .ok()?;
    let (zone_sign, zone_hour, zone_minute) = if zone == "Z" || zone.is_empty() {
        (0, 0, 0)
    } else {
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let mut parts = zone[1..].split(':');
        (
            sign,
            parts.next()?.parse::<i64>().ok()?,
            parts.next()?.parse::<i64>().ok()?,
        )
    };
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let era = adjusted_year.div_euclid(400);
    let yoe = adjusted_year - era * 400;
    let doy = (153 * adjusted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let local_ms = (((days * 24 + hour) * 60 + minute) * 60 + second) * 1_000 + fractional_ms;
    Some(i128::from(local_ms) - i128::from(zone_sign * (zone_hour * 60 + zone_minute) * 60_000))
}

fn normalized_timestamp(value: &str) -> String {
    timestamp_millis(value)
        .map(|millis| {
            format_system_time(
                UNIX_EPOCH
                    + std::time::Duration::from_millis(millis.clamp(0, i64::MAX as i128) as u64),
            )
        })
        .unwrap_or_else(|| value.to_string())
}

fn parse_fm(text: &str) -> FrontMatter {
    let mut lines = text.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return FrontMatter {
            body: text.into(),
            ..Default::default()
        };
    };
    if first.trim_end() != "---" {
        return FrontMatter {
            body: text.into(),
            ..Default::default()
        };
    }
    let mut keys = Vec::new();
    let mut offset = first.len();
    let mut end = None;
    for line in lines {
        let clean = line.trim_end_matches(['\r', '\n']);
        if clean == "---" {
            end = Some(offset + line.len());
            break;
        }
        if let Some((key, value)) = clean.split_once(':') {
            let key = key.trim();
            if !key.is_empty() {
                let value = value.split_once('#').map_or(value, |(v, _)| v).trim();
                keys.push((key.to_string(), value.trim_matches(['"', '\'']).to_string()));
            }
        }
        offset += line.len();
    }
    match end {
        Some(end) => FrontMatter {
            keys,
            body: text[end..].to_string(),
        },
        None => FrontMatter {
            body: text.into(),
            ..Default::default()
        },
    }
}

fn key<'a>(fm: &'a FrontMatter, name: &str) -> Option<&'a str> {
    fm.keys
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn update_key(fm: &mut FrontMatter, name: &str, value: &str) {
    if let Some((_, current)) = fm.keys.iter_mut().find(|(k, _)| k == name) {
        *current = value.to_string();
    } else {
        fm.keys.push((name.to_string(), value.to_string()));
    }
}

fn render_fm(fm: &FrontMatter) -> String {
    let mut out = String::from("---\n");
    for (k, v) in &fm.keys {
        out.push_str(&format!("{k}: {v}\n"));
    }
    out.push_str("---\n");
    out.push_str(&fm.body);
    out
}

fn counts(body: &str) -> (usize, usize) {
    let mut done = 0;
    let mut total = 0;
    for line in body.lines() {
        let s = line.trim_start();
        let Some(rest) = s.strip_prefix("- [").or_else(|| s.strip_prefix("* [")) else {
            continue;
        };
        let valid = rest.as_bytes().get(1) == Some(&b']')
            && rest.as_bytes().get(2) == Some(&b' ')
            && !rest[3..].is_empty()
            && matches!(rest.as_bytes()[0], b' ' | b'x' | b'X');
        if valid {
            total += 1;
            done += usize::from(matches!(rest.as_bytes()[0], b'x' | b'X'));
        }
    }
    (done, total)
}

fn title_from(body: &str, fallback: &str) -> String {
    body.lines()
        .find_map(|l| {
            l.strip_prefix("# ")
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(fallback)
        .to_string()
}

fn info(id: &str, path: &Path, read_only: bool) -> Result<(PlanInfo, String), String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let fm = parse_fm(&text);
    let updated = key(&fm, "updated")
        .map(normalized_timestamp)
        .unwrap_or_else(|| file_time(path));
    let (done, total) = counts(&fm.body);
    let file = path.file_stem().and_then(|s| s.to_str()).unwrap_or(id);
    let pi = PlanInfo {
        id: id.to_string(),
        path: path.to_string_lossy().into_owned(),
        title: key(&fm, "title")
            .map(str::to_string)
            .unwrap_or_else(|| title_from(&fm.body, file)),
        status: key(&fm, "status").unwrap_or("unknown").to_string(),
        agent: key(&fm, "agent").unwrap_or("").to_string(),
        chat: key(&fm, "chat").unwrap_or("").to_string(),
        source: key(&fm, "source").unwrap_or("").to_string(),
        created: key(&fm, "created")
            .map(normalized_timestamp)
            .unwrap_or_else(|| file_time(path)),
        updated,
        done,
        total,
        read_only,
    };
    Ok((pi, text))
}

fn validate_id(id: &str, writable: bool) -> Result<(PathBuf, bool), String> {
    if id.is_empty()
        || Path::new(id).is_absolute()
        || id.contains('\\')
        || Path::new(id)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || !id.ends_with(".md")
    {
        return Err("invalid plan id".into());
    }
    let global = id.starts_with("claude-global/");
    if writable && global {
        return Err("read-only plan".into());
    }
    let allowed = if writable {
        id.starts_with("docs/plans/")
    } else {
        id.starts_with("docs/plans/") || id.starts_with("docs/superpowers/plans/") || global
    };
    if !allowed {
        return Err("plan id must be under an allowed plans folder".into());
    }
    Ok((PathBuf::from(id), global))
}

fn path_for(root: &Path, id: &str, writable: bool) -> Result<(PathBuf, bool), String> {
    let (rel, global) = validate_id(id, writable)?;
    let read_only = global || id.starts_with("docs/superpowers/plans/");
    let base = if global {
        let profile = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .ok_or("home directory is unavailable")?;
        PathBuf::from(profile).join(".claude/plans")
    } else {
        root.to_path_buf()
    };
    let path = if global {
        base.join(
            rel.strip_prefix("claude-global")
                .map_err(|_| "invalid plan id")?,
        )
    } else {
        base.join(rel)
    };
    if path.exists() {
        let canonical_root = base.canonicalize().map_err(|e| e.to_string())?;
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(canonical_root) {
            return Err("plan path escapes its root".into());
        }
        Ok((canonical, read_only))
    } else if writable {
        let parent = path.parent().ok_or("invalid plan path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let canonical_root = base.canonicalize().map_err(|e| e.to_string())?;
        let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_parent.starts_with(canonical_root) {
            return Err("plan path escapes its root".into());
        }
        Ok((
            canonical_parent.join(path.file_name().ok_or("invalid plan path")?),
            read_only,
        ))
    } else {
        Ok((path, read_only))
    }
}

fn temp_path(path: &Path, serial: u64) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plan.md");
    path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), serial))
}

fn create_temp_at(path: &Path, serial: u64) -> std::io::Result<(PathBuf, File)> {
    let tmp = temp_path(path, serial);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map(|file| (tmp, file))
}

fn create_temp_file(path: &Path) -> Result<(PathBuf, File), String> {
    for _ in 0..100 {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        match create_temp_at(path, serial) {
            Ok(file) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("could not allocate a unique temporary plan file".into())
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let (tmp, mut file) = create_temp_file(path)?;
    let result = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn list(root: &Path, status: Option<&str>) -> Result<Vec<PlanInfo>, String> {
    let mut found = Vec::new();
    for folder in [root.join("docs/plans"), root.join("docs/superpowers/plans")] {
        if !folder.exists() {
            continue;
        }
        for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let id = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if let Ok((item, _)) = read(root, &id) {
                if status.is_none_or(|s| s == item.status) {
                    found.push(item);
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let folder = PathBuf::from(home).join(".claude/plans");
        if folder.exists() {
            for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) != Some("md") {
                    continue;
                }
                let id = format!(
                    "claude-global/{}",
                    path.file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or_default()
                );
                if let Ok((item, _)) = read(root, &id) {
                    if status.is_none_or(|s| s == item.status) {
                        found.push(item);
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| {
        timestamp_millis(&b.updated)
            .unwrap_or_default()
            .cmp(&timestamp_millis(&a.updated).unwrap_or_default())
    });
    found.truncate(100);
    Ok(found)
}

pub fn read(root: &Path, id: &str) -> Result<(PlanInfo, String), String> {
    let (path, ro) = path_for(root, id, false)?;
    if !path.exists() {
        return Err("plan not found".into());
    }
    info(id, &path, ro)
}

pub fn write(root: &Path, req: WriteReq) -> Result<PlanInfo, String> {
    if req.body.len() > MAX_BODY {
        return Err("plan body exceeds 256 KB".into());
    }
    let status = req.status.as_deref().unwrap_or("draft");
    if !["draft", "approved", "doing", "done", "dropped"].contains(&status) {
        return Err("invalid plan status".into());
    }
    let id = if let Some(id) = req.id {
        id
    } else {
        let slug = req
            .title
            .nfkd()
            .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
            .flat_map(char::to_lowercase)
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let slug = if slug.is_empty() { "plan" } else { &slug };
        let mut n = 1;
        loop {
            let candidate = format!(
                "{WRITE_DIR}/{slug}{}.md",
                if n == 1 {
                    String::new()
                } else {
                    format!("-{n}")
                }
            );
            if !root.join(&candidate).exists() {
                break candidate;
            }
            n += 1;
        }
    };
    let (path, _) = path_for(root, &id, true)?;
    let existing = path
        .exists()
        .then(|| fs::read_to_string(&path).map_err(|e| e.to_string()))
        .transpose()?;
    let mut fm = existing.as_deref().map(parse_fm).unwrap_or_default();
    if let Some(base) = req.base_updated.as_deref() {
        let current = existing
            .as_deref()
            .map(|s| {
                key(&parse_fm(s), "updated")
                    .map(normalized_timestamp)
                    .unwrap_or_else(|| file_time(&path))
            })
            .unwrap_or_default();
        if current != base {
            return Err(format!(
                "plan changed since you read it (updated={current}); plan_read again"
            ));
        }
    }
    let created = key(&fm, "created")
        .map(normalized_timestamp)
        .unwrap_or_else(|| {
            if existing.is_some() {
                file_time(&path)
            } else {
                now()
            }
        });
    let legacy_body = existing
        .as_deref()
        .filter(|text| parse_fm(text).keys.is_empty());
    if let Some(legacy_body) = legacy_body {
        fm = ensure_frontmatter(&path, legacy_body, Some(status));
    } else {
        fm.body = req.body;
    }
    let title = if legacy_body.is_some() {
        key(&fm, "title")
            .map(str::to_string)
            .unwrap_or_else(|| req.title.clone())
    } else {
        req.title.clone()
    };
    for (k, v) in [("title", title.as_str()), ("status", status)] {
        update_key(&mut fm, k, v);
    }
    if legacy_body.is_none() {
        for (k, v) in [
            ("agent", req.agent.as_str()),
            ("chat", req.chat.as_str()),
            ("source", req.source.as_str()),
            ("created", created.as_str()),
        ] {
            update_key(&mut fm, k, v);
        }
    }
    update_key(&mut fm, "updated", &now());
    atomic_write(&path, &render_fm(&fm))?;
    Ok(info(&id, &path, false)?.0)
}

fn ensure_frontmatter(path: &Path, text: &str, status: Option<&str>) -> FrontMatter {
    let mut fm = parse_fm(text);
    if fm.keys.is_empty() {
        let title = title_from(
            text,
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("plan"),
        );
        fm.body = text.to_string();
        update_key(&mut fm, "title", &title);
        update_key(&mut fm, "agent", "");
        update_key(&mut fm, "chat", "");
        update_key(&mut fm, "source", "manual");
        update_key(&mut fm, "created", &file_time(path));
    }
    if let Some(status) = status {
        update_key(&mut fm, "status", status);
    } else if key(&fm, "status").is_none() {
        update_key(&mut fm, "status", "unknown");
    }
    update_key(&mut fm, "updated", &now());
    fm
}

pub fn set_status(root: &Path, id: &str, status: &str) -> Result<PlanInfo, String> {
    if !["draft", "approved", "doing", "done", "dropped"].contains(&status) {
        return Err("invalid plan status".into());
    }
    let (path, _) = path_for(root, id, true)?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let fm = ensure_frontmatter(&path, &text, Some(status));
    atomic_write(&path, &render_fm(&fm))?;
    Ok(info(id, &path, false)?.0)
}

pub fn set_step(root: &Path, id: &str, step: StepRef, done: bool) -> Result<PlanInfo, String> {
    let (path, _) = path_for(root, id, true)?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut fm = ensure_frontmatter(&path, &text, None);
    let wanted = match step {
        StepRef::Number(n) if n > 0 => n - 1,
        StepRef::Number(_) => return Err("step numbers are 1-based".into()),
        StepRef::Text(t) => {
            let pos = fm
                .body
                .lines()
                .filter(|l| step_line(l))
                .position(|l| step_text(l) == t)
                .ok_or("step text not found")?;
            pos
        }
    };
    let mut output = String::new();
    let mut found = false;
    let mut idx = 0;
    for line in fm.body.split_inclusive('\n') {
        if step_line(line) {
            if idx == wanted {
                let prefix = line.trim_start().chars().next().unwrap_or('-');
                let indent = line.len() - line.trim_start().len();
                let text = step_text(line);
                output.push_str(&format!(
                    "{}{prefix} [{}] {text}",
                    " ".repeat(indent),
                    if done { "x" } else { " " }
                ));
                if line.ends_with('\n') {
                    output.push('\n');
                }
                found = true;
            } else {
                output.push_str(line);
            }
            idx += 1;
        } else {
            output.push_str(line);
        }
    }
    if !found {
        return Err("step number out of range".into());
    }
    fm.body = output;
    let (completed, total) = counts(&fm.body);
    let status = key(&fm, "status").unwrap_or("unknown");
    if status != "dropped" {
        if total > 0 && completed == total {
            update_key(&mut fm, "status", "done");
        } else if completed > 0 && matches!(status, "approved" | "draft") {
            update_key(&mut fm, "status", "doing");
        }
    }
    update_key(&mut fm, "updated", &now());
    atomic_write(&path, &render_fm(&fm))?;
    Ok(info(id, &path, false)?.0)
}

fn step_line(s: &str) -> bool {
    let t = s.trim_start();
    matches!(t.strip_prefix("- [").or_else(|| t.strip_prefix("* [")), Some(r) if r.as_bytes().get(1) == Some(&b']') && r.as_bytes().get(2) == Some(&b' ') && !r[3..].is_empty() && matches!(r.as_bytes()[0], b' ' | b'x' | b'X'))
}
fn step_text(s: &str) -> String {
    let t = s.trim_start();
    t.get(6..)
        .unwrap_or_default()
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string()
}

pub fn is_tool(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({"name":"plan_list","description":"Plans saved for this project, shared by every AgentDeck agent. Call before starting multi-step work; follow an approved plan and tick steps with plan_step.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"status":{"type":"string"}},"required":[]}}),
        json!({"name":"plan_read","description":"Read a project's plan by id from plan_list. Use this before following or changing a plan.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"id":{"type":"string"}},"required":["id"]}}),
        json!({"name":"plan_write","description":"Save a new or updated shared project plan. Provide a title and body with ordered checkbox steps; body must not include front matter. Use base_updated from plan_read when updating.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"},"status":{"type":"string"},"id":{"type":"string"},"agent":{"type":"string"},"base_updated":{"type":"string"}},"required":["title","body"]}}),
        json!({"name":"plan_step","description":"Mark a plan checklist step done or unchecked by its 1-based number or exact step text. Re-reads the plan before changing it.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"id":{"type":"string"},"step":{"type":["string","integer"]},"done":{"type":"boolean"}},"required":["id","step","done"]}}),
    ]
}

pub async fn call(
    app: &tauri::AppHandle,
    name: &str,
    args: &Value,
    chat: &str,
) -> Result<String, String> {
    let root = PathBuf::from(crate::index::root_of(chat, args)?);
    let result = match name {
        "plan_list" => list(&root, args["status"].as_str())?
            .into_iter()
            .map(|p| {
                format!(
                    "{} | {} | {} | {} | {} | {}/{}",
                    p.id, p.status, p.title, p.agent, p.updated, p.done, p.total
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "plan_read" => {
            let (p, body) = read(&root, args["id"].as_str().ok_or("id is required")?)?;
            let chars = body.chars().take(200_000).collect::<String>();
            format!(
                "status={} steps={}/{} updated={}{}\n{}",
                p.status,
                p.done,
                p.total,
                p.updated,
                if body.chars().count() > 200_000 {
                    " (truncated at 200000 characters)"
                } else {
                    ""
                },
                chars
            )
        }
        "plan_write" => {
            let p = write(
                &root,
                WriteReq {
                    title: args["title"].as_str().ok_or("title is required")?.into(),
                    body: args["body"].as_str().ok_or("body is required")?.into(),
                    status: args["status"].as_str().map(str::to_string),
                    id: args["id"].as_str().map(str::to_string),
                    agent: args["agent"].as_str().unwrap_or("").into(),
                    chat: chat.into(),
                    source: "mcp".into(),
                    base_updated: args["base_updated"].as_str().map(str::to_string),
                },
            )?;
            let _ = app.emit("plan-changed", json!({"root":root,"id":p.id}));
            format!("saved {} (status={})", p.id, p.status)
        }
        "plan_step" => {
            let step = if let Some(n) = args["step"].as_u64() {
                StepRef::Number(n as usize)
            } else {
                StepRef::Text(
                    args["step"]
                        .as_str()
                        .ok_or("step must be a number or text")?
                        .into(),
                )
            };
            let id = args["id"].as_str().ok_or("id is required")?;
            let selected = match &step {
                StepRef::Number(n) => *n,
                StepRef::Text(text) => {
                    let (_, body) = read(&root, id)?;
                    body.lines()
                        .filter(|line| step_line(line))
                        .position(|line| step_text(line) == *text)
                        .map(|n| n + 1)
                        .ok_or("step text not found")?
                }
            };
            let is_done = args["done"].as_bool().ok_or("done is required")?;
            let p = set_step(&root, id, step, is_done)?;
            let _ = app.emit("plan-changed", json!({"root":root,"id":p.id}));
            format!(
                "step {}/{} {}; status={}",
                selected,
                p.total,
                if is_done { "done" } else { "unchecked" },
                p.status
            )
        }
        _ => return Err("unknown plan tool".into()),
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "agentdeck-plans-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).expect("temp root");
        p
    }
    fn req(title: &str, body: &str) -> WriteReq {
        WriteReq {
            title: title.into(),
            body: body.into(),
            status: Some("draft".into()),
            id: None,
            agent: "test".into(),
            chat: "c".into(),
            source: "manual".into(),
            base_updated: None,
        }
    }
    #[test]
    fn parses_frontmatter_and_legacy() {
        let fm = parse_fm(
            "---\ntitle: Hello # note\nstatus: doing\n---\n# Body\n- [x] one\n- [ ] two\n",
        );
        assert_eq!(key(&fm, "title"), Some("Hello"));
        assert_eq!(counts(&fm.body), (1, 2));
        let old = parse_fm("# Old\n- [ ] step\n");
        assert!(old.keys.is_empty());
        assert_eq!(title_from(&old.body, "x"), "Old");
    }
    #[test]
    fn writes_steps_status_collision_and_conflicts() {
        let root = temp();
        let a = write(&root, req("My Plan", "- [ ] first\n- [ ] second\n")).expect("write");
        assert!(write(&root, req("My Plan", "body"))
            .expect("collision")
            .id
            .ends_with("my-plan-2.md"));
        let updated = set_step(&root, &a.id, StepRef::Number(1), true).expect("number");
        assert_eq!(updated.status, "doing");
        let updated = set_step(&root, &a.id, StepRef::Text("second".into()), true).expect("text");
        assert_eq!(updated.status, "done");
        let mut conflict = req("My Plan", "new");
        conflict.id = Some(a.id.clone());
        conflict.base_updated = Some("stale".into());
        assert!(write(&root, conflict)
            .expect_err("conflict")
            .contains("plan changed since you read it"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn step_changes_preserve_existing_status_and_dropped_never_auto_changes() {
        let root = temp();
        fs::create_dir_all(root.join("docs/plans")).expect("plans dir");
        let path = root.join("docs/plans/approved.md");
        fs::write(
            &path,
            "---\ntitle: Approved\nstatus: approved\ncreated: 1\nupdated: 1\n---\n- [ ] first\n- [ ] second\n",
        )
        .expect("approved plan");
        let info = set_step(&root, "docs/plans/approved.md", StepRef::Number(1), true)
            .expect("mark approved step");
        assert_eq!(info.status, "doing");

        let path = root.join("docs/plans/dropped.md");
        fs::write(
            &path,
            "---\ntitle: Dropped\nstatus: dropped\ncreated: 1\nupdated: 1\n---\n- [ ] first\n",
        )
        .expect("dropped plan");
        let info = set_step(&root, "docs/plans/dropped.md", StepRef::Number(1), true)
            .expect("mark dropped step");
        assert_eq!(info.status, "dropped");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn updating_a_legacy_plan_adds_frontmatter_without_changing_its_body() {
        let root = temp();
        let path = root.join("docs/plans/legacy.md");
        fs::create_dir_all(path.parent().expect("parent")).expect("plans dir");
        let body = "\n# Legacy heading\r\n\r\n- [ ] keep these bytes\r\n";
        fs::write(&path, body).expect("legacy plan");
        let created = file_time(&path);
        let mut request = req("Ignored replacement title", "replacement body");
        request.id = Some("docs/plans/legacy.md".into());
        let info = write(&root, request).expect("update legacy");
        let output = fs::read_to_string(&path).expect("read result");
        let mut sections = output.splitn(3, "---\n");
        sections.next().expect("opening delimiter");
        let header = sections.next().expect("front matter header");
        let kept_body = sections.next().expect("body");
        assert!(header.contains("title: Legacy heading"));
        assert!(header.contains("source: manual"));
        assert!(header.contains(&format!("created: {created}")));
        assert_eq!(kept_body, body);
        assert_eq!(info.agent, "");
        assert_eq!(info.chat, "");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn list_sorts_normalized_instants_and_marks_superpowers_plans_read_only() {
        let root = temp();
        let plans = root.join("docs/plans");
        let superpowers = root.join("docs/superpowers/plans");
        fs::create_dir_all(&plans).expect("plans dir");
        fs::create_dir_all(&superpowers).expect("superpowers dir");
        fs::write(
            plans.join("same-instant.md"),
            "---\ntitle: Same instant\nstatus: draft\nupdated: 2026-11-05T02:00:00+02:00\n---\n",
        )
        .expect("offset plan");
        fs::write(
            plans.join("later.md"),
            "---\ntitle: Later\nstatus: draft\nupdated: 2026-11-05T00:30:00Z\n---\n",
        )
        .expect("later plan");
        fs::write(superpowers.join("old.md"), "# Old\n").expect("old plan");
        let plans = list(&root, None).expect("list");
        let later = plans
            .iter()
            .position(|plan| plan.id == "docs/plans/later.md")
            .expect("later plan");
        let same_instant = plans
            .iter()
            .position(|plan| plan.id == "docs/plans/same-instant.md")
            .expect("same instant plan");
        assert!(later < same_instant);
        let old = plans
            .iter()
            .find(|plan| plan.id == "docs/superpowers/plans/old.md")
            .expect("old plan");
        assert!(old.read_only);
        assert!(timestamp_millis(&old.updated).is_some());
        assert_eq!(
            timestamp_millis("2026-01-01T00:00:00Z"),
            Some(1_767_225_600_000)
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_oversized_body_and_escaping_plan_symlink() {
        let root = temp();
        let oversized = req("Too big", &"x".repeat(MAX_BODY + 1));
        assert!(write(&root, oversized)
            .expect_err("oversized body")
            .contains("256 KB"));

        let plans = root.join("docs/plans");
        fs::create_dir_all(&plans).expect("plans dir");
        let outside = root.parent().expect("temp parent").join(format!(
            "outside-{}-{}.md",
            std::process::id(),
            root.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
        ));
        fs::write(&outside, "# outside\n").expect("outside plan");
        let link = plans.join("escape.md");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &link)
            .unwrap_or_else(|error| panic!("test requires Windows symlink support: {error}"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link)
            .unwrap_or_else(|error| panic!("test requires symlink support: {error}"));
        assert!(read(&root, "docs/plans/escape.md")
            .expect_err("escaping link")
            .contains("escapes its root"));
        fs::remove_dir_all(root).expect("cleanup");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn temp_file_creation_does_not_follow_existing_symlink() {
        let root = temp();
        let target = root.join("plan.md");
        let outside = root.parent().expect("temp parent").join(format!(
            "outside-{}-{}.txt",
            std::process::id(),
            root.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
        ));
        fs::write(&outside, "unchanged").expect("outside file");
        let serial = u64::MAX;
        let link = temp_path(&target, serial);
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &link)
            .unwrap_or_else(|error| panic!("test requires Windows symlink support: {error}"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link)
            .unwrap_or_else(|error| panic!("test requires symlink support: {error}"));
        let error = create_temp_at(&target, serial).expect_err("must reject existing symlink");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&outside).expect("outside read"),
            "unchanged"
        );
        atomic_write(&target, "safe").expect("write around symlink temp");
        assert_eq!(
            fs::read_to_string(&outside).expect("outside read"),
            "unchanged"
        );
        fs::remove_dir_all(root).expect("cleanup");
        let _ = fs::remove_file(outside);
    }
    #[test]
    fn rejects_unsafe_ids_and_preserves_legacy_body() {
        let root = temp();
        fs::create_dir_all(root.join("docs/plans")).expect("dir");
        let absolute = root.join("outside.md");
        assert!(validate_id("../x.md", false).is_err());
        assert!(validate_id(absolute.to_str().expect("path"), false).is_err());
        assert!(validate_id("docs/plans/x.txt", false).is_err());
        assert!(validate_id("claude-global/x.md", true).is_err());
        let p = root.join("docs/plans/legacy.md");
        let body = "\n# Legacy\n- [ ] old\n";
        fs::write(&p, body).expect("legacy");
        set_status(&root, "docs/plans/legacy.md", "approved").expect("status");
        let text = fs::read_to_string(&p).expect("read");
        assert!(text.split_once("---\n").expect("fm").1.ends_with(body));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
