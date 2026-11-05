//! Antigravity (agy) sessions: `~/.gemini/<variant>/brain/<conversation>/.system_generated/logs/transcript.jsonl`.
//!
//! One step per line: `{step_index, source, type, status, created_at, content?, thinking?, tool_calls?, *_tokens?}`.
//! `USER_INPUT` is the user's prompt and `PLANNER_RESPONSE` the model's turn (with its tool calls). Steps still
//! `RUNNING` are skipped until they finish. Tool results are not read yet: their payloads are protobuf, so the
//! transcript has no id to pair a result with its call.

use std::{collections::HashSet, path::Path, path::PathBuf};

use serde_json::Value;

use super::util::{assistant_slot, describe_tool, read_lines, strip_agentdeck_lead, truncate};
use super::{HistoryBlock, HistoryMessage, HistorySession, HistoryUsage, Source};

/// Every transcript under `root`, as `(conversation id, path)`. A missing folder yields nothing.
fn transcripts(root: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let Ok(variants) = std::fs::read_dir(root) else {
        return found;
    };
    for variant in variants.flatten() {
        let Ok(conversations) = std::fs::read_dir(variant.path().join("brain")) else {
            continue;
        };
        for conversation in conversations.flatten() {
            let path = conversation
                .path()
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            if path.is_file() {
                let id = conversation.file_name().to_string_lossy().into_owned();
                found.push((id, path));
            }
        }
    }
    found
}

/// One entry per conversation: the same id can sit in two app variants, and the first one found wins.
pub(super) fn list(root: &Path) -> Vec<HistorySession> {
    let mut seen = HashSet::new();
    transcripts(root)
        .into_iter()
        .filter(|(id, _)| seen.insert(id.clone()))
        .filter_map(|(id, path)| index_file(&id, &path))
        .collect()
}

fn index_file(conversation: &str, path: &Path) -> Option<HistorySession> {
    let lines = read_lines(path, |_| true).ok()?;
    let (mut count, mut title) = (0usize, None);
    let mut started = None;
    let mut updated = None;
    for line in &lines {
        let stamp = str_of(line, "created_at");
        if !stamp.is_empty() {
            started.get_or_insert(stamp);
            updated = Some(stamp.to_owned());
        }
        if let Some(text) = prompt_of(line) {
            count += 1;
            title.get_or_insert_with(|| truncate(&text, 80));
        } else if is_answer(line) {
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }

    Some(HistorySession {
        id: format!("antigravity:{conversation}"),
        source: Source::Antigravity,
        title: title.unwrap_or_else(|| "Untitled session".to_owned()),
        // The transcript does not name the model; the model is in the CLI's init event, not stored here.
        model: None,
        cwd: String::new(),
        is_project: false,
        started_at: started.map(str::to_owned),
        updated_at: updated,
        message_count: count,
        path: path.to_string_lossy().into_owned(),
        parent_id: None,
        fork_seq: None,
    })
}

/// The transcript of one conversation, in order. Consecutive model turns form one answer.
pub(super) fn load(path: &Path) -> std::io::Result<Vec<HistoryMessage>> {
    let lines = read_lines(path, |_| true)?;
    let mut messages: Vec<HistoryMessage> = Vec::new();
    for line in &lines {
        let step = line
            .get("step_index")
            .and_then(Value::as_u64)
            .map_or(String::new(), |step| step.to_string());
        if let Some(text) = prompt_of(line) {
            messages.push(HistoryMessage {
                id: format!("antigravity-{step}"),
                role: "user".into(),
                time: str_of(line, "created_at").to_owned(),
                blocks: vec![HistoryBlock::Response { text }],
                usage: None,
                model: None,
            });
            continue;
        }
        if !is_answer(line) {
            continue;
        }
        let index = assistant_slot(
            &mut messages,
            &format!("antigravity-{step}"),
            str_of(line, "created_at").to_owned(),
            None,
        );
        let answer = &mut messages[index];
        let thinking = str_of(line, "thinking");
        if !thinking.is_empty() {
            answer.blocks.push(HistoryBlock::Thinking {
                text: thinking.to_owned(),
            });
        }
        let content = str_of(line, "content");
        if !content.is_empty() {
            answer.blocks.push(HistoryBlock::Response {
                text: content.to_owned(),
            });
        }
        for call in line
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let args = call.get("args").cloned().unwrap_or(Value::Null);
            answer.blocks.push(HistoryBlock::Command {
                id: None,
                command: describe_tool(str_of(call, "name"), &args),
                output: String::new(),
                status: "ok".into(),
                change: None,
            });
        }
        // `input_tokens` is the whole prompt for the call, cached part included.
        let count = |key: &str| line.get(key).and_then(Value::as_u64).unwrap_or(0);
        HistoryUsage::merge(
            &mut answer.usage,
            Some(HistoryUsage {
                input: count("input_tokens"),
                output: count("output_tokens"),
                cache_read: count("cache_read_tokens"),
                cache_write: 0,
            }),
        );
    }
    Ok(messages)
}

/// The text the user typed, from a finished `USER_INPUT` step.
fn prompt_of(line: &Value) -> Option<String> {
    if str_of(line, "type") != "USER_INPUT" || str_of(line, "status") != "DONE" {
        return None;
    }
    let text = strip_agentdeck_lead(strip_request_tag(str_of(line, "content")));
    (!text.is_empty()).then_some(text)
}

/// Agy wraps the typed text in `<USER_REQUEST>…</USER_REQUEST>`; what follows the closing tag is app metadata.
fn strip_request_tag(content: &str) -> &str {
    const OPEN: &str = "<USER_REQUEST>";
    const CLOSE: &str = "</USER_REQUEST>";
    let Some(rest) = content.trim_start().strip_prefix(OPEN) else {
        return content;
    };
    rest.split_once(CLOSE)
        .map_or(rest, |(inner, _)| inner)
        .trim()
}

/// A finished model turn.
fn is_answer(line: &Value) -> bool {
    str_of(line, "type") == "PLANNER_RESPONSE" && str_of(line, "status") == "DONE"
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::strip_request_tag;

    #[test]
    fn the_request_tag_is_removed_and_metadata_after_it_is_dropped() {
        assert_eq!(
            strip_request_tag("<USER_REQUEST>\nread b.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"),
            "read b.txt"
        );
        assert_eq!(strip_request_tag("plain prompt"), "plain prompt");
    }
}
