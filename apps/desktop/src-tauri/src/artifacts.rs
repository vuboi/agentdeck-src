use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use unicode_normalization::UnicodeNormalization;

const DIR: &str = "docs/artifacts";
const MAX_CONTENT: usize = 1024 * 1024;
const MAX_VERSIONS: usize = 50;
const TOOLS: [&str; 4] = [
    "artifact_create",
    "artifact_update",
    "artifact_list",
    "artifact_read",
];
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub n: u32,
    pub file: String,
    pub at: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub chat: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
    pub created: String,
    pub updated: String,
    pub versions: Vec<ArtifactVersion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListItem {
    pub id: String,
    pub path: String,
    pub title: String,
    pub kind: String,
    pub language: String,
    pub agent: String,
    pub chat: String,
    pub created: String,
    pub updated: String,
    pub versions: Vec<ArtifactVersion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRead {
    pub info: ArtifactInfo,
    pub content: String,
}

fn now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = duration.as_millis() as i64;
    let days = millis.div_euclid(86_400_000);
    let day_millis = millis.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
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
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_millis / 3_600_000,
        day_millis / 60_000 % 60,
        day_millis / 1_000 % 60,
        day_millis % 1_000
    )
}

fn slug(value: &str) -> String {
    let value = value
        .nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .flat_map(char::to_lowercase);
    let mut out = String::new();
    let mut dash = false;
    for c in value {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= 32 {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn extension(kind: &str, language: &str) -> Result<&'static str, String> {
    match kind {
        "html" => Ok("html"),
        "markdown" => Ok("md"),
        "svg" => Ok("svg"),
        "code" => {
            let ext = match language.to_ascii_lowercase().as_str() {
                "js" | "javascript" => "js",
                "ts" | "typescript" => "ts",
                "tsx" => "tsx",
                "jsx" => "jsx",
                "rs" | "rust" => "rs",
                "py" | "python" => "py",
                "css" => "css",
                "json" => "json",
                "sh" | "bash" => "sh",
                "html" => "html",
                "sql" => "sql",
                "toml" => "toml",
                "yaml" | "yml" => "yml",
                _ => "txt",
            };
            Ok(ext)
        }
        _ => Err("kind must be html, markdown, svg, or code".into()),
    }
}

fn valid_id(id: &str) -> bool {
    if id.contains("..") || id.contains('/') || id.contains('\\') {
        return false;
    }
    let mut parts = id.splitn(4, '-');
    let prefix = parts.next();
    let date = parts.next();
    let time = parts.next();
    let slug = parts.next();
    prefix == Some("a")
        && date.is_some_and(|value| value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit()))
        && time.is_some_and(|value| value.len() == 6 && value.bytes().all(|b| b.is_ascii_digit()))
        && slug.is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 32
                && !value.starts_with('-')
                && !value.ends_with('-')
                && value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn artifact_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid artifact id".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let base = canonical_root.join(DIR);
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_base.starts_with(&canonical_root) {
        return Err("artifact folder escapes project root".into());
    }
    let path = canonical_base.join(id);
    if path.exists() {
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&canonical_base) {
            return Err("artifact path escapes artifact folder".into());
        }
        Ok(canonical)
    } else {
        Ok(path)
    }
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    for _ in 0..100 {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temp = path.with_file_name(format!(".artifact-{}-{serial}.tmp", std::process::id()));
        let opened = OpenOptions::new().write(true).create_new(true).open(&temp);
        let mut file = match opened {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        };
        let result = file
            .write_all(text.as_bytes())
            .and_then(|_| file.sync_all());
        drop(file);
        if let Err(e) = result {
            let _ = fs::remove_file(&temp);
            return Err(e.to_string());
        }
        return fs::rename(&temp, path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            e.to_string()
        });
    }
    Err("could not allocate a unique temporary artifact file".into())
}

fn read_meta(root: &Path, id: &str) -> Result<(PathBuf, ArtifactInfo), String> {
    let dir = artifact_dir(root, id)?;
    let meta_path = dir.join("meta.json");
    let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let canonical_meta = meta_path.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "artifact not found".to_string()
        } else {
            e.to_string()
        }
    })?;
    if !canonical_meta.starts_with(&canonical_dir) {
        return Err("artifact metadata path escapes artifact folder".into());
    }
    let text = fs::read_to_string(canonical_meta).map_err(|e| e.to_string())?;
    let meta: ArtifactInfo =
        serde_json::from_str(&text).map_err(|e| format!("invalid artifact metadata: {e}"))?;
    if meta.id != id {
        return Err("artifact metadata id mismatch".into());
    }
    let ext = extension(&meta.kind, &meta.language)?;
    if meta.versions.is_empty()
        || meta
            .versions
            .iter()
            .any(|version| version.n == 0 || version.file != format!("v{}.{}", version.n, ext))
    {
        return Err("invalid artifact version metadata".into());
    }
    Ok((dir, meta))
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_CONTENT {
        Err("artifact version exceeds 1 MB".into())
    } else {
        Ok(())
    }
}

fn write_meta(path: &Path, meta: &ArtifactInfo) -> Result<(), String> {
    let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    atomic_write(&path.join("meta.json"), &text)
}

pub fn create(
    root: &Path,
    title: &str,
    kind: &str,
    content: &str,
    language: &str,
    agent: &str,
    chat: &str,
) -> Result<(ArtifactInfo, bool), String> {
    create_with_key(root, title, kind, content, language, agent, chat, None)
}

#[allow(clippy::too_many_arguments)]
pub fn create_with_key(
    root: &Path,
    title: &str,
    kind: &str,
    content: &str,
    language: &str,
    agent: &str,
    chat: &str,
    source_key: Option<&str>,
) -> Result<(ArtifactInfo, bool), String> {
    let _mutation = MUTATION_LOCK
        .lock()
        .map_err(|_| "artifact mutation lock is unavailable")?;
    validate_content(content)?;
    if source_key.is_some_and(|key| key.is_empty() || key.len() > 4096) {
        return Err("artifact source key must contain 1 to 4096 bytes".into());
    }
    if let Some(source_key) = source_key {
        for item in list(root)? {
            let (_, existing) = read_meta(root, &item.id)?;
            if existing.source_key.as_deref() == Some(source_key) {
                return Ok((existing, false));
            }
        }
    }
    let ext = extension(kind, language)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let base = root.join(DIR);
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_base.starts_with(&root) {
        return Err("artifact folder escapes project root".into());
    }
    let stamp = now();
    let compact: String = stamp
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect();
    let date = &compact[..8];
    let time = &compact[8..14];
    let base_slug = slug(title);
    let base_slug = if base_slug.is_empty() {
        "artifact"
    } else {
        &base_slug
    };
    let mut suffix = 1;
    let id = loop {
        let id_slug = if suffix == 1 {
            base_slug.to_string()
        } else {
            format!(
                "{}-{suffix}",
                base_slug
                    .chars()
                    .take(32usize.saturating_sub(suffix.to_string().len() + 1))
                    .collect::<String>()
            )
        };
        let id = format!("a-{date}-{time}-{id_slug}");
        if !canonical_base.join(&id).exists() {
            break id;
        }
        suffix += 1;
    };
    let dir = canonical_base.join(&id);
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let timestamp = now();
    let file = format!("v1.{ext}");
    atomic_write(&dir.join(&file), content)?;
    let meta = ArtifactInfo {
        id,
        title: title.to_string(),
        kind: kind.to_string(),
        language: language.to_string(),
        agent: agent.to_string(),
        chat: chat.to_string(),
        source_key: source_key.map(str::to_string),
        created: timestamp.clone(),
        updated: timestamp.clone(),
        versions: vec![ArtifactVersion {
            n: 1,
            file,
            at: timestamp,
            note: "first draft".into(),
        }],
    };
    write_meta(&dir, &meta)?;
    Ok((meta, false))
}

pub fn update(
    root: &Path,
    id: &str,
    content: &str,
    note: &str,
    base_version: Option<u32>,
) -> Result<(ArtifactInfo, bool), String> {
    let _mutation = MUTATION_LOCK
        .lock()
        .map_err(|_| "artifact mutation lock is unavailable")?;
    validate_content(content)?;
    let (dir, mut meta) = read_meta(root, id)?;
    let current = meta
        .versions
        .iter()
        .map(|v| v.n)
        .max()
        .ok_or("artifact has no versions")?;
    if let Some(base) = base_version {
        if base != current {
            return Err(format!(
                "artifact changed since you read it (version={current}); artifact_read again"
            ));
        }
    }
    let ext = extension(&meta.kind, &meta.language)?;
    let n = current
        .checked_add(1)
        .ok_or("artifact version number is out of range")?;
    let file = format!("v{n}.{ext}");
    atomic_write(&dir.join(&file), content)?;
    let timestamp = now();
    meta.versions.push(ArtifactVersion {
        n,
        file,
        at: timestamp.clone(),
        note: note.to_string(),
    });
    let mut removed_oldest = false;
    let mut removed_files = Vec::new();
    while meta.versions.len() > MAX_VERSIONS {
        if let Some(index) = meta.versions.iter().position(|v| v.n != 1) {
            let removed = meta.versions.remove(index);
            removed_files.push(removed.file);
            removed_oldest = true;
        } else {
            break;
        }
    }
    meta.updated = timestamp;
    write_meta(&dir, &meta)?;
    for file in removed_files {
        let _ = fs::remove_file(dir.join(file));
    }
    Ok((meta, removed_oldest))
}

pub fn list(root: &Path) -> Result<Vec<ArtifactListItem>, String> {
    let folder = root.join(DIR);
    if !folder.exists() {
        return Ok(Vec::new());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_folder = folder.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_folder.starts_with(&canonical_root) {
        return Err("artifact folder escapes project root".into());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(canonical_folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Ok((dir, meta)) = read_meta(root, &id) {
            items.push(ArtifactListItem {
                id: meta.id,
                path: dir.to_string_lossy().into_owned(),
                title: meta.title,
                kind: meta.kind,
                language: meta.language,
                agent: meta.agent,
                chat: meta.chat,
                created: meta.created,
                updated: meta.updated,
                versions: meta.versions,
            });
        }
    }
    items.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(items)
}

pub fn read(root: &Path, id: &str, version: Option<u32>) -> Result<(ArtifactInfo, String), String> {
    let (dir, meta) = read_meta(root, id)?;
    let version = match version {
        Some(n) => meta.versions.iter().find(|v| v.n == n),
        None => meta.versions.iter().max_by_key(|v| v.n),
    }
    .ok_or("artifact version not found")?;
    let path = dir.join(&version.file);
    let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let canonical_file = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_file.starts_with(canonical_dir) {
        return Err("artifact version path escapes artifact folder".into());
    }
    let content = fs::read_to_string(canonical_file).map_err(|e| e.to_string())?;
    Ok((meta, content))
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let (dir, _) = read_meta(root, id)?;
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

pub fn is_tool(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({"name":"artifact_create","description":"Show the user a self-contained HTML page, SVG, Markdown document or code file in AgentDeck's Canvas panel, next to the chat. Use for previews, mockups, diagrams and reports the user should look at; use normal file edits for project source code. HTML runs sandboxed with no network: inline all CSS/JS.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"title":{"type":"string"},"kind":{"type":"string","enum":["html","markdown","svg","code"]},"content":{"type":"string"},"language":{"type":"string"}},"required":["title","kind","content"]}}),
        json!({"name":"artifact_update","description":"Save a new version of an artifact. Use base_version from artifact_list/read to avoid overwriting a newer version.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"id":{"type":"string"},"content":{"type":"string"},"note":{"type":"string"},"base_version":{"type":"integer"}},"required":["id","content"]}}),
        json!({"name":"artifact_list","description":"List artifacts saved for this project in Canvas, including their latest version number.","inputSchema":{"type":"object","properties":{"root":{"type":"string"}},"required":[]}}),
        json!({"name":"artifact_read","description":"Read an artifact, optionally at a specific version, from Canvas.","inputSchema":{"type":"object","properties":{"root":{"type":"string"},"id":{"type":"string"},"version":{"type":"integer"}},"required":["id"]}}),
    ]
}

pub async fn call(
    app: &tauri::AppHandle,
    name: &str,
    args: &Value,
    chat: &str,
) -> Result<String, String> {
    let root = PathBuf::from(crate::index::root_of(chat, args)?);
    match name {
        "artifact_create" => {
            let (meta, _) = create(
                &root,
                args["title"].as_str().ok_or("title is required")?,
                args["kind"].as_str().ok_or("kind is required")?,
                args["content"].as_str().ok_or("content is required")?,
                args["language"].as_str().unwrap_or(""),
                "",
                chat,
            )?;
            let _ = app.emit(
                "artifact-changed",
                json!({"root":root,"id":meta.id,"version":1,"chat":chat}),
            );
            Ok(format!(
                "artifact {} v1 ({}) — shown in Canvas",
                meta.id, meta.kind
            ))
        }
        "artifact_update" => {
            let base_version = args["base_version"]
                .as_u64()
                .map(|value| u32::try_from(value).map_err(|_| "base_version is out of range"))
                .transpose()?;
            let (meta, removed) = update(
                &root,
                args["id"].as_str().ok_or("id is required")?,
                args["content"].as_str().ok_or("content is required")?,
                args["note"].as_str().unwrap_or(""),
                base_version,
            )?;
            let version = meta.versions.iter().map(|v| v.n).max().unwrap_or(1);
            let _ = app.emit(
                "artifact-changed",
                json!({"root":root,"id":meta.id,"version":version,"chat":chat}),
            );
            Ok(format!(
                "artifact {} v{}{}",
                meta.id,
                version,
                if removed {
                    " (oldest version removed; v1 retained)"
                } else {
                    ""
                }
            ))
        }
        "artifact_list" => Ok(list(&root)?
            .into_iter()
            .map(|m| {
                format!(
                    "{} | {} | {} | v{} | {} | {}",
                    m.id,
                    m.kind,
                    m.title,
                    m.versions.iter().map(|v| v.n).max().unwrap_or(1),
                    m.agent,
                    m.updated
                )
            })
            .collect::<Vec<_>>()
            .join("\n")),
        "artifact_read" => {
            let version = args["version"]
                .as_u64()
                .map(|value| u32::try_from(value).map_err(|_| "version is out of range"))
                .transpose()?;
            let (_, content) = read(&root, args["id"].as_str().ok_or("id is required")?, version)?;
            Ok(content)
        }
        _ => Err("unknown artifact tool".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn temp() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "agentdeck-artifacts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }
    #[test]
    fn creates_and_reads_versions_with_safe_id() {
        let root = temp();
        let (meta, _) = create(
            &root,
            "Landing Page!",
            "html",
            "<h1>Hello</h1>",
            "",
            "codex",
            "chat-1",
        )
        .expect("create");
        assert!(valid_id(&meta.id));
        assert_eq!(
            read(&root, &meta.id, Some(1)).expect("read").1,
            "<h1>Hello</h1>"
        );
        let (v2, _) = update(&root, &meta.id, "second", "edit", Some(1)).expect("update");
        assert_eq!(v2.versions.len(), 2);
        assert_eq!(read(&root, &meta.id, None).expect("latest").1, "second");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn rejects_bad_id_stale_version_and_oversized_content() {
        let root = temp();
        assert!(create(&root, "x", "html", &"x".repeat(MAX_CONTENT + 1), "", "", "").is_err());
        let (meta, _) = create(&root, "x", "html", "ok", "", "", "").expect("create");
        assert!(!valid_id("a-20261105-123456-"));
        assert!(!valid_id(
            &("a-20261105-123456-".to_string() + &"x".repeat(33))
        ));
        assert!(read(&root, "../escape", None).is_err());
        assert!(update(&root, &meta.id, "new", "", Some(0))
            .unwrap_err()
            .contains("changed"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_artifact_folder_symlink_outside_project() {
        let root = temp();
        let outside = temp();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).expect("create docs");
        let link = docs.join("artifacts");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        if linked.is_ok() {
            assert!(create(&root, "escape", "html", "x", "", "", "").is_err());
        }
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
    #[test]
    fn keeps_v1_and_caps_versions_at_fifty() {
        let root = temp();
        let (meta, _) = create(&root, "x", "code", "one", "txt", "", "").expect("create");
        for n in 1..50 {
            update(&root, &meta.id, "next", "", Some(n)).expect("update");
        }
        let (latest, _) = update(&root, &meta.id, "last", "", Some(50)).expect("rotate");
        assert_eq!(latest.versions.len(), 50);
        assert_eq!(latest.versions.first().map(|v| v.n), Some(1));
        assert!(latest.versions.iter().all(|v| v.n != 2));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_version_metadata_that_points_outside_artifact_directory() {
        let root = temp();
        let outside = root.join("keep.txt");
        fs::write(&outside, "keep").expect("write sentinel");
        let (mut meta, _) = create(&root, "x", "html", "one", "", "", "").expect("create");
        meta.versions[0].file = "../keep.txt".into();
        let dir = root.join(DIR).join(&meta.id);
        fs::write(
            dir.join("meta.json"),
            serde_json::to_vec(&meta).expect("serialize"),
        )
        .expect("tamper metadata");
        assert!(update(&root, &meta.id, "next", "", Some(1)).is_err());
        assert_eq!(fs::read_to_string(outside).expect("read sentinel"), "keep");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fallback_source_key_returns_existing_artifact_instead_of_creating_a_duplicate() {
        let root = temp();
        let first = create_with_key(
            &root,
            "Landing",
            "html",
            "<h1>Hello</h1>",
            "",
            "custom",
            "chat-1",
            Some("chat-1:message-7:0"),
        )
        .expect("first creation")
        .0;
        let repeated = create_with_key(
            &root,
            "Landing",
            "html",
            "<h1>Hello</h1>",
            "",
            "custom",
            "chat-1",
            Some("chat-1:message-7:0"),
        )
        .expect("repeat creation")
        .0;
        assert_eq!(first.id, repeated.id);
        assert_eq!(list(&root).expect("list").len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_updates_with_same_base_version_have_one_winner() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let root = temp();
        let (meta, _) = create(&root, "x", "html", "initial", "", "", "").expect("create");
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for content in ["first update", "second update"] {
            let root = root.clone();
            let id = meta.id.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                barrier.wait();
                update(&root, &id, content, "", Some(1))
            }));
        }
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().expect("worker should not panic"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .any(|error| error.contains("changed since you read it")));
        assert_eq!(list(&root).expect("list").len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
