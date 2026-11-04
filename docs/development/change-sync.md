# Đồng bộ thay đổi giữa các run

Một chat có thể có nhiều run cùng lúc: lane chính, lane listener, worker của `delegate_task`, sub-agent của CLI. Tất cả
cùng làm việc trên một project. Tài liệu này mô tả cách AgentDeck giữ các run không ghi đè lên nhau một cách im lặng.
Plan đầy đủ: [plan.md](../../plan.md).

## Các phần

| File                                                          | Vai trò                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/desktop/src/lib/chat/runs/change-ledger.ts`             | Logic thuần: ghi, kiểm tra xung đột, đường dẫn. Có test node.                    |
| `apps/desktop/src/lib/chat/runs/change-ledger.svelte.ts`      | State: `ledgerWrites`, `ledgerReads`, `ledgerConflicts`, hook lưu file của user. |
| `apps/desktop/src/lib/chat/runs/notices.ts`                   | Nội dung các thông báo gửi giữa run.                                             |
| `apps/desktop/src/lib/chat/runs/notices.svelte.ts`            | Hàng chờ thông báo theo chat, `notifyRun`.                                       |
| `apps/desktop/src/lib/chat/session/events.svelte.ts`          | Nơi nối: `noteRunFiles`, `tellRunsOnFile`, `queueWorkerChanges`.                 |
| `apps/desktop/src/lib/chat/runs/restore.ts`                   | Khôi phục bản bị ghi đè.                                                         |
| `apps/desktop/src/lib/components/chat/LedgerConflicts.svelte` | Card cảnh báo trên composer.                                                     |
| `apps/desktop/src-tauri/src/agent_runs.rs`                    | `agent_notify`: gửi thông báo vào turn đang chạy.                                |

## Quy tắc

- **Ledger** ghi mọi lần ghi file có `change` (tool_call/tool_result), lần đọc file của tool đọc, và lần lưu của user.
- **Xung đột**: ghi đè lên thay đổi của một yêu cầu _mới hơn_ (`intentAt` lớn hơn) là xung đột. `kind=revert` nếu nội dung
  mới bằng nội dung trước thay đổi kia, ngược lại `overwrite`.
- **Thông báo** được gửi khi: user nhắn một side run; một file đổi và run khác đã đọc/ghi file đó; worker xong (parent nhận
  danh sách file); worker có `depends_on` (prompt có danh sách file của dependency); user lưu file trong editor.
- **Giữa turn** thông báo đi qua `agent_notify` (chỉ khi chat có đúng một run). Không được thì giữ trong hàng chờ và chèn vào
  prompt của lượt kế tiếp.
- **Nhả lane** cho việc nền: chỉ dev server (`browser_serve`) nhả ngay; shell chạy quá `SHELL_WAIT_MS` (20 giây) cũng nhả.

## Giới hạn

- CLI tự ghi file, AgentDeck không chặn trước được; chỉ báo trước và phát hiện sau.
- Sub-agent của Codex (`spawnAgent`) chưa nhận thông báo trực tiếp; `AutoTurn` của Claude chưa có đường deliver riêng.
- Đọc file qua lệnh shell tuỳ ý không được ghi nhận.
- Ledger chỉ sống trong phiên app; `after` tối đa 200 000 ký tự.

## Gỡ lỗi

Flow log (`%APPDATA%\dev.agentdeck.desktop*\logs\debug.log`) có các dòng: `ledger write`, `conflict`, `notify`
(`via=steer|queued`), `deliver` (lý do nhả lane).
