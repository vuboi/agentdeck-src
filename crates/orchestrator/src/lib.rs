//! Durable-workflow domain primitives for AgentDeck.
//!
//! This crate owns the run/step/attempt state machine. UI code may project its state, but it must not
//! decide whether a step is ready or whether a retry is legal. Persistence is intentionally kept at the
//! boundary: every transition produces an audit event that a daemon can append to the event store.

mod approval;
mod error;
mod event_log;
mod events;
mod harness;
mod model;
mod session_tree;
mod state;
mod supervisor;

pub use approval::{ApprovalBroker, ApprovalError, ApprovalRecord, ApprovalStatus};
pub use error::TransitionError;
pub use event_log::{AsyncHarnessEventLog, EventLogError, HarnessEventLog, ReplayOutcome};
pub use events::WorkflowEvent;
pub use harness::{HarnessEvent, HarnessEventKind, HarnessRuntime, HarnessSnapshot, HarnessState};
pub use model::{Attempt, AttemptStatus, Run, RunStatus, Step, StepSpec, StepStatus};
pub use session_tree::{SessionNode, SessionRuntimeTree};
pub use supervisor::{ProcessSupervisor, SupervisorEvent, SupervisorState};
