//! Command Code CLI (`command-code`), driven headless with its official `-p --output-format json` stream.
//!
//! The CLI keeps its own sign-in (`command-code login`), so AgentDeck never reads or passes the account token. The
//! stream is newline-delimited: `{"type":"event","event":{...}}` frames while the turn runs, then one
//! `{"type":"result",...}` line that ends it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use super::{
    allow_entry, summarize_tool_input, AgentEvent, FileSnapshot, PermissionRequest, Provider,
    TaskStatus, TurnRequest, SERVE_CONTEXT,
};

#[derive(Default)]
pub struct CommandCode {
    root: Mutex<Option<PathBuf>>,
    /// Before-images of file writes whose start event only had a path, keyed by tool call id.
    file_snapshots: Mutex<HashMap<String, FileSnapshot>>,
    /// `agent` calls started with `run_in_background`, by tool call id, with their description.
    background_calls: Mutex<HashMap<String, String>>,
    /// Background agents still running: their `agent_id` and the tool call that started them.
    open_agents: Mutex<Vec<(String, String)>>,
}

const LANGUAGE_CONTEXT: &str =
    "Reply in the same language as the user's latest message. If the user writes Vietnamese, reply in Vietnamese with proper diacritics.";

/// Writes AgentDeck's bridge into `.mcp.json` as `mcpServers.agentdeck`. Other servers stay as they are.
fn ensure_bridge_server(path: &std::path::Path, url: &str) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    let mut file: Value = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| Error::new(ErrorKind::InvalidData, error))?,
        Err(error) if error.kind() == ErrorKind::NotFound => Value::Object(Default::default()),
        Err(error) => return Err(error),
    };
    let wanted = serde_json::json!({ "type": "http", "url": url });
    let root = file
        .as_object_mut()
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "mcp config is not an object"))?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Default::default()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "mcpServers is not an object"))?;
    if servers.get("agentdeck") == Some(&wanted) {
        return Ok(());
    }
    servers.insert("agentdeck".into(), wanted);
    let text = serde_json::to_string_pretty(&file)
        .map_err(|error| Error::new(ErrorKind::InvalidData, error))?;
    std::fs::write(path, text + "\n")
}

impl Provider for CommandCode {
    fn id(&self) -> &'static str {
        "command-code"
    }

    fn binary(&self) -> &'static str {
        // The npm package installs `command-code.cmd` on Windows; `cmd` there is the built-in shell.
        "command-code"
    }

    fn candidates(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn args(&self, req: &TurnRequest) -> Vec<String> {
        // The prompt goes to stdin (`prompt_on_stdin`): `-p` without a query reads it there.
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
            "--trust".to_string(),
            "--skip-onboarding".to_string(),
            "--no-auto-update".to_string(),
        ];
        if let Some(id) = req.session_id.as_ref().filter(|_| req.resume) {
            args.push("--session".to_string());
            args.push(id.clone());
        }
        if let Some(model) = &req.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if let Some(effort) = &req.effort {
            args.push("--effort".to_string());
            args.push(effort.clone());
        }
        if let Some(mode) =
            super::permission::Mode::parse(req.permission_mode.as_deref()).commandcode()
        {
            args.push("--permission-mode".to_string());
            args.push(mode.to_string());
        }
        args
    }

    fn prompt_on_stdin(&self) -> bool {
        true
    }

    fn opening_context(&self, _req: &TurnRequest) -> Option<String> {
        Some(format!(
            "{LANGUAGE_CONTEXT}{}{}{SERVE_CONTEXT}",
            super::claude::ASK_CONTEXT,
            super::claude::WORK_CONTEXT
        ))
    }

    fn prepare(&self, req: &TurnRequest) -> Result<(), String> {
        if let Ok(mut root) = self.root.lock() {
            *root = req.cwd.clone();
        }
        // The CLI reads its MCP servers from the project's `.mcp.json`: AgentDeck's bridge goes there, beside the others.
        if let (Ok(bridge), Some(folder)) = (std::env::var("AGENTDECK_BRIDGE"), req.cwd.as_deref())
        {
            let url = super::mcp_url(&bridge, None, Some(folder));
            // A file that is not a JSON object is the user's: it is left as it is.
            let _ = ensure_bridge_server(&folder.join(".mcp.json"), &url);
        }
        if let Ok(mut snapshots) = self.file_snapshots.lock() {
            snapshots.clear();
        }
        Ok(())
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value["type"].as_str() {
            Some("event") => self.parse_event(&value["event"]),
            Some("result") => {
                // `-p` exits with its turn: a background agent nobody reported on ends with it.
                let mut events = self.stop_open_agents();
                events.extend(parse_result(&value));
                events
            }
            _ => Vec::new(),
        }
    }
}

impl CommandCode {
    fn parse_event(&self, event: &Value) -> Vec<AgentEvent> {
        match event["type"].as_str().unwrap_or_default() {
            "run_start" => text_field(event, "sessionId")
                .map(|session_id| vec![AgentEvent::Session { session_id }])
                .unwrap_or_default(),
            "text_delta" => text_field(event, "delta")
                .map(|text| vec![AgentEvent::Delta { text }])
                .unwrap_or_default(),
            "thinking_delta" => text_field(event, "delta")
                .map(|text| vec![AgentEvent::Thinking { text }])
                .unwrap_or_default(),
            "tool_queued" => self.tool_call(event),
            "tool_completed" => self.tool_finished(event, false),
            "tool_errored" => self.tool_finished(event, true),
            "tool_denied" => {
                let id = text_field(event, "toolCallId").unwrap_or_default();
                let raw_name = text_field(event, "toolName").unwrap_or_default();
                let name = canonical_tool(&raw_name);
                let input = &event["input"];
                vec![
                    AgentEvent::ToolResult {
                        id: id.clone(),
                        output: "Not allowed in this permission mode".into(),
                        is_error: true,
                        image: None,
                        change: None,
                    },
                    AgentEvent::PermissionDenied {
                        requests: vec![PermissionRequest {
                            id,
                            tool: name.to_owned(),
                            summary: summarize_tool_input(name, input),
                            allow: allow_entry(name, input),
                        }],
                    },
                ]
            }
            "run_error" => vec![AgentEvent::Error {
                message: event["error"]["message"]
                    .as_str()
                    .or_else(|| event["error"].as_str())
                    .unwrap_or("Command Code turn failed")
                    .to_owned(),
            }],
            _ => Vec::new(),
        }
    }

    fn tool_call(&self, event: &Value) -> Vec<AgentEvent> {
        let id = text_field(event, "toolCallId").unwrap_or_default();
        let name = canonical_tool(&text_field(event, "toolName").unwrap_or_default()).to_owned();
        let input = &event["input"];
        let background = input["run_in_background"].as_bool().unwrap_or(false);
        if background && name == "Agent" {
            if let Ok(mut calls) = self.background_calls.lock() {
                let label = input["description"].as_str().unwrap_or("Background agent");
                calls.insert(id.clone(), label.to_owned());
            }
        }
        let root = self.root.lock().ok().and_then(|root| root.clone());
        let snapshot = super::begin_file_snapshot(root.as_deref(), &name, input);
        let change = match snapshot {
            Some(snapshot) => {
                if let Ok(mut snapshots) = self.file_snapshots.lock() {
                    snapshots.insert(id.clone(), snapshot);
                }
                None
            }
            None => super::file_change(&name, input),
        };
        vec![AgentEvent::ToolCall {
            input: super::summarize_tool_input(&name, input),
            id,
            name,
            change,
            // A shell call the agent started with `run_in_background` keeps running after its call returns.
            background,
        }]
    }

    /// Command Code reports a background agent only in text: its launch result names the `agent_id`, and
    /// `agent_output` lists `<agent_id> [<status>] ...`. These become task events, the only thing that ends its row.
    fn background_tasks(&self, call_id: &str, output: &str, is_error: bool) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        let label = self
            .background_calls
            .lock()
            .ok()
            .and_then(|mut calls| calls.remove(call_id));
        let Ok(mut open) = self.open_agents.lock() else {
            return events;
        };
        if let (Some(label), false) = (label, is_error) {
            let agent_id = output
                .lines()
                .find_map(|line| line.trim().strip_prefix("agent_id:"))
                .map(str::trim)
                .filter(|id| !id.is_empty());
            if let Some(agent_id) = agent_id {
                open.push((agent_id.to_owned(), call_id.to_owned()));
                events.push(AgentEvent::Task {
                    id: agent_id.to_owned(),
                    tool_use_id: Some(call_id.to_owned()),
                    status: TaskStatus::Started,
                    label: Some(label),
                    summary: None,
                    tools: None,
                });
            }
        }
        if is_error {
            return events;
        }
        for line in output.lines() {
            let line = line.trim();
            let Some(index) = open
                .iter()
                .position(|(id, _)| line.starts_with(&format!("{id} [")))
            else {
                continue;
            };
            let rest = &line[open[index].0.len() + 2..];
            let status = match rest.split(']').next().unwrap_or_default() {
                "completed" | "done" => TaskStatus::Done,
                "failed" | "error" => TaskStatus::Failed,
                "stopped" | "cancelled" | "killed" => TaskStatus::Stopped,
                _ => continue,
            };
            let (id, tool_use_id) = open.remove(index);
            events.push(AgentEvent::Task {
                id,
                tool_use_id: Some(tool_use_id),
                status,
                label: None,
                summary: None,
                tools: None,
            });
        }
        events
    }

    fn stop_open_agents(&self) -> Vec<AgentEvent> {
        let Ok(mut open) = self.open_agents.lock() else {
            return Vec::new();
        };
        open.drain(..)
            .map(|(id, tool_use_id)| AgentEvent::Task {
                id,
                tool_use_id: Some(tool_use_id),
                status: TaskStatus::Stopped,
                label: None,
                summary: None,
                tools: None,
            })
            .collect()
    }

    fn tool_finished(&self, event: &Value, is_error: bool) -> Vec<AgentEvent> {
        let id = text_field(event, "toolCallId").unwrap_or_default();
        let snapshot = self
            .file_snapshots
            .lock()
            .ok()
            .and_then(|mut snapshots| snapshots.remove(&id));
        let (output, image) = if is_error {
            (text_of(&event["error"]), None)
        } else {
            (
                text_of(&event["result"]),
                super::result_image(&event["result"]),
            )
        };
        let change = snapshot
            .filter(|_| !is_error)
            .and_then(super::finish_file_snapshot);
        let tasks = self.background_tasks(&id, &output, is_error);
        let mut events = vec![AgentEvent::ToolResult {
            id,
            output,
            is_error,
            image,
            change,
        }];
        events.extend(tasks);
        events
    }
}

fn parse_result(value: &Value) -> Vec<AgentEvent> {
    let session_id = text_field(value, "sessionId");
    if value["subtype"].as_str() == Some("success") {
        return vec![AgentEvent::Done {
            session_id,
            text: text_field(value, "finalText").unwrap_or_default(),
            cost_usd: None,
        }];
    }
    let message = text_field(value, "error")
        .or_else(|| {
            value["subtype"]
                .as_str()
                .map(|subtype| format!("Command Code stopped: {subtype}"))
        })
        .unwrap_or_else(|| "Command Code turn failed".to_owned());
    vec![AgentEvent::Error { message }]
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The name a tool call shows under in the chat: Command Code's own tool names map onto the names the cards read.
fn canonical_tool(name: &str) -> &str {
    match name {
        "shell_command" | "powershell" => "Bash",
        "read_file" => "Read",
        "write_file" => "Write",
        "edit_file" => "Edit",
        "grep" => "Grep",
        "glob" => "Glob",
        "web_fetch" => "WebFetch",
        "web_search" => "WebSearch",
        "agent" | "subagent" => "Agent",
        "todo_write" => "TodoWrite",
        other => other,
    }
}

/// A tool result is either a plain string or a list of content blocks; keep the text of each block.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The output of `command-code --list-models`, or empty when it cannot run or does not answer within 20 seconds.
pub async fn models_listing(binary: std::ffi::OsString) -> String {
    let mut command = super::runner::command_for(binary, &["--list-models".to_string()]);
    if let Some((key, path)) = super::resolve::augmented_path_env() {
        command.env(key, path);
    }
    command
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    match tokio::time::timeout(std::time::Duration::from_secs(20), command.output()).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TurnRequest {
        TurnRequest {
            prompt: "hello".into(),
            session_id: Some("session-1".into()),
            resume: true,
            model: Some("claude-sonnet-5-5".into()),
            permission_mode: Some("edits".into()),
            effort: Some("high".into()),
            allowed_tools: Vec::new(),
            cwd: None,
            owner: None,
            api_key: None,
        }
    }

    #[test]
    fn args_use_headless_json_stream_and_resume_the_session() {
        assert_eq!(
            CommandCode::default().args(&request()),
            [
                "-p",
                "--output-format",
                "json",
                "--trust",
                "--skip-onboarding",
                "--no-auto-update",
                "--session",
                "session-1",
                "--model",
                "claude-sonnet-5-5",
                "--effort",
                "high",
                "--permission-mode",
                "accept-edits",
            ]
            .map(String::from)
            .to_vec()
        );
    }

    #[test]
    fn prompt_is_sent_on_stdin_with_the_language_context() {
        let provider = CommandCode::default();
        assert!(provider.prompt_on_stdin());
        assert!(super::super::turn_prompt(&provider, &request()).ends_with("\n\nhello"));
    }

    #[test]
    fn parses_session_text_thinking_and_the_final_result() {
        let provider = CommandCode::default();
        assert_eq!(
            provider
                .parse_line(r#"{"type":"event","event":{"type":"run_start","sessionId":"s1"}}"#),
            vec![AgentEvent::Session {
                session_id: "s1".into()
            }]
        );
        assert_eq!(
            provider.parse_line(r#"{"type":"event","event":{"type":"text_delta","delta":"hi"}}"#),
            vec![AgentEvent::Delta { text: "hi".into() }]
        );
        assert_eq!(
            provider
                .parse_line(r#"{"type":"event","event":{"type":"thinking_delta","delta":"hmm"}}"#),
            vec![AgentEvent::Thinking { text: "hmm".into() }]
        );
        assert_eq!(
            provider.parse_line(
                r#"{"type":"result","subtype":"success","sessionId":"s1","stopReason":"end_turn","finalText":"done"}"#
            ),
            vec![AgentEvent::Done {
                session_id: Some("s1".into()),
                text: "done".into(),
                cost_usd: None,
            }]
        );
        assert_eq!(
            provider.parse_line(r#"{"type":"result","subtype":"max_turns","sessionId":"s1"}"#),
            vec![AgentEvent::Error {
                message: "Command Code stopped: max_turns".into()
            }]
        );
    }

    fn tasks(events: &[AgentEvent]) -> Vec<(String, Option<String>, TaskStatus)> {
        events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Task {
                    id,
                    tool_use_id,
                    status,
                    ..
                } => Some((id.clone(), tool_use_id.clone(), *status)),
                _ => None,
            })
            .collect()
    }

    const LAUNCH: &str = r#"{"type":"event","event":{"type":"tool_queued","toolCallId":"c1","toolName":"agent","input":{"description":"Probe","prompt":"hi","run_in_background":true}}}"#;
    const LAUNCHED: &str = r#"{"type":"event","event":{"type":"tool_completed","toolCallId":"c1","toolName":"agent","result":"Background agent launched.\nagent_id: bg-1-abc\nThe agent is working in the background."}}"#;

    #[test]
    fn background_agent_ends_when_agent_output_reports_it() {
        let provider = CommandCode::default();
        provider.parse_line(LAUNCH);
        assert_eq!(
            tasks(&provider.parse_line(LAUNCHED)),
            vec![("bg-1-abc".into(), Some("c1".into()), TaskStatus::Started)]
        );
        let running = provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_completed","toolCallId":"c2","toolName":"agent_output","result":"bg-1-abc [running] general: Probe"}}"#,
        );
        assert!(tasks(&running).is_empty());
        let done = provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_completed","toolCallId":"c3","toolName":"agent_output","result":"bg-1-abc [completed] general: Probe"}}"#,
        );
        assert_eq!(
            tasks(&done),
            vec![("bg-1-abc".into(), Some("c1".into()), TaskStatus::Done)]
        );
        // Already ended: the turn's end stops nothing more.
        let end = provider.parse_line(
            r#"{"type":"result","subtype":"success","sessionId":"s1","finalText":"ok"}"#,
        );
        assert!(tasks(&end).is_empty());
    }

    #[test]
    fn background_agent_left_open_stops_with_the_turn() {
        let provider = CommandCode::default();
        provider.parse_line(LAUNCH);
        provider.parse_line(LAUNCHED);
        let end = provider.parse_line(
            r#"{"type":"result","subtype":"success","sessionId":"s1","finalText":"ok"}"#,
        );
        assert_eq!(
            tasks(&end),
            vec![("bg-1-abc".into(), Some("c1".into()), TaskStatus::Stopped)]
        );
        assert!(matches!(end.last(), Some(AgentEvent::Done { .. })));
    }

    #[test]
    fn foreground_agent_and_failed_launch_start_no_task() {
        let provider = CommandCode::default();
        provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_queued","toolCallId":"f1","toolName":"agent","input":{"description":"Probe","prompt":"hi"}}}"#,
        );
        let result = provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_completed","toolCallId":"f1","toolName":"agent","result":"agent_id: bg-9"}}"#,
        );
        assert!(tasks(&result).is_empty());
        provider.parse_line(LAUNCH);
        let failed = provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_errored","toolCallId":"c1","toolName":"agent","error":"agent_id: bg-1-abc"}}"#,
        );
        assert!(tasks(&failed).is_empty());
    }

    #[test]
    fn tool_call_and_result_keep_their_id_and_text() {
        let provider = CommandCode::default();
        let call = provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_queued","toolCallId":"t1","toolName":"shell_command","input":{"command":"git status"}}}"#,
        );
        assert_eq!(
            call,
            vec![AgentEvent::ToolCall {
                id: "t1".into(),
                name: "Bash".into(),
                input: "git status".into(),
                change: None,
                background: false,
            }]
        );
        assert_eq!(
            provider.parse_line(
                r#"{"type":"event","event":{"type":"tool_completed","toolCallId":"t1","toolName":"shell_command","result":[{"type":"text","text":"clean"}]}}"#
            ),
            vec![AgentEvent::ToolResult {
                id: "t1".into(),
                output: "clean".into(),
                is_error: false,
                image: None,
                change: None,
            }]
        );
        assert_eq!(
            provider.parse_line(
                r#"{"type":"event","event":{"type":"tool_errored","toolCallId":"t2","toolName":"read_file","error":"missing"}}"#
            ),
            vec![AgentEvent::ToolResult {
                id: "t2".into(),
                output: "missing".into(),
                is_error: true,
                image: None,
                change: None,
            }]
        );
    }

    #[test]
    fn denied_tool_becomes_a_permission_request() {
        let provider = CommandCode::default();
        let events = provider.parse_line(
            r#"{"type":"event","event":{"type":"tool_denied","toolCallId":"t3","toolName":"shell_command","input":{"command":"git push"}}}"#,
        );
        assert!(matches!(
            events.get(1),
            Some(AgentEvent::PermissionDenied { requests })
                if requests[0].id == "t3"
                    && requests[0].tool == "Bash"
                    && requests[0].allow == "Bash(git push)"
        ));
    }
}

#[cfg(test)]
mod bridge_config_tests {
    use super::ensure_bridge_server;

    fn folder(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ag-cc-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bridge_is_added_and_other_servers_stay() {
        let dir = folder("merge");
        let path = dir.join(".mcp.json");
        std::fs::write(&path, r#"{"mcpServers":{"serena":{"command":"serena"}}}"#).unwrap();
        ensure_bridge_server(&path, "http://127.0.0.1:9/mcp?root=x").unwrap();
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(file["mcpServers"]["serena"]["command"], "serena");
        assert_eq!(file["mcpServers"]["agentdeck"]["type"], "http");
        assert_eq!(
            file["mcpServers"]["agentdeck"]["url"],
            "http://127.0.0.1:9/mcp?root=x"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_not_json_is_left_alone() {
        let dir = folder("broken");
        let path = dir.join(".mcp.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(ensure_bridge_server(&path, "http://x/mcp").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
