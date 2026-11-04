---
description: Record a chat-content bug with its reproduction flow and suspected cause, so a later session can fix it
argument-hint: <what went wrong in the chat, e.g. "tool block shows raw JSON after stop">
---

Record the bug described in `$ARGUMENTS` in `docs/bugs/`, so a later session can fix it without re-learning the flow. This command only writes the report. Do not fix the code, do not commit, do not push.

If `$ARGUMENTS` is empty, ask the user one question: what they saw in the chat, and when. Then stop until they answer.

1. **Capture the symptom.** From `$ARGUMENTS` and the chat context, write down: what the user saw (the bug), what they expected, which agent and model, and the steps that led to it. Keep the user's words. Ask only if a required part is missing and cannot be guessed.

2. **Find the debug log.** The app writes `debug.log` and `errors.log` under the app data folder:
    - Installed app: `$APPDATA/dev.agentdeck.desktop/logs/`
    - `pnpm dev`: `$APPDATA/dev.agentdeck.desktop.dev/logs/`
    - The user may have a zip from Settings → Tasks → Errors drawer → Download debug log. Use it if they point to it.
      If no log exists, say so and continue without it. Note the gap in the report.

3. **Pull the evidence.** From the log, take the lines within a few minutes of the bug and the chat id (`chat` field) of that chat. Keep the `turn start`, `turn end`, `event`, `stream`, `heartbeat` and `PANIC` lines that show the turn's flow. Cut to the lines that matter, not the whole file. The log has no user text; tool inputs are already cut to one line.

4. **Trace the flow in code.** Follow the path the event takes to the screen. Start from the backend event, then the session store, then the render. Likely places: `apps/desktop/src/lib/chat/content/`, `apps/desktop/src/lib/chat/session/`, `apps/desktop/src/lib/chat/runs/`, `apps/desktop/src/lib/components/chat/`, and `apps/desktop/src-tauri/src/` for the Rust side. Read the code. Record each step as `file:line — what it does`.

5. **State the cause only with evidence.** If a line in the code and a line in the log explain the symptom, write it as the suspected cause with both references. If not, write `Cause: not found yet` and list what was ruled out and what would settle it. Do not guess.

6. **Write the report** to `docs/bugs/YYYY-MM-DD-<short-slug>.md` (today's date, lowercase slug, 3–6 words). Create `docs/bugs/` if missing. Use this structure:

    ```
    # <Title>

    - Status: open
    - Date: YYYY-MM-DD
    - Agent / model:
    - Chat id (from log):
    - Log files used:

    ## Symptom
    What the user saw. Expected result.

    ## Steps to reproduce
    1. ...

    ## Flow (how it gets to the screen)
    1. `file:line` — step
    2. ...

    ## Log evidence
    ```

    <trimmed lines>
    ```

    ## Suspected cause

    <cause with file:line evidence, or "Cause: not found yet" + what was ruled out and what would settle it>

    ## Fix hints for the next session
    - Files likely to change:
    - Check to add after the fix:

    ```

    ```

7. **Report.** Give the report path as a clickable link, the status (`Cause: found` or `not found yet`), and one line on the next step: hand the file to an AI with `Fix the bug in docs/bugs/<file>`. Do not add anything else.
