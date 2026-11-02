# Plan: lỗi còn lại sau Phase 0–5

Ngày: 2026-11-02. Nhánh: `main` (đã có `ad8ef6d`). Trạng thái: đề xuất, chưa code.

Thứ tự ưu tiên: (1) môi trường build và UI test, vì không có nó thì không kiểm chứng được gì; (2) hiển thị hai file native; (3) ghi ledger song song và chuyển đọc sang ledger; (4) lỗi log cũ.

Ràng buộc chung:

- Không commit lên `main` khi chưa test chạy được app thật (mục 1).
- Không sửa các file đang có thay đổi chưa commit của người khác (xem mục 0).
- Không dùng `--no-verify`. Hook lint-staged phải pass.

---

## 0. Thay đổi chưa commit của người khác (chặn trước khi commit)

Trạng thái lúc lập plan:

- `apps/desktop/src/lib/chat/agent.ts` (M)
- `apps/desktop/src/lib/chat/session/delegate-task.svelte.ts` (M, đổi trong lúc làm việc: `finishTask` chuyển sang `toCaller` callback)
- `apps/desktop/src/lib/chat/session/turns.svelte.ts` (M)
- `crates/adapters/src/agent/stall.rs` (M)
- `docs/plans/plan-fix-structure.md` (untracked)

Việc cần làm:

1. Hỏi chủ các thay đổi này (không phải lượt làm việc này) có muốn commit cùng không.
2. Nếu có: commit riêng, không gộp vào commit fix chat-history.
3. Trước khi sửa `delegate-task.svelte.ts`, đọc lại file (nội dung đã đổi trên đĩa).

Kiểm tra: `git status` chỉ còn các file thuộc phần đang làm.

---

## 1. Môi trường build và UI test

### 1.1 Build `src-tauri` trên máy Windows (`whisper-rs-sys`)

Nguyên nhân (theo session phase2): bindgen không tìm được header built-in của clang (`stdbool.h`). Khi đó `whisper-rs-sys` dùng `bindings.rs` đóng sẵn, cũ, gây overflow `12 - 16` và `208 - 216`.

Cách build đã chạy được (theo báo cáo session phase2, chưa chạy lại ở đây):

- chạy cargo trong môi trường VS 2022 BuildTools `vcvars64`;
- đặt `LIBCLANG_PATH`;
- đặt `CMAKE_GENERATOR='Visual Studio 17 2022'`;
- truyền `INCLUDE` cho bindgen dưới dạng `-isystem`.
- Batch script nằm trong scratchpad của session phase2 (đường dẫn trong `list_events`).

Bước:

1. Viết một script `scripts/win-cargo.cmd` (hoặc `.ps1`) chứa các bước trên, chạy cargo bên trong. Ghi vào repo để không phải nhớ.
2. Chạy `cargo check -p agentdeck-desktop` qua script. Kỳ vọng: pass.
3. Chạy `cargo clippy --workspace -- -D warnings` qua script. Kỳ vọng: pass (hiện chỉ lỗi từ `whisper-rs-sys`).
4. Ghi lệnh vào `docs/development/running-locally.md`.

Rủi ro: script phụ thuộc đường dẫn VS 2022 cụ thể trên máy. Ghi rõ điều kiện cài đặt.

### 1.2 Chạy app thật và checklist UI

Dùng skill `run` và `realbrowser`/`preview_start` nếu có. Phải chạy bản Tauri (không phải `dev:web`), vì Tauri commands (chat index, export, error log) chỉ có ở bản đó.

Checklist (mỗi mục ghi kết quả pass/fail và ảnh chụp):

1. Mở chat cũ Claude và Codex: transcript hiện đủ, không có dòng "This message could not be drawn".
2. Gửi tin trong chat A, chuyển sang chat B đang stream: tin và trả lời không lẫn sang B.
3. Chuyển chat trong lúc transcript đang tải: không có tin của chat cũ hiện trong chat mới.
4. Menu chuột phải chat Copilot hoặc Antigravity: không có "Continue in CLI". Chat Claude và Codex có.
5. "Continue in CLI" trên chat Claude: tạo file mới trong `~/.claude/projects/...`, clipboard có lệnh resume, file cũ không đổi (so hash).
6. Đổi model giữa chat (Claude → Codex → Claude): lượt của provider khác được gửi kèm đúng một lần.
7. Work tray: worker bị cắt bởi reload hiện "Check status", không hiện "Stopped".
8. Mở `Error log` drawer: không có entry `state_unsafe_mutation` mới sau các thao tác trên.

Dữ liệu test: chat thử trong project test. Không dùng chat thật có thông tin nhạy cảm. Các chat test không gửi tới provider nếu không cần; chỉ bấm các mục cần thiết.

Cần người dùng: chạy checklist trên máy có tài khoản Claude và Codex, vì chỉ người dùng có đăng nhập.

---

## 2. Hiển thị hai file native cho một chat (B2 phần hiển thị)

### 2.1 Hiện trạng

- `applyHistory` (`history.svelte.ts`): các dòng từ `listHistory` được alias về id chat, rồi khử trùng: giữ dòng mới nhất (`seen`, lọc `!seen.has(item.id)`).
- `source` và `path` của chat lấy từ dòng đó.
- `readTranscript` chỉ đọc `session.path`. File còn lại bị bỏ qua.
- Hệ quả: chat Claude → Codex → Claude chỉ hiện file mới nhất; lượt của provider kia chỉ còn nếu nằm trong `otherTurns`.

Chưa xác nhận: lượt Codex có luôn nằm trong `otherTurns` không. Cần kiểm tra trước khi sửa.

### 2.2 Giải pháp giai đoạn 1 (không đổi lưu trữ)

Mục tiêu: chat hiện đủ lượt của mọi file native đã bind, theo thứ tự thời gian, không trùng.

Thay đổi:

1. Lưu danh sách file native của chat trong `chat.mixed`: thêm `paths: { source, path, nativeId }[]`. Ghi khi `rememberMixed` và khi `applyHistory` thấy alias mới.
2. `applyHistory`: không bỏ các dòng alias khác provider. Gom chúng vào `paths` của chat thay vì loại. Giữ `source` và `path` của dòng mới nhất như hiện tại (để không đổi các chỗ đọc khác).
3. `readTranscript`: nếu chat có nhiều `paths`, gọi `loadHistory` cho từng file, `toMessages`, rồi gộp:
    - sắp theo `at` (thời gian); lượt không có thời gian giữ thứ tự gốc;
    - khử trùng theo `message.id` (native message id, Phase 1 đã có);
    - bỏ lượt trùng với `otherTurns` (dùng cùng khóa id).
4. `export` (`conversationForExport`) dùng cùng hàm gộp.

Kiểm thử (node, không cần app):

- Tạo fixture hai file: Claude (3 lượt) và Codex (2 lượt xen kẽ thời gian). Kỳ vọng: 5 lượt, đúng thứ tự, không trùng.
- Fixture trùng id: cùng một lượt xuất hiện trong `otherTurns` và trong file. Kỳ vọng: 1 lượt.
- Chat một file: kết quả giống hệt trước khi sửa (so snapshot).

Rủi ro:

- File lớn: đọc hai file mỗi lần mở chat. Cần cache theo `stamp` như `transcripts` đang làm.
- Thứ tự thời gian của Codex và Claude có thể lệch múi giờ. Kiểm tra định dạng `at` của từng provider trước khi so sánh.

Ước lượng: 1–2 ngày.

### 2.3 Giai đoạn 2 (sau khi ledger là nguồn sự thật)

Chuyển đọc transcript sang `chat_open` (Phase 2 `chat_index`). Điều kiện: chat_index đã ghi đủ lượt (mục 3). Khi đó bỏ gộp trong frontend. Giai đoạn này cần mục 3 xong trước.

---

## 3. Ghi ledger song song và chuyển đọc sang ledger

### 3.1 Hiện trạng

- `chat_index` chỉ được ghi bởi migration một lần (`migrateChatIndexOnce`, gọi từ `+layout.svelte`).
- Chat mới sau migration không được ghi vào `chats.db`. Ledger lệch dần so với IndexedDB.
- Không có lời gọi UI nào tới `chat_list`, `chat_open`, `chat_append`, `chat_sync_native`.

### 3.2 Các bước

1. Dual-write, sau cờ `chat_index.dual_write` (mặc định tắt):
    - khi một lượt kết thúc (`done`, không lỗi): `chat_append` các lượt mới theo `seq`;
    - khi tạo chat: `chat_save`;
    - khi bind file native mới (switch agent, model, account): `chat_bind`;
    - khi xóa: `chat_delete`.
2. Kiểm thử ghi: chạy 20 lượt trong app với cờ bật; so số lượt giữa IndexedDB và `chats.db` (script đọc cả hai, hoặc dump từ `chat_list` + `chat_open`).
3. Đọc thử (shadow read): khi mở chat, đọc cả hai nguồn, so sánh, ghi chênh lệch vào error log (`area: app`, `event: chat index mismatch`). Không hiển thị từ ledger.
4. Khi tỉ lệ khớp 100% trong một tuần dùng thật: bật đọc từ ledger cho chat, giữ IndexedDB làm fallback (rollback flag).
5. Sau một bản phát hành (điều kiện của Phase 5): xóa code legacy theo danh sách trong `plan.md` Phase 5.

Rủi ro:

- Ghi hai nguồn tốn I/O: debounce `chat_append` (500 ms) và gom theo chat.
- Lượt đang stream: chỉ ghi lượt đã `done`.
- Rollback: cờ `chat_index_set_rollback` phải tắt được đọc từ ledger ngay không cần cài lại.

Kiểm thử: unit test Rust đã có 8 test `chat_index`. Thêm test end-to-end sau khi có cờ.

---

## 4. Lỗi log cũ (`findLast`, `map` trên `undefined`)

Log: `dev.agentdeck.desktop/logs/errors.log`, ngày 30/10–02/11, build cũ. Stack trỏ tới `CommandGroup.svelte:167` (`items.findLast`).

Hiện trạng: `CommandGroup` nhận `items: CommandBlock[]` bắt buộc; `AssistantMessage` chỉ đưa `segment.items` của segment `commands`, luôn là mảng. Không tái hiện được từ code hiện tại.

Các bước:

1. Đối chiếu commit: `git log -S"items.findLast"` cho thấy dòng này vào trong `c55d148` (refactor thư mục). Build 30/10 có code khác.
2. Lấy log mới: sau khi chạy app (mục 1.2), đếm các entry `chat row failed to draw` có `detail` là `findLast` hoặc `map`. Nếu không còn: đóng vấn đề, ghi vào `docs/development/debug-log.md`.
3. Nếu còn: lấy `ctx.chat` và `ctx.row` từ entry, mở chat đó, xác định segment gây lỗi, thêm test cho segment đó, rồi sửa đúng nguyên nhân (không thêm `?? []` che lỗi).

Điều kiện đóng: không còn entry mới trong 7 ngày dùng thật.

---

## 5. Kiểm soát lỗi `state_unsafe_mutation` về sau

Đã sửa `messagesOf` trong `$derived` (`Composer.svelte`). Để tránh lặp lại:

1. Quy ước: hàm đọc dùng trong template hoặc `$derived` phải dùng `messagesView` (chỉ đọc). `messagesOf` chỉ dùng trong hàm xử lý sự kiện và luồng async.
2. Thêm kiểm tra tĩnh: script `scripts/check-derived-writes.mjs` quét `.svelte` và `.svelte.ts`, báo khi `messagesOf(` xuất hiện trong dòng có `$derived` hoặc trong block `{...}` của template. Chạy trong hook lint (không chặn commit ở bước đầu, chỉ cảnh báo).
3. Kiểm thử thủ công: mục 1.2 checklist mục 8.

---

## 6. Phạm vi không làm trong đợt này

- Copilot writer và Antigravity export: đã quyết định không làm. Menu đã ẩn cho hai provider này.
- Dữ liệu agy: không có `cwd`. Không dùng cho resume từ AgentDeck ngoài đường đọc hiện tại.

---

## Thứ tự và phụ thuộc

| Bước         | Nội dung                           | Phụ thuộc                   | Ai làm                           |
| ------------ | ---------------------------------- | --------------------------- | -------------------------------- |
| 0            | Hỏi chủ thay đổi chưa commit       | —                           | người dùng                       |
| 1.1          | Script build Windows               | —                           | session mới                      |
| 1.2          | Chạy app, checklist UI             | 1.1                         | người dùng (đăng nhập) + session |
| 4            | Đối chiếu log mới                  | 1.2                         | session                          |
| 2.2          | Gộp hai file native (giai đoạn 1)  | 1.2 để kiểm                 | session                          |
| 3.2 bước 1–3 | Dual-write và shadow read          | 2.2                         | session                          |
| 3.2 bước 4–5 | Chuyển đọc sang ledger, xóa legacy | 3.2 bước 1–3 đạt tỉ lệ khớp | session + người dùng             |
| 5            | Quy ước và kiểm tra tĩnh           | —                           | session                          |

Mỗi bước là một session riêng, một nhánh riêng, có test và báo cáo kết quả lệnh thật.

## Cần người dùng quyết định

1. Chủ các thay đổi chưa commit (mục 0): commit riêng hay bỏ qua?
2. Chạy checklist UI (mục 1.2) trên máy có tài khoản provider: ai làm, khi nào?
3. Bật dual-write (mục 3.2) có cần thời gian dùng thật bao lâu trước khi chuyển đọc?
