//! The chat index: one SQLite file (`~/.agentdeck/chats.db`) that holds which native sessions belong to which AgentDeck
//! chat, and the ordered ledger of the chat's turns. See `docs/plans/chat-history-mapping/plan.md` sections 3.1-3.3.
//!
//! Three things live here:
//! - a **chat**, with a stable id that never comes from a provider;
//! - a **binding**, one native session of one provider inside a chat. `(provider, native_id)` belongs to at most one chat;
//! - the **ledger**, the chat's turns in `seq` order. A turn that came from a native session carries its native message
//!   id, so importing the same session twice does not repeat it.

mod legacy;
mod schema;
mod store;

#[cfg(test)]
mod tests;

pub use legacy::{
    LegacyAgentId, LegacyChatInfo, LegacyDump, LegacyProviderState, LegacyTranscript,
    MigrationReport, MigrationStatus,
};

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ChatIndexError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("could not encode or decode a message's blocks: {0}")]
    Codec(String),
    #[error("native session {provider}:{native_id} already belongs to chat {chat_id}")]
    NativeBound {
        provider: String,
        native_id: String,
        chat_id: String,
    },
    #[error("chat not found: {0}")]
    ChatNotFound(String),
    #[error("binding {binding_id} does not belong to chat {chat_id}")]
    BindingNotInChat { binding_id: String, chat_id: String },
    #[error("invalid legacy dump: {0}")]
    InvalidDump(String),
}

pub type Result<T, E = ChatIndexError> = std::result::Result<T, E>;

/// A chat as the sidebar and the chat view see it. `title`, `cwd` and `project_id` are whatever the caller saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub cwd: Option<String>,
    pub active_agent: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingOrigin {
    Created,
    Imported,
    Exported,
}

impl BindingOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Imported => "imported",
            Self::Exported => "exported",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "created" => Some(Self::Created),
            "imported" => Some(Self::Imported),
            "exported" => Some(Self::Exported),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingState {
    Pending,
    Live,
    Closed,
}

impl BindingState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Live => "live",
            Self::Closed => "closed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "pending" => Some(Self::Pending),
            "live" => Some(Self::Live),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }
}

/// One native session of one provider inside a chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub chat_id: String,
    pub provider: String,
    /// `None` until the CLI reports its session id (Codex and Antigravity do so late).
    pub native_id: Option<String>,
    pub path: Option<String>,
    pub model: Option<String>,
    pub epoch: i64,
    pub origin: BindingOrigin,
    pub state: BindingState,
    /// The last ledger `seq` this session has seen. Turns above it that another binding wrote still need catching up.
    pub synced_seq: i64,
    /// Reader position for incremental import. Opaque to the index.
    pub cursor: Option<Value>,
}

/// The native message a ledger turn came from, used for dedupe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRef {
    pub provider: String,
    pub msg_id: String,
}

/// A turn to write. `blocks` is the frontend's message payload (its blocks and flags), stored as given; the index
/// reads only the columns above it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    pub role: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub binding_id: Option<String>,
    pub time: String,
    pub native: Option<NativeRef>,
    pub blocks: Value,
    /// The id the message has on screen (the app's own), so the ledger row can be matched back to it (version 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// A stored turn: a `NewMessage` plus its position in the ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub seq: i64,
    #[serde(flatten)]
    pub message: NewMessage,
}

/// The newest turns of a chat, or the turns before `before_seq`, in `seq` order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    pub chat: ChatMeta,
    pub bindings: Vec<Binding>,
    pub messages: Vec<StoredMessage>,
    /// True when older turns exist below the first message of this page.
    pub has_more: bool,
}

/// What `append` did: `skipped` counts turns whose native message id was already in the ledger.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendReport {
    pub inserted: usize,
    pub skipped: usize,
}

/// The chat index. One connection, owned by the caller; the Tauri side keeps it behind a lock.
pub struct ChatIndex {
    conn: Connection,
}

impl ChatIndex {
    /// Opens (creating if needed) the index file and makes sure its schema is current.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::with_connection(Connection::open(path)?)
    }

    /// An index in memory, for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::with_connection(Connection::open_in_memory()?)
    }

    fn with_connection(conn: Connection) -> Result<Self> {
        schema::prepare(&conn)?;
        tracing::debug!("chat index ready");
        Ok(Self { conn })
    }
}
