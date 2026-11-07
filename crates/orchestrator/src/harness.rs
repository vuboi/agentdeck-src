use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Provider-neutral lifecycle for one AgentDeck runtime session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessState {
    Created,
    Starting,
    Ready,
    Running,
    WaitingTool,
    WaitingApproval,
    Stopping,
    Completed,
    Failed,
    Cancelled,
}

impl HarnessState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessEvent {
    pub seq: u64,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub step_id: Option<String>,
    pub kind: HarnessEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HarnessEventKind {
    SessionStarted,
    TurnStarted,
    StepStarted,
    AssistantDelta {
        text: String,
    },
    ToolStarted {
        call_id: String,
        name: String,
    },
    ToolFinished {
        call_id: String,
        ok: bool,
    },
    ApprovalRequested {
        request_id: String,
    },
    ApprovalResolved {
        request_id: String,
        approved: bool,
    },
    SubagentStarted {
        child_session_id: String,
    },
    SubagentFinished {
        child_session_id: String,
        ok: bool,
    },
    /// An event observed inside a child session. It is durable for replay/UI audit, but does not mutate parent state.
    ChildEvent {
        child_session_id: String,
        event: Box<HarnessEventKind>,
    },
    FileChanged {
        path: String,
    },
    TurnCompleted,
    TurnFailed {
        reason: String,
    },
    TurnCancelled,
    SessionStatus {
        state: HarnessState,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessSnapshot {
    pub session_id: String,
    pub state: HarnessState,
    pub next_seq: u64,
    pub active_turn_id: Option<String>,
    pub active_tool_ids: Vec<String>,
    pub active_approval_ids: Vec<String>,
    pub active_subagent_ids: Vec<String>,
    pub events: Vec<HarnessEvent>,
}

/// Deterministic state holder for provider adapters and UI projections.
/// Persistence stays outside this type: callers can append `events()` to the existing store.
#[derive(Debug, Clone)]
pub struct HarnessRuntime {
    pub(crate) session_id: String,
    pub(crate) state: HarnessState,
    pub(crate) next_seq: u64,
    pub(crate) active_turn_id: Option<String>,
    pub(crate) active_tool_ids: BTreeSet<String>,
    pub(crate) active_approval_ids: BTreeSet<String>,
    pub(crate) events: Vec<HarnessEvent>,
}

impl HarnessRuntime {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self::with_next_seq(session_id, 0)
    }

    /// Creates an empty turn runtime whose first event uses the session log's next sequence.
    /// Lifecycle state starts at `Created`; prior turns and their active work are not restored.
    pub fn with_next_seq(session_id: impl Into<String>, next_seq: u64) -> Self {
        Self {
            session_id: session_id.into(),
            state: HarnessState::Created,
            next_seq,
            active_turn_id: None,
            active_tool_ids: BTreeSet::new(),
            active_approval_ids: BTreeSet::new(),
            events: Vec::new(),
        }
    }

    pub fn state(&self) -> HarnessState {
        self.state
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn events(&self) -> &[HarnessEvent] {
        &self.events
    }

    pub fn snapshot(&self) -> HarnessSnapshot {
        let mut active_subagent_ids = BTreeSet::new();
        for event in &self.events {
            match &event.kind {
                HarnessEventKind::SubagentStarted { child_session_id } => {
                    active_subagent_ids.insert(child_session_id.clone());
                }
                HarnessEventKind::SubagentFinished {
                    child_session_id, ..
                } => {
                    active_subagent_ids.remove(child_session_id);
                }
                _ => {}
            }
        }
        HarnessSnapshot {
            session_id: self.session_id.clone(),
            state: self.state,
            next_seq: self.next_seq,
            active_turn_id: self.active_turn_id.clone(),
            active_tool_ids: self.active_tool_ids.iter().cloned().collect(),
            active_approval_ids: self.active_approval_ids.iter().cloned().collect(),
            active_subagent_ids: active_subagent_ids.into_iter().collect(),
            events: self.events.clone(),
        }
    }

    pub fn start(&mut self) {
        if self.state == HarnessState::Created {
            self.state = HarnessState::Starting;
            self.record(HarnessEventKind::SessionStarted);
            self.state = HarnessState::Ready;
            self.record_status();
        }
    }

    pub fn begin_turn(&mut self, turn_id: impl Into<String>) -> bool {
        if !matches!(self.state, HarnessState::Ready | HarnessState::Completed) {
            return false;
        }
        let turn_id = turn_id.into();
        self.active_turn_id = Some(turn_id.clone());
        self.state = HarnessState::Running;
        self.record_with_turn(HarnessEventKind::TurnStarted, Some(turn_id));
        true
    }

    pub fn assistant_delta(&mut self, text: impl Into<String>) -> bool {
        if !matches!(
            self.state,
            HarnessState::Running | HarnessState::WaitingTool
        ) {
            return false;
        }
        self.record_with_turn(HarnessEventKind::AssistantDelta { text: text.into() }, None);
        true
    }

    pub fn wait_for_tool(&mut self, call_id: impl Into<String>, name: impl Into<String>) -> bool {
        if !matches!(
            self.state,
            HarnessState::Running | HarnessState::WaitingTool
        ) {
            return false;
        }
        let call_id = call_id.into();
        self.active_tool_ids.insert(call_id.clone());
        self.record(HarnessEventKind::ToolStarted {
            call_id,
            name: name.into(),
        });
        self.state = HarnessState::WaitingTool;
        self.record_status();
        true
    }

    pub fn finish_tool(&mut self, call_id: impl Into<String>, ok: bool) -> bool {
        if !matches!(
            self.state,
            HarnessState::WaitingTool | HarnessState::WaitingApproval
        ) {
            return false;
        }
        let call_id = call_id.into();
        if !self.active_tool_ids.remove(&call_id) {
            return false;
        }
        self.record(HarnessEventKind::ToolFinished { call_id, ok });
        self.refresh_wait_state();
        self.record_status();
        true
    }

    pub fn request_approval(&mut self, request_id: impl Into<String>) -> bool {
        if !matches!(
            self.state,
            HarnessState::Running | HarnessState::WaitingTool | HarnessState::WaitingApproval
        ) {
            return false;
        }
        let request_id = request_id.into();
        self.active_approval_ids.insert(request_id.clone());
        self.state = HarnessState::WaitingApproval;
        self.record(HarnessEventKind::ApprovalRequested { request_id });
        self.record_status();
        true
    }

    pub fn resolve_approval(&mut self, request_id: impl Into<String>, approved: bool) -> bool {
        if self.state != HarnessState::WaitingApproval {
            return false;
        }
        let request_id = request_id.into();
        if !self.active_approval_ids.remove(&request_id) {
            return false;
        }

        self.state = HarnessState::WaitingApproval;
        self.record(HarnessEventKind::ApprovalResolved {
            request_id,
            approved,
        });
        self.refresh_wait_state();
        self.record_status();
        true
    }

    pub fn start_subagent(&mut self, child_session_id: impl Into<String>) -> bool {
        if !matches!(
            self.state,
            HarnessState::Running | HarnessState::WaitingTool | HarnessState::WaitingApproval
        ) {
            return false;
        }
        self.record(HarnessEventKind::SubagentStarted {
            child_session_id: child_session_id.into(),
        });
        true
    }

    pub fn finish_subagent(&mut self, child_session_id: impl Into<String>, ok: bool) -> bool {
        if self.state.is_terminal() {
            return false;
        }
        self.record(HarnessEventKind::SubagentFinished {
            child_session_id: child_session_id.into(),
            ok,
        });
        true
    }

    /// Records child work without applying its tool, approval, or terminal transitions to the parent.
    pub fn record_child_event(
        &mut self,
        child_session_id: impl Into<String>,
        event: HarnessEventKind,
    ) -> bool {
        if self.state.is_terminal() {
            return false;
        }
        self.record(HarnessEventKind::ChildEvent {
            child_session_id: child_session_id.into(),
            event: Box::new(event),
        });
        true
    }

    pub fn complete_turn(&mut self) -> bool {
        if !matches!(
            self.state,
            HarnessState::Running | HarnessState::WaitingTool | HarnessState::WaitingApproval
        ) {
            return false;
        }
        self.active_tool_ids.clear();
        self.active_approval_ids.clear();
        self.state = HarnessState::Completed;
        self.record(HarnessEventKind::TurnCompleted);
        self.active_turn_id = None;
        self.record_status();
        true
    }

    pub fn fail_turn(&mut self, reason: impl Into<String>) -> bool {
        if self.state.is_terminal() || self.state == HarnessState::Created {
            return false;
        }
        self.state = HarnessState::Failed;
        self.record(HarnessEventKind::TurnFailed {
            reason: reason.into(),
        });
        self.active_turn_id = None;
        self.active_tool_ids.clear();
        self.active_approval_ids.clear();
        self.record_status();
        true
    }

    /// Idempotent cancellation boundary for adapters and process supervisors.
    pub fn cancel(&mut self) -> bool {
        if self.state.is_terminal() {
            return false;
        }
        self.state = HarnessState::Cancelled;
        self.record(HarnessEventKind::TurnCancelled);
        self.active_turn_id = None;
        self.active_tool_ids.clear();
        self.active_approval_ids.clear();
        self.record_status();
        true
    }

    fn record(&mut self, kind: HarnessEventKind) {
        self.record_with_turn(kind, None);
    }

    fn record_status(&mut self) {
        self.record(HarnessEventKind::SessionStatus { state: self.state });
    }

    pub(crate) fn refresh_wait_state(&mut self) {
        if !matches!(
            self.state,
            HarnessState::WaitingTool | HarnessState::WaitingApproval
        ) {
            return;
        }
        self.state = if !self.active_approval_ids.is_empty() {
            HarnessState::WaitingApproval
        } else if !self.active_tool_ids.is_empty() {
            HarnessState::WaitingTool
        } else {
            HarnessState::Running
        };
    }

    fn record_with_turn(&mut self, kind: HarnessEventKind, turn_id: Option<String>) {
        self.events.push(HarnessEvent {
            seq: self.next_seq,
            session_id: self.session_id.clone(),
            turn_id: turn_id.or_else(|| self.active_turn_id.clone()),
            step_id: None,
            kind,
        });
        self.next_seq += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{HarnessEventKind, HarnessRuntime, HarnessState};

    #[test]
    fn fake_provider_turn_has_stable_order_and_terminal_snapshot() {
        let mut runtime = HarnessRuntime::new("session-1");
        runtime.start();
        assert!(runtime.begin_turn("turn-1"));
        assert!(runtime.assistant_delta("hello"));
        assert!(runtime.wait_for_tool("call-1", "read_file"));
        assert!(runtime.finish_tool("call-1", true));
        assert!(runtime.complete_turn());

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.state, HarnessState::Completed);
        assert_eq!(snapshot.next_seq as usize, snapshot.events.len());
        assert!(snapshot
            .events
            .windows(2)
            .all(|events| events[0].seq < events[1].seq));
        assert!(matches!(
            snapshot.events.last().map(|event| &event.kind),
            Some(HarnessEventKind::SessionStatus {
                state: HarnessState::Completed
            })
        ));
    }

    #[test]
    fn cancellation_is_idempotent_and_keeps_terminal_state() {
        let mut runtime = HarnessRuntime::new("session-1");
        runtime.start();
        assert!(runtime.begin_turn("turn-1"));
        assert!(runtime.cancel());
        assert!(!runtime.cancel());
        assert_eq!(runtime.state(), HarnessState::Cancelled);
        assert_eq!(runtime.events().len(), 5);
    }

    #[test]
    fn invalid_events_are_rejected_without_mutating_state() {
        let mut runtime = HarnessRuntime::new("session-1");
        assert!(!runtime.begin_turn("turn-1"));
        runtime.start();
        assert!(!runtime.finish_tool("call-1", true));
        assert_eq!(runtime.state(), HarnessState::Ready);
    }

    #[test]
    fn approval_and_child_events_keep_parent_turn_identity() {
        let mut runtime = HarnessRuntime::new("session-1");
        runtime.start();
        runtime.begin_turn("turn-1");
        assert!(runtime.request_approval("approval-1"));
        assert!(runtime.resolve_approval("approval-1", true));
        assert!(runtime.start_subagent("child-1"));
        assert!(runtime.finish_subagent("child-1", true));

        assert!(runtime
            .events()
            .iter()
            .filter(|event| event.turn_id.is_some())
            .all(|event| event.turn_id.as_deref() == Some("turn-1")));
    }

    #[test]
    fn snapshot_replays_active_subagent_lifecycle_from_session_history() {
        let mut runtime = HarnessRuntime::new("session-1");
        runtime.start();
        runtime.begin_turn("turn-1");
        runtime.start_subagent("child-active");
        runtime.start_subagent("child-finished");
        runtime.finish_subagent("child-finished", true);

        assert_eq!(runtime.snapshot().active_subagent_ids, ["child-active"]);
    }

    #[test]
    fn child_event_is_recorded_without_blocking_or_finishing_parent() {
        let mut runtime = HarnessRuntime::new("session-1");
        runtime.start();
        runtime.begin_turn("turn-1");
        assert!(runtime.record_child_event(
            "child-1",
            HarnessEventKind::AssistantDelta {
                text: "child output".into(),
            },
        ));
        assert_eq!(runtime.state(), HarnessState::Running);
        assert!(matches!(
            runtime.events().last().map(|event| &event.kind),
            Some(HarnessEventKind::ChildEvent {
                child_session_id,
                event
            }) if child_session_id == "child-1"
                && matches!(**event, HarnessEventKind::AssistantDelta { .. })
        ));
    }

    #[test]
    fn parallel_tools_keep_waiting_until_all_results_arrive() {
        let mut runtime = HarnessRuntime::new("session-1");
        runtime.start();
        runtime.begin_turn("turn-1");
        assert!(runtime.wait_for_tool("call-1", "read_file"));
        assert!(runtime.wait_for_tool("call-2", "shell"));
        assert_eq!(runtime.state(), HarnessState::WaitingTool);
        assert!(runtime.finish_tool("call-1", true));
        assert_eq!(runtime.state(), HarnessState::WaitingTool);
        assert!(runtime.finish_tool("call-2", true));
        assert_eq!(runtime.state(), HarnessState::Running);
    }
}
