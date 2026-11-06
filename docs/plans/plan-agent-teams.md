# Plan: Agent Teams (Claude) and subagent types (Codex)

## Probe (Claude Code 2.1.318, haiku, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)

Run: `claude -p "<two teammates write a.txt / b.txt>" --output-format stream-json --verbose --model haiku --permission-mode bypassPermissions` in a scratch folder. Result: `success`, `num_turns` 3, files written.

- Teammates are launched with the `Agent` tool. Its input has `name` (e.g. `teammate-one`), `description`, `subagent_type` (`general-purpose`), `run_in_background: false`.
- Each teammate emits `system/task_started` (`tool_use_id` = its `Agent` call id, `subagent_type`, `description`, `spawn_depth: 1`), `task_progress`, `task_updated`, `task_notification`. These already map to `AgentEvent::Task` in `claude.rs`.
- New event `system/task_summary` (`detail`, no `task_id`). Not mapped: no id to attach it to.
- Teammate events carry `parent_tool_use_id`; already mapped to `Scoped`.
- Not exercised: teammate-to-teammate messages (`SendMessage`-style). The two teammates only wrote files, so peer messaging is still unverified.

## Findings

- Most of Agent Teams already flows through the existing `Agent`/`Task` mapping. The gap was that the flag was not set.
- Codex: `collabAgentToolCall` (`spawnAgent`, `wait`, `sendInput`, `followupTask`, `closeAgent`, `listAgents`) is already mapped in `codex_server.rs`. The item has no role field. `Thread.agentRole` / `agentNickname` exist in the protocol schema, but no probe shows that `thread/started` reaches the client for child threads (the code comment says it does not).

## Changes

1. `crates/adapters/src/agent/claude.rs` `environment()`: add `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, with test.

## Not done (needs probe first)

- Teammate names in card labels: `task_started` does not carry `name`; needs correlation with the `Agent` call input.
- `task_summary` mapping: needs a task id.
- Codex child role/nickname: needs a live `codex app-server` probe to confirm whether `thread/started` arrives for children.
- Teammate peer messaging: needs a probe where teammates message each other.

## Phase 2: teammates across providers and connectors

Goal: a team whose members run different providers or connectors (Claude, Codex, Antigravity, local model), not only Claude subagents.

Current state:
- `delegate_task` (`apps/desktop/src-tauri/src/delegate.rs`) already starts a child chat on `agent` = `claude`, `codex`, `antigravity` or a local provider from `list_agents`. Cross-provider workers exist, but only as parent → child → parent (`task_status`, `task_stop`, `task_ask`, `task_answer`).
- Missing: peer messages between workers, a shared task list across providers, and a team identity that groups them.

Proposed design:
1. Team record in AgentDeck (team id, lead chat, members with provider/model/connector, shared task list). Stored in the app, not in a CLI.
2. Peer message bus in AgentDeck: a `team_message` MCP tool on the existing `agentdeck` server, routed to a member's chat as a user turn. Delivery only when the target is idle or uses the mid-turn path gated by `ChatResponseCapabilities`.
3. Claude native teams stay as is; AgentDeck teams are a separate path that calls `delegate_task` for each member.
4. UI: members in `child-agents.svelte.ts` / `AgentsPanel.svelte`, labeled by provider and model.

Open risks:
- Claude native teammates cannot message non-Claude members; the bus must sit above the CLIs.
- Message delivery for Codex and Antigravity is unverified; needs a probe per provider before relying on it.

## Phase 2a: implemented

- `team_message` tool (`delegate.rs`: `TEAM_MESSAGE_TOOL`, `parse_team_message`, listed in `tool_defs`). Routed to the webview like `task_answer`.
- Team = the running workers of one parent (same `caller`). A sender reaches only its siblings.
- Webview (`delegate-task.svelte.ts` `teamMessage`): the note is queued with `queueCoordinationPrompt` and read after the receiver's current turn. A receiver that is no longer running gets an error. A wrong `to` gets the list of running teammates.
- `toolKindOf`, `DelegateCall`, and the activity label (`blocks.ts`) know `team_message`.

Verified: `cargo test -p agentdeck-desktop delegate` (21 pass), `cargo clippy -p agentdeck-desktop -- -D warnings` clean, `delegate-task.test.ts` 15 pass, `svelte-check` 0 errors. The desktop crate builds with `BINDGEN_EXTRA_CLANG_ARGS=-IC:/Program Files/LLVM/lib/clang/23/include` inside the VS 2022 BuildTools `vcvars64.bat` environment.

Replies: a receiver answers with `team_message` to the sender's task_id (the note names it). Both sides must still be running.

Note turns (fixed, option 1: the task stays open for the notes):
- A note queued while a worker's first turn runs: `settle` keeps that turn's answer as `TaskRun.report`, keeps the waiter, and starts the queued note (`sendNextQueued`). The task does not end yet.
- A note turn is flagged `teamNote` in the coordination queue. When it ends, `events.svelte.ts` calls `teamNoteDone` instead of `onDelegateDone`. If more notes are queued it starts the next one; otherwise it settles the kept report, so the task ends with the first report.
- A note that runs while the worker is paused or waiting on an approval keeps the waiter: the real end still settles the task.
- The note turn's own answer is never the report.
- Test: `tests/chat-flow.test.mjs`, three `team notes:` cases (pass). The file needs `--experimental-strip-types --experimental-vm-modules` and a resolver for extensionless imports (`src/lib/agents/credential-scope`), which fails on plain `node --test`; this is pre-existing. The three `R3.3` cases failed at HEAD too (`Unconfigured ../runs/change-ledger.svelte:onUserFileSave`: `events.svelte.ts` registers a save listener at load). Fixed in the harness by stubbing `onUserFileSave` in the `events` load. All 24 cases in the file pass with the flags above.
- Not verified in the app: that the pump starts the note turn right after the first turn ends. Relies on the existing `sendNextQueued` after each turn.

Claude teammate names (done): the `Agent` call's `name` becomes `AgentEvent::Teammate { id, name }` (sent right after the `ToolCall`, like `ToolModel`). `agent-reply.ts` sets `CommandBlock.teammate` and the task card label becomes `teammate-one · general-purpose: <description>`. Tests: `claude.rs` `a_teammate_call_names_its_teammate`, `agent-reply.test.ts` `a teammate names the task card of its call`.

`task_summary` (decided: not mapped): it has no `task_id` or `parent_tool_use_id`, so it cannot be attached to a card. The per-task `task_progress` event already carries the same `description` with its `task_id`, so nothing is lost.

Codex and Antigravity: note delivery goes through `send()`, the same path as `delegate_task` `continue=<task_id>` follow-ups, which already run for every provider. Not probed live: needs the app running with a real Codex or Antigravity worker.

Not done in 2a: none in the code path. Live checks in the app are still needed (see the known gap above).

## Checks

- `cargo test -p ag-adapters`
- `cargo clippy -p ag-adapters -- -D warnings`
