//! Prompt suggestions after a chat turn, for a CLI that does not predict the next prompt itself: a one-shot run of the
//! same CLI writes 1 to 3 likely next prompts. Claude predicts its own (see `claude.rs`), so this is for the rest.

use ag_adapters::agent::claude::Claude;
use ag_adapters::agent::codex::Codex;
use ag_adapters::agent::runner::{drive_turn, resolve_binary};
use ag_adapters::agent::{AgentEvent, Provider, TurnRequest};

/// Characters of the user's message and of the answer given to the model: the end of a long answer is not needed.
const TEXT_MAX_CHARS: usize = 4_000;
const MAX_SUGGESTIONS: usize = 3;

#[tauri::command]
pub async fn chat_suggest(
    provider: String,
    model: String,
    prompt: String,
    reply: String,
    existing: Vec<String>,
) -> Result<Vec<String>, String> {
    let req = TurnRequest {
        prompt: suggest_input(&prompt, &reply, &existing),
        session_id: None,
        resume: false,
        model: Some(model),
        // Plan mode: the run writes nothing and runs no command, it only answers.
        permission_mode: Some("plan".to_string()),
        effort: None,
        allowed_tools: Vec::new(),
        cwd: None,
        owner: None,
        api_key: None,
    };
    let text = match provider.as_str() {
        "claude" => one_shot(&Claude, &req).await?,
        "codex" => one_shot(&Codex::default(), &req).await?,
        other => return Err(format!("{other} has no prompt suggestions")),
    };
    Ok(parse_suggestions(&text))
}

/// One turn of `provider` with no conversation kept: the text of its answer.
async fn one_shot(provider: &dyn Provider, req: &TurnRequest) -> Result<String, String> {
    let mut events = Vec::new();
    drive_turn(resolve_binary(provider), provider, req, |event| {
        events.push(event)
    })
    .await;
    events
        .into_iter()
        .find_map(|event| match event {
            AgentEvent::Done { text, .. } => Some(Ok(text)),
            AgentEvent::Error { message } => Some(Err(message)),
            _ => None,
        })
        .unwrap_or_else(|| Err("the suggestion run ended without an answer".to_string()))
}

fn suggest_input(prompt: &str, reply: &str, existing: &[String]) -> String {
    let avoid = if existing.is_empty() {
        String::new()
    } else {
        format!(
            "\nDo not repeat these: {}.",
            serde_json::to_string(existing).unwrap_or_default()
        )
    };
    format!(
        "Predict the {MAX_SUGGESTIONS} or fewer prompts the user is most likely to send next, after this exchange. Write each \
         the way the user writes, in the language of their message, at most 120 characters, and only when it is a natural \
         next step. Reply with only a JSON array of strings.{avoid}\n\nUser's message:\n{}\n\nAgent's answer:\n{}",
        truncate(prompt),
        truncate(reply),
    )
}

fn truncate(text: &str) -> String {
    text.chars().take(TEXT_MAX_CHARS).collect()
}

/// The JSON array in the answer, with blanks and repeats dropped. Anything else gives no suggestions.
fn parse_suggestions(text: &str) -> Vec<String> {
    let (Some(start), Some(end)) = (text.find('['), text.rfind(']')) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for item in serde_json::from_str::<Vec<String>>(&text[start..=end]).unwrap_or_default() {
        let item = item.trim().to_string();
        if !item.is_empty() && !out.contains(&item) {
            out.push(item);
        }
        if out.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json_array_in_the_answer_is_read_with_blanks_and_repeats_dropped() {
        let answer = "Here you go:\n[\"Run the tests\", \" \", \"Run the tests\", \"Commit it\"]";
        assert_eq!(
            parse_suggestions(answer),
            vec!["Run the tests", "Commit it"]
        );
    }

    #[test]
    fn an_answer_without_an_array_gives_none_and_at_most_three_are_kept() {
        assert!(parse_suggestions("no list here").is_empty());
        let many = r#"["a","b","c","d"]"#;
        assert_eq!(parse_suggestions(many), vec!["a", "b", "c"]);
    }
}
