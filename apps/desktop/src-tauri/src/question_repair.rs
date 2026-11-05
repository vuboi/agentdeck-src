//! Last-resort repair of a question block whose JSON the frontend could not parse, even after its own deterministic
//! fixes (see `questions.ts`). The session's own model is asked, in one stateless pass, to return valid JSON without
//! changing any wording. The frontend validates the result and keeps the questions only when the labels did not drift,
//! so a model that rewrites instead of repairing cannot put wrong options in front of the user.

use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::image_gen::{trim_error, CustomSuggester};

const MAX_BODY_CHARS: usize = 20_000;
const INSTRUCTIONS: &str = r#"You repair malformed JSON. The text below is meant to be a JSON object of the shape {"questions":[{"question":"...","options":[{"label":"...","description":"..."}]}]} but it has a syntax error (an unescaped quote, a stray comma, a missing bracket). Return ONLY the corrected JSON object and nothing else: no markdown, no code fence, no commentary. Do NOT change, translate, shorten, add or remove any question text, option label or description. Fix only JSON syntax: quoting, commas, brackets and escaping. If you cannot fix it without changing the wording, return exactly {}."#;

#[derive(Debug, Deserialize)]
pub struct RepairRequest {
    /// The chat's agent: `claude`, `opencode`, `antigravity`, or `custom` (an OpenAI-compatible provider). Anything else
    /// is refused, so the frontend keeps its own best-effort text.
    #[serde(default)]
    pub provider: Option<String>,
    pub model: String,
    /// The block body the frontend failed to parse (the JSON between the fences).
    pub body: String,
    /// A custom provider (address and key) when `provider` is `custom`.
    #[serde(default)]
    pub custom: Option<CustomSuggester>,
}

fn cli_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    if let Some((key, path)) = ag_adapters::agent::runner::augmented_path_env() {
        command.env(key, path);
    }
    command
}

#[tauri::command]
pub async fn repair_question_json(request: RepairRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || repair(request))
        .await
        .map_err(|error| error.to_string())?
}

fn repair(request: RepairRequest) -> Result<String, String> {
    let body = request.body.trim();
    let model = request.model.trim();
    if body.is_empty() {
        return Err("nothing to repair".to_string());
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(format!(
            "the block is longer than {MAX_BODY_CHARS} characters"
        ));
    }
    if model.is_empty() {
        return Err("no model to repair with".to_string());
    }
    let input = format!("{INSTRUCTIONS}\n\n{body}");
    let provider = request.provider.as_deref().unwrap_or_default();
    let text = if provider == "custom" {
        let custom = request
            .custom
            .as_ref()
            .ok_or("the provider's address is missing")?;
        tauri::async_runtime::block_on(repair_with_custom(custom, model, &input))?
    } else if provider == "opencode" {
        repair_with_cli(
            ag_adapters::agent::runner::resolve_binary(
                &ag_adapters::agent::opencode::OpenCode::default(),
            ),
            &["run", "--standalone", "--model", model],
            Some(&input),
            "OpenCode",
        )?
    } else if provider == "antigravity" {
        repair_with_cli(
            ag_adapters::agent::runner::resolve_binary(
                &ag_adapters::agent::antigravity::Antigravity::default(),
            ),
            &[
                "--print-timeout",
                "2m",
                "--model",
                model,
                "--sandbox",
                "-p",
                &input,
            ],
            None,
            "Antigravity",
        )?
    } else if provider == "claude" || model.starts_with("claude-") {
        repair_with_cli(
            ag_adapters::agent::runner::resolve_binary(&ag_adapters::agent::claude::Claude),
            &["-p", "--model", model, "--output-format", "text"],
            Some(&input),
            "Claude",
        )?
    } else {
        return Err(format!("JSON repair is not supported for '{provider}'"));
    };
    let object = extract_object(&text).ok_or("the model did not return a JSON object")?;
    Ok(object)
}

/// One stateless run of a coding CLI in print mode. `stdin_input` is the prompt for a CLI that reads it from stdin; the
/// others get it in `args`.
fn repair_with_cli(
    binary: std::ffi::OsString,
    args: &[&str],
    stdin_input: Option<&str>,
    name: &str,
) -> Result<String, String> {
    use std::io::Write;

    let mut command = cli_command(binary);
    command
        .args(args)
        .stdin(if stdin_input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {name}: {error}"))?;
    if let (Some(input), Some(mut stdin)) = (stdin_input, child.stdin.take()) {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("{name} exited with {}", output.status)
        } else {
            trim_error(&detail)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// One chat completion on a custom OpenAI-compatible provider.
async fn repair_with_custom(
    custom: &CustomSuggester,
    model: &str,
    input: &str,
) -> Result<String, String> {
    let key = custom
        .api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| {
            custom
                .key_env
                .as_deref()
                .filter(|name| !name.is_empty())
                .and_then(|name| std::env::var(name).ok())
        });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .post(crate::custom_chat::chat_url(&custom.kind, &custom.base_url))
        .json(&serde_json::json!({
            "model": model,
            "stream": false,
            "messages": [{ "role": "user", "content": input }],
        }));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("could not reach the provider: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("the provider's answer is not JSON: {error}"))?;
    if !status.is_success() {
        let detail = body["error"]["message"].as_str().unwrap_or("no detail");
        return Err(trim_error(&format!(
            "the provider answered {status}: {detail}"
        )));
    }
    Ok(body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

/// The first balanced `{ … }` JSON object in the model's answer, validated as JSON. `None` when there is none.
fn extract_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    let slice = &text[start..=end];
    serde_json::from_str::<serde_json::Value>(slice)
        .ok()
        .map(|_| slice.to_string())
}

#[cfg(test)]
mod tests {
    use super::extract_object;

    #[test]
    fn pulls_the_json_object_out_of_chatter() {
        assert_eq!(
            extract_object("Here you go:\n{\"questions\":[]}\nthanks").as_deref(),
            Some("{\"questions\":[]}")
        );
    }

    #[test]
    fn rejects_an_answer_with_no_valid_object() {
        assert_eq!(extract_object("sorry, cannot"), None);
        assert_eq!(extract_object("{not json}"), None);
    }
}
