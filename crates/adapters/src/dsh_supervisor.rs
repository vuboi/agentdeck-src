//! Long-lived JSON-RPC process supervisor for DeepSeek Harness SDK/ACP.
//!
//! [`DshRpcAdapter`] owns protocol state. This module owns the process boundary: one child,
//! one NDJSON stdin/stdout pair, forwarded notifications, approval replies, and the explicit
//! shutdown -> wait-for-exit -> reopen boundary required before a session can resume.

use std::{future::Future, io, path::PathBuf, pin::Pin, process::ExitStatus, sync::Arc};

use serde_json::{json, Value};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Mutex},
    task::JoinHandle,
};

use crate::{
    dsh_adapter::{DshAdapterError, DshAdapterEvent, DshAdapterState, DshRequest, DshRpcAdapter},
    dsh_protocol::{encode_json_line, DshTransportProfile, JsonLineDecoder},
};

#[derive(Debug, Clone, PartialEq)]
pub struct DshApprovalRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DshApprovalResponse {
    Result(Value),
    Error {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}

pub type DshApprovalFuture = Pin<Box<dyn Future<Output = DshApprovalResponse> + Send + 'static>>;
pub type DshApprovalCallback = Arc<dyn Fn(DshApprovalRequest) -> DshApprovalFuture + Send + Sync>;

pub struct DshSupervisorConfig {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub profile: DshTransportProfile,
    pub approval_callback: Option<DshApprovalCallback>,
}

impl DshSupervisorConfig {
    pub fn new(binary: impl Into<PathBuf>, profile: DshTransportProfile) -> Self {
        Self {
            binary: binary.into(),
            args: Vec::new(),
            cwd: None,
            profile,
            approval_callback: None,
        }
    }
}

#[derive(Debug)]
pub enum DshSupervisorEvent {
    Adapter(DshAdapterEvent),
    ApprovalRequested(DshApprovalRequest),
    ApprovalResponded { id: String, allowed: bool },
    StdoutClosed,
    ProcessExited(ExitStatus),
    ProtocolError(String),
}

#[derive(Debug, Error)]
pub enum DshSupervisorError {
    #[error("failed to start dsh process: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Adapter(#[from] DshAdapterError),
    #[error("dsh supervisor event channel is closed")]
    EventChannelClosed,
    #[error("dsh process has already exited")]
    ProcessExited,
    #[error("dsh process is still running")]
    ProcessStillRunning,
}

pub struct DshSupervisor {
    config: DshSupervisorConfig,
    adapter: Arc<Mutex<DshRpcAdapter>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    child: Option<Child>,
    reader_task: Option<JoinHandle<()>>,
    events: mpsc::UnboundedReceiver<DshSupervisorEvent>,
    event_tx: mpsc::UnboundedSender<DshSupervisorEvent>,
}

impl DshSupervisor {
    pub async fn spawn(config: DshSupervisorConfig) -> Result<Self, DshSupervisorError> {
        let adapter = Arc::new(Mutex::new(DshRpcAdapter::new(config.profile)));
        let (event_tx, events) = mpsc::unbounded_channel();
        let (child, stdin, reader_task) =
            spawn_child(&config, Arc::clone(&adapter), event_tx.clone()).await?;
        Ok(Self {
            config,
            adapter,
            stdin: Some(stdin),
            child: Some(child),
            reader_task: Some(reader_task),
            events,
            event_tx,
        })
    }

    pub async fn state(&self) -> DshAdapterState {
        self.adapter.lock().await.state()
    }

    pub async fn session_id(&self) -> Option<String> {
        self.adapter.lock().await.session_id().map(str::to_owned)
    }

    pub async fn next_event(&mut self) -> Option<DshSupervisorEvent> {
        self.events.recv().await
    }

    pub async fn initialize(
        &self,
        client_name: &str,
        client_version: &str,
    ) -> Result<DshRequest, DshSupervisorError> {
        self.send(|adapter| adapter.initialize(client_name, client_version))
            .await
    }

    pub async fn new_session(
        &self,
        cwd: &str,
        model: Option<&str>,
    ) -> Result<DshRequest, DshSupervisorError> {
        self.send(|adapter| adapter.new_session(cwd, model)).await
    }

    pub async fn restore_session(
        &self,
        session_id: impl Into<String>,
    ) -> Result<(), DshSupervisorError> {
        let mut adapter = self.adapter.lock().await;
        adapter.restore_session(session_id)?;
        Ok(())
    }

    pub async fn prompt(&self, text: &str) -> Result<DshRequest, DshSupervisorError> {
        self.send(|adapter| adapter.prompt(text)).await
    }

    pub async fn wait(&self) -> Result<DshRequest, DshSupervisorError> {
        self.send(|adapter| adapter.wait()).await
    }

    pub async fn resume(&self) -> Result<DshRequest, DshSupervisorError> {
        self.send(|adapter| adapter.resume()).await
    }

    pub async fn cancel(&self) -> Result<Vec<u8>, DshSupervisorError> {
        let bytes = {
            let mut adapter = self.adapter.lock().await;
            adapter.cancel()?
        };
        self.write(&bytes).await?;
        Ok(bytes)
    }

    pub async fn shutdown(&self) -> Result<DshRequest, DshSupervisorError> {
        self.send(|adapter| adapter.shutdown()).await
    }

    /// Waits for the actual child exit before changing transport state.
    ///
    /// SDK resume must call this after [`Self::shutdown`]. Killing/replacing the process before
    /// this future resolves can race dsh's per-session lock on Windows.
    pub async fn wait_for_exit(&mut self) -> Result<ExitStatus, DshSupervisorError> {
        let mut child = self.child.take().ok_or(DshSupervisorError::ProcessExited)?;
        let status = child.wait().await?;
        self.stdin = None;
        if let Some(reader_task) = self.reader_task.take() {
            let _ = reader_task.await;
        }
        self.event_tx
            .send(DshSupervisorEvent::ProcessExited(status))
            .map_err(|_| DshSupervisorError::EventChannelClosed)?;
        self.adapter.lock().await.mark_process_exited()?;
        Ok(status)
    }

    /// Starts a fresh process only after [`Self::wait_for_exit`] completed.
    /// The adapter keeps its session id and can then be initialized followed by `resume()`.
    pub async fn restart_after_exit(&mut self) -> Result<(), DshSupervisorError> {
        if self.child.is_some() {
            return Err(DshSupervisorError::ProcessStillRunning);
        }
        self.adapter.lock().await.reopen_after_process_exit()?;
        let (child, stdin, reader_task) = spawn_child(
            &self.config,
            Arc::clone(&self.adapter),
            self.event_tx.clone(),
        )
        .await?;
        self.child = Some(child);
        self.stdin = Some(stdin);
        self.reader_task = Some(reader_task);
        Ok(())
    }

    async fn send<F>(&self, build: F) -> Result<DshRequest, DshSupervisorError>
    where
        F: FnOnce(&mut DshRpcAdapter) -> Result<DshRequest, DshAdapterError>,
    {
        let request = {
            let mut adapter = self.adapter.lock().await;
            build(&mut adapter)?
        };
        self.write(&request.bytes).await?;
        Ok(request)
    }

    async fn write(&self, bytes: &[u8]) -> Result<(), DshSupervisorError> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or(DshSupervisorError::ProcessExited)?;
        let mut stdin = stdin.lock().await;
        stdin.write_all(bytes).await?;
        stdin.flush().await?;
        Ok(())
    }
}

async fn spawn_child(
    config: &DshSupervisorConfig,
    adapter: Arc<Mutex<DshRpcAdapter>>,
    event_tx: mpsc::UnboundedSender<DshSupervisorEvent>,
) -> Result<(Child, Arc<Mutex<ChildStdin>>, JoinHandle<()>), DshSupervisorError> {
    let mut command = Command::new(&config.binary);
    command
        .args(&config.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = config.cwd.as_deref() {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
        io::Error::new(io::ErrorKind::BrokenPipe, "dsh stdin was not piped")
    })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "dsh stdout was not piped"))?;
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
    let approval_callback = config.approval_callback.clone();
    let writer = Arc::clone(&stdin);
    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut decoder = JsonLineDecoder::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let read = match reader.read(&mut chunk).await {
                Ok(read) => read,
                Err(error) => {
                    let _ = event_tx.send(DshSupervisorEvent::ProtocolError(error.to_string()));
                    break;
                }
            };
            if read == 0 {
                let _ = event_tx.send(DshSupervisorEvent::StdoutClosed);
                break;
            }
            for frame in decoder.feed(&chunk[..read]) {
                let event = match adapter.lock().await.on_frame(frame) {
                    Ok(event) => event,
                    Err(error) => {
                        let _ = event_tx.send(DshSupervisorEvent::ProtocolError(error.to_string()));
                        continue;
                    }
                };
                if let DshAdapterEvent::ServerRequest { id, method, params } = event {
                    let request = DshApprovalRequest { id, method, params };
                    let _ = event_tx.send(DshSupervisorEvent::ApprovalRequested(request.clone()));
                    if request.method == "approval/request" {
                        if let Some(callback) = approval_callback.as_ref() {
                            let response = callback(request.clone()).await;
                            let allowed = matches!(response, DshApprovalResponse::Result(_));
                            let bytes = approval_response(&request.id, response);
                            let write_result = async {
                                let mut writer = writer.lock().await;
                                writer.write_all(&bytes).await?;
                                writer.flush().await
                            }
                            .await;
                            if let Err(error) = write_result {
                                let _ = event_tx
                                    .send(DshSupervisorEvent::ProtocolError(error.to_string()));
                            } else {
                                let _ = event_tx.send(DshSupervisorEvent::ApprovalResponded {
                                    id: request.id,
                                    allowed,
                                });
                            }
                        }
                    }
                } else {
                    let _ = event_tx.send(DshSupervisorEvent::Adapter(event));
                }
            }
        }
    });
    Ok((child, stdin, reader_task))
}

fn approval_response(id: &str, response: DshApprovalResponse) -> Vec<u8> {
    let frame = match response {
        DshApprovalResponse::Result(result) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }),
        DshApprovalResponse::Error {
            code,
            message,
            data,
        } => {
            let mut error = json!({ "code": code, "message": message });
            if let Some(data) = data {
                error["data"] = data;
            }
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": error,
            })
        }
    };
    encode_json_line(&frame).expect("JSON values are serializable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dsh_adapter::DshAdapterEvent,
        dsh_protocol::{DshNotification, DshTransportProfile},
    };
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn approval_callback_contract_encodes_json_rpc_result() {
        let bytes = approval_response(
            "approval-1",
            DshApprovalResponse::Result(json!({ "approved": true })),
        );
        let frame: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(frame["id"], "approval-1");
        assert_eq!(frame["result"]["approved"], true);
    }

    #[test]
    fn config_keeps_sdk_profile_and_process_arguments() {
        let config = DshSupervisorConfig {
            binary: Path::new("dsh").into(),
            args: vec!["--profile".into(), "sdk".into()],
            cwd: Some(Path::new("C:/project").into()),
            profile: DshTransportProfile::Sdk,
            approval_callback: None,
        };
        assert_eq!(config.profile, DshTransportProfile::Sdk);
        assert_eq!(config.args, ["--profile", "sdk"]);
        assert_eq!(config.cwd.as_deref(), Some(Path::new("C:/project")));
    }

    #[tokio::test]
    async fn spawns_process_and_forwards_ndjson_stdout() {
        let mut config = if cfg!(windows) {
            DshSupervisorConfig::new("powershell.exe", DshTransportProfile::Sdk)
        } else {
            DshSupervisorConfig::new("sh", DshTransportProfile::Sdk)
        };
        if cfg!(windows) {
            config.args = vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "[Console]::WriteLine('{\"jsonrpc\":\"2.0\",\"method\":\"session/event\",\"params\":{\"kind\":\"delta\"}}')".into(),
            ];
        } else {
            config.args = vec![
                "-c".into(),
                "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"method\":\"session/event\",\"params\":{\"kind\":\"delta\"}}'".into(),
            ];
        }

        let mut supervisor = DshSupervisor::spawn(config).await.unwrap();
        let forwarded = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match supervisor.next_event().await {
                    Some(DshSupervisorEvent::Adapter(DshAdapterEvent::Notification(
                        DshNotification::SessionEvent(_),
                    ))) => break true,
                    Some(_) => continue,
                    None => break false,
                }
            }
        })
        .await
        .unwrap();
        assert!(forwarded);
        let _ = supervisor.wait_for_exit().await;
    }
}
