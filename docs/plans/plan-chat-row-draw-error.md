# Plan: lỗi "This message could not be drawn" lặp lại ở mọi chat

Ngày: 2026-11-02. Trạng thái: đề xuất, chưa code.
Liên quan: `docs/plans/plan-fix-structure.md` mục "Sự cố khẩn"; `docs/plans/chat-history-mapping/plan-remaining.md` mục 4–5.

## 0. Hiện trạng (đã kiểm tra)

- Thông báo nằm ở `apps/desktop/src/lib/components/chat/Chat.svelte:1036`, trong `{#snippet failed()}` của `<svelte:boundary>` (dòng 927). Mỗi dòng chat bọc trong một boundary; lỗi vẽ một dòng thì chỉ dòng đó hiện thông báo.
- Boundary có `onerror` ghi `logError('app', 'chat row failed to draw', message + 3 dòng stack, {chat, row})`.
- Nguyên nhân đã biết và đã sửa: `messagesOf()` ghi state trong `$derived` (`state_unsafe_mutation`). Commit `21cdfb2` thêm `messagesView()` và đổi `pendingInput`, `openQuestions`, `contextReply` trong `Composer.svelte` sang accessor chỉ đọc. Kiểm tra: `Composer.svelte` hết gọi `messagesOf` trong derived.
- Lỗi cuối cùng trong `errors.log` (`state_unsafe_mutation`, 12:40Z) xảy ra trước `21cdfb2` (15:15Z). Nghĩa là **chưa có bằng chứng nào từ bản đã sửa**. Log không ghi lỗi mới sau đó, nhưng người dùng báo vẫn gặp mọi chat.
- Hai lỗi khác cùng dấu hiệu, ghi trong log ngày 02/11 (02:01Z và 06:12Z): `Cannot read properties of undefined (reading 'findLast')` và `(reading 'map')`, `ctx.row` = `codex-827`, `codex-2100`. Build cũ hoặc đường code khác, chưa rõ còn tái hiện không.

Kết luận: không biết lỗi hiện tại là lỗi cũ (app đang chạy là bản build trước `21cdfb2`), hay một đường vẽ khác vẫn ghi state. Phải tái hiện trước khi sửa tiếp.

## 1. Xác định bản đang chạy (làm trước, 5 phút)

1. Hỏi người dùng: đang mở app nào: bản cài (`AgentDeck`), `AgentDeck Dev` (`pnpm dev`) hay `AgentDeck Local` (`run:build`)? Thời điểm build?
2. So thời điểm build với `21cdfb2` (15:15Z). Nếu build trước, rebuild từ `main` (`ad8ef6d` trở lên) rồi thử lại. Nếu không rebuild, kết quả thử lại không có giá trị.
3. Với `pnpm dev`: HMR có thể nạp code dở của checkout đang sửa (xem `plan-fix-structure.md` dòng 75). Chạy từ worktree sạch hoặc từ `main`.

Điều kiện qua bước: ghi rõ commit + thời điểm build của bản đang thử.

## 2. Làm lỗi hiện ra đầy đủ (không đoán)

Boundary hiện chỉ ghi 3 dòng stack và không ghi tên component. Đủ để tìm nguồn lỗi:

1. Sửa `onerror` trong `Chat.svelte:928`: ghi thêm `error.name`, `error.stack` đầy đủ (giới hạn 2 KB), `row.kind` (loại dòng: text, tool, delegate, command...), độ dài `messages` tại thời điểm lỗi, và `message.role`. Không ghi nội dung tin nhắn.
2. Ghi thêm phiên bản build (`commit`) vào entry để đối chiếu.
3. Test: một component giả ném lỗi trong `$derived` và một lỗi trong template; kiểm `logError` nhận đủ trường. (Vitest hoặc test node tương tự `chat-work`.)

Thay đổi này chỉ thêm log, không đổi hành vi hiển thị. Commit riêng.

## 3. Tái hiện và phân loại

1. Chạy bản từ bước 1. Mở các chat người dùng hay dùng (Claude và Codex, có tool call, có delegate, có câu hỏi đang chờ).
2. Với mỗi lỗi mới: đọc entry (`errors.log` tại `%APPDATA%\dev.agentdeck.desktop\logs`), phân loại theo `error.name` và stack:
    - `state_unsafe_mutation` → còn chỗ ghi state trong `$derived`/template. Tìm bằng: `grep -rn "messagesOf(" apps/desktop/src` (26 chỗ theo `plan-remaining.md`), lọc những chỗ nằm trong `$derived` hoặc template.
    - `Cannot read properties of undefined` → dữ liệu row thiếu trường (`findLast`, `map`). Tìm dữ liệu nguồn của `row.kind` đó, không thêm `?? []` che lỗi.
    - Khác → ghi vào plan này, mở mục mới.
3. Ghi bảng: lỗi, số lần, chat kiểu nào, build nào. Đưa vào `docs/development/debug-log.md`.

## 4. Sửa nguyên nhân

Theo phân loại ở bước 3. Quy tắc:

- Mỗi nguyên nhân một commit, có test tái hiện lỗi (test fail trước, pass sau).
- Không đổi boundary thành nuốt lỗi (`catch` im lặng). Lỗi phải vẫn được ghi.
- Với state: hàm đọc trong template hoặc `$derived` dùng accessor chỉ đọc. Hàm ghi chỉ gọi từ handler sự kiện hoặc luồng async.

## 5. Chặn tái phát

1. Script `scripts/check-derived-writes.mjs` (plan-remaining mục 5): quét `.svelte` và `.svelte.ts`, cảnh báo khi `messagesOf(` nằm trong `$derived` hoặc template. Ban đầu chỉ cảnh báo trong lint, chưa chặn commit.
2. Thêm vào checklist release (`/release`): mở một chat có tool call và một chat delegate, không có entry `chat row failed to draw` mới.

## 6. Tiêu chí đóng

- Build từ `main` có commit mới nhất. Mở 10 chat (ít nhất 5 Claude, 5 Codex, gồm chat có tool call và delegate), không có dòng "This message could not be drawn".
- `errors.log` không có entry `chat row failed to draw` hoặc `state_unsafe_mutation` mới trong 7 ngày dùng thật.
- Nếu lỗi còn: không đóng, mở mục mới trong plan này với log mới.

## Cần người dùng

1. Đang mở bản nào (cài, Dev hay Local), build lúc nào? (bước 1)
2. Cho phép thêm log chi tiết (bước 2) trong build của bạn.
3. Chạy thử các chat hay dùng và báo lại chat nào lỗi (kiểu chat: Claude/Codex, có tool call, có delegate).
