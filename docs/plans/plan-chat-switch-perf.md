# Plan: mở lại chat dài nhanh, giữ đúng vị trí đọc

Ngày: 2026-11-03. Trạng thái: đã code Phase 1–3 (xem mục 7). Chưa đo số Phase 0 trên app thật.
Liên quan: `docs/plans/chat-history-mapping/plan.md`, `apps/desktop/src/lib/chat/session/history.svelte.ts`, `apps/desktop/src/lib/components/chat/Chat.svelte`, `crates/adapters/src/history/mod.rs`.

## 0. Mục tiêu

1. Chat dài, vừa chat liên tục, sang chat khác rồi quay lại: hiện ngay (mục tiêu < 150 ms tới frame đầu có nội dung), không skeleton.
2. Người dùng đã scroll lên trên: quay lại đúng message đó, đúng offset trên màn hình, không nhảy về cuối rồi kéo lên.
3. Chat đang ở cuối: quay lại vẫn ở cuối, thấy dòng mới nhất.
4. Không đổi hành vi F5 / mở chat lần đầu (vẫn đọc từ file).

Ngoài phạm vi: đổi format file của Claude/Codex, parse tăng dần (incremental) file JSONL.

## 1. Hiện trạng: vì sao quay lại chậm

Luồng hiện tại khi đổi `workspace.activeId` (`Chat.svelte` effect `openKey`, rồi `readTranscript`):

| #   | Chỗ                                                | Chuyện xảy ra                                                                                                                                                               | Giá                                                                        |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `events.svelte.ts:1919-1920`                       | Mỗi turn xong: `session.updatedAt = now` và `transcripts.delete(sessionId)`. Cache bộ nhớ của chat bị xóa, kể cả các page cũ đã đọc bằng `loadOlder`.                       | Chat liên tục thì cache luôn mất.                                          |
| 2   | `history.svelte.ts` `readTranscript`               | Chat có file luôn `chat.messages = []`, bật skeleton, chờ 1 rAF + `setTimeout`. Bỏ qua `messagesById`, dù list đầy đủ vẫn còn trong bộ nhớ.                                 | Một frame trống + mount lại toàn bộ.                                       |
| 3   | `readTranscript`                                   | Không có cache bộ nhớ, lấy bản IndexedDB: chỉ 20 message cuối, `stamp: ''` nên luôn stale. Chạy `restoreArchivedWork` + `restoreCommandImages` (đọc IndexedDB) trên bản đó. | Vài lần đọc IndexedDB.                                                     |
| 4   | `fetchTranscript` → `history_load_page`            | Rust `load_page` **parse cả file** rồi mới cắt 20 message (`mod.rs:241`). File Claude của chat dài có thể vài chục MB.                                                      | Tỉ lệ với kích thước file.                                                 |
| 5   | `Chat.svelte` `revealAtEnd` (có vị trí cần trả về) | Chờ `transcriptSettled()` (bước 4), rồi lặp `loadOlder` từng page 20 message, tối đa 60 page, cho tới khi thấy message neo. Mỗi `loadOlder` lại parse cả file (bước 4).     | O(số page × kích thước file). Đây là chỗ chậm nhất khi user đã scroll lên. |
| 6   | `revealAtEnd`                                      | 4 frame `put()`, `whenColoured(300)`, rồi mới `revealed = true`.                                                                                                            | ≤ 300 ms + vài frame.                                                      |

Kết luận: chậm chủ yếu do (a) bỏ dữ liệu đã có trong bộ nhớ và (b) đọc lại file nhiều lần, mỗi lần parse cả file.

## 2. Hướng giải

Ba lớp, làm theo thứ tự, mỗi lớp đo trước và sau.

### Phase 0: đo (trước khi sửa)

- P0.1 Thêm mốc thời gian qua `logFlow` / `performance.mark`: đổi `activeId`, có list, `revealed = true`, số lần gọi `history_load_page`, thời gian từng lần (Rust `tracing` quanh `load_page`).
- P0.2 Kịch bản đo cố định trên app thật (WebView2 CDP, xem memory `profile-real-app`): một chat Claude ~300 message, file > 10 MB.
    - A: ở cuối, sang chat khác, quay lại.
    - B: scroll lên ~5 page, sang chat khác, quay lại.
    - C: như B nhưng chat vừa chạy thêm 1 turn trước khi rời.
    - D: F5 rồi mở chat (để chắc không chậm hơn).
- Ghi số vào cuối file này.

### Phase 1: giữ list trong bộ nhớ khi đổi chat (frontend, lợi nhiều nhất)

- P1.1 **Không xóa cache sau mỗi turn.** Ở `events.svelte.ts:1920` bỏ `transcripts.delete`. Thay bằng đánh dấu "đuôi cần đối chiếu" (`tailStale`), giữ nguyên `messages` và `start`. `sending.svelte.ts:410` xem lại cùng cách (chỉ xóa khi thật sự đổi nội dung cũ: edit/rewind).
- P1.2 **Lưu `older` theo chat.** Hiện `chat.older` là một biến chung, bị reset khi đổi chat. Thêm `olderById: Map<string, number>` (hoặc giữ trong `transcripts` entry), cập nhật ở `loadOlder` và `readTranscript`.
- P1.3 **Đường nhanh trong `readTranscript`.** Nếu `messagesById.get(id)` có list (hoặc `transcripts` entry còn), thì:
    - `setMessages` ngay với list đó, đồng bộ, không gán `[]`, không skeleton, không chờ rAF.
    - Không chạy lại `restoreArchivedWork` / `restoreCommandImages` (list trong bộ nhớ đã có sẵn).
    - `chat.older = olderById.get(id)`.
    - `transcriptDone` resolve ngay cho phần đầu chat (xem P1.5).
    - Nếu `tailStale` hoặc stamp đổi: đối chiếu đuôi ở nền (P1.4).
- P1.4 **Đối chiếu đuôi, không thay cả list.** Đọc page cuối (`before = null`), rồi ghép:
    - Tìm message chung đầu tiên giữa page mới và list cũ (theo `id`, rồi theo `signature`/role+text+`at` như `mergeWorkMessages`).
    - Giữ nguyên phần trước điểm chung (các page cũ, kể cả đã `loadOlder`), chỉ thay phần từ điểm chung tới cuối.
    - Message khớp giữ **object và id cũ** (id local của reply live), chỉ cập nhật field. Lý do: vị trí đọc neo theo id (P2), đổi id là mất neo.
    - Không thấy điểm chung (file bị rewind/fork, hoặc page cuối không chạm list cũ): rơi về luồng cũ (thay cả list, `older = fresh.start`).
    - `older` giữ nguyên nếu phần đầu không đổi (file Claude/Codex chỉ thêm ở cuối nên chỉ số đầu vẫn đúng). Có thể kiểm tra thêm bằng `page.total`.
- P1.5 **Tách "đã có list" khỏi "đã đối chiếu".** `transcriptSettled()` hiện chờ cả lần đọc file. Với đường nhanh, vị trí đọc nằm ở phần đầu không đổi, nên `revealAtEnd` không cần chờ. Thêm `transcriptReady()` (resolve khi có list) dùng cho restore; giữ `transcriptSettled()` cho chỗ cần list đã đối chiếu.
- P1.6 **Giới hạn bộ nhớ.** LRU giữ list đầy đủ cho tối đa 8 chat mở gần nhất (hoặc tổng ~3000 message). Chat bị đẩy ra: chỉ giữ 20 message cuối, `older` theo đó, `readingAt` của chat đó giữ nguyên (P2.3 lo phần đọc lại). Chat đang chạy turn không bị đẩy ra.

### Phase 2: trả về đúng vị trí, ít bước hơn

- P2.1 `readingAt` hiện lưu `{ id, offset, atEnd }`. Thêm `fileIndex` (vị trí trong file: `older + index` trong list, bỏ qua message không đến từ file) và `at` (timestamp) làm neo dự phòng.
- P2.2 Đường nhanh (P1.3): message neo đã có trong list, nên `revealAtEnd` gọi `scrollToIndex` + chỉnh `offset` ngay frame đầu. Không chờ `transcriptSettled`, không lặp `loadOlder`. Giữ 2 frame `put()` cho tới khi các row quanh neo đo xong (row-size cache đã có chiều cao nên thường đủ ngay).
- P2.3 Đường chậm (chat bị LRU đẩy ra, hoặc sau F5): thay vòng lặp 60 page × 20 bằng **một lần đọc** từ `fileIndex` tới cuối (`loadHistoryPage(before = older, limit = older - fileIndex + 20)`, hoặc lệnh mới `history_load_range(from, to)`). Nếu id neo không thấy, tìm theo `at` gần nhất; vẫn không có thì mở ở cuối.
- P2.4 Đối chiếu đuôi (P1.4) chạy sau khi đã reveal tại neo. Đuôi đổi không được kéo view: `following = false` đã đúng; kiểm tra thêm virtualizer `anchorTo: 'end'` không dời `scrollTop` khi đuôi dài ra. Nếu có dời, bù lại bằng cách đo `top` của row neo trước và sau khi ghép.
- P2.5 `whenColoured(300)`: với đường nhanh, code đã tô màu từ lần trước (cache markdown). Chỉ chờ khi row quanh neo chưa từng render. Giảm còn ≤ 100 ms hoặc bỏ nếu cache trúng.

### Phase 3: Rust không parse cả file mỗi page

- P3.1 Cache kết quả `load()` trong `ag_adapters::history`: `Mutex<LruCache<PathBuf, (len, mtime, Arc<Vec<HistoryMessage>>)>>`, tối đa 4 file hoặc ~64 MB. `load_page` dùng cache nếu `len` + `mtime` khớp. Các page `loadOlder` tiếp theo thành O(page).
- P3.2 File đổi (`len`/`mtime` khác): parse lại cả file như hiện nay. Không làm incremental: Claude dựng chuỗi từ `parentUuid` của leaf mới nhất (`claude.rs:171`), rewind/fork làm chuỗi đổi, append-only không an toàn.
- P3.3 Lệnh `history_load_range(source, path, from, to)` cho P2.3 (một IPC thay vì N).
- P3.4 Test Rust: cache trả cùng kết quả với không cache; file đổi thì cache bị bỏ; `load_range` đúng biên. Không gọi mạng.

## 3. Rủi ro

- Ghép đuôi sai khi provider viết lại message cũ (Codex compaction, Claude rewind): P1.4 rơi về thay cả list. Cần test riêng cho rewind.
- Id live khác id file: P1.4 giữ id cũ cho message khớp. Nếu không khớp được bằng text (reply bị cắt), neo dùng `at` (P2.1).
- Bộ nhớ: P1.6 giới hạn. Đo heap trước/sau ở P0.
- Hai chat cùng lúc chạy turn: list nằm theo id (`messagesById`), không đụng `chat.messages` của chat đang mở. Giữ nguyên quy tắc `setMessages`.
- Không thêm hiệu ứng khi đổi chat (memory `chat-switch-no-extra-motion`): đường nhanh chỉ bỏ skeleton, không thêm fade/slide.

## 4. Kiểm tra (DoD)

- Unit test frontend: ghép đuôi (thêm cuối, reply live → file, rewind, không điểm chung), LRU, `readingAt` dự phòng theo `at`.
- Test Rust: P3.4.
- Đo lại 4 kịch bản P0.2, ghi số trước/sau.
- `pnpm -C apps/desktop check` (svelte-check), `pnpm -C apps/desktop test`, `cargo clippy --workspace -- -D warnings`, `cargo test -p ag-adapters`.

## 5. Thứ tự làm

1. Phase 0 (đo).
2. P1.1, P1.2, P1.3, P2.2: đủ cho kịch bản A, B, C khi chat còn trong LRU. Lợi nhiều nhất, ít rủi ro.
3. P1.4, P1.5, P2.4: đối chiếu đuôi đúng, không kéo view.
4. P3.1: Rust cache, lợi cho F5 và chat bị LRU đẩy ra.
5. P1.6, P2.1, P2.3, P3.3: đường chậm một lần đọc.
6. P2.5: tinh chỉnh chờ tô màu.

## 6. Số đo

(điền sau Phase 0 và sau mỗi bước)

## 7. Đã làm (2026-11-03)

- Rust (`crates/adapters/src/history/mod.rs`): giữ tối đa 4 file đã parse, khóa theo đường dẫn + độ dài + mtime. `load_page` cắt từ bản giữ, không parse lại cả file mỗi page. Test: `load_page_reads_a_file_again_once_it_has_grown`. P3.3 (`history_load_range`) bỏ: không cần khi đã có cache.
- Frontend:
    - `session/held.ts` (mới) + `held.test.ts`: `sameMessage`, `tailStart`. Test pass.
    - `history.svelte.ts`: `olderById` (vị trí file của message đầu list giữ), `heldOrder` + `releaseHeld` (giữ 8 chat gần nhất, không đụng chat đang mở / đang chạy / chưa có file). `readTranscript` có đường nhanh cho chat đang giữ: hiện ngay, không skeleton. `catchUp` đọc 200 message cuối và ghép đuôi; đầu danh sách giữ nguyên. Không khớp thì đọc lại từ file. Phần cũ tách thành `readFromFile`.
    - `events.svelte.ts`: không xóa cache sau mỗi turn nữa.
    - `Chat.svelte`: lưu `fileIndex` khi rời chat; khi cần tìm lại vị trí đã rời thì `loadOlder` đọc một đoạn đủ lớn, không lặp 20 message.
- Kiểm tra: `pnpm check` 0 errors; `cargo clippy -p ag-adapters -D warnings` sạch; `cargo test -p ag-adapters` 192 pass; `held.test.ts` 4 pass.
- Chưa làm: đo Phase 0 trên app thật (cần WebView2 + file chat dài). Chưa test tích hợp đường nhanh / catchUp (logic trong store có rune, chỉ test được qua app).
- Rủi ro cần soi khi test tay: reply live đã xong mà file chưa ghi kịp thì bị mất khi mở lại (cùng rủi ro với bản cũ); message live đổi id khi file ghi xong nên neo đọc theo id có thể không tìm thấy (rơi về cuối).
