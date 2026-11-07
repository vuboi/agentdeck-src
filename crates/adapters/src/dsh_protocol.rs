use std::collections::BTreeSet;

use serde_json::{json, Value};
use thiserror::Error;

/// Incremental newline-delimited JSON decoder used by the dsh sidecar transport.
/// It accepts chunk boundaries and CRLF, while keeping malformed frames observable.
#[derive(Debug, Default)]
pub struct JsonLineDecoder {
    buffer: Vec<u8>,
    malformed_frames: usize,
}

impl JsonLineDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=newline).collect();
            let line = line.strip_suffix(b"\n").unwrap_or(&line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice(line) {
                Ok(frame) => frames.push(frame),
                Err(_) => self.malformed_frames += 1,
            }
        }
        frames
    }

    pub fn malformed_frames(&self) -> usize {
        self.malformed_frames
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }
}

pub fn encode_json_line(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Stable SDK/ACP method names shared by the dsh sidecar adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DshMethod {
    Initialize,
    SessionNew,
    SessionPrompt,
    SessionWait,
    SessionResume,
    SessionStatus,
    ApprovalRequest,
    UserQuestionAsk,
    Shutdown,
}

impl DshMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::SessionNew => "session/new",
            Self::SessionPrompt => "session/prompt",
            Self::SessionWait => "session/wait",
            Self::SessionResume => "session/resume",
            Self::SessionStatus => "session/status",
            Self::ApprovalRequest => "approval/request",
            Self::UserQuestionAsk => "user-question/ask",
            Self::Shutdown => "shutdown",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DshNotification {
    SessionEvent(Value),
    SessionStatus(Value),
    ApprovalRequest(Value),
    UserQuestion(Value),
    SubagentStarted(Value),
    SubagentFinished(Value),
    Unknown { method: String, params: Value },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DshTransportProfile {
    Sdk,
    Acp,
}

/// Request builder for one persistent dsh JSON-RPC session.
/// It owns protocol ordering and leaves child-process I/O to the desktop supervisor.
#[derive(Debug)]
pub struct DshSessionClient {
    profile: DshTransportProfile,
    session_id: Option<String>,
    transport: JsonRpcTransport,
}

impl DshSessionClient {
    pub fn new(profile: DshTransportProfile) -> Self {
        Self {
            profile,
            session_id: None,
            transport: JsonRpcTransport::new(),
        }
    }

    pub fn profile(&self) -> DshTransportProfile {
        self.profile
    }
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
    pub fn transport(&self) -> &JsonRpcTransport {
        &self.transport
    }
    pub fn transport_mut(&mut self) -> &mut JsonRpcTransport {
        &mut self.transport
    }

    pub fn initialize(
        &mut self,
        client_name: &str,
        client_version: &str,
    ) -> Result<(String, Vec<u8>), TransportError> {
        self.transport.request(
            "initialize",
            json!({
                "protocolVersion": "1",
                "clientInfo": { "name": client_name, "version": client_version },
            }),
        )
    }

    pub fn new_session(
        &mut self,
        cwd: &str,
        model: Option<&str>,
    ) -> Result<(String, Vec<u8>), TransportError> {
        let method = match self.profile {
            DshTransportProfile::Sdk => "session/new",
            DshTransportProfile::Acp => "session/new",
        };
        let mut params = json!({ "cwd": cwd });
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        self.transport.request(method, params)
    }

    pub fn set_session_id(&mut self, session_id: impl Into<String>) {
        self.session_id = Some(session_id.into());
    }

    pub fn prompt(&mut self, text: &str) -> Result<(String, Vec<u8>), TransportError> {
        let session_id = self.session_id.clone().unwrap_or_default();
        let params = match self.profile {
            DshTransportProfile::Sdk => json!({ "sessionId": session_id, "text": text }),
            DshTransportProfile::Acp => {
                json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
            }
        };
        self.transport.request("session/prompt", params)
    }

    pub fn resume(&mut self) -> Result<(String, Vec<u8>), TransportError> {
        self.transport.request(
            "session/resume",
            json!({ "sessionId": self.session_id.clone().unwrap_or_default() }),
        )
    }

    pub fn wait(&mut self) -> Result<(String, Vec<u8>), TransportError> {
        self.transport.request(
            "session/wait",
            json!({ "sessionId": self.session_id.clone().unwrap_or_default() }),
        )
    }

    pub fn cancel(&mut self) -> Result<Vec<u8>, TransportError> {
        match self.profile {
            DshTransportProfile::Acp => self.transport.notification(
                "session/cancel",
                json!({ "sessionId": self.session_id.clone().unwrap_or_default() }),
            ),
            // SDK currently has no wire-level session/cancel. Caller must shutdown, await exit, then resume.
            DshTransportProfile::Sdk => Err(TransportError::NotOpen(TransportState::ShuttingDown)),
        }
    }

    pub fn shutdown(&mut self) -> Result<(String, Vec<u8>), TransportError> {
        self.transport.begin_shutdown()
    }

    /// Reopens JSON-RPC transport after the sidecar has actually exited.
    /// The session id stays intact so the next request can use `session/resume`.
    pub fn reopen_after_process_exit(&mut self) -> Result<(), TransportError> {
        if self.transport.state() != TransportState::Closed {
            return Err(TransportError::NotOpen(self.transport.state()));
        }
        self.transport = JsonRpcTransport::new();
        Ok(())
    }
}

impl DshNotification {
    pub fn parse(method: String, params: Value) -> Self {
        match method.as_str() {
            "session/event" => Self::SessionEvent(params),
            "session/status" => Self::SessionStatus(params),
            "approval/request" => Self::ApprovalRequest(params),
            "user-question/ask" => Self::UserQuestion(params),
            "subagent/started" => Self::SubagentStarted(params),
            "subagent/finished" => Self::SubagentFinished(params),
            _ => Self::Unknown { method, params },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportState {
    Open,
    ShuttingDown,
    Closed,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransportError {
    #[error("dsh transport is not open: {0:?}")]
    NotOpen(TransportState),
    #[error("response id is not pending: {0}")]
    UnknownResponse(String),
    #[error("JSON-RPC frame has no method or id")]
    InvalidFrame,
}

#[derive(Debug, PartialEq)]
pub enum IncomingFrame {
    Response {
        id: String,
        result: Result<Value, Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
}

/// JSON-RPC request correlation for one long-lived dsh process.
/// Process I/O remains outside this type so the existing Windows runner owns stderr draining and tree cleanup.
#[derive(Debug, Default)]
pub struct JsonRpcTransport {
    next_id: u64,
    pending: BTreeSet<String>,
    state: Option<TransportState>,
}

impl JsonRpcTransport {
    pub fn new() -> Self {
        Self {
            state: Some(TransportState::Open),
            ..Self::default()
        }
    }

    pub fn state(&self) -> TransportState {
        self.state.unwrap_or(TransportState::Closed)
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(String, Vec<u8>), TransportError> {
        if self.state() != TransportState::Open {
            return Err(TransportError::NotOpen(self.state()));
        }
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.pending.insert(id.clone());
        let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        Ok((
            id,
            encode_json_line(&frame).expect("JSON values are serializable"),
        ))
    }

    pub fn notification(&self, method: &str, params: Value) -> Result<Vec<u8>, TransportError> {
        if self.state() == TransportState::Closed {
            return Err(TransportError::NotOpen(TransportState::Closed));
        }
        let frame = json!({"jsonrpc": "2.0", "method": method, "params": params});
        Ok(encode_json_line(&frame).expect("JSON values are serializable"))
    }

    pub fn ingest(&mut self, frame: Value) -> Result<IncomingFrame, TransportError> {
        if let Some(id) = frame.get("id").and_then(Value::as_str) {
            if !self.pending.remove(id) {
                return Err(TransportError::UnknownResponse(id.to_owned()));
            }
            if let Some(error) = frame.get("error") {
                return Ok(IncomingFrame::Response {
                    id: id.to_owned(),
                    result: Err(error.clone()),
                });
            }
            return Ok(IncomingFrame::Response {
                id: id.to_owned(),
                result: Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
            });
        }
        if let Some(method) = frame.get("method").and_then(Value::as_str) {
            return Ok(IncomingFrame::Notification {
                method: method.to_owned(),
                params: frame.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        Err(TransportError::InvalidFrame)
    }

    pub fn begin_shutdown(&mut self) -> Result<(String, Vec<u8>), TransportError> {
        if self.state() != TransportState::Open {
            return Err(TransportError::NotOpen(self.state()));
        }
        let request = self.request("shutdown", Value::Null)?;
        self.state = Some(TransportState::ShuttingDown);
        Ok(request)
    }

    /// Called only after the child process has actually exited, before a resume restart.
    pub fn mark_process_exited(&mut self) {
        self.pending.clear();
        self.state = Some(TransportState::Closed);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        encode_json_line, DshMethod, DshNotification, DshSessionClient, DshTransportProfile,
        JsonLineDecoder,
    };
    use serde_json::json;

    #[test]
    fn decodes_frames_split_across_chunks_and_crlf() {
        let mut decoder = JsonLineDecoder::new();
        assert!(decoder.feed(br#"{"jsonrpc":"2.0","id":"1"}"#).is_empty());
        let frames = decoder.feed(b"\r\n{");
        assert_eq!(frames, vec![json!({"jsonrpc": "2.0", "id": "1"})]);
        assert!(decoder.feed(br#""#).is_empty());
        assert_eq!(decoder.buffered_bytes(), 1);
        let frames = decoder.feed(b"\"id\":\"2\"}\n");
        assert_eq!(frames, vec![json!({"id": "2"})]);
    }

    #[test]
    fn skips_empty_and_malformed_lines_but_keeps_later_frames() {
        let mut decoder = JsonLineDecoder::new();
        let frames = decoder.feed(b"\nnot-json\n{\"ok\":true}\n");
        assert_eq!(frames, vec![json!({"ok": true})]);
        assert_eq!(decoder.malformed_frames(), 1);
    }

    #[test]
    fn encoder_always_terminates_one_frame_with_newline() {
        assert_eq!(
            encode_json_line(&json!({"id": "1"})).unwrap(),
            b"{\"id\":\"1\"}\n"
        );
    }

    #[test]
    fn correlates_multiple_requests_and_keeps_notifications_out_of_pending() {
        let mut transport = super::JsonRpcTransport::new();
        let (first, _) = transport.request("initialize", json!({})).unwrap();
        let (second, _) = transport
            .request("session/prompt", json!({"text": "hi"}))
            .unwrap();
        assert_eq!(transport.pending_count(), 2);
        assert_eq!(
            transport
                .ingest(json!({"jsonrpc":"2.0","method":"session/event","params":{"kind":"delta"}}))
                .unwrap(),
            super::IncomingFrame::Notification {
                method: "session/event".into(),
                params: json!({"kind":"delta"})
            }
        );
        assert!(matches!(
            transport.ingest(json!({"id": second, "result": {"messageId":"m1"}})),
            Ok(super::IncomingFrame::Response { .. })
        ));
        assert!(matches!(
            transport.ingest(json!({"id": first, "result": {"ok":true}})),
            Ok(super::IncomingFrame::Response { .. })
        ));
        assert_eq!(transport.pending_count(), 0);
    }

    #[test]
    fn shutdown_waits_for_process_exit_before_transport_can_be_replaced() {
        let mut transport = super::JsonRpcTransport::new();
        let (id, frame) = transport.begin_shutdown().unwrap();
        assert_eq!(transport.state(), super::TransportState::ShuttingDown);
        assert!(String::from_utf8(frame).unwrap().contains("shutdown"));
        assert!(transport.request("session/resume", json!({})).is_err());
        assert!(transport.ingest(json!({"id": id, "result": null})).is_ok());
        transport.mark_process_exited();
        assert_eq!(transport.state(), super::TransportState::Closed);
        assert!(transport.notification("session/event", json!({})).is_err());
    }

    #[test]
    fn sdk_client_reopens_only_after_process_exit_and_keeps_session() {
        let mut client = DshSessionClient::new(DshTransportProfile::Sdk);
        client.set_session_id("session-1");
        let _ = client.shutdown().unwrap();
        assert!(client.reopen_after_process_exit().is_err());
        client.transport_mut().mark_process_exited();
        client.reopen_after_process_exit().unwrap();
        let (_, frame) = client.resume().unwrap();
        let frame = String::from_utf8(frame).unwrap();
        assert!(frame.contains("session/resume"));
        assert!(frame.contains("session-1"));
    }

    #[test]
    fn typed_protocol_names_cover_sdk_lifecycle_and_interactive_requests() {
        assert_eq!(DshMethod::SessionResume.as_str(), "session/resume");
        assert!(matches!(
            DshNotification::parse("approval/request".into(), json!({"id":"a"})),
            DshNotification::ApprovalRequest(_)
        ));
        assert!(matches!(
            DshNotification::parse("future/event".into(), json!({})),
            DshNotification::Unknown { .. }
        ));
    }

    #[test]
    fn session_client_builds_sdk_prompt_and_preserves_cancel_boundary() {
        let mut client = DshSessionClient::new(DshTransportProfile::Sdk);
        let (_, init) = client.initialize("agentdeck", "0.1.82").unwrap();
        assert!(String::from_utf8(init).unwrap().contains("initialize"));
        client.set_session_id("s1");
        let (_, prompt) = client.prompt("hello").unwrap();
        let prompt = String::from_utf8(prompt).unwrap();
        assert!(prompt.contains("session/prompt") && prompt.contains("s1"));
        assert!(client.cancel().is_err());
        let (_, shutdown) = client.shutdown().unwrap();
        assert!(String::from_utf8(shutdown).unwrap().contains("shutdown"));
    }
}
