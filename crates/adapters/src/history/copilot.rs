//! GitHub Copilot CLI sessions: `~/.copilot/session-state/<uuid>/events.jsonl`.
//!
//! One event per line: `{type, id, parentId, timestamp, data}`. The transcript is the `user.message`,
//! `assistant.message` (text, reasoning and tool requests) and `tool.execution_complete` (tool output)
//! events. `session.usage_record` carries the tokens of each model call. Everything else is skipped.

use std::{collections::HashMap, path::Path};

use serde_json::Value;

use super::util::{
    assistant_slot, describe_tool, read_lines, strip_agentdeck_lead, strip_ansi, truncate,
};
use super::{HistoryBlock, HistoryMessage, HistorySession, HistoryUsage, Source};

const OUTPUT_LIMIT: usize = 6_000;

/// Only these events matter; a session file also holds bookkeeping that is not part of the chat.
fn wanted(line: &str) -> bool {
    [
        "\"type\":\"session.start\"",
        "\"type\":\"user.message\"",
        "\"type\":\"assistant.message\"",
        "\"type\":\"tool.execution_complete\"",
        "\"type\":\"session.usage_record\"",
    ]
    .iter()
    .any(|marker| line.contains(marker))
}

/// Every session folder under `root`. A missing folder yields nothing.
pub(super) fn list(root: &Path) -> Vec<HistorySession> {
    let Ok(folders) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    folders
        .flatten()
        .filter_map(|folder| {
            let id = folder.file_name().to_string_lossy().into_owned();
            index_file(&folder.path().join("events.jsonl"), &id)
        })
        .collect()
}

fn index_file(path: &Path, id: &str) -> Option<HistorySession> {
    let lines = read_lines(path, wanted).ok()?;
    let start = lines
        .iter()
        .find(|line| str_of(line, "type") == "session.start")?
        .get("data")?;
    let context = start.get("context").unwrap_or(&Value::Null);

    let (mut count, mut title) = (0usize, None);
    let mut updated = None;
    for line in &lines {
        let stamp = str_of(line, "timestamp");
        if !stamp.is_empty() {
            updated = Some(stamp.to_owned());
        }
        if let Some(text) = prompt_of(line) {
            count += 1;
            title.get_or_insert_with(|| truncate(&text, 80));
        } else if str_of(line, "type") == "assistant.message" {
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }

    Some(HistorySession {
        id: format!("copilot:{id}"),
        source: Source::Copilot,
        title: title.unwrap_or_else(|| "Untitled session".to_owned()),
        model: Some(str_of(start, "selectedModel").to_owned()).filter(|model| !model.is_empty()),
        cwd: str_of(context, "cwd").to_owned(),
        is_project: false,
        started_at: Some(str_of(start, "startTime").to_owned()).filter(|stamp| !stamp.is_empty()),
        updated_at: updated,
        message_count: count,
        path: path.to_string_lossy().into_owned(),
        parent_id: None,
        fork_seq: None,
    })
}

/// The transcript of one session, in order. Consecutive assistant events form one answer.
pub(super) fn load(path: &Path) -> std::io::Result<Vec<HistoryMessage>> {
    let lines = read_lines(path, wanted)?;
    let mut messages: Vec<HistoryMessage> = Vec::new();
    // toolCallId -> (message index, block index), so a completion finds the command it ends.
    let mut pending: HashMap<String, (usize, usize)> = HashMap::new();

    for line in &lines {
        let data = line.get("data").unwrap_or(&Value::Null);
        match str_of(line, "type") {
            "user.message" => {
                if let Some(text) = prompt_of(line) {
                    messages.push(HistoryMessage {
                        id: str_of(data, "messageId").to_owned(),
                        role: "user".into(),
                        time: str_of(line, "timestamp").to_owned(),
                        blocks: vec![HistoryBlock::Response { text }],
                        usage: None,
                        model: None,
                    });
                }
            }
            "assistant.message" => {
                let model =
                    Some(str_of(data, "model").to_owned()).filter(|model| !model.is_empty());
                let index = assistant_slot(
                    &mut messages,
                    str_of(data, "messageId"),
                    str_of(line, "timestamp").to_owned(),
                    model,
                );
                let reasoning = str_of(data, "reasoningText");
                if !reasoning.is_empty() {
                    messages[index].blocks.push(HistoryBlock::Thinking {
                        text: reasoning.to_owned(),
                    });
                }
                let content = str_of(data, "content");
                if !content.is_empty() {
                    messages[index].blocks.push(HistoryBlock::Response {
                        text: content.to_owned(),
                    });
                }
                for request in data
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let name = tool_name(str_of(request, "name"));
                    let arguments = request.get("arguments").cloned().unwrap_or(Value::Null);
                    messages[index].blocks.push(HistoryBlock::Command {
                        id: None,
                        command: describe_tool(name, &arguments),
                        output: String::new(),
                        status: "ok".into(),
                        change: None,
                    });
                    let call_id = str_of(request, "toolCallId");
                    if !call_id.is_empty() {
                        let block = messages[index].blocks.len() - 1;
                        pending.insert(call_id.to_owned(), (index, block));
                    }
                }
            }
            "tool.execution_complete" => {
                if let Some(&(index, block)) = pending.get(str_of(data, "toolCallId")) {
                    attach_output(&mut messages, index, block, data);
                }
            }
            "session.usage_record" => {
                let usage = data.get("usage").unwrap_or(&Value::Null);
                let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                if let Some(answer) = messages
                    .last_mut()
                    .filter(|message| message.role == "assistant")
                {
                    HistoryUsage::merge(
                        &mut answer.usage,
                        Some(HistoryUsage {
                            input: count("inputTokens"),
                            output: count("outputTokens"),
                            cache_read: count("cacheReadTokens"),
                            cache_write: count("cacheWriteTokens"),
                        }),
                    );
                }
            }
            _ => {}
        }
    }
    Ok(messages)
}

/// The output of a finished tool call. A `success: false` result is a failure.
fn attach_output(messages: &mut [HistoryMessage], index: usize, block: usize, data: &Value) {
    let Some(HistoryBlock::Command { output, status, .. }) = messages
        .get_mut(index)
        .and_then(|message| message.blocks.get_mut(block))
    else {
        return;
    };
    let text = data
        .get("result")
        .and_then(|result| result.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    *output = truncate(&strip_ansi(text), OUTPUT_LIMIT);
    if data.get("success").and_then(Value::as_bool) == Some(false) {
        *status = "fail".into();
    }
}

/// The text the user typed. A sub-agent prompt (`parentAgentTaskId`) is AgentDeck's own, not the user's.
fn prompt_of(line: &Value) -> Option<String> {
    if str_of(line, "type") != "user.message" {
        return None;
    }
    let data = line.get("data")?;
    if data
        .get("parentAgentTaskId")
        .is_some_and(|id| !id.is_null())
    {
        return None;
    }
    let text = strip_agentdeck_lead(str_of(data, "content"));
    (!text.is_empty()).then_some(text)
}

/// Copilot's tool names, mapped to the names the chat view already knows.
fn tool_name(name: &str) -> &str {
    match name {
        "powershell" | "bash" => "Bash",
        "view" => "Read",
        "create" => "Write",
        "edit" => "Edit",
        "grep" => "Grep",
        "glob" => "Glob",
        other => other,
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
