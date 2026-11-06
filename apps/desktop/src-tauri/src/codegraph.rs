//! CodeGraph built into AgentDeck: its `codegraph_explore` tool answers "how does X work" in one call, with the relevant
//! symbols' source, the call paths between them and a blast-radius summary. The CLI ships in the app's resources
//! (`build/codegraph`, see `scripts/build-codegraph.mjs`), so no global install is needed. Each project gets its
//! `.codegraph/` index on first use; the project folder comes from the chat, like the `code_*` tools.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

/// The app's resource folder: the bundled CodeGraph lives in `codegraph/` there (see `tauri.conf.json`).
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, PartialEq)]
enum Init {
    /// Not tried yet for this project.
    Pending,
    Ready,
    Failed(String),
}

/// One per project folder. Its lock is held while `codegraph init` runs, so a call waits for a background init.
type Gate = Arc<Mutex<Init>>;
static GATES: OnceLock<Mutex<HashMap<String, Gate>>> = OnceLock::new();

/// Called once at start-up with Tauri's resource folder.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

fn gate(root: &str) -> Result<Gate, String> {
    let mut all = GATES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "codegraph gates busy")?;
    Ok(all
        .entry(root.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(Init::Pending)))
        .clone())
}

/// Node runtime and CLI entry point of the bundled CodeGraph.
fn runtime() -> Result<(PathBuf, PathBuf), String> {
    let dir = RESOURCE_DIR
        .get()
        .ok_or("codegraph: resource folder is unknown")?
        .join("codegraph");
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let cli = dir
        .join("lib")
        .join("dist")
        .join("bin")
        .join("codegraph.js");
    if node.is_file() && cli.is_file() {
        Ok((node, cli))
    } else {
        Err(format!("CodeGraph is not bundled in {}", dir.display()))
    }
}

fn cli(args: &[&str]) -> Result<Output, String> {
    let (node, script) = runtime()?;
    let mut command = Command::new(node);
    command
        .arg("--liftoff-only")
        .arg("--disable-warning=ExperimentalWarning")
        .arg(script)
        .args(args)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.output().map_err(|error| error.to_string())
}

/// Builds the project's index in the background, so the first `codegraph_explore` does not wait for it.
pub fn prepare(root: &str) {
    let Ok(gate) = gate(root) else { return };
    let root = root.to_string();
    if gate
        .lock()
        .map(|state| *state != Init::Pending)
        .unwrap_or(true)
    {
        return;
    }
    std::thread::spawn(move || {
        let _ = ensure(&root);
    });
}

/// Runs `codegraph init` once per project folder, unless the folder already has a `.codegraph/` index.
fn ensure(root: &str) -> Result<(), String> {
    let gate = gate(root)?;
    let mut state = gate.lock().map_err(|_| "codegraph busy")?;
    match &*state {
        Init::Ready => return Ok(()),
        Init::Failed(error) => return Err(error.clone()),
        Init::Pending => {}
    }
    if Path::new(root).join(".codegraph").is_dir() {
        *state = Init::Ready;
        return Ok(());
    }
    let outcome = match cli(&["init", "-y", root]) {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(format!(
            "codegraph init failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(error) => Err(format!("codegraph init failed: {error}")),
    };
    match outcome {
        Ok(()) => {
            *state = Init::Ready;
            Ok(())
        }
        Err(error) => {
            *state = Init::Failed(error.clone());
            Err(error)
        }
    }
}

// --- the tool ------------------------------------------------------------------------------------------------------

/// The `codegraph_*` tools, as MCP tool definitions.
pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "codegraph_sync",
            "description": "Brings the CodeGraph index of the project up to date: changed files only, or with force a full rebuild. Reports the files and symbols indexed. Use it when the index looks stale or after large changes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "force": { "type": "boolean", "description": "rebuild the whole index instead of only the changed files" },
                    "root": { "type": "string", "description": "absolute path of the project folder (left out: the folder of this chat)" }
                }
            }
        }),
        json!({
            "name": "codegraph_explore",
            "description": "Answers a question about how the project works in one call (CodeGraph): the relevant symbols' verbatim source grouped by file, the call paths between them and a blast-radius summary. Use it for \"how does X work\", a flow (\"how does X reach Y\") or to survey an area, before grepping or opening many files. Name a file or symbol in the query to read its current line-numbered source.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "the question, or the name of a symbol or file" },
                    "root": { "type": "string", "description": "absolute path of the project folder (left out: the folder of this chat)" }
                },
                "required": ["query"]
            }
        }),
    ]
}

pub fn is_tool(name: &str) -> bool {
    matches!(name, "codegraph_explore" | "codegraph_sync")
}

/// Runs `codegraph_explore` or `codegraph_sync`. Blocking work (node, disk) happens off the async threads.
pub async fn call(name: &str, args: &Value, chat: &str) -> Result<String, String> {
    let (name, args, chat) = (name.to_string(), args.clone(), chat.to_string());
    tokio::task::spawn_blocking(move || {
        if name == "codegraph_sync" {
            sync(&args, &chat)
        } else {
            run(&args, &chat)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `codegraph sync` (changed files) or `codegraph index --force` (everything) for the project of this chat.
fn sync(args: &Value, chat: &str) -> Result<String, String> {
    let root = crate::index::root_of(chat, args)?;
    let force = args["force"].as_bool().unwrap_or(false);
    ensure(&root)?;
    let outcome = if force {
        cli(&["index", "--force", "--quiet", &root])?
    } else {
        cli(&["sync", &root])?
    };
    let text = String::from_utf8_lossy(&outcome.stdout).trim().to_string();
    if outcome.status.success() {
        Ok(match (text.is_empty(), force) {
            (false, _) => text,
            (true, true) => "CodeGraph index rebuilt.".to_string(),
            (true, false) => "CodeGraph index is up to date.".to_string(),
        })
    } else {
        let error = String::from_utf8_lossy(&outcome.stderr).trim().to_string();
        Err(if error.is_empty() { text } else { error })
    }
}

fn run(args: &Value, chat: &str) -> Result<String, String> {
    let root = crate::index::root_of(chat, args)?;
    let query = args["query"]
        .as_str()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .ok_or("query is required")?;
    ensure(&root)?;
    let output = cli(&["explore", "-p", &root, "--", query])?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        Ok(text)
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() { text } else { error })
    }
}
