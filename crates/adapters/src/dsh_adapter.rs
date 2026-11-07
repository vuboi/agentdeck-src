//! Stateful JSON-RPC contract for a DeepSeek Harness SDK or ACP sidecar.
//!
//! This adapter deliberately stops at the process boundary. The desktop supervisor owns
//! child-process I/O, while this type owns request ordering, session identity, and the
//! SDK/ACP lifecycle that the supervisor can drive safely.

use serde_json::Value;
use thiserror::Error;

use crate::dsh_protocol::{
    DshNotification, DshSessionClient, DshTransportProfile, IncomingFrame, TransportError,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DshRequest {
    pub id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DshAdapterState {
    New,
    Initializing,
    Initialized,
    CreatingSession,
    Ready,
    Prompting,
    Waiting,
    Resuming,
    ShuttingDown,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingRequest {
    Initialize,
    NewSession,
    Prompt,
    Wait,
    Resume,
    Shutdown,
}

#[derive(Debug, PartialEq)]
pub enum DshAdapterEvent {
    Initialized {
        result: Value,
    },
    SessionReady {
        session_id: String,
        result: Value,
    },
    PromptAccepted {
        message_id: Option<String>,
        result: Value,
    },
    WaitCompleted {
        result: Value,
    },
    Resumed {
        result: Value,
    },
    ShutdownAcknowledged {
        result: Value,
    },
    Notification(DshNotification),
    ServerRequest {
        id: String,
        method: String,
        params: Value,
    },
    Error {
        stage: &'static str,
        error: Value,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DshAdapterError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("cannot {operation} while dsh adapter is in {state:?}")]
    InvalidState {
        operation: &'static str,
        state: DshAdapterState,
    },
    #[error("dsh session id is not available")]
    MissingSession,
    #[error("dsh response {id} did not match the active request")]
    UnexpectedResponse { id: String },
}

/// Drives the SDK/ACP JSON-RPC lifecycle without owning a child process.
///
/// The caller writes [`DshRequest::bytes`] to the sidecar and feeds every decoded JSON
/// frame back to [`Self::on_frame`]. This keeps the contract usable by the existing
/// runner/supervisor without pretending that the one-shot `Provider` runner is a
/// long-lived JSON-RPC process.
#[derive(Debug)]
pub struct DshRpcAdapter {
    client: DshSessionClient,
    state: DshAdapterState,
    pending: Option<(String, PendingRequest)>,
}

impl DshRpcAdapter {
    pub fn new(profile: DshTransportProfile) -> Self {
        Self {
            client: DshSessionClient::new(profile),
            state: DshAdapterState::New,
            pending: None,
        }
    }

    pub fn profile(&self) -> DshTransportProfile {
        self.client.profile()
    }

    pub fn state(&self) -> DshAdapterState {
        self.state
    }

    pub fn session_id(&self) -> Option<&str> {
        self.client.session_id()
    }

    pub fn initialize(
        &mut self,
        client_name: &str,
        client_version: &str,
    ) -> Result<DshRequest, DshAdapterError> {
        self.require("initialize", DshAdapterState::New)?;
        let request = self.client.initialize(client_name, client_version)?;
        self.start_pending(
            request,
            PendingRequest::Initialize,
            DshAdapterState::Initializing,
        )
    }

    pub fn new_session(
        &mut self,
        cwd: &str,
        model: Option<&str>,
    ) -> Result<DshRequest, DshAdapterError> {
        self.require("new session", DshAdapterState::Initialized)?;
        let request = self.client.new_session(cwd, model)?;
        self.start_pending(
            request,
            PendingRequest::NewSession,
            DshAdapterState::CreatingSession,
        )
    }

    pub fn prompt(&mut self, text: &str) -> Result<DshRequest, DshAdapterError> {
        self.require("prompt", DshAdapterState::Ready)?;
        if self.client.session_id().is_none() {
            return Err(DshAdapterError::MissingSession);
        }
        let request = self.client.prompt(text)?;
        self.start_pending(request, PendingRequest::Prompt, DshAdapterState::Prompting)
    }

    pub fn wait(&mut self) -> Result<DshRequest, DshAdapterError> {
        self.require("wait", DshAdapterState::Waiting)?;
        let request = self.client.wait()?;
        self.start_pending(request, PendingRequest::Wait, DshAdapterState::Waiting)
    }

    /// Sends ACP's cancel notification. SDK cancellation remains an explicit error because
    /// its protocol currently requires shutdown, process exit, and a later resume.
    pub fn cancel(&mut self) -> Result<Vec<u8>, DshAdapterError> {
        if !matches!(
            self.state,
            DshAdapterState::Prompting | DshAdapterState::Waiting | DshAdapterState::Resuming
        ) || self.pending.is_some()
        {
            return Err(DshAdapterError::InvalidState {
                operation: "cancel",
                state: self.state,
            });
        }
        Ok(self.client.cancel()?)
    }

    pub fn resume(&mut self) -> Result<DshRequest, DshAdapterError> {
        self.require("resume", DshAdapterState::Initialized)?;
        if self.client.session_id().is_none() {
            return Err(DshAdapterError::MissingSession);
        }
        let request = self.client.resume()?;
        self.start_pending(request, PendingRequest::Resume, DshAdapterState::Resuming)
    }

    pub fn shutdown(&mut self) -> Result<DshRequest, DshAdapterError> {
        if !matches!(
            self.state,
            DshAdapterState::Initialized | DshAdapterState::Ready | DshAdapterState::Waiting
        ) {
            return Err(DshAdapterError::InvalidState {
                operation: "shutdown",
                state: self.state,
            });
        }
        let request = self.client.shutdown()?;
        self.start_pending(
            request,
            PendingRequest::Shutdown,
            DshAdapterState::ShuttingDown,
        )
    }

    /// Marks the child as exited. A new process may only be opened after this call.
    pub fn mark_process_exited(&mut self) -> Result<(), DshAdapterError> {
        if self.state != DshAdapterState::ShuttingDown {
            return Err(DshAdapterError::InvalidState {
                operation: "mark process exited",
                state: self.state,
            });
        }
        self.client.transport_mut().mark_process_exited();
        self.pending = None;
        self.state = DshAdapterState::Closed;
        Ok(())
    }

    /// Reopens transport after the supervisor observed actual process exit.
    pub fn reopen_after_process_exit(&mut self) -> Result<(), DshAdapterError> {
        if self.state != DshAdapterState::Closed {
            return Err(DshAdapterError::InvalidState {
                operation: "reopen after process exit",
                state: self.state,
            });
        }
        self.client.reopen_after_process_exit()?;
        self.state = DshAdapterState::New;
        Ok(())
    }

    pub fn on_frame(&mut self, frame: Value) -> Result<DshAdapterEvent, DshAdapterError> {
        match self.client.transport_mut().ingest(frame)? {
            IncomingFrame::ServerRequest { id, method, params } => {
                Ok(DshAdapterEvent::ServerRequest { id, method, params })
            }
            IncomingFrame::Notification { method, params } => Ok(DshAdapterEvent::Notification(
                DshNotification::parse(method, params),
            )),
            IncomingFrame::Response { id, result } => {
                let Some((pending_id, stage)) = self.pending.take() else {
                    return Err(DshAdapterError::UnexpectedResponse { id });
                };
                if pending_id != id {
                    return Err(DshAdapterError::UnexpectedResponse { id });
                }
                match result {
                    Ok(result) => Ok(self.complete(stage, result)),
                    Err(error) => {
                        self.state = match stage {
                            PendingRequest::Initialize => DshAdapterState::New,
                            PendingRequest::NewSession => DshAdapterState::Initialized,
                            PendingRequest::Prompt | PendingRequest::Wait => DshAdapterState::Ready,
                            PendingRequest::Resume => DshAdapterState::Initialized,
                            PendingRequest::Shutdown => DshAdapterState::ShuttingDown,
                        };
                        Ok(DshAdapterEvent::Error {
                            stage: stage.as_str(),
                            error,
                        })
                    }
                }
            }
        }
    }

    fn require(
        &self,
        operation: &'static str,
        expected: DshAdapterState,
    ) -> Result<(), DshAdapterError> {
        if self.state == expected && self.pending.is_none() {
            Ok(())
        } else {
            Err(DshAdapterError::InvalidState {
                operation,
                state: self.state,
            })
        }
    }

    fn start_pending(
        &mut self,
        (id, bytes): (String, Vec<u8>),
        stage: PendingRequest,
        state: DshAdapterState,
    ) -> Result<DshRequest, DshAdapterError> {
        self.pending = Some((id.clone(), stage));
        self.state = state;
        Ok(DshRequest { id, bytes })
    }

    fn complete(&mut self, stage: PendingRequest, result: Value) -> DshAdapterEvent {
        match stage {
            PendingRequest::Initialize => {
                self.state = DshAdapterState::Initialized;
                DshAdapterEvent::Initialized { result }
            }
            PendingRequest::NewSession => {
                let session_id = session_id(&result).unwrap_or_default();
                self.client.set_session_id(session_id.clone());
                self.state = DshAdapterState::Ready;
                DshAdapterEvent::SessionReady { session_id, result }
            }
            PendingRequest::Prompt => {
                self.state = DshAdapterState::Waiting;
                DshAdapterEvent::PromptAccepted {
                    message_id: result
                        .get("messageId")
                        .or_else(|| result.get("message_id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    result,
                }
            }
            PendingRequest::Wait => {
                self.state = DshAdapterState::Ready;
                DshAdapterEvent::WaitCompleted { result }
            }
            PendingRequest::Resume => {
                self.state = DshAdapterState::Waiting;
                DshAdapterEvent::Resumed { result }
            }
            PendingRequest::Shutdown => DshAdapterEvent::ShutdownAcknowledged { result },
        }
    }
}

impl PendingRequest {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::NewSession => "session/new",
            Self::Prompt => "session/prompt",
            Self::Wait => "session/wait",
            Self::Resume => "session/resume",
            Self::Shutdown => "shutdown",
        }
    }
}

fn session_id(result: &Value) -> Option<String> {
    result
        .get("sessionId")
        .or_else(|| result.get("session_id"))
        .or_else(|| result.get("session").and_then(|session| session.get("id")))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsh_protocol::TransportState;
    use serde_json::json;

    fn response(request: &DshRequest, result: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": request.id, "result": result })
    }

    #[test]
    fn sdk_lifecycle_keeps_process_boundary_explicit() {
        let mut adapter = DshRpcAdapter::new(DshTransportProfile::Sdk);
        let init = adapter.initialize("agentdeck", "0.1.82").unwrap();
        assert_eq!(adapter.state(), DshAdapterState::Initializing);
        assert!(matches!(
            adapter
                .on_frame(response(&init, json!({"ok":true})))
                .unwrap(),
            DshAdapterEvent::Initialized { .. }
        ));

        let session = adapter
            .new_session("C:/project", Some("deepseek-chat"))
            .unwrap();
        assert!(matches!(
            adapter
                .on_frame(response(&session, json!({"sessionId":"s1"})))
                .unwrap(),
            DshAdapterEvent::SessionReady { ref session_id, .. } if session_id == "s1"
        ));

        let prompt = adapter.prompt("hello").unwrap();
        let prompt_frame: Value = serde_json::from_slice(&prompt.bytes).unwrap();
        assert_eq!(prompt_frame["params"]["text"], "hello");
        assert!(matches!(
            adapter
                .on_frame(response(&prompt, json!({"messageId":"m1"})))
                .unwrap(),
            DshAdapterEvent::PromptAccepted { message_id: Some(ref id), .. } if id == "m1"
        ));
        assert!(matches!(
            adapter.cancel(),
            Err(DshAdapterError::Transport(TransportError::NotOpen(
                TransportState::ShuttingDown
            )))
        ));

        let shutdown = adapter.shutdown().unwrap();
        assert!(matches!(
            adapter.on_frame(response(&shutdown, Value::Null)).unwrap(),
            DshAdapterEvent::ShutdownAcknowledged { .. }
        ));
        adapter.mark_process_exited().unwrap();
        assert_eq!(adapter.state(), DshAdapterState::Closed);
        adapter.reopen_after_process_exit().unwrap();
        assert_eq!(adapter.state(), DshAdapterState::New);
    }

    #[test]
    fn acp_uses_prompt_content_array_and_forwards_notifications() {
        let mut adapter = DshRpcAdapter::new(DshTransportProfile::Acp);
        let init = adapter.initialize("agentdeck", "0.1.82").unwrap();
        adapter
            .on_frame(response(&init, json!({"ok":true})))
            .unwrap();
        let session = adapter.new_session("/project", None).unwrap();
        adapter
            .on_frame(response(&session, json!({"session":{"id":"s2"}})))
            .unwrap();
        let prompt = adapter.prompt("hello").unwrap();
        let prompt_frame: Value = serde_json::from_slice(&prompt.bytes).unwrap();
        assert_eq!(prompt_frame["params"]["prompt"][0]["type"], "text");
        assert_eq!(prompt_frame["params"]["prompt"][0]["text"], "hello");

        let event = adapter
            .on_frame(json!({
                "jsonrpc":"2.0",
                "method":"session/event",
                "params":{"kind":"assistant/message"}
            }))
            .unwrap();
        assert!(matches!(
            event,
            DshAdapterEvent::Notification(DshNotification::SessionEvent(_))
        ));
    }

    #[test]
    fn sdk_rejects_resume_before_reopen_and_acp_can_cancel() {
        let mut sdk = DshRpcAdapter::new(DshTransportProfile::Sdk);
        assert!(matches!(
            sdk.resume(),
            Err(DshAdapterError::InvalidState { .. })
        ));

        let mut acp = DshRpcAdapter::new(DshTransportProfile::Acp);
        let init = acp.initialize("agentdeck", "0.1.82").unwrap();
        acp.on_frame(response(&init, json!({}))).unwrap();
        let session = acp.new_session("/project", None).unwrap();
        acp.on_frame(response(&session, json!({"sessionId":"s3"})))
            .unwrap();
        let prompt = acp.prompt("hello").unwrap();
        acp.on_frame(response(&prompt, json!({}))).unwrap();
        assert_eq!(acp.state(), DshAdapterState::Waiting);
        assert!(acp.cancel().is_ok());
        assert_eq!(acp.client.transport().state(), TransportState::Open);
    }
}
