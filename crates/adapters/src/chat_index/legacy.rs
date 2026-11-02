//! One-time import of the chat state the frontend kept in IndexedDB. The dump is passed in by the frontend, read-only:
//! this module never touches IndexedDB, so the old data stays in place until a later release removes it.
//!
//! Rules, in short:
//! - a chat keeps its id; its bindings come from `chat.mixed` (the first agent's session first, then `agentIds`);
//! - the ledger is the chat's own messages (`local.messages.<id>`, or the transcript when there are no local messages),
//!   with `chat.otherTurns` merged in by time when every message has a timestamp;
//! - a native session already held by an earlier chat is not bound twice: the binding is kept without its native id and
//!   the conflict is reported.
//!
//! The rollback flag tells the frontend to keep reading IndexedDB. Running the migration again is a no-op unless `force`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::store::{insert_message, is_known, native_owner, write_binding};
use super::{Binding, BindingOrigin, BindingState, ChatIndex, NativeRef, NewMessage, Result};

const MIGRATION_KEY: &str = "legacy_migration";
const ROLLBACK_KEY: &str = "legacy_rollback";

/// The IndexedDB values the migration reads, as the frontend dumps them. Unknown fields are ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDump {
    /// `chat.mixed`: per chat, the provider sessions and the models they ran.
    #[serde(default)]
    pub mixed: BTreeMap<String, LegacyProviderState>,
    /// `chat.otherTurns`: turns of another agent in a saved chat.
    #[serde(default)]
    pub other_turns: BTreeMap<String, Vec<Value>>,
    /// `local.messages.<id>`: the messages of a chat that exists only in AgentDeck.
    #[serde(default)]
    pub local_messages: BTreeMap<String, Vec<Value>>,
    /// `transcript.<id>`: the messages read from a native session.
    #[serde(default)]
    pub transcripts: BTreeMap<String, LegacyTranscript>,
    /// Sidebar names and folders, when the frontend passes them. Optional.
    #[serde(default)]
    pub chat_info: BTreeMap<String, LegacyChatInfo>,
    /// The native file of each session the sidebar knows (`index.history`), so bindings get their path.
    #[serde(default)]
    pub history_paths: Vec<LegacyHistoryPath>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHistoryPath {
    pub provider: String,
    pub native_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProviderState {
    pub agent: Option<String>,
    pub first_agent: Option<String>,
    pub source: Option<String>,
    #[serde(default)]
    pub agents: Vec<String>,
    pub agent_session: Option<String>,
    pub agent_epoch: Option<i64>,
    #[serde(default)]
    pub agent_models: BTreeMap<String, String>,
    #[serde(default)]
    pub agent_ids: BTreeMap<String, LegacyAgentId>,
    pub conversation_model: Option<String>,
    /// `provider:nativeId` of every session the chat used before a model or account change.
    #[serde(default)]
    pub provider_aliases: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAgentId {
    pub id: Option<String>,
    pub epoch: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LegacyTranscript {
    #[serde(default)]
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyChatInfo {
    #[serde(default)]
    pub title: String,
    pub cwd: Option<String>,
    pub project_id: Option<String>,
}

/// What the migration wrote. `skipped` counts messages left out (a repeated message id, or no role).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub chats: usize,
    pub bindings: usize,
    pub messages: usize,
    pub skipped: usize,
    /// Native sessions that were already bound to an earlier chat, and so were stored without their native id.
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub migrated: bool,
    /// True when the frontend should keep reading IndexedDB instead of the index.
    pub rollback: bool,
    pub report: Option<MigrationReport>,
}

impl ChatIndex {
    pub fn legacy_status(&self) -> Result<MigrationStatus> {
        let report = meta_get(&self.conn, MIGRATION_KEY)?
            .map(|text| serde_json::from_str::<MigrationReport>(&text))
            .transpose()?;
        let rollback = meta_get(&self.conn, ROLLBACK_KEY)?.as_deref() == Some("1");
        Ok(MigrationStatus {
            migrated: report.is_some(),
            rollback,
            report,
        })
    }

    /// Sets or clears the rollback flag. It only changes what the frontend reads; no data is removed either way.
    pub fn set_legacy_rollback(&mut self, enabled: bool) -> Result<()> {
        meta_set(&self.conn, ROLLBACK_KEY, if enabled { "1" } else { "0" })
    }

    /// Imports the dump in one transaction. Runs once: a later call returns the stored report. `force` clears the index's
    /// chat data first and imports again (IndexedDB is only read, so this is always safe to repeat).
    pub fn migrate_legacy(&mut self, dump: &LegacyDump, force: bool) -> Result<MigrationReport> {
        if !force {
            if let Some(text) = meta_get(&self.conn, MIGRATION_KEY)? {
                return Ok(serde_json::from_str(&text)?);
            }
        }
        let tx = self.conn.transaction()?;
        if force {
            tx.execute("DELETE FROM messages", [])?;
            tx.execute("DELETE FROM bindings", [])?;
            tx.execute("DELETE FROM chats", [])?;
        }
        let report = import(&tx, dump)?;
        meta_set(&tx, MIGRATION_KEY, &serde_json::to_string(&report)?)?;
        tx.commit()?;
        tracing::info!(
            chats = report.chats,
            messages = report.messages,
            conflicts = report.conflicts.len(),
            "imported IndexedDB chats into the chat index"
        );
        Ok(report)
    }
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn import(tx: &Transaction, dump: &LegacyDump) -> Result<MigrationReport> {
    let mut ids = BTreeSet::new();
    ids.extend(dump.mixed.keys().map(String::as_str));
    ids.extend(dump.local_messages.keys().map(String::as_str));
    ids.extend(dump.transcripts.keys().map(String::as_str));
    ids.extend(dump.other_turns.keys().map(String::as_str));
    ids.extend(dump.chat_info.keys().map(String::as_str));

    let paths: HashMap<(String, String), String> = dump
        .history_paths
        .iter()
        .map(|item| {
            (
                (item.provider.clone(), item.native_id.clone()),
                item.path.clone(),
            )
        })
        .collect();

    let mut report = MigrationReport::default();
    for chat_id in ids {
        import_chat(tx, dump, chat_id, &paths, &mut report)?;
    }
    Ok(report)
}

/// Sessions a chat used before a model or account change. They are kept as closed bindings, so their turns can still be
/// attributed. A session already planned for the chat is not added twice.
fn alias_bindings(chat_id: &str, aliases: &[String], planned: &[Binding]) -> Vec<Binding> {
    let mut seen: HashSet<(String, String)> = planned
        .iter()
        .filter_map(|binding| {
            binding
                .native_id
                .clone()
                .map(|native_id| (binding.provider.clone(), native_id))
        })
        .collect();
    let mut found = Vec::new();
    for alias in aliases {
        let Some((provider, native_id)) = alias.split_once(':') else {
            continue;
        };
        if provider.is_empty() || native_id.is_empty() {
            continue;
        }
        if !seen.insert((provider.to_string(), native_id.to_string())) {
            continue;
        }
        found.push(Binding {
            id: format!("{chat_id}#{provider}#{native_id}"),
            chat_id: chat_id.to_string(),
            provider: provider.to_string(),
            native_id: Some(native_id.to_string()),
            path: None,
            model: None,
            epoch: 0,
            origin: BindingOrigin::Created,
            state: BindingState::Closed,
            synced_seq: 0,
            cursor: None,
        });
    }
    found
}

fn import_chat(
    tx: &Transaction,
    dump: &LegacyDump,
    chat_id: &str,
    paths: &HashMap<(String, String), String>,
    report: &mut MigrationReport,
) -> Result<()> {
    let state = dump.mixed.get(chat_id);
    let first = state.and_then(first_agent);
    let current = state
        .and_then(|state| state.agent.clone())
        .or_else(|| first.clone());

    // Planned now, written once the chat row exists (a binding refers to its chat). Messages point at them by provider.
    let mut planned = plan_bindings(chat_id, state, first.as_deref(), current.as_deref());
    let binding_of: HashMap<String, String> = planned
        .iter()
        .map(|binding| (binding.provider.clone(), binding.id.clone()))
        .collect();
    if let Some(state) = state {
        let extra = alias_bindings(chat_id, &state.provider_aliases, &planned);
        planned.extend(extra);
    }

    let (own, from_transcript) = match dump.local_messages.get(chat_id) {
        Some(list) => (list.as_slice(), false),
        None => (
            dump.transcripts
                .get(chat_id)
                .map_or(&[][..], |transcript| transcript.messages.as_slice()),
            true,
        ),
    };
    let others = dump.other_turns.get(chat_id).map_or(&[][..], Vec::as_slice);
    let mut ordered = Vec::new();
    let mut seen_ids = HashSet::new();
    for (message, native) in own
        .iter()
        .map(|m| (m, from_transcript))
        .chain(others.iter().map(|m| (m, false)))
    {
        if let Some(id) = message.get("id").and_then(Value::as_str) {
            if !seen_ids.insert(id.to_string()) {
                report.skipped += 1;
                continue;
            }
        }
        ordered.push((message, native));
    }
    // Other agents' turns are interleaved by time, but only when every turn has a time to sort by.
    if !others.is_empty() && ordered.iter().all(|(message, _)| stamp(message).is_some()) {
        ordered.sort_by(|a, b| {
            stamp(a.0)
                .unwrap_or_default()
                .cmp(stamp(b.0).unwrap_or_default())
        });
    }

    let times: Vec<&str> = ordered
        .iter()
        .filter_map(|(message, _)| stamp(message))
        .collect();
    let info = dump.chat_info.get(chat_id);
    tx.execute(
        "INSERT INTO chats (id, title, project_id, cwd, active_agent, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![
            chat_id,
            info.map_or("", |info| info.title.as_str()),
            info.and_then(|info| info.project_id.as_deref()),
            info.and_then(|info| info.cwd.as_deref()),
            current,
            times.first().copied().unwrap_or_default(),
            times.last().copied().unwrap_or_default(),
        ],
    )?;
    report.chats += 1;

    let mut bindings = Vec::new();
    for mut binding in planned {
        if let Some(native_id) = binding.native_id.clone() {
            if let Some(owner) = native_owner(tx, &binding)? {
                report.conflicts.push(format!(
                    "{chat_id}: {}:{native_id} is already bound to chat {owner}",
                    binding.provider
                ));
                binding.native_id = None;
            }
        }
        // A session that lost its native id to another chat has no file of its own here, so it gets no path.
        if let Some(native_id) = &binding.native_id {
            binding.path = paths
                .get(&(binding.provider.clone(), native_id.clone()))
                .cloned();
        }
        write_binding(tx, chat_id, &binding)?;
        report.bindings += 1;
        bindings.push(binding);
    }

    let mut seq = 0;
    for (message, native) in ordered {
        let Some(role) = message.get("role").and_then(Value::as_str) else {
            report.skipped += 1;
            continue;
        };
        let agent = message
            .get("agent")
            .and_then(Value::as_str)
            .map(str::to_string);
        let provider = agent.clone().or_else(|| current.clone());
        let native = match (
            native,
            message.get("id").and_then(Value::as_str),
            provider.clone(),
        ) {
            (true, Some(msg_id), Some(provider)) => Some(NativeRef {
                provider,
                msg_id: msg_id.to_string(),
            }),
            _ => None,
        };
        if is_known(tx, chat_id, native.as_ref())? {
            report.skipped += 1;
            continue;
        }
        seq += 1;
        let new = NewMessage {
            role: role.to_string(),
            agent,
            model: message
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            binding_id: provider
                .as_deref()
                .and_then(|provider| binding_of.get(provider))
                .cloned(),
            time: stamp(message).unwrap_or_default().to_string(),
            native,
            blocks: message.clone(),
        };
        insert_message(tx, chat_id, seq, &new)?;
        report.messages += 1;
    }

    // A binding has seen the ledger up to its own last turn; anything later from another agent still needs catching up.
    for binding in &bindings {
        tx.execute(
            "UPDATE bindings SET synced_seq = (SELECT COALESCE(MAX(seq), 0) FROM messages WHERE binding_id = ?1)
             WHERE id = ?1",
            [&binding.id],
        )?;
    }
    Ok(())
}

fn first_agent(state: &LegacyProviderState) -> Option<String> {
    state
        .first_agent
        .clone()
        .or_else(|| state.source.clone())
        .or_else(|| state.agent.clone())
        .or_else(|| state.agents.first().cloned())
}

/// One binding per provider of the chat. The first agent takes its `agentSession`; the others take their `agentIds` entry.
fn plan_bindings(
    chat_id: &str,
    state: Option<&LegacyProviderState>,
    first: Option<&str>,
    current: Option<&str>,
) -> Vec<Binding> {
    let Some(state) = state else {
        return Vec::new();
    };
    let mut providers: BTreeMap<String, (Option<String>, Option<i64>)> = BTreeMap::new();
    for agent in &state.agents {
        providers.entry(agent.clone()).or_default();
    }
    for (agent, entry) in &state.agent_ids {
        let slot = providers.entry(agent.clone()).or_default();
        slot.0 = entry.id.clone();
        slot.1 = entry.epoch;
    }
    if let Some(first) = first {
        let slot = providers.entry(first.to_string()).or_default();
        if let Some(session) = &state.agent_session {
            slot.0 = Some(session.clone());
        }
        if slot.1.is_none() {
            slot.1 = state.agent_epoch;
        }
    }
    if let Some(current) = current {
        providers.entry(current.to_string()).or_default();
    }

    providers
        .into_iter()
        .map(|(provider, (native_id, epoch))| {
            let model = state.agent_models.get(&provider).cloned().or_else(|| {
                (Some(provider.as_str()) == first)
                    .then(|| state.conversation_model.clone())
                    .flatten()
            });
            let is_current = Some(provider.as_str()) == current;
            let state_of = match (&native_id, is_current) {
                (None, _) => BindingState::Pending,
                (Some(_), true) => BindingState::Live,
                (Some(_), false) => BindingState::Closed,
            };
            Binding {
                id: format!("{chat_id}#{provider}"),
                chat_id: chat_id.to_string(),
                provider,
                native_id,
                path: None,
                model,
                epoch: epoch.unwrap_or(0),
                origin: BindingOrigin::Created,
                state: state_of,
                synced_seq: 0,
                cursor: None,
            }
        })
        .collect()
}

/// A message's time: `at` (ISO) when present, else the display `time`.
fn stamp(message: &Value) -> Option<&str> {
    message
        .get("at")
        .and_then(Value::as_str)
        .or_else(|| message.get("time").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
}
