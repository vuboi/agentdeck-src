# `/btw` redo: one chat view, Claude's own side question

Status: plan, not started. `/btw` stays behind `BTW_ENABLED` (`apps/desktop/src/lib/chat/session/btw-command.ts`) until step 6 passes.

## Goal

- The side panel looks and behaves exactly like the main chat: same message list, same composer, same streaming, same
  effects. No second design.
- The answer comes the way Claude Code's `/btw` makes it: a side question to the chat's own Claude conversation, no tools,
  not added to the chat's history, the chat's run, queue and model untouched.
- Claude only for now.

## What is known (checked)

- Claude Code 2.1.318 has `/btw` as a UI command (`local-jsx`, `thinClientDispatch: "control-request"`). `claude -p "/btw …"`
  answers `/btw isn't available in this environment`: print mode cannot run it.
- The Agent SDK in the repo (`@anthropic-ai/claude-agent-sdk` 0.3.316, CLI 2.1.316) handles a control request
  `{ subtype: "side_question", question: string, history: [{ question, response }] }` and reports progress with
  `SDKControlRequestProgressMessage` (correlated by `request_id`). Its prompt is the CLI's: "This is a side question from the
  user. You must answer this question directly in a single response." plus the conversation so far (fork context, cached).
- AgentDeck already keeps Claude chats open between turns through the SDK (`claude-sdk-runner.mjs --warm`, `warm.rs`).
  The runner already forwards two control requests to the live `query`: `interrupt` and `set_model`.
- The current `/btw` (`btw.rs` + `btw.svelte.ts` + `BtwPanel.svelte`) starts a separate `claude -p` per question and draws
  its own panel. That is the design being replaced. It also crashed the app once (`tokio::spawn` outside a runtime, fixed by
  making `btw_ask` async).

## Step 1 result (spike, `scratchpad/btw-spike.mjs`)

- `Query` has no `sideQuestion()` in `sdk.d.ts`. The raw control request works on the CLI's stdin:
  `{ type: "control_request", request_id, request: { subtype: "side_question", question, history: [] } }`, sent after a
  normal `user` turn finished (`result` seen).
- The CLI answers with `system.control_request_progress` (`status: "started"`), then one
  `control_response` `{ subtype: "success", request_id, response: { response: "<answer>", synthetic: false } }`.
- Answer comes once, not streamed. Cancel: not tested. Whether the side answer enters the main history: not tested
  (check in step 3 by sending a follow-up turn and reading `history`).
- Spawn flags used: `-p --input-format stream-json --output-format stream-json --verbose --permission-mode plan
--no-session-persistence`. The SDK runner uses the same stdin path, so step 2 is only a passthrough.

## Steps

1. **Spike (no app code).** In a scratch script, open a warm SDK `query` like the runner does, send one turn, then send a
   `side_question` control request. Record: request/response shape, streaming or not, cancel, cost/usage fields, and that the
   main conversation's history is unchanged afterwards. Stop and report if the CLI refuses it: then the fallback below applies.
2. **Runner.** `claude-sdk-runner.mjs`: accept `{ type: "control_request", request: { subtype: "side_question", … } }` on
   stdin while warm, pass it to the live session, and print its progress and result as stream-json lines tagged with the
   `request_id`.
3. **Rust.** Replace `btw.rs`'s separate process with a call into the chat's warm Claude process (`warm.rs`): write the
   control request, read the lines tagged with its `request_id`, emit them as `btw-event` {id, event} / `btw-done` {id}.
   No new process, no session id of its own, nothing written to `~/.claude/projects` (drop the `btw.ignored` list then).
   If the chat has no warm process, start it the way a normal turn would (prewarm), without sending a turn.
4. **One chat view.** Extract the transcript and composer of `Chat.svelte` into a component that takes a message source
   instead of reading `chat` / `workspace.activeId`:
    - `ChatThread.svelte`: the virtual list, row wrapper, reveal and scroll logic, live line, `UserMessage` / `AssistantMessage`.
    - `Composer` gets a `target` prop: the normal chat, or a side question (sends through `followUpBtw`, hides what a side
      question cannot use: attachments, mentions, model picker, queue).
    - `Chat.svelte` uses `ChatThread` for the main chat; `BtwPanel.svelte` becomes the header (`/btw`, question, close) plus
      the same `ChatThread` and `Composer` with the side source. Its own skeleton, wrapper, buttons and textarea go.
    - `AssistantMessage` / `UserMessage` keep the `sessionId` / `detached` props added for this; nothing else in them changes.
5. **Store.** `btw.svelte.ts` keeps one side question in memory (`btwChat`), builds blocks with `applyAgentEvent` as now,
   and holds the `history` list the control request needs (previous side questions and answers).
6. **Verify.** svelte-check, `pnpm release:check`, then in the dev app: a Claude chat, `/btw` twice (follow-up), Stop,
   close, F5; the main chat's model, queue and next turn unchanged (debug log `turn start` agent/model). Screenshot both
   panes side by side. Then set `BTW_ENABLED = true`.

## Fallback (if step 1 fails)

Keep the current separate-process answer (`btw_ask`, `claude -p` stream-json, plan mode, conversation snapshot in the
prompt) and do only steps 4 to 6. It does not reuse the prompt cache and writes a transcript that must stay ignored.

## Files

- `apps/desktop/src/agent/claude-sdk-runner.mjs` (step 2)
- `crates/adapters/src/agent/warm.rs`, `apps/desktop/src-tauri/src/btw.rs`, `lib.rs` (step 3)
- `apps/desktop/src/lib/components/chat/Chat.svelte`, new `ChatThread.svelte`, `Composer.svelte`, `BtwPanel.svelte` (step 4)
- `apps/desktop/src/lib/chat/session/btw.svelte.ts` (step 5)

## Risks

- `Chat.svelte` is large and carries reveal/scroll fixes (see memory: no extra motion on chat switch). The extraction must
  move code, not rewrite it, and be checked for jank on chat switch.
- A side question on a busy warm process (a turn running): Claude Code allows it; check the CLI does too, or queue it.
