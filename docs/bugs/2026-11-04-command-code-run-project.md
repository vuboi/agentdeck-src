# Bug — "chạy project" trên provider Command Code: server chạy nhưng chat không báo kết quả, chat bị khoá/queue

- Ngày: 2026-11-04
- Provider gặp lỗi: `command-code` (Command Code CLI) — `crates/adapters/src/agent/commandcode.rs`
- Dự án thử: msg-new-template (Angular 20 / Nx / pnpm), lệnh `pnpm start:msg-connect`
- Ảnh hưởng: mọi chat chạy trên provider Command Code (và cùng nguyên nhân với `workbuddy`)

---

## 1. Triệu chứng

1. User nhắn "chạy project". Agent — vốn chạy trên provider Command Code — khởi động dev server bằng tool shell của chính nó (`pnpm start:msg-connect`, chạy nền) thay vì `browser_serve`.
2. Sau đó chat **không báo gì thêm**: không có dòng "server đã chạy OK" hay lỗi, cũng không có card/tray "Work" hay "Run project" cho tiến trình đó. User tưởng app treo ("chạy xong rồi sao treo luôn vậy").
3. Trong lúc lượt chạy còn sống, user chỉ gửi được khoảng 1 tin; các tin sau **bị đẩy vào queue**, không tới agent cho tới khi lượt chạy kết thúc ("chỉ cho chat được 1 câu rồi lại đá vào queue").
4. Agent **không có** các tool AgentDeck MCP trong phiên: `browser_serve`, `browser_open`, `browser_screenshot`, `browser_console`, `browser_network` — dù chúng là các tool mà hint `AGENTDECK_HINT` bảo phải dùng.

Kỳ vọng: agent gọi `browser_serve`, server do AgentDeck quản lý (sống qua lượt chạy), Preview mở, và **kết quả start (thành công/lỗi kèm log) được ghi thẳng vào chat content**.

---

## 2. Tái hiện

1. Trong AgentDeck, mở chat mới với provider **Command Code** cho một project có dev server (ví dụ msg-new-template).
2. Nhắn: `chạy project`.
3. Quan sát:
    - Agent gọi tool `shell_command` (hiển thị dưới tên `Bash`) với `run_in_background: true`, KHÔNG gọi `browser_serve`.
    - Sau tool call đó, chat không có thêm dòng phản hồi / không có mục Work nào xuất hiện.
4. Trong lúc chờ, gửi liên tiếp 2-3 tin ngắn → các tin vào queue (thấy dải "queue" trên composer), không được xử lý cho tới khi lượt chạy kết thúc.
5. Đối chiếu: chat chạy trên provider **claude** cùng kịch bản → agent gọi được `browser_serve`, có mục Work, và gửi thêm tin trong lúc chờ được đưa sang lane listener.

---

## 3. Nguyên nhân

### RC1 — Provider `command-code` không được cấp MCP bridge của AgentDeck (nguyên nhân gốc)

AgentDeck tự host MCP browser server ở `/mcp` và bơm vào CLI của từng provider. Chỉ một số provider được bơm:

- `crates/adapters/src/agent/claude.rs:112-142` — `--mcp-config` (inline `mcpServers`, HTTP) + `allowed_tools.push("mcp__agentdeck")`.
- `crates/adapters/src/agent/codex.rs:360-370` — TOML `mcp_servers.agentdeck.url`.
- `crates/adapters/src/agent/codex_server.rs:42` — tương tự codex.
- `crates/adapters/src/agent/opencode.rs:445-447` — `config["mcp"] = { agentdeck: { type: "remote", url } }`.
- Antigravity — liên kết/auto (`agy_auto`, `agy_link` trong `mcp_manage.rs`).

`commandcode.rs` **không có một tham chiếu `mcp` nào**: `args()` (dòng 42) dựng `-p --output-format json --trust --skip-onboarding --no-auto-update [--session --model --effort --permission-mode]`, không có MCP config, không nhận `AGENTDECK_BRIDGE`. Vì vậy CLI Command Code không biết server `agentdeck`, agent không có tool `mcp__agentdeck__browser_*` → buộc phải tự chạy server bằng shell riêng.

Điều này đã được ghi nhận trong code frontend: `apps/desktop/src/lib/chat/session/turns.svelte.ts:83-88`

```
/** Agents whose CLI is not given AgentDeck's MCP bridge (crates/adapters: claude, codex, opencode write it): delegate_task and
 *  list_agents do not exist for them, so the delegation notes and task routing are not sent to them at all. */
export const NO_DELEGATE_TOOLS = new SvelteSet<Agent>([
    'command-code',
    'workbuddy',
]);
```

Lưu ý: biến môi trường bridge là **toàn cục** (`apps/desktop/src-tauri/src/bridge.rs:281` `std::env::set_var("AGENTDECK_BRIDGE", &bridge_url)`), nên provider nào cũng đọc được — chỉ là `commandcode.rs` chưa đọc/dùng.

### RC2 — Event tool của Command Code luôn bị đánh dấu `background: false`

`crates/adapters/src/agent/commandcode.rs:156-177` — `tool_call()` dựng `AgentEvent::ToolCall { ..., background: false }` **cứng**, không đọc cờ background từ event của CLI. Nên dù Command Code chạy shell nền, AgentDeck vẫn coi đó là tool call đồng bộ thường.

### RC3 — Tray "Work" bỏ qua mọi thứ không phải background / "Run project" / `browser_serve`

`apps/desktop/src/lib/chat/runs/chat-work.ts:93-95` trong `projectChatWork()`:

```
(!event.background &&
    event.name !== 'Run project' &&
    !isLongRunningWork(event.name)) || ...
    continue;
```

Và `apps/desktop/src/lib/chat/runs/run-lanes.ts:26-27`:

```
export function isLongRunningWork(name: string): boolean {
    return SERVE_TOOL.test(name);   // SERVE_TOOL = /(?:^|[._/:]|__)browser_serve$/i  (dòng 15)
}
```

`canonical_tool()` trong `commandcode.rs` map `shell_command`/`powershell` → `Bash`, nên tên không khớp `browser_serve`; `background` lại là `false` (RC2) → **tiến trình dev server không bao giờ xuất hiện trong tray Work**, và không có dòng "server đã chạy / lỗi" nào được đẩy vào chat content.

### RC4 — `deliveryFor()` mặc định trả `queue` khi còn lane đang chạy

`run-lanes.ts:41-57` — chỉ khi lane chính đang `waiting` **và** `backgroundWork === true` thì mới route tin nhắn sang lane `listener`; mọi trường hợp khác trả `queue`. Vì Command Code background shell không thoả (`isLongRunningWork` chỉ nhận `browser_serve`; `isBackgroundWait` ở dòng 59 chỉ nhận `delegate_task`/`wait*`), lane ở trạng thái running → tin nhắn mới bị xếp queue.

### RC5 — `canSendWhileWaiting()` khoá cứng vào `claude`

`apps/desktop/src/lib/chat/session/send-while-waiting.ts:20-29`:

```
export function canSendWhileWaiting(state: WaitState): boolean {
    return (
        state.agent === 'claude' &&
        state.whileRunning === 'queue' &&
        state.backgroundWorkOpen &&
        !state.foregroundTurn &&
        !state.streamingText &&
        !state.needsUserInput
    );
}
```

Điều kiện `state.agent === 'claude'` khiến **mọi provider khác** (`command-code`, `codex`, `opencode`, `antigravity`, `workbuddy`) không bao giờ gửi được tin trong lúc chờ background work → luôn rơi vào queue (khớp triệu chứng 3).
---

## 4. Hướng sửa (đề xuất cho AI sửa code)

1. **Bơm MCP bridge cho `commandcode.rs`** (fix RC1). Command Code đọc MCP từ file config, schema `{"mcpServers": { "<name>": {...} }}`, 3 scope:
    - `local` → `~/.commandcode/projects/<slug>/mcp.json`
    - `project` → `.mcp.json` ở project root
    - `user` → `~/.commandcode/mcp.json`
      Tool xuất hiện dưới tên `mcp__<server>__<tool>`.
      Cần thêm server tên `agentdeck`, transport `http`, `url = super::mcp_url(&bridge, req.owner, req.cwd)`, đọc từ `AGENTDECK_BRIDGE` — theo đúng mẫu `opencode.rs:445-447`.
    - **Cần xác nhận**: tài liệu headless của Command Code (bundled `reference/headless.md`) **không liệt kê** cờ kiểu `--mcp-config`; các cờ cấu hình đi qua `--config key=value`. Nên nhiều khả năng phải ghi file config (hoặc `cmd mcp add-json`) thay vì truyền inline. Vì URL bridge là **per-chat** (`/mcp?chat=<id>&root=<folder>`) nên ghi vào scope `user`/`local` có rủi ro race giữa nhiều chat → ưu tiên scope `local` (theo project) hoặc xác nhận có cách truyền theo tiến trình.
    - Sau khi bơm được, bỏ `'command-code'` khỏi `NO_DELEGATE_TOOLS` (`turns.svelte.ts:85-88`) để hint delegate_task hoạt động lại.
2. **Đọc cờ background thật** trong `commandcode.rs` `tool_call()` (fix RC2) thay vì hardcode `background: false` — nếu event của CLI có trường background/job id thì truyền vào `AgentEvent::ToolCall`.
3. **Mở rộng nhận diện long-running** (fix RC3/RC4): thêm tên tool shell nền của Command Code vào `isLongRunningWork`/`SHELL_TOOL` (`run-lanes.ts:13-27`), hoặc coi `event.background === true` là đủ điều kiện cho tray và cho `backgroundWork` của lane.
4. **Bỏ ràng buộc `claude`** trong `send-while-waiting.ts:22` (fix RC5) — chỉ cần `backgroundWorkOpen && !foregroundTurn && !streamingText && !needsUserInput`.
5. **Đảm bảo kết quả start được ghi vào chat**: khi một tool call được xác định là "start server" (background/long-running), đẩy kết quả (`ok`/lỗi + log) thành nội dung chat, không chỉ là ToolResult card ẩn trong tray.

---

## 5. Trả lời câu hỏi: "Using shell_output là tiến trình nền hay không?"

- Trong phiên chat này, `shell_command` với `run_in_background: true` **là** tiến trình nền: nó trả về ngay một task id + file log, và `shell_output` chỉ đọc output của task đó (không tự chạy gì thêm).
- Vấn đề không nằm ở việc tool có phải background hay không, mà ở chỗ AgentDeck coi nó như một tool call thường: lane của lượt chạy vẫn `running`, nên tin nhắn mới bị xếp queue (RC4 + RC5) và tiến trình không hiện trong tray Work (RC2 + RC3). Sửa 4 hướng ở mục 4 thì chat sẽ rảnh tay trong lúc server chạy nền.

---

## 6. Phụ lục — vị trí code liên quan

| File                                                          | Dòng                                              | Vai trò                                                              |
| ------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `crates/adapters/src/agent/commandcode.rs`                    | 42 `args()`, 156-177 `tool_call()`                | Thiếu MCP config; `background: false` cứng                           |
| `crates/adapters/src/agent/claude.rs`                         | 106-157 `sdk_args()`                              | Mẫu bơm `mcpServers` + `mcp__agentdeck`                              |
| `crates/adapters/src/agent/codex.rs`                          | 360-370                                           | Mẫu bơm TOML `mcp_servers.agentdeck.url`                             |
| `crates/adapters/src/agent/opencode.rs`                       | 445-447                                           | Mẫu bơm `config["mcp"]`                                              |
| `crates/adapters/src/agent/mod.rs`                            | 139-166 `mcp_url()`                               | URL `/mcp?chat=&root=`                                               |
| `apps/desktop/src-tauri/src/bridge.rs`                        | 259-281                                           | Đặt `AGENTDECK_BRIDGE` (toàn cục)                                    |
| `apps/desktop/src/lib/chat/session/turns.svelte.ts`           | 70-71 `AGENTDECK_HINT`, 83-88 `NO_DELEGATE_TOOLS` | Hint vô hiệu với command-code; danh sách provider không có bridge    |
| `apps/desktop/src/lib/chat/runs/run-lanes.ts`                 | 13-27, 41-57, 59-80                               | `SHELL_TOOL`, `isLongRunningWork`, `deliveryFor`, `isBackgroundWait` |
| `apps/desktop/src/lib/chat/runs/chat-work.ts`                 | 88-100                                            | `projectChatWork()` lọc event cho tray Work                          |
| `apps/desktop/src/lib/chat/session/send-while-waiting.ts`     | 20-29                                             | `canSendWhileWaiting()` khoá `agent === 'claude'`                    |
| `apps/desktop/src/lib/components/chat/BackgroundTasks.svelte` | —                                                 | Tray "Work" hiển thị background task                                 |
| Tài liệu Command Code (bundled với CLI)                       | `reference/mcp.md`, `reference/headless.md`       | Schema `mcpServers`, scope config, tên tool `mcp__<server>__<tool>`  |

---

## 7. Bổ sung từ transcript chat `cbf2d018` (đối chiếu file hội thoại)

Nguồn: `C:\Users\boi.vn\AppData\Roaming\dev.agentdeck.desktop\conversations\ch-y-project-claude-cbf2d018-147e-46cb-a5fe-48a89d8c3213.md`

1. **Agent tự chặn lượt của chính nó.** Sau `shell_command` (`run_in_background`), agent gọi `shell_output` với `"wait":"output"` và `timeout_ms` 90–180 s (dòng ~1014, 1172, 2393). Dev server không bao giờ kết thúc, nên lượt chờ hết timeout rồi mới đến lượt kế. Trong lúc đó lane vẫn `running`, tin của user vào queue.
2. **Tác vụ nền bị mất.** `shell_tasks` trả `No tracked shell or monitor tasks` (dòng ~1189), `shell_output` trả `no background process found with id "s0czo1w9"` (dòng ~2286). Agent không đọc được output, không biết server lên hay lỗi, nên không báo kết quả lên chat.
3. **Quyền shell.** `shell_command` bị từ chối `requires permissions. Use --yolo`; agent chuyển sang tool `powershell` (dòng ~1772, ~2259).
4. **Hỏi đáp bị quên.** Agent chưa từng hỏi user; khi lượt bị thay bằng tin queue (09:23:15, 09:26:40), block `agentdeck-ask` không được mở card (xem `2026-11-04-ask-card-not-opened.md`).
5. **Cơ chế MCP đã xác minh cho Command Code.** Command Code đọc `mcpServers` từ `.mcp.json` ở project root (ví dụ `E:\WORK\PROJECTS\msg-new-template\.mcp.json` có `codegraph`, `serena`, `agentation`). Cờ inline hoặc `--config` vẫn chưa xác minh (CLI không cài trên máy đang đọc).

### Hướng sửa bổ sung

- Với `shell_output` có `wait`, coi là tác vụ dài: không để lane `running` vô hạn (timeout phía AgentDeck, hoặc không tính là lượt đang chạy).
- Tin queue lúc có background work không được thay lượt đang chạy khi provider không có listener (`armShellWait` → `sendNextQueued`, `events.svelte.ts:1640-1654`).
- Kết quả start server (thành công/lỗi + log) phải được ghi vào chat content, không phụ thuộc agent đọc được `shell_output`.
- MCP cho Command Code: ghi `.mcp.json` vào project root (có rủi ro race giữa nhiều chat và ghi vào repo của user) — cần quyết định.
