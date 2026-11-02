# Plan: tính năng worktree kiểu Claude Code (tự gợi ý tách task)

Ngày: 2026-11-02. Trạng thái: đề xuất, chưa code.
Liên quan: `docs/plans/plan-fix-structure.md` Phase 8 (chi tiết W1–W…) và mục 7.5 (quyết định đã chốt). Plan này là bản rút gọn theo trải nghiệm người dùng; các mục kỹ thuật vẫn lấy từ Phase 8.

## 0. Mục tiêu

Giống Claude Code:

1. Khi một yêu cầu gồm nhiều việc độc lập (sửa các module khác nhau), AgentDeck **gợi ý tách** thành các task, mỗi task chạy trong một **git worktree** riêng và một branch riêng.
2. Người dùng xem và duyệt danh sách task trước khi chạy. Không tự chạy.
3. Mỗi worktree là một phiên (chat) riêng, nằm dưới project trong sidebar.
4. Khi xong, AgentDeck đề nghị merge từng branch về branch chính, hỏi trước khi merge, và dọn worktree sau khi merge.

Ngoài phạm vi: tự push, tự mở PR, tự giải quyết xung đột.

## 1. Hiện trạng

- Chưa có worktree trong desktop. Chỉ có `codex.rs` (baseline file để tính diff) và `history/mod.rs` (nhận ra `.git` là file trong worktree). Xem `plan-fix-structure.md` 8.1.
- Đã có: harness điều phối (Phase 7), `propose_session` (đề xuất phiên), `delegate_task` (worker). Phase 8 nối các phần này với worktree.
- Chưa có: nơi cấu hình worktree của project, lệnh tạo/xóa worktree, gắn phiên với worktree.

## 2. Luồng người dùng

1. Người dùng gửi yêu cầu lớn trong chat chính, ví dụ "thêm export PDF, sửa dark mode, viết test cho sync".
2. Agent (qua `propose_session` có `isolation: 'worktree'`) hoặc harness (tín hiệu: nhiều file ở thư mục không chồng nhau) đề xuất: "Tách thành 3 việc, chạy song song trong 3 worktree? [Tách] [Làm trong một phiên] [Sửa danh sách]".
3. Hộp đề xuất hiện: tên task, phạm vi file (write scope), phụ thuộc giữa các task, nút chỉnh sửa. Mặc định chọn "Làm trong một phiên" nếu task có phụ thuộc chặt.
4. Khi duyệt: tạo worktree cho từng task, mỗi task thành một chat con có brief (khuôn Phase 6), chạy song song. Tối đa 3 phiên cùng lúc (quyết định 7.5).
5. Chat chính theo dõi trạng thái từng worktree (đang chạy / xong / lỗi / cần hỏi).
6. Khi task xong: header phiên hiện base, số commit ahead, số file đổi, nút "Merge về base", "Cập nhật từ base", "Xóa worktree". Merge luôn hỏi xác nhận.
7. Xung đột: dừng, liệt kê file xung đột, mở phiên để người dùng quyết định. Không tự giải quyết.

## 3. Thiết kế kỹ thuật (tham chiếu Phase 8)

### 3.1 Backend (Rust)

- Module `worktree.rs` (Phase 8 W1): `worktree_create`, `worktree_list`, `worktree_status`, `worktree_sync`, `worktree_merge`, `worktree_remove`.
- Thư mục: `<repo>/.agentdeck/worktrees/<slug>`, branch `agentdeck/<slug>-<4 ký tự>`. Slug ≤ 24 ký tự (đường dẫn dài trên Windows).
- `worktree_remove`: dừng tiến trình đang chạy trong worktree trước (`process_registry.rs`), từ chối nếu dirty trừ khi `force`.
- Merge: từ chối nếu checkout chính đang dirty.

### 3.2 Gợi ý tách task

- Đầu vào: yêu cầu của người dùng + danh sách file đã đọc/sẽ sửa (từ brief) + thư mục gốc các module.
- Agent đưa `propose_session` có `tasks[]` với `write_scope` (danh sách thư mục/file) và `depends_on`. Harness kiểm tra: hai task có `write_scope` chồng nhau thì không cho chạy song song, gợi ý làm tuần tự hoặc gộp.
- Ngưỡng gợi ý: ít nhất 2 task có write scope rời nhau và không phụ thuộc. Không gợi ý cho việc nhỏ (≤ 2 file).
- Test: fixture với 3 yêu cầu (rời nhau, chồng nhau, phụ thuộc). Kỳ vọng: 2 task song song, 1 task tuần tự, 1 không gợi ý.

### 3.3 Phiên gắn worktree

- `SessionItem.worktree?: { path, branch, base, createdAt, state: 'active' | 'merged' | 'removed' }`.
- `cwdOf` ưu tiên worktree khi `state === 'active'`. Mọi chỗ khởi động CLI, dev server, Changes panel, `run_checks` dùng `cwdOf`.
- Lịch sử CLI: hội thoại Claude/Codex chạy trong worktree vẫn map về project gốc (rà từng adapter theo Phase 8 W2).

### 3.4 Cấu hình project

- `.agentdeck/worktree.json` (commit cùng repo, tùy chọn):
    - `setup`: lệnh chạy sau khi tạo (ví dụ `pnpm install --offline`), cần người dùng bật lần đầu;
    - `include`: file chưa track cần chép (ví dụ `.env.local`), chỉ chép khi người dùng đồng ý; không bao giờ commit.

## 4. Các bước

| Bước | Nội dung                                                                                             | Kiểm tra                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | `worktree.rs` + test tích hợp với repo tạm (tạo, liệt kê, merge sạch, merge xung đột, xóa khi dirty) | `cargo test`, chạy qua `scripts\win-cargo.cmd`                        |
| 2    | Gắn `SessionItem.worktree`, `cwdOf`, hiện trong sidebar dưới project                                 | Vitest + kiểm tay: chat trong worktree chạy `git status` đúng thư mục |
| 3    | Menu "Chat mới trong worktree" (thủ công, Phase 8 W3)                                                | kiểm tay: tạo, đóng, xóa, không để lại thư mục                        |
| 4    | Gợi ý tách task qua `propose_session.isolation` + hộp duyệt                                          | fixture 3 tình huống ở 3.2                                            |
| 5    | Header phiên: ahead/behind, merge, sync, xóa                                                         | kiểm tay + test merge xung đột                                        |
| 6    | Dọn dẹp: worktree đã merge, phiên đã đóng                                                            | test: không xóa khi dirty; không xóa branch chưa merge                |

Mỗi bước là một PR riêng, không gộp refactor với thay đổi hành vi (quy tắc 0.1 của `plan-fix-structure.md`).

## 5. Rủi ro

- Windows khóa file: dev server hoặc tiến trình còn chạy làm `git worktree remove` lỗi. Dừng tiến trình trước, báo rõ nếu vẫn lỗi.
- Đường dẫn dài: slug ngắn; báo lỗi rõ khi `git worktree add` thất bại.
- Gợi ý sai (task thực ra phụ thuộc nhau): người dùng luôn duyệt trước; có nút "Làm trong một phiên".
- Chi phí: mỗi worktree là một bản sao file và một tiến trình agent. Giới hạn 3 phiên song song.
- Chưa có `pnpm install` trong worktree mới: `setup` là tùy chọn, không tự chạy nếu chưa bật.

## 6. Tiêu chí hoàn thành

- Trên một repo test có 3 module độc lập: yêu cầu lớn → hộp đề xuất 3 task → duyệt → 3 worktree chạy song song → merge từng cái về `main` → xóa worktree. Không có file nào của checkout chính bị đổi ngoài ý muốn.
- Có test cho `worktree.rs` và fixture gợi ý tách, chạy pass qua `scripts\win-cargo.cmd`.
- `git worktree list` sau khi xong không còn worktree tạm.

## Cần người dùng quyết định

1. Gợi ý tách task: tự hiện hộp đề xuất, hay chỉ hiện khi người dùng bấm nút? (Mặc định đề xuất: hiện hộp, không tự chạy.)
2. Merge: hỏi xác nhận mỗi lần, hay có chế độ tự merge khi test pass? (Mặc định đề xuất: luôn hỏi.)
3. Thư mục worktree: `<repo>/.agentdeck/worktrees` (trong repo, cần thêm vào `.gitignore`) hay ngoài repo (`%USERPROFILE%\.agentdeck\worktrees\<project>`)? Mặc định đề xuất: trong repo.
