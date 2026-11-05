# Plan: xem sub-agent / background task / delegate cạnh chat chính

## Mục tiêu

Khi chat chính có sub-agent, background task hoặc delegate task đang chạy, người dùng mở được
transcript sống của child ngay bên cạnh chat chính (dock trái/phải, float, hoặc grid nhiều agent)
thay vì phải rời chat chính (`showSession(childId)` hiện thay luôn chat đang xem).

Tham chiếu UX: ảnh Codex — panel "Subagents" bên phải, có nút back, header agent + model,
nội dung là transcript chat bình thường.

## Hiện trạng (đã kiểm tra trong code)

- Native sub-agent (Claude `Task`/`Agent`, Codex `spawnAgent`, OpenCode, Antigravity):
  adapter phát `AgentEvent::Scoped{parent,event}` và `Task{...}`
  (`crates/adapters/src/agent/mod.rs:100-118`). Frontend gom vào `CommandBlock.children`
  của tool call cha (`apps/desktop/src/lib/chat/agent-reply.ts:373-395`), vẽ inline trong
  `CommandGroup.svelte:641-830`. Không có session riêng.
- Claude history bỏ qua `agent-*.jsonl` (`crates/adapters/src/history/claude.rs:4`) nên
  transcript sub-agent mất sau reload.
- Delegate task: mỗi task là child chat thật (`childId`), store `delegateTasks`
  (`apps/desktop/src/lib/chat/session/delegate-task.svelte.ts:138`).
- Danh sách việc nền theo chat: `chatWork(sessionId)`
  (`apps/desktop/src/lib/chat/session/work.svelte.ts:49`), type `ChatWork`
  (`chat/runs/chat-work.ts:15`, có `childId` optional). Hiển thị ở tray
  `BackgroundTasks.svelte` trên composer.
- `Chat.svelte` không nhận `sessionId`; đọc `workspace.activeId` khắp nơi.
- Layout: dock zone / floating chỉ chứa tên tool trong `TOOLS`
  (`chat/content/tools.ts:6`, `app/ui/layout.svelte.ts:19`). Chưa có pane chat thứ hai, chưa có grid.
- Vùng icon: `components/layout/ToolbarActions.svelte:77-137`.

## Thiết kế

### 1. Một nguồn dữ liệu "agent con" thống nhất

Thêm `apps/desktop/src/lib/chat/runs/child-agents.svelte.ts`:

```ts
type ChildAgent = {
  key: string;              // `${parentId}:${callId}` hoặc `session:${childId}`
  parentId: string;         // chat cha
  kind: 'subagent' | 'background' | 'delegate';
  provider?: string;        // cho AgentLogo
  model?: string;
  label: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  source:
    | { type: 'session'; sessionId: string }               // delegate, fork, /btw
    | { type: 'call'; messageId: string; callId: string }; // native sub-agent, bg shell
};
childAgents(parentId): ChildAgent[]   // $derived từ chatWork + delegateTasks + message blocks
```

Dựng từ dữ liệu sẵn có (`chatWork`, `delegateTasks`, `CommandBlock.task/children`),
không thêm event mới ở Rust ở pha đầu.

### 2. `TranscriptView` theo id (read-only, live)

Thêm `components/chat/TranscriptView.svelte` nhận `source`:

- `session`: render `messagesOf(sessionId)` bằng chính `ChatBlock`/`CommandGroup` đang dùng,
  có composer gọn tùy chọn (gửi follow-up cho delegate child) — pha 3.
- `call`: tìm `CommandBlock` theo `messageId`+`callId`, render `children` như một transcript
  (tái dùng renderer của `CommandGroup` cho từng step), auto-scroll khi đang chạy.

Không refactor `Chat.svelte` thành đa-session ở pha này (rủi ro lớn vì phụ thuộc
`workspace.activeId`). Header: `AgentLogo` + label + model + trạng thái + nút Stop
(`stopTarget`) + "Mở full" (`showSession` cho loại session).

### 3. Tool mới "Agents" trong hệ thống dock sẵn có

Thêm tool `agents` vào `TOOLS` → tự có dock trái/phải/dưới, float (`ToolsModal`),
kéo-thả, nhớ kích thước qua `layout` store. Không xây hệ layout mới.

Nội dung tool `AgentsPanel.svelte`, 3 chế độ (lưu trong `layout`/localStorage per-viewer):

- **List**: danh sách `childAgents(activeId)` (icon `AgentLogo`, label, trạng thái, thời gian).
  Click → chế độ Single. Giống màn danh sách trong ảnh Codex.
- **Single**: một `TranscriptView`, nút back về List, tab/chọn agent khác qua `PickerPopover`.
- **Grid**: 2–4 `TranscriptView` cùng lúc (CSS grid 1×2 / 2×2 theo bề rộng pane),
  mỗi ô có header riêng; click header → Single.
- Split = dock tool `agents` sang trái/phải chat chính (đã có `Splitter`), không cần mode riêng.

### 4. Icon trên toolbar

Trong `ToolbarActions.svelte`, thêm nút icon "agents" chỉ hiện khi
`childAgents(activeId).length > 0`; số đang chạy hiển thị bằng chữ nhỏ cạnh icon
(không badge màu). Click → mở/đóng tool `agents` (trigger dùng `TRIGGER_ON` khi panel mở).
Bên trong `BackgroundTasks.svelte` và task row `CommandGroup`, thêm hành động
"Xem bên cạnh" → mở tool `agents` ở Single với agent đó, thay vì `showSession` thay chat chính.

### 5. Giữ transcript sub-agent sau reload (pha 4)

Claude: đọc `agent-*.jsonl` trong history và gắn vào `CommandBlock.children` theo
`parent_tool_use_id` thay vì bỏ qua. Provider khác: kiểm tra từng adapter có lưu child hay không,
ghi rõ trong `docs/development/adding-agent-provider.md`.

## Các pha

| Pha | Việc                                                                                       | File chính                                                                                              |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | `child-agents.svelte.ts` + `TranscriptView` (call + session, read-only) + unit test derive | `chat/runs/`, `components/chat/`                                                                        |
| 2   | Tool `agents` (List/Single/Grid) + icon toolbar + "Xem bên cạnh" từ tray/task row          | `tools.ts`, `ToolView.svelte`, `ToolbarActions.svelte`, `BackgroundTasks.svelte`, `CommandGroup.svelte` |
| 3   | Composer gọn trong Single cho delegate child (follow-up, answer `task_ask`)                | `TranscriptView.svelte`, `delegate-task.svelte.ts`                                                      |
| 4   | Load lại transcript sub-agent từ history (Claude trước)                                    | `crates/adapters/src/history/claude.rs`                                                                 |

Mỗi pha một commit, dừng review giữa các pha.

## Kiểm tra (DoD)

- `pnpm check` (svelte-check 0 lỗi), unit test cho `childAgents` (native call, background shell,
  delegate child, trạng thái done/failed).
- Pha 4: `cargo test -p adapters` + `cargo clippy --workspace -- -D warnings`.
- Chạy app thật: chat Claude gọi 2 sub-agent + 1 bash nền + 1 `delegate_task`; xác nhận icon hiện,
  List đủ 4 mục, Single cập nhật live, Grid 2×2, dock trái/phải/float đều chạy; screenshot so với
  panel tool hiện có.

## Câu hỏi mở

1. Grid tối đa 4 ô có đủ không?
2. Pha 3 (gửi tin cho child từ panel) có cần không, hay chỉ xem?
3. Khi chuyển chat chính, panel theo chat mới (mặc định) hay giữ agent đang xem?
