//! DeepSeek Harness headless provider.
//!
//! The headless profile is the compatibility-first DSH surface: it emits stable JSONL events,
//! accepts the task on stdin, and resumes a persisted session with `--session-id`.

use serde_json::Value;

use super::{AgentEvent, ChatResponseCapabilities, Provider, TurnRequest};

#[derive(Debug, Default)]
pub struct Dsh;

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

impl Provider for Dsh {
    fn id(&self) -> &'static str {
        "dsh"
    }

    fn binary(&self) -> &'static str {
        "dsh"
    }

    fn candidates(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }

    fn args(&self, req: &TurnRequest) -> Vec<String> {
        let mut args = vec!["--profile".into(), "headless".into(), "--json".into()];
        if let Some(session) = req.session_id.as_deref().filter(|_| req.resume) {
            args.extend(["--session-id".into(), session.into()]);
        }
        if let Some(mode) = req.permission_mode.as_deref() {
            args.extend(["--permission-mode".into(), mode.into()]);
        }
        args.push("-".into());
        args
    }

    fn prompt_on_stdin(&self) -> bool {
        true
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![AgentEvent::Raw {
                source: "dsh".into(),
                label: "malformed_json".into(),
                line: line.into(),
            }];
        };
        match value["type"].as_str().unwrap_or_default() {
            "session" => vec![AgentEvent::Session {
                session_id: text(&value, "sessionId"),
            }],
            "text" => vec![AgentEvent::Delta {
                text: text(&value, "text"),
            }],
            "thinking" => vec![AgentEvent::Thinking {
                text: text(&value, "text"),
            }],
            "status" => vec![AgentEvent::Notice {
                text: format!("dsh: {}", text(&value, "phase")),
            }],
            "tool_call" => vec![AgentEvent::ToolCall {
                id: text(&value, "callId"),
                name: text(&value, "tool"),
                input: value["input"].to_string(),
                change: None,
                background: false,
                child_kind: None,
            }],
            "tool_result" => vec![AgentEvent::ToolResult {
                id: text(&value, "callId"),
                output: value["result"].as_str().unwrap_or_default().into(),
                is_error: value["status"].as_str() == Some("error"),
                image: None,
                change: None,
            }],
            "final" => vec![AgentEvent::Done {
                session_id: value["sessionId"].as_str().map(str::to_owned),
                text: text(&value, "text"),
                cost_usd: None,
            }],
            "error" => vec![AgentEvent::Error {
                message: text(&value, "message"),
            }],
            _ => vec![AgentEvent::Raw {
                source: "dsh".into(),
                label: value["type"].as_str().unwrap_or("unknown").into(),
                line: line.into(),
            }],
        }
    }

    fn finish(&self, _req: &TurnRequest) -> Option<AgentEvent> {
        Some(AgentEvent::Error {
            message: "dsh exited before sending a final event".into(),
        })
    }

    fn chat_capabilities(&self, _req: &TurnRequest) -> ChatResponseCapabilities {
        ChatResponseCapabilities::custom()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(resume: bool) -> TurnRequest {
        TurnRequest {
            prompt: "hello".into(),
            session_id: Some("s1".into()),
            resume,
            model: None,
            permission_mode: Some("workspace-write".into()),
            effort: None,
            allowed_tools: Vec::new(),
            cwd: None,
            owner: None,
            api_key: None,
        }
    }

    #[test]
    fn starts_headless_json_and_resumes_only_when_requested() {
        let provider = Dsh;
        assert_eq!(
            provider.args(&request(false)),
            [
                "--profile",
                "headless",
                "--json",
                "--permission-mode",
                "workspace-write",
                "-"
            ]
        );
        assert_eq!(
            provider.args(&request(true)),
            [
                "--profile",
                "headless",
                "--json",
                "--session-id",
                "s1",
                "--permission-mode",
                "workspace-write",
                "-"
            ]
        );
    }

    #[test]
    fn maps_headless_jsonl_to_shared_events() {
        let provider = Dsh;
        assert_eq!(
            provider.parse_line(r#"{"type":"session","sessionId":"s1"}"#),
            vec![AgentEvent::Session {
                session_id: "s1".into()
            }]
        );
        assert_eq!(
            provider.parse_line(
                r#"{"type":"tool_call","callId":"c1","tool":"Read","input":{"path":"a"}}"#
            ),
            vec![AgentEvent::ToolCall {
                id: "c1".into(),
                name: "Read".into(),
                input: json!({"path":"a"}).to_string(),
                change: None,
                background: false,
                child_kind: None,
            }]
        );
        assert!(matches!(
            provider.parse_line("not json").as_slice(),
            [AgentEvent::Raw { label, .. }] if label == "malformed_json"
        ));
    }
}
