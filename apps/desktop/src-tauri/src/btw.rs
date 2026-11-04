//! `/btw`: a side question answered by the chat's own Claude process, as Claude Code does it: the CLI answers a
//! `side_question` control request without a turn, so the chat's conversation, queue and model are not touched (see
//! `warm::side_question`). The answer goes to the panel as `btw-event` {id, event} and ends with `btw-done` {id}.

use ag_adapters::agent::warm::side_question;
use ag_adapters::agent::AgentEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct BtwEvent {
    id: String,
    event: AgentEvent,
}

#[derive(Serialize, Clone)]
struct BtwDone {
    id: String,
}

/// Asks one side question of `chat` (the chat's id). `history` is the earlier side questions and their answers, in order.
#[tauri::command]
pub(crate) async fn btw_ask(
    app: AppHandle,
    id: String,
    chat: String,
    question: String,
    history: Vec<[String; 2]>,
) -> Result<(), String> {
    let history: Vec<(String, String)> = history
        .into_iter()
        .map(|[question, response]| (question, response))
        .collect();
    tokio::spawn(async move {
        let event = match side_question(&chat, &question, &history).await {
            Ok(text) => AgentEvent::Delta { text },
            Err(message) => AgentEvent::Error { message },
        };
        // Only the main window: a Preview page is a copy of this app and must not answer the panel.
        let _ = app.emit_to(
            "main",
            "btw-event",
            BtwEvent {
                id: id.clone(),
                event,
            },
        );
        let _ = app.emit_to("main", "btw-done", BtwDone { id });
    });
    Ok(())
}

/// Stops an answer. The CLI process belongs to the chat and is not killed here: the panel just stops listening to it.
#[tauri::command]
pub(crate) fn btw_stop(id: String) {
    let _ = id;
}
