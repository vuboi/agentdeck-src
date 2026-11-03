# plan_wait_send: chờ task nền — nhãn đúng, gửi tin không bị queue, logo sub-agent

Ngày: 2026-11-03. Base: `main`. Người làm: Haiku 5.5. Quy tắc làm việc và lệnh kiểm tra: như `docs/plans/plan_fix.md` mục 0 và `docs/plans/plan_next.md` phần đầu. Mỗi nhóm W là một nhánh `wait/w<k>-<tên>`, có worktree riêng, test tái hiện trước, merge `--no-ff` vào `main`.

## Hiện trạng (đã đọc code)

Tình huống thật: chat Claude (Haiku). Người dùng nhờ Codex tìm hiểu một việc. Haiku gọi tool `Agent` của Claude Code với `subagent_type: "codex:codex-rescue"` (agent của plugin codex, chạy `node .../codex-companion.mjs`) ở chế độ nền, rồi trả lời và kết thúc lượt.

1. Khi job nền của Claude kết thúc, Claude CLI tự mở một lượt mới. AgentDeck tạo lượt tự động "Task result · …" (`apps/desktop/src/lib/chat/session/events.svelte.ts` `beginAutoTurn`, ~:1199) với lane `role: 'primary'` (trừ khi đã có lượt foreground).
2. Trong lượt đó, CLI ngồi chờ agent `codex-rescue` còn chạy. Không có event nên `liveState(message.blocks)` (`chat/content/blocks.ts`, dùng ở `components/chat/LiveStatus.svelte`) hiện mặc định **"Thinking"**, sai bản chất.
3. Vì có lane `primary` đang chạy, tin mới của người dùng bị đưa vào queue (`chat/session/sending.svelte.ts` `send`).
4. Rust đã có đường gửi thêm tin:
    - `agent_inject` (`apps/desktop/src-tauri/src/agent_runs.rs:535`) → `ag_adapters::agent::warm::inject` (`crates/adapters/src/agent/warm.rs:100`);
    - frontend `injectAgentMessage` (`src/lib/chat/agent.ts:527`) **không có chỗ nào gọi**.

    Với Claude, `agent_inject` luôn trả `false`:
    - `can_inject_as_distinct_reply()` (`crates/adapters/src/agent/mod.rs:410`) chỉ đúng với `NativeSteer { PerMessage }`, còn Claude là `NativeSteer { MergedIntoActive }` (`mod.rs:~346`);
    - inbox (`InjectSlot::open`, `warm.rs:~604`) chỉ mở trong lượt warm, không mở trong tail.

5. Lượt mới gửi trong lúc tail sẽ gọi `tail::stop` (`warm.rs:~597`), và hàm này đợi câu trả lời đang dở xong rồi mới lấy lại tiến trình. Nghĩa là Rust đã có cơ chế "đợi rồi gửi"; queue ở frontend chỉ làm việc đó hiển thị khác đi.
6. Logo: card "Subagent & background activity" và Work tray hiện icon robot và "Claude · Haiku 5.5", vì đây là sub-agent của Claude. Không có code nào đọc `subagent_type`.

---

## W1. Nhãn "đang chờ task nền" thay vì "Thinking"

1. Hàm thuần mới trong `chat/content/blocks.ts`:

    ```ts
    export function waitingLabel(
        blocks: Block[],
        open: { name: string }[],
    ): string | null;
    ```

    Trả `"Waiting for 1 background task · codex:codex-rescue"` (hoặc `"Waiting for N background tasks"`) khi:
    - câu trả lời chưa có block nào đang stream, hoặc block cuối đã xong;
    - và `open.length > 0`.

    Các trường hợp khác trả `null`.

2. Nguồn `open`: các mục `activity` (`chat/runs/activity.svelte.ts`) của chat đó có `background === true` và chưa kết thúc (dùng `endedByTask`/status hiện có, xem `chat/runs/activity-status.ts`). Tên lấy theo thứ tự: `subagent_type`, rồi `description`, rồi tên tool. Tham khảo cách `AgentActivityCards.svelte` đọc dữ liệu.
3. `LiveStatus.svelte`: nếu `waitingLabel` khác `null` thì dùng nhãn đó, spinner `LOADER.thinking` hoặc loader chờ sẵn có. Không ghi state trong `$derived`: chỉ đọc `activity`.
4. Test (`blocks.test.ts` hoặc `tests/`):
    - không block, 1 task mở → nhãn đúng có tên;
    - 2 task → số nhiều;
    - đang stream text → `null`;
    - không task mở → `null`.

## W2. Logo provider cho sub-agent của plugin (làm được thì làm, không thì bỏ và ghi lý do)

1. Hàm thuần `providerOfSubagent(type: string | undefined): Agent | null` (đặt cạnh `chat/content/tool-kind.ts`):
    - lấy namespace trước `:`, hoặc chính chuỗi nếu không có `:`;
    - khớp với id provider đã đăng ký (`agents/provider-registry.ts`: `codex`, `antigravity`/`gemini`, `opencode`, `copilot`…);
    - không khớp → `null`.
2. Chỗ đọc `subagent_type`: input của tool `Agent`/`Task` (block command, ví dụ `Agent  {"description":"…","subagent_type":"codex:codex-rescue"}`, xem `chat/mock.ts:392`). Dùng `argsOfCall`/parser JSON sẵn có, không viết parser mới.
3. Hiển thị:
    - `AgentActivityCards.svelte` và hàng Work tray (`components/chat/BackgroundTasks.svelte` hoặc chỗ render "Work"): nếu `providerOfSubagent` khác `null` thì dùng `AgentLogo agent=<provider>`, nhãn `"<Provider> · via Claude"`.
    - Giữ tên `subagent_type` ở dòng phụ.
4. Test:
    - `codex:codex-rescue` → `codex`;
    - `explore` → `null`;
    - `gemini:x` → provider gemini nếu có trong registry, không thì `null`;
    - thiếu input → `null`.

## W3. Gửi tin trong lúc chỉ đang chờ task nền (Claude)

Mục tiêu: khi chat Claude chỉ đang chờ (lượt tự động hoặc tail không có output, không có quyền/câu hỏi đang chờ), tin của người dùng **được gửi ngay**, không vào queue. Câu trả lời gắn với tin đó. Provider khác giữ nguyên queue.

### Bước 0 — Spike (bắt buộc trước khi code, ghi kết quả vào Báo cáo)

Kiểm chứng hành vi thật của Claude CLI chế độ SDK streaming (runner `apps/desktop/src/agent/claude-sdk-runner.mjs`, cờ `--replay-user-messages`). Cách làm: test thủ công hoặc script node trong scratchpad, gọi runner `--warm`:

1. Gửi một prompt bắt Claude chạy một lệnh nền dài (ví dụ `Bash` `sleep 60` với `run_in_background`).
2. Sau khi có `result`, trong lúc lệnh nền còn chạy, ghi tiếp một user message vào stdin.
3. Ghi lại: Claude có trả lời ngay không, hay đợi lệnh nền xong? Có event replay của user message không? Thứ tự event ra sao (`assistant`, `result`, task notification)?

Nếu Claude **không** trả lời ngay mà chỉ đợi: bỏ bước 1–3. Chỉ làm bước 4 (UI rõ ràng hơn) và ghi lý do.

### Bước 1 — Rust: inbox trong tail cho Claude

- `crates/adapters/src/agent/tail.rs`: khi tail giữ tiến trình Claude, mở `InjectSlot::open(&chat)`. Tin nhận được ghi vào stdin của tiến trình bằng `provider.warm_message(text)`.
- `inject` trả `true` chỉ khi đã ghi được.
- Khi tail kết thúc hoặc bị `tail::stop`, slot đóng (Drop).
- Capability: thêm cờ cho Claude, ví dụ `background: BackgroundBehavior::TailAutoTurn` kèm `tail_accepts_input: true`, hoặc hàm `ChatResponseCapabilities::accepts_input_while_waiting()`. Không đổi `can_inject_as_distinct_reply` cho lượt foreground.
- Test Rust: Fake CLI `sh` (theo kiểu test có sẵn trong `tail.rs`) ở trạng thái tail; `inject` → dòng xuất hiện trong stdin của fake; sau `tail::stop` thì `inject` trả `false`.

### Bước 2 — Lệnh Tauri

- `agent_runs.rs` `agent_inject`: cho phép khi chat **không có run foreground** và tail của chat đang mở inbox. Lệnh mới tách biệt, ví dụ `agent_send_while_waiting(session, text) -> bool`, để không đổi hành vi cũ.
- Đăng ký trong `generate_handler!`. Commit file permission autogenerated của lệnh mới (chỉ file đó).

### Bước 3 — Frontend

1. Hàm thuần `canSendWhileWaiting(state)`, nhận `{ agent, lanes, needsUserInput, streamingOutput, autoTurn }`. Trả `true` khi tất cả đều đúng:
    - agent là `claude`;
    - lane đang chạy duy nhất là lượt tự động (`autoTurn`) hoặc chỉ có task nền;
    - không có quyền/câu hỏi đang chờ;
    - không có text đang stream trong 2 giây gần nhất.
2. `sending.svelte.ts` `send`: nếu `canSendWhileWaiting` thì gọi lệnh ở bước 2.
    - Trả `true`:
        - thêm tin người dùng vào chat;
        - đóng câu trả lời tự động hiện tại (đánh dấu xong, giữ nội dung);
        - tạo câu trả lời mới gắn với tin người dùng;
        - các event tiếp theo của CLI đi vào câu trả lời mới. Khi có event replay user message (`--replay-user-messages`), dùng nó làm mốc tách.
    - Trả `false` → queue như cũ.
3. Không làm cho provider khác.

### Bước 4 — UI khi vẫn phải queue

- Khi tin bị queue vì chat chỉ đang chờ task nền, dòng queue ghi `"Sends when the background task reports"`, không ghi "queued" chung chung.
- Nút **Send now** giữ hành vi hiện có (`steerQueued`: dừng câu trả lời đang chạy và gửi ngay).

### Test bước 3

- `canSendWhileWaiting`: mỗi điều kiện có 1 test (agent khác, có quyền chờ, đang stream, có lane foreground).
- Loader (`tests/support/load-session.mjs`) với stub lệnh trả `true`: `send` không tạo queue, có tin người dùng, có câu trả lời mới; trả `false`: có queue.

---

## Thứ tự

W1 → W2 → W3 (bước 0 trước). Mỗi nhóm merge riêng. W3 bước 1–3 chỉ làm nếu spike xác nhận Claude trả lời ngay khi đang chờ task nền.

## Kiểm tra cuối

svelte-check, eslint (file sửa), `check-derived-writes --strict`, node tests (tất cả). Có Rust: `clippy --workspace --all-targets -D warnings`, `test -p agentdeck-desktop`, rồi `test -p ag-adapters` riêng. Tắt app dev trước khi build Rust (`os error 32`), xong thì mở lại.

## Báo cáo (người làm điền)

- W1:
- W2:
- W3 spike:
- W3:
- Kiểm tra cuối:
