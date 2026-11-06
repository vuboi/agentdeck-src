//! `delegate_task` and its companions on the app's `agentdeck` MCP server: an agent (Claude, Codex, Antigravity or a
//! local model) hands a task to another agent during its own turn, as a tool call.
//!
//! The work is done by the webview, which owns the chats: each call is emitted as an `agent-delegate` event
//! `{ callId, tool, caller, args }` (`caller` is the chat the MCP URL names, see `mcp_url`) and the call waits until the
//! webview answers through the `delegate_reply` command. Nothing here knows how a child chat runs. A call that is dropped
//! before its answer (the caller's run was stopped, its connection closed) tells the webview with `agent-delegate-abort`,
//! so a worker nobody waits for is stopped.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

pub const DEFAULT_TIMEOUT_S: u64 = 1800;
pub const MIN_TIMEOUT_S: u64 = 10;
pub const MAX_TIMEOUT_S: u64 = 7200;
/// Longest task text accepted: it is a prompt, not a document.
pub const TASK_MAX_CHARS: usize = 30_000;
/// How long a quick tool (list, status, stop, a task started in the background) may wait for the webview.
const QUICK_WAIT: Duration = Duration::from_secs(20);
/// How long a worker may wait for another agent's answer before the question is released.
pub const QUESTION_WAIT: Duration = Duration::from_secs(900);
/// What the call waits beyond the task's own timeout, which the webview enforces (stopping the worker): only a backstop.
const BACKSTOP: Duration = Duration::from_secs(60);

pub const DELEGATE_TOOL: &str = "delegate_task";
/// The tool an agent calls to suggest splitting its work into sessions. It only shows a card: the user decides, so the
/// call is answered at once and never waits (see `call`).
pub const PROPOSE_TOOL: &str = "propose_session";
pub const PROPOSE_REPLY: &str = "Proposed to the user; wait for their choice.";
/// A proposal's title is a short name: under 60 characters.
const PROPOSAL_TITLE_MAX: usize = 59;
const PROPOSAL_TASKS: std::ops::RangeInclusive<usize> = 2..=4;
/// A worker sends a short message to a sibling worker of the same parent (its team). The webview delivers it after the
/// receiver's current turn; the sender gets the delivery answer at once.
pub const TEAM_MESSAGE_TOOL: &str = "team_message";
const TOOLS: [&str; 8] = [
    DELEGATE_TOOL,
    "list_agents",
    "task_status",
    "task_stop",
    "task_ask",
    "task_answer",
    PROPOSE_TOOL,
    TEAM_MESSAGE_TOOL,
];

pub fn is_tool(name: &str) -> bool {
    TOOLS.contains(&name)
}

/// Checks the arguments of `propose_session`: a title, 2 to 4 tasks, each with a title, a brief and a write scope. The
/// overlaps and dependencies between the tasks are checked by the webview (tasks/propose.ts).
pub fn check_proposal(args: &Value) -> Result<(), String> {
    let title = text_of(&args["title"])
        .ok_or("title is required: a short name for the split, under 60 characters")?;
    if title.chars().count() > PROPOSAL_TITLE_MAX {
        return Err("title is longer than 59 characters: a short name for the split".into());
    }
    let tasks = args["tasks"]
        .as_array()
        .ok_or("tasks is required: a list of 2 to 4 tasks")?;
    if !PROPOSAL_TASKS.contains(&tasks.len()) {
        return Err(format!(
            "tasks takes 2 to 4 tasks, not {}: propose a split only when there are 2 independent parts",
            tasks.len()
        ));
    }
    for (at, task) in tasks.iter().enumerate() {
        let number = at + 1;
        if text_of(&task["title"]).is_none() {
            return Err(format!("task {number}: title is required"));
        }
        if text_of(&task["brief"]).is_none() {
            return Err(format!(
                "task {number}: brief is required: the goal, paths and what to report back"
            ));
        }
        if text_of(&task["brief"]).is_some_and(|brief| brief.chars().count() > TASK_MAX_CHARS) {
            return Err(format!(
                "task {number}: brief is longer than {TASK_MAX_CHARS} characters"
            ));
        }
        let scope = task["write_scope"]
            .as_array()
            .filter(|scope| !scope.is_empty())
            .ok_or(format!(
                "task {number}: write_scope is required: the files or folders it may change"
            ))?;
        if scope.iter().any(|path| text_of(path).is_none()) {
            return Err(format!(
                "task {number}: write_scope takes paths, not empty entries"
            ));
        }
        match &task["depends_on"] {
            Value::Null => {}
            Value::Array(items) if items.iter().all(|item| text_of(item).is_some()) => {}
            _ => {
                return Err(format!(
                    "task {number}: depends_on is a list of task titles"
                ))
            }
        }
    }
    match text_of(&args["isolation"]).as_deref() {
        None | Some("worktree") | Some("shared") => Ok(()),
        Some(_) => Err("isolation must be worktree or shared".into()),
    }
}

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": DELEGATE_TOOL,
            "description": format!("Hands a task to another AI agent running in AgentDeck (Claude, Codex, Antigravity or a local model) and returns its short report. Use this for cross-provider handoffs or independent work that benefits from another AgentDeck agent. If your CLI already has native sub-agents, use those for its own internal orchestration; do not replace them with this cross-provider tool. Do NOT delegate small things: keep ordinary Q&A, a small or single-file edit, a quick command or a simple artifact action in the current chat, and do not invent work just to delegate. Implementing a larger plan (several files or steps) is delegated too: split it into independent work packages, one worker each, and keep the integration yourself. Use 1-4 workers for genuinely independent capabilities such as investigation, implementation on disjoint files, verification, browser or artifact work; never assign overlapping write scopes. Give each worker a self-contained goal, paths/resources, constraints and evidence-first handoff: it sees nothing of this conversation. Independent tasks go out together in ONE turn with wait=false so they work in the background while you continue the main task; use wait=true only when the next step depends on a report, and use depends_on=[task_id] for an explicit sequence. At most {MAX_PARALLEL_WORKERS} workers run at a time; more wait in line and start as others finish. A worker may ask its parent with task_ask and continue after task_answer; use wait=false when the parent must answer a child during a longer workflow, because a synchronous parent waiting for that child would deadlock. Keep ownership of the main task and final integration. Never delegate merely to relay the user's message; never delegate the final answer. Reuse worker conversations for corrections: to send a correction to a worker that already answered, call delegate_task with continue=<task_id>. Replan only after evidence shows a real gap. Call list_agents first when unsure which agent or model to use. A FREE TIER agent sees no file or project and may train on the task: send it only public, non-sensitive text."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "description": "claude, codex, antigravity, or the id of a local model provider as listed by list_agents. Left out: the agent of the calling chat" },
                    "continue": { "type": "string", "description": "a task_id (e.g. t-ab12cd) or worker chat id of a worker that already answered and is idle: its chat is reused and `task` is sent to it as a follow-up. agent and model may then be left out" },
                    "model": { "type": "string", "description": "a model of that agent as listed by list_agents (a part of its name is enough); left out: the agent's usual one" },
                    "role": { "type": "string", "description": "the kind of work: a role switched on in Settings > Tasks and listed in this chat's task routing note. AgentDeck then sends the work to the first agent set for that role, so agent and model can be left out" },
                    "isolation": { "type": "string", "enum": ["shared", "worktree"], "description": "worktree: the worker gets its own git worktree and branch from this chat's branch, so its file edits stay out of the main checkout until merged. It cannot be combined with depends_on (the worktree starts from the base branch). Default shared." },
                    "task": { "type": "string", "description": "the self-contained task: goal, paths, constraints, what to report back" },
                    "wait": { "type": "boolean", "description": "true (default): wait for the report because the next step depends on it. false: run in the background and return a task_id now" },
                    "depends_on": { "type": ["string", "array"], "items": { "type": "string" }, "description": "task_id or task_ids that must finish successfully before this worker starts; use this for an explicit sequence" },
                    "timeout_s": { "type": "number", "description": format!("seconds the worker may take before it is stopped (default {DEFAULT_TIMEOUT_S}, at most {MAX_TIMEOUT_S})") },
                },
                "required": ["task"],
            },
        }),
        json!({
            "name": "list_agents",
            "description": "The agents delegate_task can hand work to right now, with their models and the id to pass as `agent`. Use these for cross-provider handoffs or extra independent work; if your CLI has native sub-agents, use them for its internal orchestration. Independent AgentDeck work can run in the background while you continue. Keep small things in the main chat and keep the final answer yourself. An agent marked FREE TIER may train on what it is sent: give it only light public work (search, emails, prompts, scripts, small text edits) with no source code, private data or secrets.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] },
        }),
        json!({
            "name": "task_status",
            "description": "The state of a task started with delegate_task (queued, running, done, failed or stopped), with its report once done. A background task's report is delivered to you anyway: use this only to look before it arrives.",
            "inputSchema": { "type": "object", "properties": { "task_id": { "type": "string", "description": "the task_id delegate_task returned" } }, "required": ["task_id"] },
        }),
        json!({
            "name": "task_stop",
            "description": "Stops a task started with delegate_task: its worker is killed. Use it when the result is no longer needed.",
            "inputSchema": { "type": "object", "properties": { "task_id": { "type": "string", "description": "the task_id delegate_task returned" } }, "required": ["task_id"] },
        }),
        json!({
            "name": "task_ask",
            "description": "Ask the agent that handed you this task for a decision or missing context. Your task pauses at Waiting for <agent>'s answer and resumes in the same worker conversation when the parent calls task_answer. Keep the question focused. If the parent is waiting synchronously for your report, use your own best judgement instead of creating a deadlock.",
            "inputSchema": { "type": "object", "properties": { "question": { "type": "string", "description": "the focused question for the parent agent" } }, "required": ["question"] },
        }),
        json!({
            "name": "task_answer",
            "description": "Answer a task_ask from a child agent. Use the question_id and give the decision or context directly so the child can continue its work.",
            "inputSchema": { "type": "object", "properties": { "question_id": { "type": "string", "description": "the question_id shown in the coordination prompt" }, "answer": { "type": "string", "description": "the answer the child should use" } }, "required": ["question_id", "answer"] },
        }),
        json!({
            "name": TEAM_MESSAGE_TOOL,
            "description": "Sends a short message to a sibling worker of the same parent agent (your team): the other worker receives it as a coordination note after its current turn. Use it to share a finding or an interface change that affects a teammate's files. It does not wait for a reply and does not reach other chats. To ask the parent, use task_ask instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "the task_id of a running teammate; if it is wrong, the error lists the running teammates" },
                    "message": { "type": "string", "description": "the message: what changed or was found, and what the teammate should check" }
                },
                "required": ["to", "message"]
            },
        }),
        json!({
            "name": PROPOSE_TOOL,
            "description": "Suggests splitting the work into sessions the user can run in parallel, each in its own git worktree. Shows the user a card with the tasks; nothing runs until the user chooses. Propose only when the request has 2 independent parts with disjoint write_scope (the files or folders each task may change) and no task needs another's result; Do NOT propose for work of 2 files or fewer, one continuous change, or a plan that must be done in order (give depends_on then, or keep it here). Each task has a self-contained brief (goal, paths, constraints, what to report back). Reply is immediate: say briefly what you proposed, then wait for their choice; do not start the tasks yourself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "a short name for the split, under 60 characters" },
                    "tasks": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "description": "2 to 4 independent tasks",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string", "description": "a short name for this task" },
                                "brief": { "type": "string", "description": "the self-contained task: goal, paths, constraints, what to report back" },
                                "write_scope": { "type": "array", "items": { "type": "string" }, "description": "the files or folders this task may change; scopes of different tasks must not overlap" },
                                "depends_on": { "type": "array", "items": { "type": "string" }, "description": "titles of other tasks in this list that must finish first" }
                            },
                            "required": ["title", "brief", "write_scope"]
                        }
                    },
                    "isolation": { "type": "string", "enum": ["worktree", "shared"], "description": "worktree (default): each task gets its own git worktree and branch" }
                },
                "required": ["title", "tasks"]
            },
        }),
    ]
}

/// The arguments of `delegate_task`, checked and with their defaults.
#[derive(Debug, PartialEq)]
pub struct DelegateArgs {
    pub agent: String,
    pub model: Option<String>,
    pub role: Option<String>,
    pub task: String,
    pub wait: bool,
    pub timeout_s: u64,
    /// A task id or worker chat id whose chat is reused for a follow-up.
    pub continue_id: Option<String>,
    pub depends_on: Vec<String>,
    /// Run the worker in its own git worktree and branch (`isolation: "worktree"`).
    pub worktree: bool,
}

fn text_of(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Local models often send `"true"` or `1` for a boolean.
fn flag_of(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        Value::Number(number) => number.as_f64().map(|n| n != 0.0),
        _ => None,
    }
}

fn seconds_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

pub fn parse_delegate(args: &Value) -> Result<DelegateArgs, String> {
    // A blank id is not "no continue": it would silently start a new task.
    if matches!(&args["continue"], Value::String(value) if value.trim().is_empty()) {
        return Err("continue must be the id of the task to continue".into());
    }
    let continue_id = text_of(&args["continue"]);
    // A role names its agent in Settings > Task roles, so it needs none here.
    let role = text_of(&args["role"]);
    let depends_on = match &args["depends_on"] {
        Value::Null => Vec::new(),
        Value::String(value) => vec![parse_task_id(&json!({ "task_id": value }))?],
        Value::Array(values) => values
            .iter()
            .map(|value| parse_task_id(&json!({ "task_id": value })))
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("depends_on must be a task_id or an array of task_ids".into()),
    };
    if depends_on.len() > 8 {
        return Err("depends_on accepts at most 8 task ids".into());
    }
    // No agent: the calling chat's agent does the work (see planTask in delegate-plan.ts).
    let agent = match &args["agent"] {
        Value::Null => String::new(),
        Value::String(agent) => agent.trim().to_owned(),
        _ => return Err("agent must be the name of an agent: claude, codex, antigravity or an id from list_agents".into()),
    };
    let task = text_of(&args["task"])
        .ok_or("task is required: say what the worker must do and report back")?;
    if task.chars().count() > TASK_MAX_CHARS {
        return Err(format!("task is longer than {TASK_MAX_CHARS} characters: give the goal and the paths, not whole files"));
    }
    let wait = match args.get("wait") {
        None | Some(Value::Null) => true,
        Some(value) => flag_of(value).ok_or("wait must be true or false")?,
    };
    let timeout_s = match args.get("timeout_s") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_S,
        Some(value) => {
            let seconds = seconds_of(value)
                .filter(|seconds| seconds.is_finite())
                .ok_or("timeout_s must be a number of seconds")?;
            (seconds.round().max(0.0) as u64).clamp(MIN_TIMEOUT_S, MAX_TIMEOUT_S)
        }
    };
    let worktree = match text_of(&args["isolation"]).as_deref() {
        None | Some("shared") => false,
        Some("worktree") => true,
        Some(_) => return Err("isolation must be shared or worktree".into()),
    };
    Ok(DelegateArgs {
        agent,
        model: text_of(&args["model"]),
        role,
        task,
        wait,
        timeout_s,
        continue_id,
        depends_on,
        worktree,
    })
}

pub fn parse_task_id(args: &Value) -> Result<String, String> {
    let id =
        text_of(&args["task_id"]).ok_or("task_id is required: the one delegate_task returned")?;
    if id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(format!("{id} is not a task_id"));
    }
    Ok(id)
}

pub fn parse_question(args: &Value) -> Result<String, String> {
    let question = text_of(&args["question"]).ok_or(
        "question is required: ask the parent for one focused decision or missing context",
    )?;
    if question.chars().count() > TASK_MAX_CHARS {
        return Err(format!(
            "question is longer than {TASK_MAX_CHARS} characters"
        ));
    }
    Ok(question)
}

pub fn parse_question_id(args: &Value) -> Result<(String, String), String> {
    let id = parse_task_id(&json!({ "task_id": args["question_id"] }))?;
    let answer = text_of(&args["answer"])
        .ok_or("answer is required: give the child the decision or context it asked for")?;
    if answer.chars().count() > TASK_MAX_CHARS {
        return Err(format!("answer is longer than {TASK_MAX_CHARS} characters"));
    }
    Ok((id, answer))
}

/// The arguments of `team_message`: a task_id of a sibling and a message of at most `TASK_MAX_CHARS` characters.
pub fn parse_team_message(args: &Value) -> Result<(String, String), String> {
    let to = parse_task_id(&json!({ "task_id": args["to"] }))?;
    let message = text_of(&args["message"])
        .ok_or("message is required: what changed or was found, for the teammate")?;
    if message.chars().count() > TASK_MAX_CHARS {
        return Err(format!(
            "message is longer than {TASK_MAX_CHARS} characters"
        ));
    }
    Ok((to, message))
}

/// How long the call waits for the webview's answer.
pub fn wait_limit(tool: &str, args: &Value) -> Duration {
    if tool == "task_ask" && parse_question(args).is_ok() {
        return QUESTION_WAIT + BACKSTOP;
    }
    match (tool, parse_delegate(args)) {
        (DELEGATE_TOOL, Ok(parsed)) if parsed.wait => {
            Duration::from_secs(parsed.timeout_s) + BACKSTOP
        }
        _ => QUICK_WAIT,
    }
}

/// Whether a JSON-RPC body is a `delegate_task` call that blocks until the worker is done: its answer is streamed so
/// the connection is not taken for dead (an HTTP client gives up on a response that says nothing for minutes).
pub fn is_long_call(body: &str) -> bool {
    let Ok(request) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    request["method"] == "tools/call"
        && ((request["params"]["name"] == DELEGATE_TOOL
            && parse_delegate(&request["params"]["arguments"]).is_ok_and(|parsed| parsed.wait))
            || (request["params"]["name"] == "task_ask"
                && parse_question(&request["params"]["arguments"]).is_ok()))
}

// ---------------------------------------------------------------------------------------------------------------
// Calls waiting for the webview

/// The webview's answer to a call.
#[derive(Debug, PartialEq)]
pub struct Reply {
    pub text: String,
    pub is_error: bool,
}

static NEXT: AtomicU64 = AtomicU64::new(1);
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<Reply>>>> =
    LazyLock::new(Default::default);

/// The calls waiting for the webview. A panic while it was held must not stop later calls from being answered: the map is
/// still sound, so its guard is taken back.
fn pending() -> std::sync::MutexGuard<'static, HashMap<String, oneshot::Sender<Reply>>> {
    PENDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The cap on running workers. Taken back after a panic too: the gate fails open, never stuck.
fn gate() -> std::sync::MutexGuard<'static, Gate> {
    GATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register() -> (String, oneshot::Receiver<Reply>) {
    let id = format!("dlg-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = oneshot::channel();
    pending().insert(id.clone(), sender);
    (id, receiver)
}

fn resolve(id: &str, reply: Reply) -> bool {
    let sender = pending().remove(id);
    sender.is_some_and(|sender| sender.send(reply).is_ok())
}

fn fail_all(reason: &str) -> usize {
    let all: Vec<_> = pending().drain().collect();
    let count = all.len();
    for (_, sender) in all {
        let _ = sender.send(Reply {
            text: reason.to_owned(),
            is_error: true,
        });
    }
    count
}

/// What the webview tells a waiting call's clock: the task is held (queued, waiting for a dependency, paused by the user)
/// or it runs again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clock {
    Pause,
    Resume,
}

static CLOCKS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<Clock>>>> =
    LazyLock::new(Default::default);

fn clocks() -> std::sync::MutexGuard<'static, HashMap<String, mpsc::UnboundedSender<Clock>>> {
    CLOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The time a blocking call may wait for its answer. It runs only while the task runs: a held task (queued for a
/// worker slot, waiting for a dependency, paused) keeps its remaining time, so waiting in line never times the call out.
#[derive(Debug, PartialEq)]
struct Budget {
    deadline: Instant,
    /// The time left while held; `None` while running.
    held: Option<Duration>,
}

impl Budget {
    fn new(limit: Duration, now: Instant) -> Self {
        Self {
            deadline: now + limit,
            held: None,
        }
    }

    fn pause(&mut self, now: Instant) {
        if self.held.is_none() {
            self.held = Some(self.deadline.saturating_duration_since(now));
        }
    }

    fn resume(&mut self, now: Instant) {
        if let Some(left) = self.held.take() {
            self.deadline = now + left;
        }
    }

    /// When the call times out; `None` while it is held.
    fn due(&self) -> Option<Instant> {
        self.held.is_none().then_some(self.deadline)
    }
}

/// Removes the call when it is dropped without an answer, and tells the webview to stop the worker nobody waits for.
struct Abandon<'a> {
    app: &'a AppHandle,
    id: String,
    notify: bool,
    done: bool,
}

impl Drop for Abandon<'_> {
    fn drop(&mut self) {
        clocks().remove(&self.id);
        if self.done {
            return;
        }
        pending().remove(&self.id);
        if self.notify {
            let _ = self
                .app
                .emit_to("main", "agent-delegate-abort", json!({ "callId": self.id }));
        }
    }
}

fn reply_value(text: String, is_error: bool) -> Value {
    if is_error {
        json!({ "content": [{ "type": "text", "text": text }], "isError": true })
    } else {
        json!({ "content": [{ "type": "text", "text": text }] })
    }
}

/// One tool call of the MCP server: checks the arguments, hands the call to the webview and waits for its answer.
pub async fn call(app: &AppHandle, tool: &str, args: &Value, chat: &str) -> Value {
    // A proposal is only shown: the webview draws its card from the call's own line in the chat, so nothing here waits.
    if tool == PROPOSE_TOOL {
        return match check_proposal(args) {
            Ok(()) => reply_value(PROPOSE_REPLY.into(), false),
            Err(error) => reply_value(error, true),
        };
    }
    let checked = match tool {
        DELEGATE_TOOL => parse_delegate(args).map(|parsed| {
            json!({ "agent": parsed.agent, "model": parsed.model, "role": parsed.role, "task": parsed.task, "wait": parsed.wait, "timeout_s": parsed.timeout_s, "continue": parsed.continue_id, "depends_on": parsed.depends_on })
        }),
        "task_status" | "task_stop" => parse_task_id(args).map(|id| json!({ "task_id": id })),
        "task_ask" => parse_question(args).map(|question| json!({ "question": question })),
        "task_answer" => parse_question_id(args).map(|(question_id, answer)| json!({ "question_id": question_id, "answer": answer })),
        TEAM_MESSAGE_TOOL => parse_team_message(args).map(|(to, message)| json!({ "to": to, "message": message })),
        _ => Ok(json!({})),
    };
    let args = match checked {
        Ok(args) => args,
        Err(error) => return reply_value(error, true),
    };
    let limit = wait_limit(tool, &args);
    let (id, receiver) = register();
    let (clock_tx, mut clock_rx) = mpsc::unbounded_channel();
    clocks().insert(id.clone(), clock_tx);
    let mut guard = Abandon {
        app,
        id: id.clone(),
        notify: (tool == DELEGATE_TOOL && args["wait"] == true) || tool == "task_ask",
        done: false,
    };
    // Only the main window: a Preview page is a copy of this app and must not answer the chats' calls.
    if let Err(error) = app.emit_to(
        "main",
        "agent-delegate",
        json!({ "callId": id, "tool": tool, "caller": chat, "args": args }),
    ) {
        return reply_value(format!("AgentDeck could not start the task: {error}"), true);
    }
    let mut budget = Budget::new(limit, Instant::now());
    let mut timer = Box::pin(tokio::time::sleep(limit));
    let mut receiver = receiver;
    loop {
        tokio::select! {
            answer = &mut receiver => {
                guard.done = true;
                return match answer {
                    Ok(reply) => reply_value(reply.text, reply.is_error),
                    Err(_) => reply_value("AgentDeck dropped the call.".into(), true),
                };
            }
            () = &mut timer, if budget.due().is_some() => {
                return reply_value(
                    format!("AgentDeck did not answer within {} s.", limit.as_secs()),
                    true,
                );
            }
            Some(clock) = clock_rx.recv() => {
                let now = Instant::now();
                match clock {
                    Clock::Pause => budget.pause(now),
                    Clock::Resume => {
                        budget.resume(now);
                        if let Some(due) = budget.due() {
                            timer.as_mut().reset(tokio::time::Instant::from_std(due));
                        }
                    }
                }
            }
        }
    }
}

/// The webview's answer to a call (the worker's report, or the reason there is none).
#[tauri::command]
pub fn delegate_reply(call_id: String, text: String, is_error: bool) -> bool {
    resolve(&call_id, Reply { text, is_error })
}

/// Holds a waiting call's clock: its task is queued, waiting for another task, or paused. `false` when the call is gone.
#[tauri::command]
pub fn delegate_pause(call_id: String) -> bool {
    send_clock(&call_id, Clock::Pause)
}

/// The task runs again: the call's clock goes on with the time it kept when it was held.
#[tauri::command]
pub fn delegate_resume(call_id: String) -> bool {
    send_clock(&call_id, Clock::Resume)
}

fn send_clock(call_id: &str, clock: Clock) -> bool {
    clocks()
        .get(call_id)
        .is_some_and(|sender| sender.send(clock).is_ok())
}

/// The webview just (re)loaded: the chats and workers of the page before it are gone, so no call can be answered.
#[tauri::command]
pub fn delegate_ready() -> usize {
    *gate() = Gate::default();
    fail_all("AgentDeck was reloaded while this task ran; the task is lost. Start it again if it is still needed.")
}

// ---------------------------------------------------------------------------------------------------------------
// The cap on workers running at once

/// How many delegated workers run at the same time for one asking chat (wait=true or false). The cap is per chat: a
/// chat whose workers hang or pile up never takes a place from another chat. The webview asks for a place before it
/// starts a worker (`delegate_enter`) and gives it back when the task ends (`delegate_release`).
pub const MAX_PARALLEL_WORKERS: usize = 4;

/// Workers running and workers waiting for a place, in the order they asked, each with the chat that asked. Holds ids
/// only, no I/O: a place is given by `enter` or, once one is released, by the list `release` returns.
#[derive(Debug, Default)]
struct Gate {
    running: Vec<(String, String)>,
    waiting: VecDeque<(String, String)>,
}

impl Gate {
    fn used_by(&self, owner: &str) -> usize {
        self.running.iter().filter(|(_, who)| who == owner).count()
    }

    /// `true`: the task may start now. `false`: it waits, and `release` names it when its turn comes.
    fn enter(&mut self, id: &str, owner: &str) -> bool {
        if self.running.iter().any(|(item, _)| item == id) {
            return true;
        }
        if self.waiting.iter().any(|(item, _)| item == id) {
            return false;
        }
        if self.used_by(owner) < MAX_PARALLEL_WORKERS {
            self.running.push((id.to_owned(), owner.to_owned()));
            return true;
        }
        self.waiting.push_back((id.to_owned(), owner.to_owned()));
        false
    }

    /// Frees the task's place (or its place in the line) and returns the waiting tasks that may start now.
    fn release(&mut self, id: &str) -> Vec<String> {
        self.running.retain(|(item, _)| item != id);
        self.waiting.retain(|(item, _)| item != id);
        let mut started = Vec::new();
        let mut index = 0;
        while index < self.waiting.len() {
            let owner = self.waiting[index].1.clone();
            if self.used_by(&owner) < MAX_PARALLEL_WORKERS {
                if let Some(entry) = self.waiting.remove(index) {
                    started.push(entry.0.clone());
                    self.running.push(entry);
                }
            } else {
                index += 1;
            }
        }
        started
    }
}

static GATE: LazyLock<Mutex<Gate>> = LazyLock::new(Default::default);

/// A worker is about to start: `true` when it may, `false` when it is queued behind `MAX_PARALLEL_WORKERS` others (the
/// webview is then told with `agent-delegate-slot` `{ taskId }` when its turn comes).
#[tauri::command]
pub fn delegate_enter(task_id: String, owner: Option<String>) -> bool {
    let owner = owner.unwrap_or_default();
    gate().enter(&task_id, &owner)
}

/// A task ended (done, failed, stopped, timed out or never started): its place goes to the next one waiting.
#[tauri::command]
pub fn delegate_release(app: AppHandle, task_id: String) {
    let started = gate().release(&task_id);
    for id in started {
        let _ = app.emit_to("main", "agent-delegate-slot", json!({ "taskId": id }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolation_is_shared_unless_worktree_is_asked() {
        let base = json!({ "agent": "claude", "task": "fix export" });
        assert!(!parse_delegate(&base).unwrap().worktree);
        let mut w = base.clone();
        w["isolation"] = json!("worktree");
        assert!(parse_delegate(&w).unwrap().worktree);
        let mut bad = base;
        bad["isolation"] = json!("everywhere");
        assert!(parse_delegate(&bad).is_err());
    }

    #[test]
    fn defaults_are_wait_and_thirty_minutes() {
        let parsed = parse_delegate(&json!({ "agent": " claude ", "task": " read the logs " }))
            .expect("valid");
        assert_eq!(
            parsed,
            DelegateArgs {
                agent: "claude".into(),
                model: None,
                role: None,
                task: "read the logs".into(),
                wait: true,
                timeout_s: 1800,
                continue_id: None,
                depends_on: vec![],
                worktree: false,
            }
        );
    }

    #[test]
    fn missing_or_empty_agent_and_task_are_refused() {
        // Without an agent the calling chat's agent is used, so only the task is required.
        assert_eq!(parse_delegate(&json!({ "task": "x" })).unwrap().agent, "");
        assert!(parse_delegate(&json!({ "agent": "codex" })).is_err());
        assert!(parse_delegate(&json!({ "agent": "codex", "task": "   " })).is_err());
        assert!(parse_delegate(&json!({ "agent": 3, "task": "x" })).is_err());
        assert!(parse_delegate(&Value::Null).is_err());
    }

    #[test]
    fn continue_replaces_agent() {
        let parsed =
            parse_delegate(&json!({ "continue": " t-ab12cd ", "task": "fix it" })).expect("valid");
        assert_eq!(parsed.continue_id.as_deref(), Some("t-ab12cd"));
        assert!(parsed.agent.is_empty());
        assert!(parse_delegate(&json!({ "continue": "   ", "task": "x" })).is_err());
        assert!(parse_delegate(&json!({ "continue": "t-ab12cd" })).is_err());
    }

    #[test]
    fn a_task_role_can_route_without_an_explicit_agent() {
        let parsed = parse_delegate(&json!({ "role": "read", "task": "inspect the image" }))
            .expect("a role supplies the configured route");
        assert!(parsed.agent.is_empty());
        assert_eq!(parsed.role.as_deref(), Some("read"));
    }

    #[test]
    fn wait_and_timeout_accept_what_local_models_send() {
        let args = json!({ "agent": "codex", "task": "x", "wait": "false", "timeout_s": "90", "model": "gpt-6-luna" });
        let parsed = parse_delegate(&args).expect("valid");
        assert!(!parsed.wait);
        assert_eq!(parsed.timeout_s, 90);
        assert_eq!(parsed.model.as_deref(), Some("gpt-6-luna"));
        assert!(parse_delegate(&json!({ "agent": "a", "task": "x", "wait": "maybe" })).is_err());
        assert!(
            parse_delegate(&json!({ "agent": "a", "task": "x", "timeout_s": "soon" })).is_err()
        );
        assert!(
            parse_delegate(&json!({ "agent": "a", "task": "x", "wait": null }))
                .expect("null is unset")
                .wait
        );
    }

    #[test]
    fn timeout_is_kept_within_bounds() {
        let timeout = |value: Value| {
            parse_delegate(&json!({ "agent": "a", "task": "x", "timeout_s": value }))
                .expect("valid")
                .timeout_s
        };
        assert_eq!(timeout(json!(1)), MIN_TIMEOUT_S);
        assert_eq!(timeout(json!(-5)), MIN_TIMEOUT_S);
        assert_eq!(timeout(json!(999_999)), MAX_TIMEOUT_S);
        assert_eq!(timeout(json!(600.4)), 600);
    }

    #[test]
    fn a_huge_task_is_refused() {
        let task = "x".repeat(TASK_MAX_CHARS + 1);
        assert!(parse_delegate(&json!({ "agent": "claude", "task": task })).is_err());
    }

    #[test]
    fn task_ids_are_plain_words() {
        assert_eq!(
            parse_task_id(&json!({ "task_id": " t-ab12 " })).as_deref(),
            Ok("t-ab12")
        );
        assert!(parse_task_id(&json!({})).is_err());
        assert!(parse_task_id(&json!({ "task_id": "a b" })).is_err());
        assert!(parse_task_id(&json!({ "task_id": "../x" })).is_err());
    }

    #[test]
    fn the_wait_limit_follows_the_task_timeout() {
        let blocking = json!({ "agent": "claude", "task": "x", "timeout_s": 120 });
        assert_eq!(
            wait_limit(DELEGATE_TOOL, &blocking),
            Duration::from_secs(120) + BACKSTOP
        );
        assert_eq!(
            wait_limit(DELEGATE_TOOL, &json!({ "agent": "claude", "task": "x" })),
            Duration::from_secs(1800) + BACKSTOP
        );
        // A background task answers at once; so do the other tools.
        assert_eq!(
            wait_limit(
                DELEGATE_TOOL,
                &json!({ "agent": "claude", "task": "x", "wait": false })
            ),
            QUICK_WAIT
        );
        assert_eq!(
            wait_limit("task_status", &json!({ "task_id": "t1" })),
            QUICK_WAIT
        );
        assert_eq!(wait_limit("list_agents", &json!({})), QUICK_WAIT);
    }

    #[test]
    fn a_held_call_keeps_its_time_and_runs_on_after_resume() {
        let start = Instant::now();
        let mut budget = Budget::new(Duration::from_secs(100), start);
        assert_eq!(budget.due(), Some(start + Duration::from_secs(100)));
        // Held (queued or paused) at 30 s: 70 s are left, and waiting does not use them.
        budget.pause(start + Duration::from_secs(30));
        assert_eq!(budget.due(), None);
        budget.pause(start + Duration::from_secs(500));
        budget.resume(start + Duration::from_secs(600));
        assert_eq!(budget.due(), Some(start + Duration::from_secs(670)));
        // A resume that holds nothing changes nothing.
        budget.resume(start + Duration::from_secs(650));
        assert_eq!(budget.due(), Some(start + Duration::from_secs(670)));
    }

    #[test]
    fn only_a_blocking_delegate_call_is_streamed() {
        let call = |name: &str, arguments: Value| {
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } }).to_string()
        };
        assert!(is_long_call(&call(
            DELEGATE_TOOL,
            json!({ "agent": "claude", "task": "x" })
        )));
        assert!(!is_long_call(&call(
            DELEGATE_TOOL,
            json!({ "agent": "claude", "task": "x", "wait": false })
        )));
        assert!(!is_long_call(&call(
            DELEGATE_TOOL,
            json!({ "agent": "claude" })
        )));
        assert!(!is_long_call(&call(
            "task_status",
            json!({ "task_id": "t1" })
        )));
        assert!(!is_long_call(&call(
            "browser_click",
            json!({ "x": 1, "y": 2 })
        )));
        assert!(!is_long_call(
            &json!({ "method": "tools/list" }).to_string()
        ));
        assert!(!is_long_call("not json"));
    }

    #[test]
    fn workers_run_up_to_the_limit_and_the_next_waits_for_a_release() {
        // Written against the limit, not a number: it is raised and lowered in one place.
        let mut gate = Gate::default();
        let running: Vec<String> = (0..MAX_PARALLEL_WORKERS).map(|n| format!("w{n}")).collect();
        for id in &running {
            assert!(gate.enter(id, "chat"));
        }
        assert!(!gate.enter("x", "chat"));
        assert!(!gate.enter("y", "chat"));
        // Asking twice does not take a second place, nor lose the one in line.
        assert!(gate.enter(&running[0], "chat"));
        assert!(!gate.enter("x", "chat"));
        assert_eq!(gate.release(&running[1]), ["x"]);
        assert_eq!(gate.running.len(), MAX_PARALLEL_WORKERS);
        // Completion order, not start order: the next place goes to the next in line.
        assert_eq!(gate.release(&running[0]), ["y"]);
        assert!(gate.release(&running[2]).is_empty());
        assert_eq!(gate.running.len(), MAX_PARALLEL_WORKERS - 1);
    }

    #[test]
    fn one_chat_full_of_workers_does_not_block_another_chat() {
        let mut gate = Gate::default();
        for n in 0..MAX_PARALLEL_WORKERS {
            assert!(gate.enter(&format!("a{n}"), "chat-a"));
        }
        assert!(!gate.enter("a-extra", "chat-a"));
        assert!(gate.enter("b0", "chat-b"));
        // A place freed in chat B never starts chat A's waiting task.
        assert!(gate.release("b0").is_empty());
        assert_eq!(gate.release("a0"), ["a-extra"]);
    }

    #[test]
    fn a_task_stopped_in_line_leaves_the_line_and_an_unknown_release_is_harmless() {
        let mut gate = Gate::default();
        let running: Vec<String> = (0..MAX_PARALLEL_WORKERS).map(|n| format!("w{n}")).collect();
        for id in &running {
            assert!(gate.enter(id, "chat"));
        }
        assert!(!gate.enter("x", "chat"));
        assert!(!gate.enter("y", "chat"));
        assert!(gate.release("x").is_empty());
        assert!(gate.release("nobody").is_empty());
        assert_eq!(gate.release(&running[0]), ["y"]);
    }

    #[test]
    fn the_tools_are_listed_with_their_guidance() {
        let defs = tool_defs();
        let names: Vec<_> = defs
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names,
            [
                "delegate_task",
                "list_agents",
                "task_status",
                "task_stop",
                "task_ask",
                "task_answer",
                "team_message",
                "propose_session"
            ]
        );
        assert!(names.iter().all(|name| is_tool(name)));
        assert_eq!(
            parse_team_message(&json!({ "to": "t-ab12cd", "message": "API changed" })),
            Ok(("t-ab12cd".to_string(), "API changed".to_string()))
        );
        assert!(parse_team_message(&json!({ "to": "../x", "message": "m" })).is_err());
        assert!(parse_team_message(&json!({ "to": "t-ab12cd", "message": " " })).is_err());
        let text = defs[0]["description"].as_str().unwrap_or_default();
        for phrase in [
            "wait=true",
            "wait=false",
            "Do NOT delegate small things",
            "never delegate the final answer",
            "1-4 workers",
            "continue=<task_id>",
        ] {
            assert!(text.contains(phrase), "the description lacks: {phrase}");
        }
        assert_eq!(defs[0]["inputSchema"]["required"], json!(["task"]));
    }

    fn proposed_task(title: &str) -> Value {
        json!({ "title": title, "brief": "do the part", "write_scope": [format!("src/{title}")] })
    }

    #[test]
    fn a_proposal_needs_a_short_title_and_two_to_four_tasks() {
        let two = json!({ "title": "Export", "tasks": [proposed_task("a"), proposed_task("b")] });
        assert!(check_proposal(&two).is_ok());
        let four = json!({ "title": "Export", "tasks": [proposed_task("a"), proposed_task("b"), proposed_task("c"), proposed_task("d")] });
        assert!(check_proposal(&four).is_ok());
        let one = json!({ "title": "Export", "tasks": [proposed_task("a")] });
        assert!(check_proposal(&one).is_err());
        let five = json!({ "title": "Export", "tasks": [proposed_task("a"), proposed_task("b"), proposed_task("c"), proposed_task("d"), proposed_task("e")] });
        assert!(check_proposal(&five).is_err());
        let no_tasks = json!({ "title": "Export" });
        assert!(check_proposal(&no_tasks).is_err());
        let no_title = json!({ "tasks": [proposed_task("a"), proposed_task("b")] });
        assert!(check_proposal(&no_title).is_err());
        let longest =
            json!({ "title": "x".repeat(59), "tasks": [proposed_task("a"), proposed_task("b")] });
        assert!(check_proposal(&longest).is_ok());
        let too_long =
            json!({ "title": "x".repeat(60), "tasks": [proposed_task("a"), proposed_task("b")] });
        assert!(check_proposal(&too_long).is_err());
    }

    #[test]
    fn each_task_needs_a_title_a_brief_and_a_write_scope() {
        let bad_tasks = [
            json!({ "title": "a", "brief": "x" }),
            json!({ "title": "a", "brief": "x", "write_scope": [] }),
            json!({ "title": "a", "brief": "x", "write_scope": [""] }),
            json!({ "title": "", "brief": "x", "write_scope": ["a"] }),
            json!({ "title": "a", "brief": " ", "write_scope": ["a"] }),
            json!({ "title": "a", "brief": "x", "write_scope": ["a"], "depends_on": "b" }),
        ];
        for bad in bad_tasks {
            let args = json!({ "title": "Export", "tasks": [bad.clone(), proposed_task("b")] });
            assert!(check_proposal(&args).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn isolation_of_a_proposal_is_worktree_or_shared() {
        let base = json!({ "title": "Export", "tasks": [proposed_task("a"), proposed_task("b")] });
        assert!(check_proposal(&base).is_ok());
        let mut shared = base.clone();
        shared["isolation"] = json!("shared");
        assert!(check_proposal(&shared).is_ok());
        let mut bad = base;
        bad["isolation"] = json!("everywhere");
        assert!(check_proposal(&bad).is_err());
    }

    #[test]
    fn propose_session_is_listed_with_when_to_propose() {
        let defs = tool_defs();
        let propose = defs
            .iter()
            .find(|tool| tool["name"] == PROPOSE_TOOL)
            .expect("propose_session is listed");
        assert!(is_tool(PROPOSE_TOOL));
        let text = propose["description"].as_str().unwrap_or_default();
        for phrase in [
            "write_scope",
            "2 independent",
            "Do NOT propose",
            "wait for their choice",
        ] {
            assert!(text.contains(phrase), "the description lacks: {phrase}");
        }
        assert_eq!(
            propose["inputSchema"]["required"],
            json!(["title", "tasks"])
        );
    }

    // One test: both use the shared registry, and a reload empties it for everyone.
    #[tokio::test]
    async fn an_answer_reaches_its_call_once_and_a_reload_fails_the_rest() {
        let (id, receiver) = register();
        assert!(resolve(
            &id,
            Reply {
                text: "report".into(),
                is_error: false
            }
        ));
        assert_eq!(
            receiver.await.ok(),
            Some(Reply {
                text: "report".into(),
                is_error: false
            })
        );
        // Nobody waits any more: a second answer is not taken.
        assert!(!resolve(
            &id,
            Reply {
                text: "again".into(),
                is_error: false
            }
        ));
        assert!(!resolve(
            "dlg-unknown",
            Reply {
                text: "x".into(),
                is_error: false
            }
        ));

        let (_, first) = register();
        let (_, second) = register();
        assert_eq!(fail_all("gone"), 2);
        for receiver in [first, second] {
            let reply = receiver.await.expect("answered");
            assert!(reply.is_error);
            assert_eq!(reply.text, "gone");
        }
    }
}
