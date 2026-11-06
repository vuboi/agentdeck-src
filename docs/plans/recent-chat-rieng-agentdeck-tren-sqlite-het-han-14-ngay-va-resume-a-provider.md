---
title: Recent Chat riêng AgentDeck trên SQLite, hết hạn 14 ngày và resume đa provider
status: draft
agent:
chat: claude:3714637a-0b58-4ad7-9e60-b446ef9dcd5f
source: mcp
created: 2026-11-06T15:50:07.765Z
updated: 2026-11-06T15:55:21.418Z
---

## Mục tiêu

Recent Chat chỉ liệt kê chat tạo trong AgentDeck, đọc và ghi SQLite `chats.db`. Một chat hết hạn đúng 14 ngày sau lần người dùng gửi tin gần nhất; gửi tin mới đẩy hạn thêm 14 ngày. UI khôi phục toàn bộ nội dung do AgentDeck ghi, kể cả chat dùng nhiều model, provider, connector và agent. Provider chỉ nhận native session ID để resume; lịch sử AgentDeck không dựa vào lịch sử provider.

## Quyết định mặc định

- Không quét/import lịch sử độc lập của Claude, Codex, Antigravity hay connector để tạo hoặc làm đầy Recent Chat. Không ánh xạ native session ID ngược về chat AgentDeck, không ghép các file transcript provider vào một chat.
- Quan hệ duy nhất cần giữ là từ chat AgentDeck và route của từng lượt → native session ID của provider, để resume. Không dùng native ID, path hay nội dung file provider làm khóa nhận diện chat AgentDeck. Không xoá file lịch sử gốc của provider khi dọn chat AgentDeck.
- Chat cũ có `made`/placement `agentdeck` được chuyển từ dữ liệu AgentDeck đã lưu vào SQLite, kể cả từng có file provider. Chat chỉ được import từ provider biến mất khỏi Recent; dữ liệu gốc vẫn nằm tại provider. Nếu bản AgentDeck cũ thiếu block, báo thiếu trong migration thay vì âm thầm đọc ngược transcript provider.
- `last_user_at` lấy từ lúc gửi tin thực của người dùng (kể cả gửi lại tin đã sửa), không lấy từ reply tự động, task, mở chat, đổi tên hay đồng bộ provider. Chat rỗng tính từ lúc tạo. Chat đang chạy được dọn ngay khi idle sau khi quá hạn.
- Ngữ cảnh model có giới hạn token: transcript AgentDeck là nguồn đầy đủ; truyền phần gần nhất cùng tóm tắt có thể truy nguyên cho phần cũ. Không hứa gửi vô hạn nội dung vào một context window.

## Các bước

- [ ] 1. Chụp baseline trước sửa: kiểm tra startup/Recent/mở chat/chuyển provider/xoá chat; ghi kết quả. Backup `chats.db` và dữ liệu IndexedDB trước migration.
- [ ] 2. Mở rộng schema `chats.db` bằng migration có phiên bản: cờ sở hữu AgentDeck, metadata `SessionItem` cần khôi phục, `last_user_at`, `expires_at`; lưu đầy đủ message/block, thứ tự, parent/task/run links và tham chiếu tệp. Binding chỉ đi từ chat/route AgentDeck đến provider/connector native session ID, model, account epoch, trạng thái resumable và `synced_seq`. Khóa route phải phân biệt từng connector, không gộp tất cả dưới `custom`; bỏ path provider khỏi nguồn dữ liệu chat.
- [ ] 3. Migrate chat AgentDeck cũ từ IndexedDB/`chat.mixed` và các hàng ledger do AgentDeck ghi. Chỉ lấy native ID cần resume, bỏ `providerAliases` và mapping file transcript. Đối chiếu ID, số message, block và binding; báo mọi khoảng thiếu, không đọc provider transcript để bù. Giữ backup và rollback cho đến khi đối chiếu xong.
- [ ] 4. Chuyển startup và Recent sang `chat_list` chỉ lấy chat AgentDeck chưa hết hạn; bỏ `history_list`, `importHistory`, cache `index.history`, refresh sau turn, bộ lọc Imported, alias-to-owner và đường `chat_resolve_native`/`chat_sync_native` khỏi luồng chat. Dựng project, active tab và tiêu đề từ metadata SQLite.
- [ ] 5. Chuyển mở chat/cuộn trang sang `chat_open` và ghi mọi thay đổi UI vào SQLite: user/assistant, stream dở, block tool/permission/ask, task/subagent/delegate/work report, edit/tombstone, archive, attachment và metadata turn. Ghi theo chat với thứ tự/revision rõ ràng; flush khi kết thúc turn, đóng app và trước xoá. Không tái dựng UI từ transcript provider. IndexedDB chỉ phục vụ migration/rollback rồi được dọn sau khi chứng minh đọc từ SQLite.
- [ ] 6. Resume qua binding một chiều: mỗi route provider + connector + model + account dùng đúng native ID; chỉ resume sau xác nhận provider đã bắt đầu session. Đổi model/account/edit đóng resume target cũ nhưng giữ lịch sử AgentDeck; không dò provider file hoặc reverse-map ID để tìm chat. Khi đổi route, dựng context đã bỏ lỡ từ ledger AgentDeck, gồm kết quả subagent/multiagent và handback; cập nhật `synced_seq` sau lượt thành công.
- [ ] 7. Dọn hạn ở SQLite theo `expires_at <= now` lúc startup và theo lịch khi app đang mở; cập nhật hạn trong transaction của tin user mới. Xoá chat và record con/attachment không còn tham chiếu, ngừng warm process của chat; không xoá native provider session/file. Xoá tay dùng cùng semantics và cập nhật UI.
- [ ] 8. Kiểm chứng migration và khoảng thiếu, 14 ngày (mốc trước/đúng/sau; reply tự động không reset; tin user reset), reload chat đầy đủ, phân trang, edit, restart giữa stream, nhiều connector cùng `custom`, đổi model/account rồi quay lại, task con và delegate. Xác nhận một native session không tự tạo hàng Recent và không ghép nội dung vào chat AgentDeck. Chạy `cargo test -p ag-adapters`, `cargo test -p agentdeck-desktop`, `cargo clippy --workspace -- -D warnings`, `pnpm exec svelte-check` tại desktop; kiểm tra native UI Recent/khôi phục/resume với provider thật.

## Rủi ro và điểm quay lui

SQLite hiện chỉ dual-write turn `done`; UI vẫn đọc IndexedDB/provider. Chuyển nguồn đọc trước khi lưu đủ block sẽ làm thiếu lịch sử AgentDeck. Dữ liệu AgentDeck cũ có thể không chứa toàn bộ nội dung từng được hiển thị từ file provider: migration phải báo rõ phần không khôi phục được theo yêu cầu không đọc ngược. Rollback giữ backup và cờ đọc bản cũ cho đến khi dữ liệu SQLite được đối chiếu.
