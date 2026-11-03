//! OpenCode kept running between the turns of a chat, through a private `opencode serve`.
//!
//! `opencode run --standalone` starts a server for every turn and ends it with the turn: about 2 s per message. The
//! shared background service would skip that, but it ignores the config a turn hands over in the environment (the
//! denied `question` tool, the agentdeck MCP server) and is the user's own OpenCode. So each chat gets its own server,
//! started with that environment on a loopback port behind a password, and each turn runs `opencode run --server`
//! against it (measured 2026-11-03: 1.7–2.9 s a turn against 3.8–4.6 s standalone; the denied tool stayed denied).
//!
//! Ending the client does not end the turn on the server: a tool it started keeps running. So once a turn ends, by a
//! stop or any other way, every session the server still runs is interrupted (`/api/session/active`, then
//! `/api/session/{id}/interrupt`). A server that does not start leaves the turn to the standalone run.

use std::collections::HashMap;
use std::ffi::OsString;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;

use super::interrupt::StopToken;
use super::runner::{augmented_path_env, command_for, kill_tree};
use super::{AgentEvent, Provider, TurnRequest};

/// A server nobody has used for this long ends.
const IDLE: Duration = Duration::from_secs(20 * 60);
/// At most this many servers are kept; the one used longest ago goes first.
const MAX_SERVERS: usize = 4;
/// How long a server gets to say where it listens.
const START_LIMIT: Duration = Duration::from_secs(20);
/// How long one call to a server may take.
const CALL_LIMIT: Duration = Duration::from_secs(5);

/// Where a turn's client connects: set for the turn by [`drive`], read by `OpenCode::args` and `environment`.
#[derive(Clone, Debug, PartialEq)]
pub struct Attach {
    pub url: String,
    pub password: String,
}

tokio::task_local! {
    static ATTACH: Attach;
}

/// The server the current turn runs against, if [`drive`] started it on one.
pub fn attached() -> Option<Attach> {
    ATTACH.try_with(Clone::clone).ok()
}

struct Server {
    /// The binary and the environment it was started with: a turn with other settings needs another server.
    key: String,
    attach: Attach,
    child: Child,
    serial: u64,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            super::runner::release_pid(pid);
            kill_tree(pid);
        }
    }
}

static SERVERS: LazyLock<Mutex<HashMap<String, Server>>> = LazyLock::new(Default::default);
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn servers() -> MutexGuard<'static, HashMap<String, Server>> {
    SERVERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn key_of(binary: &OsString, env: &[(String, String)]) -> String {
    format!("{binary:?}\u{1f}{env:?}")
}

/// The chat's server for these settings: the running one, or a new one. `None` when it could not be started.
async fn ensure(binary: OsString, provider: &dyn Provider, req: &TurnRequest) -> Option<Attach> {
    let chat = req.owner.clone()?;
    let env = provider.environment(req);
    let key = key_of(&binary, &env);
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut servers = servers();
        if let Some(server) = servers.get_mut(&chat) {
            if server.key == key && matches!(server.child.try_wait(), Ok(None)) {
                server.serial = serial;
                return Some(server.attach.clone());
            }
        }
        // Other settings or a server that ended: ended outside the lock.
        let gone = servers.remove(&chat);
        drop(servers);
        drop(gone);
    }
    let server = match start(binary, provider, req, &env, key, serial).await {
        Ok(server) => server,
        Err(message) => {
            tracing::warn!("opencode server for {chat}: {message}");
            return None;
        }
    };
    let attach = server.attach.clone();
    let mut evicted = Vec::new();
    {
        let mut servers = servers();
        evicted.extend(servers.insert(chat, server));
        while servers.len() > MAX_SERVERS {
            let Some(oldest) = servers
                .iter()
                .min_by_key(|(_, server)| server.serial)
                .map(|(chat, _)| chat.clone())
            else {
                break;
            };
            evicted.extend(servers.remove(&oldest));
        }
    }
    drop(evicted);
    Some(attach)
}

/// Starts `opencode serve` on a free loopback port with the turn's environment, folder and PATH, and waits for the
/// line that names its address.
async fn start(
    binary: OsString,
    provider: &dyn Provider,
    req: &TurnRequest,
    env: &[(String, String)],
    key: String,
    serial: u64,
) -> Result<Server, String> {
    let password = uuid::Uuid::new_v4().simple().to_string();
    let args = ["serve", "--hostname", "127.0.0.1", "--port", "0"].map(String::from);
    let mut command = command_for(binary, &args);
    for name in provider.environment_remove(req) {
        command.env_remove(name);
    }
    // No `kill_on_drop`: it would end the `.cmd` shim at once, before `kill_tree` (in `Drop`) walks the tree from it,
    // and leave `opencode.exe` running with the pipe open.
    command
        .envs(env.iter().cloned())
        .env("OPENCODE_PASSWORD", &password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some((name, path)) = augmented_path_env() {
        command.env(name, path);
    }
    if let Some(dir) = req.cwd.as_deref().filter(|dir| dir.is_dir()) {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start: {error}"))?;
    super::runner::spawned(&child);
    if let (Some(pid), Some(chat)) = (child.id(), req.owner.as_deref()) {
        super::runner::claim_pid(pid, chat);
    }
    let stdout = child.stdout.take().ok_or("no output to read")?;
    let mut server = Server {
        key,
        attach: Attach {
            url: String::new(),
            password,
        },
        child,
        serial,
    };
    let mut lines = BufReader::new(stdout).lines();
    let url = tokio::time::timeout(START_LIMIT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(at) = line.find("listening on ") {
                return Some(line[at + "listening on ".len()..].trim().to_owned());
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .ok_or("it did not say where it listens")?;
    // What it prints later is read and dropped, so a full pipe never holds it up.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    server.attach.url = url;
    Ok(server)
}

/// Starts the chat's server before its message is sent, so the first turn does not wait for it.
pub async fn prewarm(binary: OsString, provider: &dyn Provider, req: &TurnRequest) {
    ensure(binary, provider, req).await;
}

/// Runs one turn on the chat's server. `false` (nothing emitted) when no server could be started: the caller runs the
/// turn standalone instead.
pub async fn drive(
    binary: OsString,
    provider: &dyn Provider,
    req: &TurnRequest,
    mut stop: StopToken,
    emit: impl FnMut(AgentEvent),
) -> bool {
    let Some(attach) = ensure(binary.clone(), provider, req).await else {
        return false;
    };
    ATTACH
        .scope(attach.clone(), async {
            tokio::select! {
                () = super::runner::drive_turn(binary, provider, req, emit) => {}
                () = stop.stopped() => {}
            }
        })
        .await;
    interrupt_active(&attach).await;
    if let Some(chat) = req.owner.clone() {
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(server) = servers().get_mut(&chat) {
            server.serial = serial;
        }
        tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            let idle = {
                let mut servers = servers();
                if servers
                    .get(&chat)
                    .is_some_and(|server| server.serial == serial)
                {
                    servers.remove(&chat)
                } else {
                    None
                }
            };
            drop(idle);
        });
    }
    true
}

/// Interrupts every session the server still runs. A server belongs to one chat, which runs one turn at a time, so
/// whatever is still active there is what the ended turn left behind.
async fn interrupt_active(attach: &Attach) {
    let Some(body) = call(attach, "GET", "/api/session/active").await else {
        return;
    };
    let sessions: Vec<String> = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value["data"]
                .as_object()
                .map(|data| data.keys().cloned().collect())
        })
        .unwrap_or_default();
    for session in sessions {
        call(attach, "POST", &format!("/api/session/{session}/interrupt")).await;
    }
}

/// One HTTP/1.1 call to the server on loopback, returning the body of a 2xx answer.
async fn call(attach: &Attach, method: &str, path: &str) -> Option<String> {
    let host = attach.url.strip_prefix("http://")?.trim_end_matches('/');
    let auth =
        base64::engine::general_purpose::STANDARD.encode(format!("opencode:{}", attach.password));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Basic {auth}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let answer = tokio::time::timeout(CALL_LIMIT, async {
        let mut stream = tokio::net::TcpStream::connect(host).await.ok()?;
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.ok()?;
        Some(answer)
    })
    .await
    .ok()
    .flatten()?;
    body_of(&String::from_utf8_lossy(&answer))
}

/// The body of a 2xx HTTP answer, joined back together when it came in chunks.
fn body_of(answer: &str) -> Option<String> {
    let (head, body) = answer.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?;
    if !status.starts_with('2') {
        return None;
    }
    let chunked = head
        .lines()
        .any(|line| line.to_ascii_lowercase().replace(' ', "") == "transfer-encoding:chunked");
    if !chunked {
        return Some(body.to_owned());
    }
    let mut joined = String::new();
    let mut rest = body;
    loop {
        let (size, after) = rest.split_once("\r\n")?;
        let size = usize::from_str_radix(size.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(joined);
        }
        joined.push_str(after.get(..size)?);
        rest = after.get(size..)?.strip_prefix("\r\n")?;
    }
}

/// Ends the servers of all chats: after an account switch the next turn must start with the new sign-in.
pub fn reset() {
    let gone: Vec<Server> = servers().drain().map(|(_, server)| server).collect();
    drop(gone);
}

/// Ends the server of one chat.
pub fn reset_chat(chat: &str) {
    let gone = servers().remove(chat);
    drop(gone);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_body_is_returned_as_is() {
        let answer = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"data\":{}}";
        assert_eq!(body_of(answer).as_deref(), Some("{\"data\":{}}"));
    }

    #[test]
    fn a_chunked_body_is_joined() {
        let answer = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"dat\r\n6\r\na\":{}}\r\n0\r\n\r\n";
        assert_eq!(body_of(answer).as_deref(), Some("{\"data\":{}}"));
    }

    #[test]
    fn an_error_answer_has_no_body() {
        assert_eq!(body_of("HTTP/1.1 401 Unauthorized\r\n\r\nno"), None);
    }

    #[test]
    fn no_turn_is_attached_outside_a_drive() {
        assert_eq!(attached(), None);
    }
}
