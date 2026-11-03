//! Real check of OpenCode on the chat's own server (`opencode_server.rs`), the way the app runs it: the server is
//! started ahead of the first message (prewarm), then turns are timed from send to their end, a session is resumed,
//! and a turn is stopped while its shell command still runs (the command must not finish after the stop). Uses a free
//! model, so it costs nothing. Run: `cargo run -p ag-adapters --example warm_opencode`

use std::time::{Duration, Instant};

use ag_adapters::agent::interrupt::{StopHandle, StopToken};
use ag_adapters::agent::opencode::OpenCode;
use ag_adapters::agent::runner::resolve_binary;
use ag_adapters::agent::warm::{drive_warm_turn_with, prewarm, reset};
use ag_adapters::agent::{AgentEvent, TurnRequest};

fn request(prompt: &str, session: Option<String>, cwd: &std::path::Path) -> TurnRequest {
    TurnRequest {
        prompt: prompt.into(),
        resume: session.is_some(),
        session_id: session,
        model: Some("opencode/big-pickle".into()),
        permission_mode: Some("auto".into()),
        effort: None,
        allowed_tools: Vec::new(),
        cwd: Some(cwd.to_path_buf()),
        owner: Some("warm-check-opencode".into()),
        api_key: None,
    }
}

async fn turn(req: TurnRequest, stop: StopToken) -> (bool, String, Option<String>) {
    let provider = OpenCode::default();
    let (mut text, mut session) = (String::new(), None);
    let kept =
        drive_warm_turn_with(
            resolve_binary(&provider),
            &provider,
            &req,
            stop,
            |event| match event {
                AgentEvent::Delta { text: piece } => text.push_str(&piece),
                AgentEvent::Done { session_id, .. } => session = session_id,
                AgentEvent::Error { message } => text.push_str(&format!("[error {message}]")),
                _ => {}
            },
        )
        .await;
    (kept, text, session)
}

#[tokio::main]
async fn main() {
    let cwd = std::env::temp_dir().join("agentdeck-warm-opencode-check");
    std::fs::create_dir_all(&cwd).expect("temp folder");
    let provider = OpenCode::default();
    let started = Instant::now();
    prewarm(
        resolve_binary(&provider),
        &provider,
        &request("", None, &cwd),
    )
    .await;
    println!("prewarm: {}ms", started.elapsed().as_millis());

    let mut session = None;
    for prompt in [
        "Remember the word ZEBRA42. Reply only: ok",
        "Reply only: done",
        "What word did I ask you to remember? Reply with the word only.",
    ] {
        let sent = Instant::now();
        let (kept, text, id) =
            turn(request(prompt, session.clone(), &cwd), StopToken::never()).await;
        session = id.or(session);
        println!(
            "turn {prompt:?}: {}ms on server {kept}: {:?}",
            sent.elapsed().as_millis(),
            text.trim()
        );
    }

    let marker = cwd.join("DONE.txt");
    let _ = std::fs::remove_file(&marker);
    let (handle, token) = StopHandle::new();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        handle.stop();
    });
    let sent = Instant::now();
    let prompt = "Run exactly this shell command and nothing else: powershell -NoProfile -Command \"Start-Sleep 15; Set-Content DONE.txt x\"";
    let (kept, text, _) = turn(request(prompt, session.clone(), &cwd), token).await;
    println!(
        "stopped turn ended after {}ms on server {kept}: {:?}",
        sent.elapsed().as_millis(),
        text.trim()
    );
    tokio::time::sleep(Duration::from_secs(20)).await;
    println!("command finished after the stop: {}", marker.exists());

    let sent = Instant::now();
    let (kept, text, _) = turn(
        request("Reply only: still here", session, &cwd),
        StopToken::never(),
    )
    .await;
    println!(
        "turn after the stop: {}ms on server {kept}: {:?}",
        sent.elapsed().as_millis(),
        text.trim()
    );
    reset(None);
    let _ = std::fs::remove_dir_all(&cwd);
}
