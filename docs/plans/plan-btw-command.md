# Plan: lệnh `/btw` (hỏi nhanh ngoài luồng, không ngắt chat chính)

Ngày: 2026-11-02. Trạng thái: đề xuất, chưa code.

## 0. Mục tiêu

Giống `/btw` của Claude Code:

1. Gõ `/btw <câu hỏi>` trong chat chính → câu hỏi đi sang một **chat phụ** dùng ngữ cảnh của chat chính tại thời điểm đó.
2. Chat chính không bị ngắt: không dừng lượt đang chạy, không vào hàng đợi, không đổi trạng thái busy, không xuất hiện trong transcript chính.
3. Câu trả lời hiện ở một khung phụ (panel/drawer cạnh chat). Người dùng có thể đóng, hoặc "Đưa vào chat chính" để ghi thành một ghi chú.
4. Chat phụ chỉ đọc: không sửa file, không gọi `delegate_task` lồng nhau.

Ngoài phạm vi: nhiều chat phụ cùng lúc (giới hạn 1 ở bản đầu), lưu lâu dài chat phụ, chat phụ có quyền ghi.

## 1. Hiện trạng (đã đọc code)

- Gửi tin: `send()` ở `chat/session/sending.svelte.ts:549`. Khi bận, Enter vào hàng đợi (`runs/queue`). Khi đang chạy, không có đường gửi "song song" trong cùng session.
- Lệnh slash đã có một: `/compact` (`COMPACT_COMMAND`, `sending.svelte.ts:811`), xử lý ở `run.svelte.ts:737` và `:1078`. Chưa có registry chung cho slash command: `/btw` cần thêm vào đó.
- Mỗi session có run state riêng (`runStates`, `advanceRun`). Hai session có thể chạy song song: đây là nền để chat phụ không chặn chat chính.
- Delegate đã có khái niệm chat con (`parentId`, `delegateTasks`, `MAX_WORKERS`) và tạo session với ngữ cảnh fork (`context: 'fork' | 'fresh'` trong Phase 7 H3). `/btw` tái dùng hạ tầng này, không làm luồng mới.
- Chưa có chỗ hiển thị "phụ": `SubChatBar.svelte` có thể là nơi bắt đầu, cần đọc trước khi quyết định.

## 2. Thiết kế

### 2.1 Mô hình dữ liệu

- `SessionItem.side?: { parentId: string; snapshotAt: number; answered: boolean; pinned: boolean }`. Chat phụ là một `SessionItem` có `side` set.
- Không hiện trong sidebar, không tính vào danh sách chat, không ghi vào `chats.db` ở bản đầu (ephemeral). Đóng panel là xóa.
- Ngữ cảnh: snapshot các lượt của chat chính **tại thời điểm gửi** (không gồm lượt đang stream). Dùng cùng hàm dựng context với `delegate_task` fork. Giới hạn token theo cài đặt `contextLimitHistory`.

### 2.2 Luồng gửi

1. `Composer` nhận `/btw ...` (trước khi xử lý `/compact`): không gọi `send()` của chat chính, không đổi `queued`.
2. Tạo side session: `side = { parentId, snapshotAt, ... }`, copy snapshot làm lịch sử.
3. Chạy bằng cùng agent và model của chat chính (hoặc model chọn trong panel). Prompt có tiền tố: "Trả lời ngắn câu hỏi phụ dưới đây dựa trên ngữ cảnh. Không sửa file, không chạy lệnh ghi."
4. Kết quả đi vào `side.answer` và panel hiện; không gọi `handbackPrompt` về chat chính.
5. Chat chính tiếp tục bình thường trong suốt thời gian này.

### 2.3 Chỉ đọc

- Claude: chạy với tập tool bị giới hạn (không `Edit`, `Write`, `Bash` ghi). Xác minh cấu hình tool của adapter claude trước khi làm.
- Codex, Antigravity, model local: không có cơ chế cấm chắc chắn cho mọi adapter → panel ghi rõ "chế độ hỏi, không cam kết chỉ đọc", và không cho chọn chat phụ trên adapter không kiểm soát được. Đây là quyết định cần người dùng xác nhận (xem mục 5).
- Không cho `delegate_task`, `propose_session` trong chat phụ.

### 2.4 Hiển thị

- Panel phụ cạnh chat chính (theo `ContentTabs`/`RightPanel`, không đè Composer): câu hỏi, câu trả lời stream, trạng thái, nút Đóng, Đưa vào chat chính, Hỏi thêm (cùng chat phụ).
- Badge nhỏ trên Composer khi chat phụ đang chạy, không chặn gõ.
- Đưa vào chat chính: ghi một tin hệ thống loại `note` (không phải tin người dùng) gồm câu hỏi + đáp, không kích hoạt lượt mới.

### 2.5 Giới hạn và an toàn

- Một chat phụ tại một thời điểm cho mỗi chat chính; gửi `/btw` mới khi đang có thì hỏi thay thế hay chờ.
- Chiếm một slot worker: tôn trọng `MAX_WORKERS`, không để chat phụ làm nghẽn delegate.
- Nếu chat chính bị xóa hoặc đổi project khi chat phụ đang chạy: dừng chat phụ, bỏ kết quả.
- Không để lộ nội dung ngữ cảnh ra ngoài chat chính (không ghi vào log `errors.log` ngoài độ dài và id).

## 3. Các bước

| Bước | Nội dung                                                           | Kiểm tra                                                                                     |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1    | Registry slash command (`/compact` chuyển vào đó, `/btw` thêm vào) | Vitest: parse `/btw x`, `/compact`, `/btwx` (không khớp)                                     |
| 2    | Side session: model, snapshot ngữ cảnh, ephemeral                  | test: snapshot không gồm lượt đang stream; chat chính không đổi `queued`/busy khi gửi `/btw` |
| 3    | Chạy song song + panel hiển thị + đóng                             | kiểm tay: chat chính stream trong khi chat phụ trả lời                                       |
| 4    | Chỉ đọc cho Claude (cấu hình tool)                                 | kiểm tay: yêu cầu "sửa file X" trong `/btw` không sửa được                                   |
| 5    | Đưa vào chat chính (note)                                          | test: note không tạo lượt mới                                                                |
| 6    | Hủy khi chat chính bị xóa, giới hạn slot                           | test: xóa chat chính → chat phụ dừng                                                         |

Mỗi bước một commit, không gộp refactor với thay đổi hành vi.

## 4. Rủi ro

- Chat phụ tốn token (ngữ cảnh lặp lại): có ước lượng trước khi gửi nếu ngữ cảnh lớn.
- Provider không chặn ghi được: rủi ro sửa file nếu bỏ qua cảnh báo. Mitigation: không cho chọn adapter không kiểm soát được ở bản đầu.
- Chat chính và chat phụ cùng một CLI session (Claude): cần chắc chắn chat phụ không ghi vào file session của chat chính. Phải dùng session id mới cho chat phụ.
- Race: snapshot cũ nếu chat chính đang stream và người dùng hỏi đúng lúc. Snapshot không gồm lượt đang chạy, và panel nói rõ điều đó.

## 5. Cần người dùng quyết định

1. Chat phụ chỉ cho Claude ở bản đầu, hay cho cả Codex (phải kiểm chứng cấm ghi)? Mặc định đề xuất: chỉ Claude.
2. Có cho chọn model khác trong panel không? Mặc định đề xuất: không, dùng model của chat chính.
3. Câu trả lời có được lưu sau khi đóng panel không? Mặc định đề xuất: không (ephemeral), trừ khi bấm "Đưa vào chat chính".
4. Nếu đang có chat phụ mà gửi `/btw` mới: thay thế hay xếp hàng? Mặc định đề xuất: thay thế, hỏi xác nhận nếu câu trả lời cũ chưa được đưa vào chat chính.

## Tiêu chí hoàn thành

- Trong chat Claude đang stream một lượt dài, gửi `/btw câu hỏi`: lượt chính không dừng, không vào hàng đợi, transcript chính không có tin mới, panel hiện câu trả lời.
- `/compact` vẫn hoạt động như cũ (test hồi quy).
- Đóng panel không để lại file session mới trong `~/.claude/projects/...` của chat chính.
- Vitest cho parse lệnh và snapshot pass; `svelte-check` 0 lỗi; `eslint` sạch trên file đã sửa.
