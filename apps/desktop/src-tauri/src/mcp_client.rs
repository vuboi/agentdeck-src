//! A small MCP client, so a custom provider can use the servers the user set up for Claude, Codex or Antigravity.
//!
//! Both ways a server is reached are covered: a command spoken to over stdin and stdout, and an address that takes
//! JSON-RPC over HTTP (the answer is JSON or an event stream). A server is started when a turn starts, asked for its
//! tools once, called while the turn runs, and stopped with the turn (HTTP sessions are deleted best effort;
//! stdio processes are killed when their guards are dropped).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::connectors::{command, which, KillTree};
use crate::mcp_manage::{initialize, message_with_id, rpc_error, Raw};

#[allow(clippy::large_enum_variant)] // one per server for one turn: boxing buys nothing
enum Link {
    Http {
        client: reqwest::Client,
        url: String,
        headers: BTreeMap<String, String>,
        session: Option<String>,
    },
    Stdio {
        // Before the child: dropped first, so the whole tree (npx, the shell, node) goes with it.
        _tree: KillTree,
        _child: Child,
        stdin: ChildStdin,
        lines: tokio::io::Lines<BufReader<ChildStdout>>,
    },
}

/// What one tool call gave back.
pub struct Reply {
    pub text: String,
    pub is_error: bool,
    pub image: Option<String>,
}

pub struct Server {
    pub name: String,
    /// The tools as the server lists them: `name`, `description`, `inputSchema`.
    pub tools: Vec<Value>,
    link: Link,
    next: i64,
}

impl Link {
    fn take_shutdown_request(&mut self) -> Option<reqwest::RequestBuilder> {
        let Link::Http {
            client,
            url,
            headers,
            session,
        } = self
        else {
            return None;
        };
        let id = session.take()?;
        let mut request = client.delete(url.as_str()).timeout(Duration::from_secs(3));
        for (key, value) in headers {
            request = request.header(key.as_str(), value.as_str());
        }
        Some(request.header("Mcp-Session-Id", id))
    }

    async fn shutdown(&mut self) {
        if let Some(request) = self.take_shutdown_request() {
            // Session termination is best effort, including unsupported DELETE (405) and expired sessions (404).
            let _ = request.send().await;
        }
    }

    async fn send(&mut self, message: &Value) -> Result<Option<String>, String> {
        match self {
            Link::Http {
                client,
                url,
                headers,
                session,
            } => {
                let mut request = client
                    .post(url.as_str())
                    .header("Accept", "application/json, text/event-stream")
                    .json(message);
                for (key, value) in headers.iter() {
                    request = request.header(key.as_str(), value.as_str());
                }
                if let Some(id) = session.as_deref() {
                    request = request.header("Mcp-Session-Id", id);
                }
                let response = request.send().await.map_err(|error| error.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("the server answered {}", response.status()));
                }
                if let Some(id) = response
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|value| value.to_str().ok())
                {
                    *session = Some(id.to_owned());
                }
                response
                    .text()
                    .await
                    .map(Some)
                    .map_err(|error| error.to_string())
            }
            Link::Stdio { stdin, .. } => {
                stdin
                    .write_all(format!("{message}\n").as_bytes())
                    .await
                    .map_err(|error| error.to_string())?;
                stdin.flush().await.map_err(|error| error.to_string())?;
                Ok(None)
            }
        }
    }

    /// Sends a request and waits for the answer with the same id; `Err` carries the server's own error text.
    async fn request(&mut self, id: i64, method: &str, params: Value) -> Result<Value, String> {
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let body = self.send(&message).await?;
        let answer = match (&mut *self, body) {
            (_, Some(body)) => message_with_id(&body, id).ok_or("the server gave no answer")?,
            (Link::Stdio { lines, .. }, None) => loop {
                let line = lines
                    .next_line()
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("the server closed before it answered")?;
                if let Some(found) = serde_json::from_str::<Value>(&line)
                    .ok()
                    .filter(|found| found["id"].as_i64() == Some(id))
                {
                    break found;
                }
            },
            _ => return Err("the server gave no answer".into()),
        };
        match rpc_error(&answer) {
            Some(error) => Err(error),
            None => Ok(answer["result"].clone()),
        }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        // Startup failure, timeout or turn cancellation can drop the future before explicit shutdown.
        if let Some(request) = self.take_shutdown_request() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = request.send().await;
                });
            }
        }
    }
}

impl Server {
    /// Best-effort termination of an HTTP MCP session; stdio process ownership remains with the drop guards.
    pub async fn shutdown(&mut self) {
        self.link.shutdown().await;
    }

    /// Starts or reaches the server and reads its tools.
    pub async fn start(raw: &Raw) -> Result<Server, String> {
        let link = if let Some(url) = &raw.url {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|error| error.to_string())?;
            Link::Http {
                client,
                url: url.clone(),
                headers: raw.headers.clone(),
                session: None,
            }
        } else {
            let name = raw.command.clone().ok_or("no command")?;
            let program = which(&name).unwrap_or_else(|| PathBuf::from(&name));
            let mut process = command(&program);
            process
                .args(&raw.args)
                .stdin(Stdio::piped())
                .stderr(Stdio::null());
            process.env_clear();
            for (key, value) in mcp_child_environment(std::env::vars_os(), &raw.env) {
                process.env(key, value);
            }
            if let Some((key, path)) = ag_adapters::agent::runner::augmented_path_env() {
                process.env(key, path);
            }
            let mut child = process
                .spawn()
                .map_err(|error| format!("could not start {name}: {error}"))?;
            if let Some(pid) = child.id() {
                crate::process_guard::adopt_pid(pid);
            }
            let stdin = child.stdin.take().ok_or("no stdin")?;
            let stdout = child.stdout.take().ok_or("no stdout")?;
            Link::Stdio {
                _tree: KillTree::of(&child),
                _child: child,
                stdin,
                lines: BufReader::new(stdout).lines(),
            }
        };
        let mut server = Server {
            name: raw.name.clone(),
            tools: Vec::new(),
            link,
            next: 1,
        };
        let init = initialize();
        server
            .link
            .request(1, "initialize", init["params"].clone())
            .await?;
        let _ = server
            .link
            .send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        server.next = 2;
        let listed = server.link.request(2, "tools/list", json!({})).await?;
        server.tools = listed["tools"].as_array().cloned().unwrap_or_default();
        server.next = 3;
        Ok(server)
    }

    pub async fn call(&mut self, tool: &str, args: &Value) -> Reply {
        self.next += 1;
        let id = self.next;
        let work = self
            .link
            .request(id, "tools/call", json!({ "name": tool, "arguments": args }));
        let result = match tokio::time::timeout(Duration::from_secs(120), work).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                return Reply {
                    text: error,
                    is_error: true,
                    image: None,
                }
            }
            Err(_) => {
                return Reply {
                    text: "the tool did not answer in 120 seconds".into(),
                    is_error: true,
                    image: None,
                }
            }
        };
        let mut text = Vec::new();
        let mut image = None;
        for part in result["content"].as_array().into_iter().flatten() {
            match part["type"].as_str() {
                Some("text") => text.push(part["text"].as_str().unwrap_or_default().to_owned()),
                Some("image") => {
                    image = Some(format!(
                        "data:{};base64,{}",
                        part["mimeType"].as_str().unwrap_or("image/png"),
                        part["data"].as_str().unwrap_or_default()
                    ))
                }
                _ => {}
            }
        }
        if text.is_empty() {
            if let Some(structured) = result.get("structuredContent") {
                text.push(structured.to_string());
            }
        }
        Reply {
            text: text.join("\n"),
            is_error: result["isError"].as_bool().unwrap_or(false),
            image,
        }
    }
}

/// Keeps MCP child processes from inheriting AgentDeck credentials and unrelated settings.
fn filtered_parent_environment(
    vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ];
    vars.into_iter()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            ALLOWED.iter().any(|allowed| {
                #[cfg(windows)]
                {
                    key.eq_ignore_ascii_case(allowed)
                }
                #[cfg(not(windows))]
                {
                    key == *allowed
                }
            })
        })
        .collect()
}

fn mcp_child_environment(
    vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    configured: &BTreeMap<String, String>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut environment = filtered_parent_environment(vars);
    for (key, value) in configured {
        environment.retain(|(inherited_key, _)| {
            #[cfg(windows)]
            {
                !inherited_key.eq_ignore_ascii_case(key)
            }
            #[cfg(not(windows))]
            {
                inherited_key != key
            }
        });
        environment.push((key.into(), value.into()));
    }
    environment
}

#[cfg(test)]
mod environment_tests {
    use super::mcp_child_environment;
    use std::collections::BTreeMap;
    use std::ffi::OsString;

    #[test]
    fn child_environment_excludes_parent_secrets_and_keeps_configured_values() {
        let configured = BTreeMap::from([("MCP_TOKEN".to_string(), "explicit".to_string())]);
        let filtered = mcp_child_environment(
            [
                (OsString::from("PATH"), OsString::from("/usr/bin")),
                (OsString::from("DEEPSEEK_API_KEY"), OsString::from("secret")),
                (OsString::from("DATABASE_URL"), OsString::from("private")),
                (OsString::from("MCP_TOKEN"), OsString::from("inherited")),
            ],
            &configured,
        );

        assert_eq!(filtered.len(), 2);
        assert!(filtered.contains(&(OsString::from("PATH"), OsString::from("/usr/bin"))));
        assert!(filtered.contains(&(OsString::from("MCP_TOKEN"), OsString::from("explicit"))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    async fn http_session(status: u16) -> (Link, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut deletion = String::new();
            for step in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    bytes.push(byte[0]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let headers = String::from_utf8(bytes).unwrap();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).await.unwrap();
                let response = if step == 0 {
                    "HTTP/1.1 200 OK\r\nMcp-Session-Id: session-123\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
                } else {
                    deletion = headers;
                    format!("HTTP/1.1 {status} Cleanup\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            deletion
        });
        let mut link = Link::Http {
            client: reqwest::Client::new(),
            url,
            headers: BTreeMap::from([("Authorization".into(), "Bearer test".into())]),
            session: None,
        };
        link.send(&json!({"method": "initialize"})).await.unwrap();
        (link, task)
    }

    #[tokio::test]
    async fn http_shutdown_deletes_issued_session_and_tolerates_404_and_405() {
        for status in [204, 404, 405] {
            let (mut link, task) = http_session(status).await;
            link.shutdown().await;
            link.shutdown().await;
            let request = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            let request = request.to_ascii_lowercase();
            assert!(request.starts_with("delete /mcp http/1.1\r\n"));
            assert!(request.contains("mcp-session-id: session-123\r\n"));
            assert!(request.contains("authorization: bearer test\r\n"));
        }
    }

    #[tokio::test]
    async fn dropping_http_link_deletes_issued_session() {
        let (link, task) = http_session(204).await;
        drop(link);
        let request = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert!(request.starts_with("DELETE /mcp HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn http_shutdown_without_session_sends_nothing() {
        let mut link = Link::Http {
            client: reqwest::Client::new(),
            url: "http://127.0.0.1:1/mcp".into(),
            headers: BTreeMap::new(),
            session: None,
        };
        assert!(link.take_shutdown_request().is_none());
        link.shutdown().await;
    }
}
