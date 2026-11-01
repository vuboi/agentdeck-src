//! CodeBuddy Code CLI, driven headless with its official stream-json output.
//!
//! This adapter intentionally uses the public CLI contract instead of the WorkBuddy desktop
//! application's private HTTP gateway. The CLI can therefore keep its own authentication and
//! model configuration while AgentDeck only owns the process and event translation.

use std::path::PathBuf;

use serde_json::Value;

use super::{AgentEvent, Provider, TurnRequest};

pub struct WorkBuddy;

const LANGUAGE_CONTEXT: &str =
    "Reply in the same language as the user's latest message. If the user writes Vietnamese, reply in Vietnamese with proper diacritics.";

impl Provider for WorkBuddy {
    fn id(&self) -> &'static str {
        "workbuddy"
    }

    fn binary(&self) -> &'static str {
        "codebuddy"
    }

    fn candidates(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn args(&self, req: &TurnRequest) -> Vec<String> {
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--include-partial-messages".to_string(),
        ];
        if let Some(id) = &req.session_id {
            args.push(
                if req.resume {
                    "--resume"
                } else {
                    "--session-id"
                }
                .to_string(),
            );
            args.push(id.clone());
        }
        if let Some(model) = &req.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if let Some(mode) = super::permission::Mode::parse(req.permission_mode.as_deref()).claude()
        {
            args.push("--permission-mode".to_string());
            args.push(mode.to_string());
        }
        args.push(super::turn_prompt(self, req));
        args
    }

    fn opening_context(&self, _req: &TurnRequest) -> Option<String> {
        Some(LANGUAGE_CONTEXT.to_owned())
    }

    fn environment(&self, req: &TurnRequest) -> Vec<(String, String)> {
        req.api_key
            .as_ref()
            .filter(|token| !token.is_empty())
            .map(|token| vec![("CODEBUDDY_AUTH_TOKEN".to_string(), token.clone())])
            .unwrap_or_default()
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        parse_value(&value)
    }
}

fn parse_value(value: &Value) -> Vec<AgentEvent> {
    let kind = value["type"].as_str().unwrap_or_default();
    match kind {
        "init" => session_event(value),
        "system" if value["subtype"].as_str() == Some("init") => session_event(value),
        "assistant" | "message" => content_events(&value["message"]["content"])
            .or_else(|| content_events(&value["content"]))
            .unwrap_or_default(),
        "stream_event" => {
            let delta = &value["event"]["delta"];
            match delta["type"].as_str() {
                Some("text_delta") => delta["text"]
                    .as_str()
                    .map(|text| {
                        vec![AgentEvent::Delta {
                            text: text.to_owned(),
                        }]
                    })
                    .unwrap_or_default(),
                Some("thinking_delta") => delta["thinking"]
                    .as_str()
                    .map(|text| {
                        vec![AgentEvent::Thinking {
                            text: text.to_owned(),
                        }]
                    })
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        "result" => {
            if value["is_error"].as_bool().unwrap_or(false) {
                return vec![AgentEvent::Error {
                    message: value["result"]
                        .as_str()
                        .or_else(|| value["error"]["message"].as_str())
                        .or_else(|| value["errors"].as_array()?.first()?.as_str())
                        .unwrap_or("CodeBuddy turn failed")
                        .to_owned(),
                }];
            }
            vec![AgentEvent::Done {
                session_id: value["session_id"].as_str().map(str::to_owned),
                text: value["result"].as_str().unwrap_or_default().to_owned(),
                cost_usd: value["cost_usd"]
                    .as_f64()
                    .or_else(|| value["total_cost_usd"].as_f64()),
            }]
        }
        _ => Vec::new(),
    }
}

fn session_event(value: &Value) -> Vec<AgentEvent> {
    value["session_id"]
        .as_str()
        .map(|id| {
            vec![AgentEvent::Session {
                session_id: id.to_owned(),
            }]
        })
        .unwrap_or_default()
}

fn content_events(content: &Value) -> Option<Vec<AgentEvent>> {
    let blocks = content.as_array()?;
    Some(
        blocks
            .iter()
            .filter_map(|block| match block["type"].as_str() {
                Some("text") => block["text"].as_str().map(|text| AgentEvent::Delta {
                    text: text.to_owned(),
                }),
                _ => None,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_use_official_headless_flags_and_model_selection() {
        let request = TurnRequest {
            prompt: "hello".into(),
            session_id: Some("session-1".into()),
            resume: true,
            model: Some("gpt-5".into()),
            permission_mode: None,
            effort: None,
            allowed_tools: Vec::new(),
            cwd: None,
            owner: None,
            api_key: None,
        };
        let mut expected = vec![
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--resume",
            "session-1",
            "--model",
            "gpt-5",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        expected.push(format!("{LANGUAGE_CONTEXT}\n\nhello"));
        assert_eq!(WorkBuddy.args(&request), expected);
    }

    #[test]
    fn passes_the_official_auth_token_without_using_custom_gateway_headers() {
        let mut request = TurnRequest {
            prompt: "hello".into(),
            session_id: None,
            resume: false,
            model: None,
            permission_mode: None,
            effort: None,
            allowed_tools: Vec::new(),
            cwd: None,
            owner: None,
            api_key: Some("oauth-token".into()),
        };
        assert_eq!(
            WorkBuddy.environment(&request),
            vec![("CODEBUDDY_AUTH_TOKEN".into(), "oauth-token".into())]
        );
        request.api_key = None;
        assert!(WorkBuddy.environment(&request).is_empty());
    }

    #[test]
    fn parses_init_delta_and_result() {
        let provider = WorkBuddy;
        assert_eq!(
            provider.parse_line(r#"{"type":"system","subtype":"init","session_id":"s0"}"#),
            vec![AgentEvent::Session {
                session_id: "s0".into()
            }]
        );
        assert_eq!(
            provider.parse_line(r#"{"type":"init","session_id":"s1"}"#),
            vec![AgentEvent::Session {
                session_id: "s1".into()
            }]
        );
        assert_eq!(
            provider.parse_line(
                r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"hi"}}}"#
            ),
            vec![AgentEvent::Delta { text: "hi".into() }]
        );
        assert_eq!(
            provider.parse_line(r#"{"type":"result","session_id":"s1","result":"done"}"#),
            vec![AgentEvent::Done {
                session_id: Some("s1".into()),
                text: "done".into(),
                cost_usd: None
            }]
        );
        assert_eq!(
            provider.parse_line(
                r#"{"type":"result","is_error":true,"errors":["Authentication required"]}"#
            ),
            vec![AgentEvent::Error {
                message: "Authentication required".into()
            }]
        );
    }
}
