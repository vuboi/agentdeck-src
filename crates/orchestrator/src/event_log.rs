use crate::{HarnessEvent, HarnessEventKind, HarnessRuntime, HarnessState};
use serde_json::Error as JsonError;
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::mpsc::{self, SyncSender},
    thread::{self, JoinHandle},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EventLogError {
    #[error("event log I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("event log JSON failed: {0}")]
    Json(#[from] JsonError),
    #[error("event log sequence expected {expected}, got {actual}")]
    Sequence { expected: u64, actual: u64 },
    #[error("event belongs to session {actual}, expected {expected}")]
    Session { expected: String, actual: String },
    #[error("event log writer is closed")]
    Closed,
}

#[derive(Debug, Clone)]
pub struct ReplayOutcome {
    pub runtime: HarnessRuntime,
    pub interrupted: bool,
}

#[derive(Debug, Clone)]
pub struct HarnessEventLog {
    path: PathBuf,
}

enum AsyncMessage {
    Event(HarnessEvent),
    Flush(mpsc::Sender<Result<(), EventLogError>>),
}

/// Non-blocking event-log facade. The bounded queue applies backpressure without blocking the agent process on disk I/O.
pub struct AsyncHarnessEventLog {
    sender: Option<SyncSender<AsyncMessage>>,
    worker: Option<JoinHandle<()>>,
}

impl AsyncHarnessEventLog {
    pub fn new(path: impl Into<PathBuf>, capacity: usize) -> Self {
        let (sender, receiver) = mpsc::sync_channel(capacity.max(1));
        let path = path.into();
        let worker = thread::spawn(move || {
            let log = HarnessEventLog::new(path);
            while let Ok(message) = receiver.recv() {
                match message {
                    AsyncMessage::Event(event) => {
                        let _ = log.append(&event);
                    }
                    AsyncMessage::Flush(reply) => {
                        let result = log.flush();
                        let _ = reply.send(result);
                    }
                }
            }
        });
        Self {
            sender: Some(sender),
            worker: Some(worker),
        }
    }

    pub fn append(&self, event: &HarnessEvent) -> Result<(), EventLogError> {
        self.sender
            .as_ref()
            .ok_or(EventLogError::Closed)?
            .send(AsyncMessage::Event(event.clone()))
            .map_err(|_| EventLogError::Closed)
    }

    pub fn flush(&self) -> Result<(), EventLogError> {
        let (reply, result) = mpsc::channel();
        self.sender
            .as_ref()
            .ok_or(EventLogError::Closed)?
            .send(AsyncMessage::Flush(reply))
            .map_err(|_| EventLogError::Closed)?;
        result.recv().map_err(|_| EventLogError::Closed)?
    }
}

impl Drop for AsyncHarnessEventLog {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            self.sender.take();
            let _ = worker.join();
        }
    }
}

impl HarnessEventLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, event: &HarnessEvent) -> Result<(), EventLogError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        serde_json::to_writer(&mut file, event)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(())
    }

    fn flush(&self) -> Result<(), EventLogError> {
        if !self.path.exists() {
            return Ok(());
        }
        OpenOptions::new()
            .append(true)
            .open(&self.path)?
            .sync_data()?;
        Ok(())
    }

    pub fn read(&self) -> Result<Vec<HarnessEvent>, EventLogError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        BufReader::new(File::open(&self.path)?)
            .lines()
            .map(|line| Ok(serde_json::from_str(&line?)?))
            .collect()
    }

    pub fn replay(&self, session_id: impl Into<String>) -> Result<ReplayOutcome, EventLogError> {
        let session_id = session_id.into();
        let events = self.read()?;
        let mut runtime = HarnessRuntime::new(session_id.clone());
        for (expected, event) in events.iter().enumerate() {
            if event.seq != expected as u64 {
                return Err(EventLogError::Sequence {
                    expected: expected as u64,
                    actual: event.seq,
                });
            }
            if event.session_id != session_id {
                return Err(EventLogError::Session {
                    expected: session_id,
                    actual: event.session_id.clone(),
                });
            }
            runtime.apply_recorded(event)?;
        }
        let interrupted =
            !runtime.state().is_terminal() && runtime.state() != HarnessState::Created;
        Ok(ReplayOutcome {
            runtime,
            interrupted,
        })
    }
}

impl HarnessRuntime {
    pub(crate) fn apply_recorded(&mut self, event: &HarnessEvent) -> Result<(), EventLogError> {
        if event.seq != self.next_seq() {
            return Err(EventLogError::Sequence {
                expected: self.next_seq(),
                actual: event.seq,
            });
        }
        self.next_seq = event.seq + 1;
        self.events.push(event.clone());
        match &event.kind {
            HarnessEventKind::SessionStarted => self.state = HarnessState::Ready,
            HarnessEventKind::TurnStarted => {
                self.active_turn_id = event.turn_id.clone();
                self.state = HarnessState::Running;
            }
            HarnessEventKind::ToolStarted { call_id, .. } => {
                self.active_tool_ids.insert(call_id.clone());
                self.state = HarnessState::WaitingTool;
            }
            HarnessEventKind::ToolFinished { call_id, .. } => {
                self.active_tool_ids.remove(call_id);
                self.refresh_replayed_state();
            }
            HarnessEventKind::ApprovalRequested { request_id } => {
                self.active_approval_ids.insert(request_id.clone());
                self.state = HarnessState::WaitingApproval;
            }
            HarnessEventKind::ApprovalResolved { request_id, .. } => {
                self.active_approval_ids.remove(request_id);
                self.refresh_replayed_state();
            }
            HarnessEventKind::TurnCompleted => {
                self.active_tool_ids.clear();
                self.active_approval_ids.clear();
                self.active_turn_id = None;
                self.state = HarnessState::Completed;
            }
            HarnessEventKind::TurnFailed { .. } => {
                self.active_tool_ids.clear();
                self.active_approval_ids.clear();
                self.active_turn_id = None;
                self.state = HarnessState::Failed;
            }
            HarnessEventKind::TurnCancelled => {
                self.active_tool_ids.clear();
                self.active_approval_ids.clear();
                self.active_turn_id = None;
                self.state = HarnessState::Cancelled;
            }
            HarnessEventKind::SessionStatus { state } => self.state = *state,
            _ => {}
        }
        Ok(())
    }
    fn refresh_replayed_state(&mut self) {
        self.state = if !self.active_approval_ids.is_empty() {
            HarnessState::WaitingApproval
        } else if !self.active_tool_ids.is_empty() {
            HarnessState::WaitingTool
        } else {
            HarnessState::Running
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn append_and_replay_detects_interrupted_turn() {
        let path = std::env::temp_dir().join(format!(
            "agentdeck-harness-events-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let log = HarnessEventLog::new(&path);
        let mut runtime = HarnessRuntime::new("s");
        runtime.start();
        runtime.begin_turn("t");
        runtime.assistant_delta("hi");
        for event in runtime.events() {
            log.append(event).unwrap();
        }
        let replay = log.replay("s").unwrap();
        assert!(replay.interrupted);
        assert_eq!(replay.runtime.next_seq(), runtime.next_seq());
        assert_eq!(replay.runtime.state(), HarnessState::Running);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn async_log_flushes_events_without_synthetic_records() {
        let path = std::env::temp_dir().join(format!(
            "agentdeck-harness-async-events-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let log = AsyncHarnessEventLog::new(&path, 2);
        let event = HarnessEvent {
            seq: 0,
            session_id: "s".into(),
            turn_id: None,
            step_id: None,
            kind: HarnessEventKind::SessionStarted,
        };
        log.append(&event).unwrap();
        log.flush().unwrap();
        drop(log);
        let events = HarnessEventLog::new(&path).read().unwrap();
        assert_eq!(events, vec![event]);
        let _ = std::fs::remove_file(path);
    }
}
