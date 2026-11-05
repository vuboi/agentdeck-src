use serde_json::json;

use super::{
    Binding, BindingOrigin, BindingState, ChatIndex, ChatIndexError, ChatMeta, LegacyDump,
    NativeRef, NewMessage, StoredMessage,
};

fn chat(id: &str) -> ChatMeta {
    ChatMeta {
        id: id.to_string(),
        title: id.to_string(),
        project_id: None,
        cwd: Some("E:/work".to_string()),
        active_agent: None,
        created_at: "2026-11-01T09:00:00Z".to_string(),
        updated_at: "2026-11-01T09:00:00Z".to_string(),
    }
}

fn binding(id: &str, chat_id: &str, provider: &str, native_id: Option<&str>) -> Binding {
    Binding {
        id: id.to_string(),
        chat_id: chat_id.to_string(),
        provider: provider.to_string(),
        native_id: native_id.map(str::to_string),
        path: None,
        model: None,
        epoch: 0,
        origin: BindingOrigin::Created,
        state: BindingState::Live,
        synced_seq: 0,
        cursor: None,
    }
}

/// A turn whose text is `text`. `native` is `(provider, native message id)` when it came from a native session.
fn turn(text: &str, binding_id: Option<&str>, native: Option<(&str, &str)>) -> NewMessage {
    NewMessage {
        client_id: None,
        role: "user".to_string(),
        agent: None,
        model: None,
        binding_id: binding_id.map(str::to_string),
        time: "2026-11-01T10:00:00Z".to_string(),
        native: native.map(|(provider, msg_id)| NativeRef {
            provider: provider.to_string(),
            msg_id: msg_id.to_string(),
        }),
        blocks: json!({ "id": text, "text": text }),
    }
}

fn texts(messages: &[StoredMessage]) -> Vec<&str> {
    messages
        .iter()
        .map(|message| message.message.blocks["text"].as_str().unwrap_or_default())
        .collect()
}

fn seqs(messages: &[StoredMessage]) -> Vec<i64> {
    messages.iter().map(|message| message.seq).collect()
}

fn page_of(index: &ChatIndex, chat_id: &str) -> Vec<StoredMessage> {
    index
        .open_page(chat_id, None, 100)
        .expect("page")
        .map(|page| page.messages)
        .unwrap_or_default()
}

#[test]
fn native_session_belongs_to_one_chat() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("a")).expect("save a");
    index.save_chat(&chat("b")).expect("save b");

    index
        .bind("a", &binding("a#claude", "a", "claude", Some("s1")))
        .expect("bind");
    assert_eq!(
        index.resolve_native("claude", "s1").expect("resolve"),
        Some("a".to_string())
    );

    let clash = index.bind("b", &binding("b#claude", "b", "claude", Some("s1")));
    assert!(matches!(
        clash,
        Err(ChatIndexError::NativeBound { ref chat_id, .. }) if chat_id == "a"
    ));
    assert!(index.bindings("b").expect("bindings").is_empty());

    // The same provider id under another provider is a different session.
    index
        .bind("b", &binding("b#codex", "b", "codex", Some("s1")))
        .expect("other provider");

    // Updating the binding that already owns the session is fine.
    let mut moved = binding("a#claude", "a", "claude", Some("s1"));
    moved.model = Some("opus".to_string());
    index.bind("a", &moved).expect("update own binding");
    assert_eq!(
        index.bindings("a").expect("bindings")[0].model.as_deref(),
        Some("opus")
    );

    // Bindings with no native id yet do not clash with each other.
    index
        .bind("a", &binding("a#codex-pending", "a", "antigravity", None))
        .expect("pending a");
    index
        .bind("b", &binding("b#codex-pending", "b", "antigravity", None))
        .expect("pending b");
}

#[test]
fn unique_index_rejects_a_second_owner_even_without_the_check() {
    let index = ChatIndex::open_in_memory().expect("open");
    index
        .conn
        .execute("INSERT INTO chats (id) VALUES ('a'), ('b')", [])
        .expect("chats");
    index
        .conn
        .execute(
            "INSERT INTO bindings (id, chat_id, provider, native_id, origin, state) VALUES ('a#c', 'a', 'codex', 'x', 'created', 'live')",
            [],
        )
        .expect("first");
    let second = index.conn.execute(
        "INSERT INTO bindings (id, chat_id, provider, native_id, origin, state) VALUES ('b#c', 'b', 'codex', 'x', 'created', 'live')",
        [],
    );
    assert!(second.is_err());
}

#[test]
fn repeated_native_message_is_stored_once() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("a")).expect("save");
    index
        .bind("a", &binding("a#claude", "a", "claude", Some("s1")))
        .expect("bind");

    let first = index
        .append(
            "a",
            &[turn("hello", Some("a#claude"), Some(("claude", "u1")))],
        )
        .expect("append");
    assert_eq!((first.inserted, first.skipped), (1, 0));

    let again = index
        .append(
            "a",
            &[turn("hello", Some("a#claude"), Some(("claude", "u1")))],
        )
        .expect("append again");
    assert_eq!((again.inserted, again.skipped), (0, 1));

    // Two copies in one batch: the second is skipped too.
    let batch = index
        .append(
            "a",
            &[
                turn("two", Some("a#claude"), Some(("claude", "u2"))),
                turn("two", Some("a#claude"), Some(("claude", "u2"))),
            ],
        )
        .expect("batch");
    assert_eq!((batch.inserted, batch.skipped), (1, 1));

    // A native sync of the same session adds only what is new.
    let synced = index
        .sync_native(
            "a",
            "a#claude",
            &[
                turn("one", None, Some(("claude", "u1"))),
                turn("three", None, Some(("claude", "u3"))),
            ],
        )
        .expect("sync");
    assert_eq!((synced.inserted, synced.skipped), (1, 1));

    assert_eq!(texts(&page_of(&index, "a")), vec!["hello", "two", "three"]);
}

#[test]
fn externally_resumed_turn_goes_after_its_binding() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("c")).expect("save");
    index
        .bind("c", &binding("c#claude", "c", "claude", Some("s1")))
        .expect("claude");
    index
        .bind("c", &binding("c#codex", "c", "codex", Some("x1")))
        .expect("codex");

    index
        .append(
            "c",
            &[
                turn("claude 1", Some("c#claude"), None),
                turn("claude 2", Some("c#claude"), None),
            ],
        )
        .expect("claude turns");
    index
        .append(
            "c",
            &[
                turn("codex 1", Some("c#codex"), None),
                turn("codex 2", Some("c#codex"), None),
            ],
        )
        .expect("codex turns");

    // The user continued the Claude session in its own terminal: one new turn.
    let report = index
        .sync_native(
            "c",
            "c#claude",
            &[turn("resumed", None, Some(("claude", "r1")))],
        )
        .expect("sync");
    assert_eq!(report.inserted, 1);

    let page = index
        .open_page("c", None, 100)
        .expect("page")
        .expect("chat");
    assert_eq!(
        texts(&page.messages),
        vec!["claude 1", "claude 2", "resumed", "codex 1", "codex 2"]
    );
    assert_eq!(seqs(&page.messages), vec![1, 2, 3, 4, 5]);
    assert_eq!(
        page.messages[2].message.binding_id.as_deref(),
        Some("c#claude")
    );

    // Codex had seen up to its old seq 4, which is now 5. Claude has seen up to 3, the new turn.
    let codex = page
        .bindings
        .iter()
        .find(|b| b.id == "c#codex")
        .expect("codex binding");
    let claude = page
        .bindings
        .iter()
        .find(|b| b.id == "c#claude")
        .expect("claude binding");
    assert_eq!((codex.synced_seq, claude.synced_seq), (5, 3));

    // Two more resumed turns keep their order and push Codex down again.
    index
        .sync_native(
            "c",
            "c#claude",
            &[
                turn("resumed 2", None, Some(("claude", "r2"))),
                turn("resumed 3", None, Some(("claude", "r3"))),
            ],
        )
        .expect("sync again");
    let page = index
        .open_page("c", None, 100)
        .expect("page")
        .expect("chat");
    assert_eq!(
        texts(&page.messages),
        vec![
            "claude 1",
            "claude 2",
            "resumed",
            "resumed 2",
            "resumed 3",
            "codex 1",
            "codex 2"
        ]
    );
    assert_eq!(seqs(&page.messages), (1..=7).collect::<Vec<_>>());
}

#[test]
fn sync_of_a_binding_with_no_turns_appends_at_the_end() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("c")).expect("save");
    index
        .bind("c", &binding("c#codex", "c", "codex", Some("x1")))
        .expect("codex");
    index
        .append("c", &[turn("first", None, None)])
        .expect("append");
    index
        .bind("c", &binding("c#claude", "c", "claude", Some("s1")))
        .expect("claude");

    index
        .sync_native(
            "c",
            "c#claude",
            &[turn("from claude", None, Some(("claude", "m1")))],
        )
        .expect("sync");
    assert_eq!(texts(&page_of(&index, "c")), vec!["first", "from claude"]);
}

#[test]
fn page_walks_back_through_the_ledger() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("p")).expect("save");
    let turns: Vec<NewMessage> = (1..=5)
        .map(|n| turn(&format!("t{n}"), None, None))
        .collect();
    index.append("p", &turns).expect("append");

    let newest = index.open_page("p", None, 2).expect("page").expect("chat");
    assert_eq!(texts(&newest.messages), vec!["t4", "t5"]);
    assert!(newest.has_more);

    let older = index
        .open_page("p", Some(4), 2)
        .expect("page")
        .expect("chat");
    assert_eq!(texts(&older.messages), vec!["t2", "t3"]);
    assert!(older.has_more);

    let oldest = index
        .open_page("p", Some(2), 2)
        .expect("page")
        .expect("chat");
    assert_eq!(texts(&oldest.messages), vec!["t1"]);
    assert!(!oldest.has_more);
}

#[test]
fn delete_returns_native_paths_and_frees_the_session() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("a")).expect("save");
    let mut bound = binding("a#claude", "a", "claude", Some("s1"));
    bound.path = Some("C:/home/.claude/projects/x/s1.jsonl".to_string());
    index.bind("a", &bound).expect("bind");
    index
        .append("a", &[turn("hi", Some("a#claude"), Some(("claude", "u1")))])
        .expect("append");

    let paths = index.delete_chat("a").expect("delete");
    assert_eq!(
        paths,
        vec!["C:/home/.claude/projects/x/s1.jsonl".to_string()]
    );
    assert!(index.chat("a").expect("chat").is_none());
    assert_eq!(index.resolve_native("claude", "s1").expect("resolve"), None);

    index.save_chat(&chat("b")).expect("save b");
    index
        .bind("b", &binding("b#claude", "b", "claude", Some("s1")))
        .expect("rebind after delete");
}

#[test]
fn migrates_an_indexeddb_dump_once() {
    let dump: LegacyDump = serde_json::from_value(json!({
        "mixed": {
            "chat-a": {
                "agent": "codex",
                "firstAgent": "claude",
                "agentSession": "claude-s1",
                "agentEpoch": 1,
                "agents": ["claude", "codex"],
                "agentIds": {
                    "claude": { "id": "claude-s1", "epoch": 1 },
                    "codex": { "id": "cx-1", "epoch": 2 }
                },
                "agentModels": { "claude": "opus", "codex": "gpt-5" },
                "conversationModel": "opus",
                "providerAliases": ["claude:claude-s1", "codex:cx-0"]
            },
            "chat-b": {
                "agent": "claude",
                "firstAgent": "claude",
                "agentSession": "claude-s1",
                "agentIds": { "claude": { "id": "claude-s1" } }
            },
            "chat-c": { "agent": "copilot", "firstAgent": "copilot", "agents": ["copilot"] }
        },
        "localMessages": {
            "chat-a": [
                { "id": "m1", "role": "user", "time": "10:00", "at": "2026-11-01T10:00:00Z", "blocks": [] },
                { "id": "m2", "role": "assistant", "agent": "claude", "model": "opus", "at": "2026-11-01T10:00:05Z", "blocks": [] }
            ]
        },
        "transcripts": {
            "chat-b": { "stamp": "x", "start": 0, "messages": [
                { "id": "n1", "role": "user", "at": "2026-11-01T09:00:00Z", "blocks": [] },
                { "id": "n2", "role": "assistant", "at": "2026-11-01T09:00:03Z", "blocks": [] },
                { "id": "n2", "role": "assistant", "at": "2026-11-01T09:00:03Z", "blocks": [] }
            ] }
        },
        "otherTurns": {
            "chat-a": [
                { "id": "o1", "role": "assistant", "agent": "codex", "at": "2026-11-01T10:00:02Z", "blocks": [] }
            ]
        },
        "chatInfo": { "chat-a": { "title": "Auth fix", "cwd": "E:/work" } },
        "historyPaths": [{ "provider": "claude", "nativeId": "claude-s1", "path": "C:/h/s1.jsonl" }]
    }))
    .expect("dump");

    let mut index = ChatIndex::open_in_memory().expect("open");
    let report = index.migrate_legacy(&dump, false).expect("migrate");
    assert_eq!(report.chats, 3);
    assert_eq!(report.bindings, 5);
    assert_eq!(report.messages, 5);
    assert_eq!(report.skipped, 1);
    // chat-a took claude-s1 first, so chat-b's claude binding is kept without its native id.
    assert_eq!(report.conflicts.len(), 1);

    // Chat a: local turns and the other agent's turn, merged by time.
    let page = index
        .open_page("chat-a", None, 100)
        .expect("page")
        .expect("chat");
    assert_eq!(page.chat.title, "Auth fix");
    assert_eq!(page.chat.active_agent.as_deref(), Some("codex"));
    assert_eq!(
        page.messages
            .iter()
            .map(|m| m.message.blocks["id"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        vec!["m1", "o1", "m2"]
    );
    assert_eq!(
        page.messages[1].message.binding_id.as_deref(),
        Some("chat-a#codex")
    );
    assert_eq!(
        page.messages[2].message.binding_id.as_deref(),
        Some("chat-a#claude")
    );
    let codex = page
        .bindings
        .iter()
        .find(|b| b.provider == "codex")
        .expect("codex");
    let claude = page
        .bindings
        .iter()
        .find(|b| b.provider == "claude")
        .expect("claude");
    assert_eq!(codex.state, BindingState::Live);
    assert_eq!(claude.state, BindingState::Closed);
    assert_eq!(
        index
            .resolve_native("claude", "claude-s1")
            .expect("resolve"),
        Some("chat-a".to_string())
    );

    // Chat b: transcript turns carry their native message ids, and the repeated one is dropped.
    let chat_b = index
        .open_page("chat-b", None, 100)
        .expect("page")
        .expect("chat");
    assert_eq!(chat_b.messages.len(), 2);
    assert_eq!(
        chat_b.messages[0].message.native,
        Some(NativeRef {
            provider: "claude".to_string(),
            msg_id: "n1".to_string()
        })
    );
    assert_eq!(chat_b.bindings[0].native_id, None);
    assert_eq!(chat_b.bindings[0].path, None);

    // The alias that is not the current session is a closed binding; the known one keeps its file path.
    let alias = page
        .bindings
        .iter()
        .find(|b| b.id == "chat-a#codex#cx-0")
        .expect("alias binding");
    assert_eq!(alias.state, BindingState::Closed);
    assert_eq!(claude.path.as_deref(), Some("C:/h/s1.jsonl"));

    // Chat c has no turns yet, only a pending binding.
    let chat_c = index
        .open_page("chat-c", None, 100)
        .expect("page")
        .expect("chat");
    assert!(chat_c.messages.is_empty());
    assert_eq!(chat_c.bindings[0].state, BindingState::Pending);

    // Running it again returns the stored report and writes nothing.
    let again = index.migrate_legacy(&dump, false).expect("again");
    assert_eq!(again, report);
    assert_eq!(index.list_chats().expect("list").len(), 3);
    assert_eq!(page_of(&index, "chat-a").len(), 3);

    let status = index.legacy_status().expect("status");
    assert!(status.migrated);
    assert!(!status.rollback);

    // Rollback: the frontend keeps reading IndexedDB; the index data stays.
    index.set_legacy_rollback(true).expect("rollback on");
    assert!(index.legacy_status().expect("status").rollback);
    index.set_legacy_rollback(false).expect("rollback off");
    assert!(!index.legacy_status().expect("status").rollback);

    // Forced: clears and imports again with the same result.
    let forced = index.migrate_legacy(&dump, true).expect("forced");
    assert_eq!(forced, report);
    assert_eq!(index.list_chats().expect("list").len(), 3);
}

#[test]
fn a_row_written_before_version_two_still_reads() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("old")).expect("chat");
    // What version 1 wrote: the blocks as JSON text, no blob.
    index
        .conn
        .execute(
            "INSERT INTO messages (chat_id, seq, role, time, blocks_json) VALUES ('old', 1, 'user', '2026-11-01T10:00:00Z', ?1)",
            [json!({ "id": "x", "text": "from version one" }).to_string()],
        )
        .expect("legacy row");
    let page = index
        .open_page("old", None, 10)
        .expect("page")
        .expect("chat");
    assert_eq!(texts(&page.messages), vec!["from version one"]);
}
