//! Writes an AgentDeck chat as a new native session of Claude Code or Codex, so it can be continued in that CLI.
//!
//! Only ever creates a file under a new id. An existing native file is never opened for writing; the Codex index
//! gets one appended line under a lock. Each file is written to a temp file in its own folder, then renamed.
//! Tool calls and file edits become plain text summaries, never `tool_use` or `function_call` records, so resuming
//! the session cannot run anything again.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::util::truncate;
use super::{HistoryError, Roots};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Tool output kept in a summary: enough to see what happened, not a copy of the whole log.
const OUTPUT_SUMMARY: usize = 400;
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// A lock older than this was left by a process that died while holding it.
const LOCK_STALE: Duration = Duration::from_secs(30);

/// The CLI the chat is continued in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportTarget {
    Claude,
    Codex,
}

/// One part of a turn. Only what the export writes as text: thinking and other blocks are left out by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportBlock {
    Response {
        #[serde(default)]
        text: String,
    },
    Command {
        #[serde(default)]
        command: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        output: String,
        #[serde(default)]
        change: Option<ExportChange>,
    },
}

/// The file a tool call changed, with its line counts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ExportChange {
    pub path: String,
    #[serde(default)]
    pub added: usize,
    #[serde(default)]
    pub removed: usize,
}

/// One turn of the chat. `role` is `user` or `assistant`; other roles are not exported.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ExportTurn {
    pub role: String,
    /// ISO time as the chat recorded it, empty when unknown.
    #[serde(default)]
    pub time: String,
    pub blocks: Vec<ExportBlock>,
}

/// A whole chat to write: its title, the folder it resumes in, and its turns in order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ExportChat {
    pub title: String,
    pub cwd: String,
    pub turns: Vec<ExportTurn>,
}

/// The new native session and the command that resumes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub native_id: String,
    pub path: String,
    pub resume_command: String,
}

/// Writes `chat` as a new session of `target` under `roots`, and returns where it went.
pub fn export_chat(
    roots: &Roots,
    target: ExportTarget,
    chat: &ExportChat,
) -> Result<ExportResult, HistoryError> {
    if chat.cwd.trim().is_empty() {
        return Err(HistoryError::Invalid(
            "this chat has no folder to resume in".into(),
        ));
    }
    let turns: Vec<(&str, String, &str)> = chat
        .turns
        .iter()
        .filter(|turn| matches!(turn.role.as_str(), "user" | "assistant"))
        .filter_map(|turn| {
            let text = turn_text(turn);
            (!text.is_empty()).then_some((turn.role.as_str(), text, turn.time.as_str()))
        })
        .collect();
    if turns.is_empty() {
        return Err(HistoryError::Invalid(
            "this chat has no text to export".into(),
        ));
    }
    let title = chat.title.trim();
    let title = if title.is_empty() {
        "AgentDeck chat"
    } else {
        title
    };
    match target {
        ExportTarget::Claude => write_claude(roots, title, chat.cwd.trim(), &turns),
        ExportTarget::Codex => write_codex(roots, title, chat.cwd.trim(), &turns),
    }
}

/// The turn as plain text. Tool calls and file edits are described, not replayed.
fn turn_text(turn: &ExportTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(block_text)
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_owned()
}

fn block_text(block: &ExportBlock) -> Option<String> {
    match block {
        ExportBlock::Response { text } => {
            Some(text.trim().to_owned()).filter(|text| !text.is_empty())
        }
        ExportBlock::Command {
            command,
            status,
            output,
            change,
        } => {
            let mut lines = vec![format!(
                "[Earlier tool call, not re-run: `{}` ({})]",
                command.trim(),
                if status.is_empty() { "unknown" } else { status }
            )];
            let output = output.trim();
            if !output.is_empty() {
                lines.push(format!("[Output: {}]", truncate(output, OUTPUT_SUMMARY)));
            }
            if let Some(change) = change {
                lines.push(format!(
                    "[Earlier file change: {} (+{} / -{})]",
                    change.path, change.added, change.removed
                ));
            }
            Some(lines.join("\n"))
        }
    }
}

fn write_claude(
    roots: &Roots,
    title: &str,
    cwd: &str,
    turns: &[(&str, String, &str)],
) -> Result<ExportResult, HistoryError> {
    let id = Uuid::new_v4().to_string();
    let dir = roots.claude.join(claude_folder(cwd));
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.jsonl"));

    let now = stamp(SystemTime::now());
    let mut lines = vec![json!({"type": "custom-title", "customTitle": title, "sessionId": id})];
    let mut parent = Value::Null;
    for (role, text, time) in turns {
        let uuid = Uuid::new_v4().to_string();
        let message = if *role == "user" {
            json!({"role": "user", "content": text})
        } else {
            json!({
                "id": format!("msg_{}", uuid.replace('-', "")),
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "stop_sequence": null
            })
        };
        let stamp_value = if time.is_empty() {
            now.clone()
        } else {
            (*time).to_owned()
        };
        lines.push(json!({
            "parentUuid": parent,
            "isSidechain": false,
            "type": role,
            "message": message,
            "uuid": uuid.clone(),
            "timestamp": stamp_value,
            "sessionId": id,
            "cwd": cwd,
            "version": VERSION,
            "userType": "external",
            "entrypoint": "cli"
        }));
        parent = Value::String(uuid);
    }

    write_new(&path, &jsonl(&lines))?;
    Ok(ExportResult {
        resume_command: format!("claude --resume {id}"),
        native_id: id,
        path: path.to_string_lossy().into_owned(),
    })
}

fn write_codex(
    roots: &Roots,
    title: &str,
    cwd: &str,
    turns: &[(&str, String, &str)],
) -> Result<ExportResult, HistoryError> {
    let id = Uuid::new_v4().to_string();
    let now = SystemTime::now();
    let (year, month, day, hour, minute, second) = parts(now);
    let dir = roots
        .codex
        .join(format!("{year:04}"))
        .join(format!("{month:02}"))
        .join(format!("{day:02}"));
    fs::create_dir_all(&dir)?;
    let stamp_text = stamp(now);
    let path = dir.join(format!(
        "rollout-{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}-{id}.jsonl"
    ));

    let mut lines = vec![json!({
        "timestamp": stamp_text,
        "type": "session_meta",
        "payload": {
            "id": id,
            "timestamp": stamp_text,
            "cwd": cwd,
            "originator": "exec",
            "cli_version": VERSION,
            "source": "exec"
        }
    })];
    for (role, text, time) in turns {
        let kind = if *role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        let stamp_value = if time.is_empty() {
            stamp_text.clone()
        } else {
            (*time).to_owned()
        };
        lines.push(json!({
            "timestamp": stamp_value,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [{"type": kind, "text": text}]
            }
        }));
    }

    write_new(&path, &jsonl(&lines))?;
    if let Err(error) = append_index(&roots.codex_index, &id, title, &stamp_text) {
        // The index is what names the session; without its line the rollout is only an orphan file, so remove it.
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(ExportResult {
        resume_command: format!("codex resume {id}"),
        native_id: id,
        path: path.to_string_lossy().into_owned(),
    })
}

/// Claude's folder name for a working folder: every character that is not a letter or digit becomes `-`.
fn claude_folder(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn jsonl(lines: &[Value]) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&line.to_string());
        out.push('\n');
    }
    out
}

/// Writes a file that must not exist yet: temp file in the same folder, then rename.
fn write_new(path: &Path, body: &str) -> Result<(), HistoryError> {
    if path.exists() {
        return Err(HistoryError::Invalid(
            "a native session with this id already exists".into(),
        ));
    }
    let folder = path
        .parent()
        .ok_or_else(|| HistoryError::Invalid("the session path has no folder".into()))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = folder.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result: std::io::Result<()> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(HistoryError::from)
}

/// Appends one line to Codex's `session_index.jsonl` while holding `session_index.jsonl.lock`.
fn append_index(index: &Path, id: &str, title: &str, updated: &str) -> Result<(), HistoryError> {
    if let Some(folder) = index.parent() {
        fs::create_dir_all(folder)?;
    }
    let _lock = IndexLock::take(index)?;
    let mut line = json!({"id": id, "thread_name": title, "updated_at": updated}).to_string();
    line.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(index)?;
    // A line the CLI left unfinished must not run into ours.
    if file.metadata()?.len() > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            line.insert(0, '\n');
        }
    }
    file.write_all(line.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// An exclusive lock file next to the index: created with `create_new`, removed on drop.
struct IndexLock(PathBuf);

impl IndexLock {
    fn take(index: &Path) -> Result<Self, HistoryError> {
        let mut name = index.file_name().unwrap_or_default().to_os_string();
        name.push(".lock");
        let path = index.with_file_name(name);
        let start = Instant::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > LOCK_STALE);
                    if stale {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if start.elapsed() > LOCK_WAIT {
                        return Err(HistoryError::Invalid(
                            "the Codex session index is locked by another process".into(),
                        ));
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` in UTC, the form the CLIs write.
fn stamp(at: SystemTime) -> String {
    let (year, month, day, hour, minute, second) = parts(at);
    let millis = at
        .duration_since(UNIX_EPOCH)
        .map(|age| age.subsec_millis())
        .unwrap_or(0);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// UTC calendar fields of a time.
fn parts(at: SystemTime) -> (i64, u32, u32, u32, u32, u32) {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .map(|age| age.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil(secs.div_euclid(86_400));
    let rest = secs.rem_euclid(86_400);
    (
        year,
        month,
        day,
        (rest / 3_600) as u32,
        (rest % 3_600 / 60) as u32,
        (rest % 60) as u32,
    )
}

/// Year, month and day of a count of days since 1970-01-01 (proleptic Gregorian calendar).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::super::{claude, codex, HistoryBlock, Roots, Source};
    use super::*;

    /// A throwaway home folder: nothing outside it is touched.
    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ag-export-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("temp home");
            Self(path)
        }

        fn roots(&self) -> Roots {
            Roots::from_home(&self.0)
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn response(text: &str) -> ExportBlock {
        ExportBlock::Response { text: text.into() }
    }

    fn turn(role: &str, blocks: Vec<ExportBlock>) -> ExportTurn {
        ExportTurn {
            role: role.into(),
            time: String::new(),
            blocks,
        }
    }

    fn chat(home: &TempHome, turns: Vec<ExportTurn>) -> ExportChat {
        ExportChat {
            title: "Chat title".into(),
            cwd: home.0.join("project").to_string_lossy().into_owned(),
            turns,
        }
    }

    /// The (role, text) pairs a reader returns, text joined per message.
    fn texts(messages: &[super::super::HistoryMessage]) -> Vec<(String, String)> {
        messages
            .iter()
            .map(|message| {
                let text = message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        HistoryBlock::Response { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                (message.role.clone(), text)
            })
            .collect()
    }

    fn expected(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(role, text)| ((*role).to_owned(), (*text).to_owned()))
            .collect()
    }

    fn sample_turns() -> Vec<ExportTurn> {
        vec![
            turn("user", vec![response("Xin chào, hãy đọc README")]),
            turn("assistant", vec![response("Đã đọc. Dự án dùng Tauri.")]),
            turn("user", vec![response("Tóm tắt kiến trúc")]),
            turn("assistant", vec![response("Ba lớp: UI, adapter, store.")]),
        ]
    }

    /// A native Claude session written the way the CLI writes it, as the file that must stay byte-identical.
    fn write_fixture_claude(roots: &Roots, cwd: &str) -> (PathBuf, Vec<u8>) {
        let folder = roots.claude.join(claude_folder(cwd));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("11111111-2222-4333-8444-555555555555.jsonl");
        let body = concat!(
            r#"{"type":"user","uuid":"a1","parentUuid":null,"isSidechain":false,"message":{"role":"user","content":"native question"},"timestamp":"2026-10-01T10:00:00.000Z","sessionId":"11111111-2222-4333-8444-555555555555","cwd":"CWD"}"#, "\n",
            r#"{"type":"assistant","uuid":"a2","parentUuid":"a1","isSidechain":false,"message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"native answer"}]},"timestamp":"2026-10-01T10:00:05.000Z","sessionId":"11111111-2222-4333-8444-555555555555","cwd":"CWD"}"#, "\n",
        )
        .replace("CWD", &cwd.replace('\\', "\\\\"));
        fs::write(&path, &body).unwrap();
        (path, body.into_bytes())
    }

    #[test]
    fn claude_export_round_trips_through_the_reader() {
        let home = TempHome::new();
        let roots = home.roots();
        let cwd = home.0.join("project").to_string_lossy().into_owned();
        let (fixture, before) = write_fixture_claude(&roots, &cwd);

        let result = export_chat(&roots, ExportTarget::Claude, &chat(&home, sample_turns()))
            .expect("export");

        assert_eq!(
            fs::read(&fixture).unwrap(),
            before,
            "existing native file changed"
        );
        assert_ne!(result.native_id, "11111111-2222-4333-8444-555555555555");
        assert_eq!(
            result.resume_command,
            format!("claude --resume {}", result.native_id)
        );
        let path = PathBuf::from(&result.path);
        assert_eq!(
            path.parent(),
            Some(roots.claude.join(claude_folder(&cwd)).as_path())
        );

        let sessions = claude::list(&roots.claude, &roots.index.join("claude.json"));
        let session = sessions
            .iter()
            .find(|session| session.id == format!("claude:{}", result.native_id))
            .expect("the new session is listed");
        assert_eq!(session.title, "Chat title");
        assert_eq!(session.source, Source::Claude);

        let messages = claude::load(&path).expect("load");
        assert_eq!(
            texts(&messages),
            expected(&[
                ("user", "Xin chào, hãy đọc README"),
                ("assistant", "Đã đọc. Dự án dùng Tauri."),
                ("user", "Tóm tắt kiến trúc"),
                ("assistant", "Ba lớp: UI, adapter, store."),
            ])
        );
    }

    #[test]
    fn claude_export_writes_no_tool_records() {
        let home = TempHome::new();
        let roots = home.roots();
        let turns = vec![
            turn("user", vec![response("Sửa file")]),
            turn(
                "assistant",
                vec![
                    ExportBlock::Command {
                        command: "rm -rf build".into(),
                        status: "ok".into(),
                        output: "removed".into(),
                        change: Some(ExportChange {
                            path: "src/lib.rs".into(),
                            added: 2,
                            removed: 1,
                        }),
                    },
                    response("Đã xong."),
                ],
            ),
        ];
        let result =
            export_chat(&roots, ExportTarget::Claude, &chat(&home, turns)).expect("export");
        let body = fs::read_to_string(&result.path).unwrap();

        assert!(!body.contains("tool_use"), "tool_use record written");
        assert!(!body.contains("tool_result"), "tool_result record written");
        assert!(body.contains("[Earlier tool call, not re-run: `rm -rf build` (ok)]"));
        assert!(body.contains("[Earlier file change: src/lib.rs (+2 / -1)]"));

        let messages = claude::load(Path::new(&result.path)).expect("load");
        assert!(texts(&messages).last().unwrap().1.contains("Đã xong."));
    }

    #[test]
    fn claude_export_refuses_an_existing_id() {
        let home = TempHome::new();
        let roots = home.roots();
        let dir = roots.claude.join("x");
        fs::create_dir_all(&dir).unwrap();
        let existing = dir.join("taken.jsonl");
        fs::write(&existing, "keep me").unwrap();

        let error = write_new(&existing, "new body").unwrap_err();
        assert!(matches!(error, HistoryError::Invalid(_)));
        assert_eq!(fs::read_to_string(&existing).unwrap(), "keep me");
    }

    #[test]
    fn codex_export_round_trips_through_the_reader() {
        let home = TempHome::new();
        let roots = home.roots();
        // An existing rollout and index line, which must survive the export unchanged.
        let fixture_dir = roots.codex.join("2026").join("10").join("01");
        fs::create_dir_all(&fixture_dir).unwrap();
        let fixture = fixture_dir.join("rollout-2026-10-01T10-00-00-aaaa-bbbb.jsonl");
        let fixture_body = concat!(
            r#"{"timestamp":"2026-10-01T10:00:00.000Z","type":"session_meta","payload":{"id":"aaaa-bbbb","timestamp":"2026-10-01T10:00:00.000Z","cwd":"/x"}}"#,
            "\n",
            r#"{"timestamp":"2026-10-01T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"native"}]}}"#,
            "\n",
        );
        fs::write(&fixture, fixture_body).unwrap();
        let index_before = "{\"id\":\"aaaa-bbbb\",\"thread_name\":\"native\"}\n";
        fs::write(&roots.codex_index, index_before).unwrap();

        let result =
            export_chat(&roots, ExportTarget::Codex, &chat(&home, sample_turns())).expect("export");

        assert_eq!(fs::read_to_string(&fixture).unwrap(), fixture_body);
        assert_eq!(
            result.resume_command,
            format!("codex resume {}", result.native_id)
        );
        let index_after = fs::read_to_string(&roots.codex_index).unwrap();
        assert!(
            index_after.starts_with(index_before),
            "index line was not appended"
        );
        assert!(index_after.contains(&result.native_id));
        assert!(!roots
            .codex_index
            .with_file_name("session_index.jsonl.lock")
            .exists());

        let path = PathBuf::from(&result.path);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("rollout-") && name.ends_with(&format!("-{}.jsonl", result.native_id))
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("function_call"));

        let sessions = codex::list(
            &roots.codex,
            &roots.codex_index,
            &roots.index.join("codex.json"),
        );
        let session = sessions
            .iter()
            .find(|session| session.id == format!("codex:{}", result.native_id))
            .expect("the new session is listed");
        assert_eq!(session.title, "Chat title");

        let messages = codex::load(&path).expect("load");
        assert_eq!(
            texts(&messages),
            expected(&[
                ("user", "Xin chào, hãy đọc README"),
                ("assistant", "Đã đọc. Dự án dùng Tauri."),
                ("user", "Tóm tắt kiến trúc"),
                ("assistant", "Ba lớp: UI, adapter, store."),
            ])
        );
    }

    #[test]
    fn codex_export_gets_a_new_id_each_time() {
        let home = TempHome::new();
        let roots = home.roots();
        let first = export_chat(&roots, ExportTarget::Codex, &chat(&home, sample_turns())).unwrap();
        let second =
            export_chat(&roots, ExportTarget::Codex, &chat(&home, sample_turns())).unwrap();
        assert_ne!(first.native_id, second.native_id);
        let index = fs::read_to_string(&roots.codex_index).unwrap();
        assert_eq!(index.lines().count(), 2);
    }

    #[test]
    fn an_empty_chat_or_a_chat_without_a_folder_is_refused() {
        let home = TempHome::new();
        let roots = home.roots();
        let empty = chat(&home, vec![turn("user", vec![response("   ")])]);
        assert!(export_chat(&roots, ExportTarget::Claude, &empty).is_err());

        let mut no_folder = chat(&home, sample_turns());
        no_folder.cwd = " ".into();
        assert!(export_chat(&roots, ExportTarget::Codex, &no_folder).is_err());
        assert!(
            !roots.codex.exists(),
            "nothing written for a refused export"
        );
    }

    #[test]
    fn stamps_use_the_utc_calendar() {
        // 2026-11-02 is 20_759 days after the epoch.
        assert_eq!(civil(20_759), (2026, 11, 2));
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(11_016), (2000, 2, 29));
    }
}
