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
        last_user_at: "2026-11-01T09:00:00Z".to_string(),
        expires_at: "2026-11-15T09:00:00Z".to_string(),
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
    assert_eq!(report.chats, 1);
    assert_eq!(report.bindings, 3);
    assert_eq!(report.messages, 3);
    assert_eq!(report.skipped, 0);
    assert!(report.conflicts.is_empty());

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

    // The alias that is not the current session is a closed binding; native ids do not carry provider file paths.
    let alias = page
        .bindings
        .iter()
        .find(|b| b.id == "chat-a#codex#cx-0")
        .expect("alias binding");
    assert_eq!(alias.state, BindingState::Closed);
    assert_eq!(claude.path, None);

    // Running it again returns the stored report and writes nothing.
    let again = index.migrate_legacy(&dump, false).expect("again");
    assert_eq!(again, report);
    assert_eq!(index.list_chats().expect("list").len(), 1);
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
    assert_eq!(index.list_chats().expect("list").len(), 1);
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

#[test]
fn other_turns_and_archive_are_kept_per_chat_and_die_with_it() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("a")).expect("save");
    index.save_chat(&chat("b")).expect("save");
    index
        .put_other_turn("a", 2, &json!({ "id": "o2", "text": "second" }))
        .expect("put");
    index
        .put_other_turn("a", 1, &json!({ "id": "o1", "text": "first" }))
        .expect("put");
    index
        .put_other_turn("a", 1, &json!({ "id": "o1", "text": "first again" }))
        .expect("replace");
    let turns = index.other_turns("a").expect("read");
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].0, 1);
    assert_eq!(turns[0].1["text"], "first again");
    assert!(index.other_turns("b").expect("read").is_empty());

    index
        .put_archive(
            "a",
            "m1",
            "2026-11-02T10:00:00Z",
            Some(120),
            &json!({ "text": "reply" }),
        )
        .expect("archive");
    index
        .put_archive(
            "a",
            "m1",
            "2026-11-02T10:00:00Z",
            Some(130),
            &json!({ "text": "reply v2" }),
        )
        .expect("archive again");
    let archived = index.archive("a").expect("read");
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].tokens, Some(130));
    assert_eq!(archived[0].snapshot["text"], "reply v2");

    index.delete_chat("a").expect("delete");
    assert!(index.other_turns("a").expect("read").is_empty());
    assert!(index.archive("a").expect("read").is_empty());
}

fn chat_at(id: &str, updated_at: &str) -> ChatMeta {
    ChatMeta {
        updated_at: updated_at.to_string(),
        ..chat(id)
    }
}

#[test]
fn an_attachment_is_removed_only_when_every_chat_using_it_is_idle() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index
        .save_chat(&chat_at("old", "2026-09-01T00:00:00Z"))
        .expect("save");
    index
        .save_chat(&chat_at("recent", "2026-11-05T00:00:00Z"))
        .expect("save");
    index
        .save_chat(&chat_at("other", "2026-09-01T00:00:00Z"))
        .expect("save");
    index
        .note_attachments("old", &["/a/one.png".to_string()])
        .expect("note");
    index
        .note_attachments("recent", &["/a/two.png".to_string()])
        .expect("note");
    index
        .note_attachments("other", &["/a/two.png".to_string()])
        .expect("note");

    let idle = index
        .idle_attachments("2026-10-06T00:00:00Z")
        .expect("idle");
    assert_eq!(idle, vec!["/a/one.png".to_string()]);

    index.forget_attachments(&idle).expect("forget");
    assert!(index
        .idle_attachments("2026-10-06T00:00:00Z")
        .expect("idle")
        .is_empty());
}

#[test]
fn the_all_readers_list_every_chats_turns_and_archive() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("a")).expect("save");
    index.save_chat(&chat("b")).expect("save");
    index
        .put_other_turn("b", 0, &json!({ "text": "b0" }))
        .expect("put");
    index
        .put_other_turn("a", 1, &json!({ "text": "a1" }))
        .expect("put");
    index
        .put_other_turn("a", 0, &json!({ "text": "a0" }))
        .expect("put");
    index
        .put_archive(
            "b",
            "m1",
            "2026-11-02T10:00:00Z",
            None,
            &json!({ "text": "r" }),
        )
        .expect("archive");
    let turns = index.other_turns_all().expect("turns");
    let order: Vec<(String, i64)> = turns
        .iter()
        .map(|(chat, seq, _)| (chat.clone(), *seq))
        .collect();
    assert_eq!(
        order,
        vec![
            ("a".to_string(), 0),
            ("a".to_string(), 1),
            ("b".to_string(), 0)
        ]
    );
    let archived = index.archive_all().expect("archive");
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].0, "b");
    assert_eq!(archived[0].1.msg_id, "m1");
}

#[test]
fn messages_are_dictionary_compressed_once_enough_rows_exist() {
    let mut index = ChatIndex::open_in_memory().expect("open");
    index.save_chat(&chat("big")).expect("save");
    let turns: Vec<NewMessage> = (0..2_100)
        .map(|i| {
            turn(
                &format!("message number {i} about the same subject"),
                None,
                None,
            )
        })
        .collect();
    index.append("big", &turns).expect("append");
    assert!(index.dicts.latest.is_none());

    index.train_dict_if_due().expect("train");
    assert!(index.dicts.latest.is_some());

    let long = "a long reply that repeats itself ".repeat(60);
    index
        .append("big", &[turn(&long, None, None)])
        .expect("append long");
    let page = index
        .open_page("big", None, 1)
        .expect("open")
        .expect("chat");
    assert_eq!(texts(&page.messages), vec![long.as_str()]);
    let stored: Vec<u8> = index
        .conn
        .query_row(
            "SELECT blocks FROM messages WHERE chat_id = 'big' ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("blob");
    assert_eq!(stored[0], crate::codec::DICT_ZSTD);
}
