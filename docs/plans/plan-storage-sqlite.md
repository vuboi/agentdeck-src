# Plan: Lưu trữ nặng đọc/ghi chuyển sang SQLite (+ mã hoá nhị phân), dọn code index và rác

Ngày: 2026-11-05. Trạng thái: đề xuất, chưa code. Người viết plan không sửa code nào.

Người nhận: đọc `AGENTS.md` trước. Làm đúng thứ tự phase. Mỗi phase là một commit (phase lớn: một PR). Cuối mỗi phase chạy "Kiểm tra" và ghi kết quả thật, **kèm số đo trước/sau** (mục 6). Câu nào ghi "hỏi người dùng" thì dừng lại hỏi.

Số dòng `file:line` đọc trên `main` `7a6859a`. Riêng `ui_memory.rs` chỉ có trên nhánh `feat/dom-first-browser` (commit `1769304`, `99cb0de`, `ab4a115`) — P2 phải làm trên nhánh đó hoặc sau khi nhánh đó được merge.

---

## 0. Đánh giá hướng "dùng SQLite + binary" của người dùng

**Kết luận: đúng hướng cho dữ liệu lớn, ghi nhiều, cần lọc/phân trang. Không nên áp cho mọi thứ.**

Cái lợi lớn của SQLite ở đây đến từ **truy vấn theo hàng có index và ghi từng hàng**, không phải từ "binary" tự thân:

| Vấn đề hiện tại | SQLite giải quyết thế nào |
| --- | --- |
| Đọc cả mảng 20.000 bản ghi rồi ghi lại cả mảng cho mỗi câu trả lời (`usage.log`) | `INSERT` 1 hàng; báo cáo dùng `SELECT … WHERE at BETWEEN … GROUP BY` |
| Nạp mọi chat vào RAM lúc khởi động | Mở chat nào đọc trang đó (`LIMIT/OFFSET` hoặc theo `seq`) |
| Một blob toàn cục ghi lại cả khối (`chat.otherTurns`) | Một hàng mỗi message |
| IndexedDB của webview **bị tách theo origin**: mỗi cổng dev (1420, 1430, 1431, 1440…) có kho riêng — đo thấy 25 kho khác nhau trong `%LOCALAPPDATA%\dev.agentdeck.desktop\EBWebView\Default\IndexedDB` | File SQLite do Rust giữ, một chỗ duy nhất theo channel (`~/.agentdeck`, `~/.agentdeck-dev`…) |
| Mỗi get/put qua worker tốn `JSON.stringify` + `JSON.parse` (`prefs-db.ts:130,156`) | Rust đọc/ghi trực tiếp; chỉ phần cần thiết đi qua IPC |

**"Binary" nên hiểu là:** cột có cấu trúc cho thứ cần lọc (thời gian, chat, project, model, số token) + **một cột BLOB nhị phân** cho phần thân lớn. Định dạng BLOB **khác nhau theo loại dữ liệu** — xem mục 2A: MessagePack (+ zstd khi ≥ 512 B) cho dữ liệu lưu lâu; postcard + lz4 cho cache dựng lại được; không BLOB cho log nhỏ (usage).

**Không nên chuyển** (lợi ít, rủi ro cao): prefs nhỏ (layout, tabs, terminal, theme, composer, permissions), accounts/providers (có API key — chuyển là việc bảo mật riêng), localStorage nhỏ (row heights, theme), cache màu cú pháp (đã có cap 3.000, chạy trong worker, không chặn UI). Các file per-project dạng Markdown (memory, plans, artifacts) giữ dạng text để người đọc và git diff được.

**Vấn đề lớn nhất đo được lại không phải IndexedDB mà là code index và rác** (đo 2026-11-05 trên máy người dùng):

| Thư mục | Dung lượng | Nguyên nhân |
| --- | --- | --- |
| `~/.agentdeck/index` | 3,19 GB (68 db, 2,21 GB là file `-wal`) | WAL không bao giờ checkpoint/truncate; không VACUUM; db mồ côi không xoá |
| `~/.agentdeck-dev/index` | 5,40 GB (một file `-wal` 3,07 GB) | Như trên |
| `index/269e377f1cde0b60.db` | 0,89–1,08 GB **dù chỉ còn 4 file, 60 symbol** | Index của thư mục home `C:\Users\boi.vn` (chat "This computer"): quét cả profile, xoá rồi chèn lại liên tục, không VACUUM |
| `index/23ac8bfbe68c8d13.db-wal` | 1,03 GB | Index thư mục tạm/scratch |
| `~/.agentdeck/trash` | 2,07 GB, 2.135 file | File xoá trong Explore (`lib.rs:1547-1553`) **không bao giờ dọn** |
| WebView `Cache` + `Code Cache` | 380 MB + 288 MB | Cache của WebView2 (để nguyên; chỉ ghi nhận) |

⇒ **P0 (dọn index + trash) là việc lợi nhất, làm trước.**

---

## 1. Kiểm kê (rút gọn; chi tiết đọc code đã kiểm)

| Kho | Ở đâu | Định dạng | Kiểu đọc/ghi | Kết luận |
| --- | --- | --- | --- | --- |
| Code index | `apps/desktop/src-tauri/src/index.rs:19-76, 431-538` | SQLite `<home>/index/<fnv(root)>.db`, WAL | Quét lại cây ≤ 2s/lần, ghi lại file đổi | **P0**: checkpoint, VACUUM, chặn root rác, xoá db mồ côi |
| Trash | `lib.rs:1547-1625` (`path_trash`, `path_restore`) | Bản sao file | Mỗi lần xoá | **P0**: dọn > 14 ngày / > 2 GB |
| `usage.log` | `apps/desktop/src/lib/chat/runs/usage.ts:270-291` | IDB `prefs`, 1 mảng ≤ 20.000 | Đọc cả + ghi cả mỗi câu trả lời; UsageView/ComposerQuota đọc cả rồi lọc | **P3** |
| Tin nhắn chat local | `chat/session/state.svelte.ts:479-604` | IDB `chats`, 1 mảng JSON/chat | Khởi động nạp mọi chat (`:585`); lưu debounce 600 ms, có dirty-tracking | **P5** (qua chat ledger) |
| `chat.otherTurns` | `chat/session/history.svelte.ts:708-775` | IDB `chatmeta`, 1 blob toàn cục | Đọc cả lúc khởi động; ghi cả mỗi lượt | **P5** |
| Archive | `chat/content/archive.ts:92-154` | IDB `archive`, 1 bản ghi/message | 1 ghi/message/lượt; không bao giờ dọn; export đọc cả kho | **P5** |
| Index lịch sử (`index.history`) + scan cache | `history.svelte.ts:194-334`; `crates/adapters/src/history/index_cache.rs` | IDB 1 mảng + JSON `~/.agentdeck/history-index/*.json` (đường dẫn cứng, không theo channel) | Đọc/ghi cả mỗi `history_list` (khởi động + sau lượt) | **P6** |
| Transcript provider | `crates/adapters/src/history/mod.rs:261-299` | JSONL của Claude/Codex | Parse cả file, giữ 4 file trong RAM | **P6** (cache trang đã parse) |
| Audit log | `lib.rs:939-1280`; `runs/activity.svelte.ts:146-267` | `audit.jsonl` + `audit.index.json` | 1 append/tool call + đọc-ghi cả file index; prune hằng giờ ghi lại file | **P4** |
| Chat ledger | `crates/adapters/src/chat_index/{schema,store,legacy}.rs`; `src-tauri/src/chat_index.rs`; `chat/index/{dual-write,ledger}.ts` | SQLite `<home>/chats.db` (30 MB) — bảng `meta`, `chats`, `bindings`, `messages(blocks_json TEXT)` | Chỉ ghi khi pref `chat_index.dual_write` bật (mặc định **tắt**, `ledger.ts:1,12`); app không đọc từ nó | **P5**: hoàn tất và dùng nó |
| UI memory | `ui_memory.rs` (nhánh `feat/dom-first-browser`) | JSON trong project | Read-modify-write mỗi lần quét | **P2**: SQLite trong project |
| Image history | `image_history.rs:13-120` | SQLite `<home>/image-history.db` | Mở connection mới mỗi lần | Nhỏ; **P1** dùng chung helper mở DB |
| Error log / debug log / project activity | `error_log.rs`, `flow_log.rs`, `project_activity.rs` | Text/JSONL có xoay vòng hoặc cap | Ổn | Giữ |
| Folder listing cache (`index.files.*`) | `components/files/FileExplorer.svelte:60-84` | IDB `index`, 1 key/thư mục, không dọn | Đọc/ghi mỗi lần mở thư mục | **P7**: thêm dọn (LRU), không chuyển |
| Highlight colour cache | `files/highlight.worker.ts:58-120` | IDB riêng `agentdeck-colours`, cap 3.000 | Trong worker | Giữ |
| Prefs nhỏ, layout, tabs, accounts, providers, localStorage | `app/platform/prefs*.ts`, `layout.svelte.ts`, `connectors.svelte.ts`… | IDB / localStorage | Nhỏ | **Giữ nguyên** |

---

## 2. Quyết định thiết kế (đã chốt, đừng đổi khi chưa hỏi)

1. **Một helper mở SQLite dùng chung** (`apps/desktop/src-tauri/src/sqlite.rs`): đặt PRAGMA đúng một chỗ, migration theo `user_version`, codec BLOB. Mọi DB mới và DB cũ (index, image history, chat ledger) dùng helper này.
2. **PRAGMA chuẩn:** `journal_mode=WAL` (trừ DB trong project — xem 2.4), `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `wal_autocheckpoint=1000`, `journal_size_limit=67108864` (64 MB). Sau mỗi lô ghi lớn: `PRAGMA wal_checkpoint(TRUNCATE)`.
3. **Codec BLOB:** chọn theo loại dữ liệu, xem **mục 2A** (đã chốt). Byte đầu mọi BLOB là mã codec, để đổi định dạng sau này mà không phải migrate lại cả bảng.
   - Số đo thật (2026-11-05, `~/.agentdeck/chats.db`, 1.411 message): JSON 30,4 MB (trung vị 832 B/dòng, p95 109 KB, lớn nhất 734 KB) → nén từng dòng (zlib-6, thay cho zstd vì máy đo không có thư viện zstd cho Python) còn 8,3 MB, **giảm 3,6×**; giải nén + parse 182 ms so với parse thuần 91 ms cho cả 1.411 dòng. Dòng < 200 B (149 dòng) nén chỉ được tổng 2,3 KB ⇒ dòng nhỏ không nén.
4. **DB trong project** (UI memory): `journal_mode=DELETE` để không sinh `-wal`/`-shm` trong thư mục project; `.agentdeck/ui-memory/.gitignore` (đã có) vẫn giữ.
5. **Mỗi lần chuyển một kho:** có migration một lần từ kho cũ → SQLite, đánh dấu xong bằng pref `storage.migrated.<name> = <version>`; giữ kho cũ **chỉ đọc** thêm 1 phiên bản phát hành để rollback, phiên bản sau mới xoá.
6. **IPC:** frontend không bao giờ nhận "tất cả". Mọi lệnh đọc có `limit` (mặc định 50–200) và con trỏ/khoảng thời gian; tổng hợp (sum, group) làm bằng SQL ở Rust.
7. **Không đụng prefs nhỏ, accounts/providers, localStorage** trong plan này. **IndexedDB vẫn được dùng** cho các việc ở nhóm E (mục 2A); plan này không loại bỏ IndexedDB.

---

## 2B. Ưu tiên theo phạm vi (cập nhật 2026-11-05, theo ý người dùng)

Trọng tâm tối ưu là **dữ liệu theo project, theo chat, theo file view**. Project là nguồn tối ưu nên phải **lưu lâu dài**:

| Phạm vi | Dữ liệu | Quy tắc giữ |
| --- | --- | --- |
| **Project** (lâu dài) | Code index, UI memory, project memory, plans, artifacts, lịch sử provider đã quét, usage theo project | Giữ khi thư mục project còn tồn tại. **Không xoá vì lâu không dùng** (đã sửa `e61f801`). Chỉ xoá khi thư mục mất hoặc không còn là project |
| **Chat** (lâu dài) | Tin nhắn, other turns, archive, blocks | Giữ đến khi người dùng xoá chat. Không có TTL |
| **File view** (có thể dựng lại) | Cây thư mục, token màu cú pháp, nội dung file đã đọc | LRU theo dung lượng; xoá khi file/thư mục đổi (mtime) |
| **Trash** (tạm) | File người dùng đã xoá | 14 ngày, 2 GB (đã làm `85830be`) |

**Câu hỏi cần chốt:** trước đây code index nằm ở `~/.agentdeck/index` (ngoài project). Với yêu cầu "project lưu lâu dài", có hai hướng:
- **A. Giữ ở home (hiện tại):** không ghi vào project; mất khi cài lại app hoặc đổi máy. Index tự dựng lại.
- **B. Chuyển vào `<project>/.agentdeck/index.db`:** đi theo project, sống sót khi cài lại; ghi vào thư mục project (dùng `journal_mode=DELETE`, đã có `.gitignore` như UI memory). Nhược: OneDrive/Dropbox đồng bộ file DB.

**Chốt quy tắc giữ/xoá (2026-11-05, người dùng duyệt):**
- Index code của project: xoá khi project không có hoạt động 7 ngày (`last_used`, ghi tối đa mỗi ngày khi có tool gọi index). Mở lại project thì dựng lại index. Thư mục project vẫn còn thì không bị xoá. Triển khai: `index::cleanup_stale`, `IDLE_AFTER`.
- Dữ liệu của project (UI memory, memory, plans, artifacts): không xoá theo thời gian.
- Cache theo ngày (cây thư mục đã liệt kê, token màu cú pháp): giữ tối đa N ngày gần nhất, LRU. Chưa làm; cần chọn N và nơi áp dụng.
- Trash: giữ rule 14 ngày / 2 GB.
- Chưa chốt: "hoạt động" hiện là lần gọi tool index, chưa tính tin nhắn chat.

**Đã chốt: A.** Code index giữ ở home (`~/.agentdeck/index`), không ghi vào project. Phần còn lại của plan (P1 trở đi) chờ duyệt 3 crate `rmp-serde`, `postcard`, `lz4_flex`.

## 2A. Phương án chốt theo từng loại dữ liệu

Không dùng một cách cho mọi thứ. Chọn theo 3 câu hỏi: **dữ liệu sống bao lâu** (lưu lâu / dựng lại được / tạm), **đọc thế nào** (theo trang / tổng hợp / tra từ khoá / đọc cả), **to cỡ nào**.

### Bảng mã codec (byte đầu của mọi BLOB)

| Mã | Tên | Dùng cho | Crate |
| --- | --- | --- | --- |
| `0` | JSON thuần | Chỉ để **đọc** dữ liệu cũ (`blocks_json` hiện có). Không ghi mới | `serde_json` (có) |
| `2` | MessagePack | Giá trị lưu lâu, < 512 B | `rmp-serde` (**thêm**) |
| `3` | MessagePack + zstd level 3 | Giá trị lưu lâu, ≥ 512 B | `rmp-serde` + `zstd` (có ở workspace) |
| `4` | MessagePack + zstd + dictionary | Như `3`, khi bảng đã có dictionary (P1.6) | như trên |
| `10` | postcard + lz4 | **Chỉ cache dựng lại được** | `postcard` (feature `alloc`), `lz4_flex` (**thêm**) |

Lý do:
- **MessagePack cho dữ liệu lưu lâu:** nhị phân, encode/decode nhanh hơn JSON khoảng 1,5–3×, nhỏ hơn 10–25% trước khi nén, và **tự mô tả** (giữ tên trường) nên thêm/bớt trường không làm hỏng dữ liệu cũ. Dùng `rmp_serde::to_vec_named` (giữ tên trường), **không** dùng `to_vec` (mảng theo vị trí, đổi thứ tự trường là hỏng).
- **zstd chỉ khi ≥ 512 B:** dòng nhỏ nén không lợi (số đo ở 2.3) mà tốn CPU.
- **postcard + lz4 cho cache:** nhỏ và nhanh nhất, nhưng không lưu tên trường ⇒ đổi struct là đọc hỏng. Chấp nhận được vì cache sai thì **xoá và dựng lại**: bảng cache có `format_version`; lệch version ⇒ xoá sạch bảng.
- **Dictionary (mã 4):** nhiều dòng nhỏ có chung tên khoá (`kind`, `text`, `tool`…); zstd dictionary làm dòng < 1 KB nhỏ thêm 2–5×. Làm sau (P1.6), chỉ cho `chats.db`.
- **Không dùng** bincode (giống postcard nhưng kém ổn định định dạng), Protobuf (phải duy trì `.proto` cho rất nhiều kiểu block), rkyv/FlatBuffers (file to hơn, gắn phiên bản Rust; lợi đọc không-parse không cần ở quy mô này).

### Nhóm A — Dữ liệu người dùng lưu lâu, ghi nối, đọc theo trang (chat)

Áp dụng: tin nhắn chat (ledger `chats.db`), `other_turns`, archive.

- **Kho:** SQLite `<home>/chats.db`, WAL, một connection/process.
- **Cột có cấu trúc** (để lọc/sắp/phân trang, không giải nén): `chat_id`, `seq`, `role`, `agent`, `model`, `time`, `input_tokens`, `output_tokens`, `preview TEXT` (300 ký tự đầu phần chữ, cho sidebar/tìm nhanh).
- **Thân:** `blocks BLOB` mã `3` (hoặc `2` nếu < 512 B; `4` sau P1.6).
- **Tìm kiếm (làm sau, hỏi trước):** bảng FTS5 `messages_fts(text)` chỉ chứa phần chữ đã bỏ block code/tool output, `content=''` để không nhân đôi dữ liệu.
- **Tối ưu đọc:** mở chat lấy trang 50 theo `seq` giảm dần; trang kế được đọc trước (prefetch) khi người dùng cuộn tới 70% trang hiện tại.
- **Tối ưu ghi:** cả lượt (user + assistant + block cuối) trong **một** transaction ở cuối lượt; trong lúc stream không ghi DB (giữ trong RAM như hiện nay).
- **Không** nén `preview`, `role`, số token (cần đọc mà không giải nén).

### Nhóm B — Log nối thêm, tổng hợp theo thời gian (usage, audit)

- **Kho:** SQLite `<home>/app.db`, WAL.
- **Usage:** **toàn bộ là cột**, không BLOB thân (mỗi dòng ~100 B, nén vô ích). Tổng hợp bằng SQL (`GROUP BY day/model/project`). Index `(at)`, `(model, at)`, `(project, at)`. Giữ theo tuổi (hỏi người dùng con số).
- **Audit:** cột cho thứ lọc (`at`, `day`, `chat`, `project`, `agent`, `tool`, `status`, `ms`, `image`); input/output của tool vào `body BLOB` mã `3`/`2` (output tool có thể rất lớn). Ảnh vẫn là file. Giữ 2 ngày như hiện nay.
- **Tối ưu ghi:** gom các bản ghi đến trong 250 ms thành một transaction (hàng đợi trong Rust), vì audit ghi mỗi tool call.

### Nhóm C — Cache dựng lại được (code index, transcript đã parse, scan lịch sử)

- **Code index:** **giữ nguyên dạng cột** hiện có (`files`, `symbols`, `refs`, `imports`) vì cần truy vấn SQL; chỉ sửa vệ sinh (P0). Không BLOB.
- **Scan lịch sử provider:** bảng cột `history_files(path, len, mtime, provider, session_id, title, updated, cwd)` trong `app.db`; không BLOB.
- **Transcript provider đã parse (P6.3):** bảng `history_pages(path, len, mtime, page, data BLOB)`, `data` mã `10` (postcard + lz4), mỗi trang 50 message; `format_version` lệch ⇒ xoá bảng. Giới hạn tổng 500 MB, xoá theo lần dùng cũ nhất.
- **Tối ưu:** ưu tiên tốc độ hơn kích thước (lz4 giải nén nhanh gấp nhiều lần zstd).

### Nhóm D — Trí nhớ theo project (trong thư mục project)

- **UI memory:** SQLite `<project>/.agentdeck/ui-memory/memory.db`, `journal_mode=DELETE`; cột + bảng từ khoá (P2). `steps` của recipe mã `2` (nhỏ, không nén).
- **Project memory, plans, artifacts:** **giữ file Markdown/JSON** như hiện nay — người dùng đọc, sửa tay và git diff được. Không chuyển sang DB.

### Nhóm E — Giữ IndexedDB (không chuyển)

IndexedDB vẫn là chỗ đúng cho dữ liệu **nhỏ, chỉ giao diện dùng, mất cũng không sao hoặc dựng lại được, đọc ngay trong webview không qua IPC**:

| Dữ liệu | Key / store | Tối ưu cần làm |
| --- | --- | --- |
| Layout, tabs, terminal, composer, workflows, viewer tabs, `permissions.allowed` | `layout`, `tabs`, `terminal`, `prefs`, `permissions` | Không cần. (Tuỳ chọn: debounce 300 ms các `$effect` ghi liên tục) |
| Accounts / providers (có API key) | `accounts`, `providers` | Không đụng trong plan này (là việc bảo mật riêng: chuyển key sang keychain) |
| Transcript tail cache (12 chat × 20 message) | `transcripts` | Giữ: là cache ấm giúp mở chat tức thì trước khi ledger trả trang đầu |
| Chat meta nhỏ (`chat.parents`, `chat.placements`, `chat.hidden`, `chat.mixed`…) | `chatmeta` | Giữ; chỉ `chat.otherTurns` chuyển sang nhóm A |
| Tool screenshot index (`chat.toolImages.*`, chỉ đường dẫn) | `images` | Giữ; dọn khi chat bị xoá |
| Cache màu cú pháp | IDB riêng `agentdeck-colours` (worker) | Giữ (đã cap 3.000, chạy trong worker) |
| Cache danh sách thư mục (`index.files.*`) | `index` | Giữ, **thêm dọn LRU 2.000 key** (P7) |
| Giá model (`usage.prices`, `usage.remote-prices`) | `prefs` | Giữ |
| localStorage: row heights, theme, active session, browser history, profile | localStorage | Giữ |

Quy tắc cho chỗ mới về sau: **IndexedDB** nếu tổng < ~1 MB mỗi key, chỉ UI đọc, không cần lọc/tổng hợp; **SQLite** nếu lớn lên theo thời gian, cần phân trang/lọc/tổng hợp, hoặc Rust/agent cũng cần đọc.

### Nhóm F — File nhị phân (giữ là file)

- Attachments (`<home>/attachments`, WebP, 74,7 MB), ảnh audit, ảnh sinh ra: **giữ file**, không đưa vào DB (DB phình, backup chậm). Thêm dọn: attachment không còn chat nào tham chiếu và cũ hơn 30 ngày (hỏi người dùng con số) — làm trong P7.
- Trash: dọn theo P0.

---

## 3. Các phase

### P0 — Dọn code index và trash (làm trước, lợi nhất)

**Mục đích:** lấy lại ~8–10 GB, giảm I/O nền.

**Việc làm — `index.rs`:**

1. Trong `open()` (`index.rs:52-76`): thêm `PRAGMA journal_size_limit=67108864; PRAGMA wal_autocheckpoint=1000;`. Sau mỗi `refresh()` có ghi (`tx.commit()` `:535`): `PRAGMA wal_checkpoint(TRUNCATE)`.
2. **Chặn root không phải project** (trong `set_root` `:79` và `run` `:576`): không index nếu root là
   - thư mục home người dùng (`dirs::home_dir()` hoặc `crate::home_folder()`), ổ đĩa gốc (`C:\`), `%TEMP%`/`std::env::temp_dir()`, `AppData`,
   - hoặc không có dấu hiệu project nào ở root: `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `*.csproj`, `*.sln`, `composer.json`, `Gemfile`, `deno.json`.
   Tool `code_*` khi đó trả: "This folder is not a project (no .git or project manifest), so it is not indexed. Use Grep/Glob." Có test.
3. **Giới hạn quy mô:** dừng index khi vượt 50.000 file nguồn; ghi vào `code_index_status` "stopped at 50,000 files".
4. **VACUUM:** khi `refresh` xoá > 20% số file hoặc file db > 2× (số file × 64 KB), chạy `VACUUM` ở thread nền sau commit.
5. **Dọn db mồ côi:** khi app khởi động (thread nền, sau 60 s): với mỗi `*.db` trong `index/`, đọc bảng mới `meta(key,value)` có `root` và `last_used` (thêm bảng này, ghi `root` khi `open`, `last_used` khi `run`). Xoá db (+ `-wal`, `-shm`) nếu `last_used` > 30 ngày, hoặc root không còn tồn tại, hoặc root thuộc danh sách chặn ở mục 2. Db cũ chưa có bảng `meta` → coi như mồ côi nếu `mtime` > 30 ngày; còn lại thêm `meta` ở lần mở sau.

**Việc làm — trash (`lib.rs:1547-1625`):**

6. Khi khởi động (thread nền): xoá mục trong `trash/files` cũ hơn 14 ngày; nếu tổng > 2 GB, xoá cũ nhất đến khi < 1,5 GB. **Hỏi người dùng** con số 14 ngày / 2 GB trước khi merge.
7. Không đổi `path_trash` / `path_restore`.

**Test:** chặn root (home, temp, ổ gốc, thư mục không manifest, project có `.git`); `meta` được ghi; db mồ côi bị xoá (tạo db giả có `last_used` cũ); trash prune theo tuổi và theo tổng dung lượng (thư mục tạm).

**Kiểm tra:** `cargo test -p agentdeck-desktop --lib index`, clippy. **Đo:** dung lượng `~/.agentdeck*/index` và `trash` trước/sau một lần khởi động app (ghi vào PR).

---

### P1 — Nền tảng SQLite dùng chung

**Việc làm:**

1. File mới `apps/desktop/src-tauri/src/sqlite.rs`:
   ```rust
   pub enum Journal { Wal, Delete }
   pub fn open(path: &Path, journal: Journal, migrations: &[&str]) -> Result<Connection, String>;
   // Đặt PRAGMA (mục 2.2), chạy migrations[user_version..] trong một transaction, cập nhật user_version.
   pub fn checkpoint(conn: &Connection);            // wal_checkpoint(TRUNCATE), bỏ qua lỗi
   ```
   File mới `apps/desktop/src-tauri/src/codec.rs` (mục 2A):
   ```rust
   /// Dữ liệu lưu lâu: mã 2 (< 512 B) hoặc 3 (≥ 512 B); mã 4 khi có dictionary.
   pub fn encode_keep<T: Serialize>(value: &T, dict: Option<&Dict>) -> Result<Vec<u8>, String>;
   /// Cache dựng lại được: mã 10.
   pub fn encode_cache<T: Serialize>(value: &T) -> Result<Vec<u8>, String>;
   /// Đọc mọi mã (0, 2, 3, 4, 10); mã lạ → lỗi rõ ràng.
   pub fn decode<T: DeserializeOwned>(bytes: &[u8], dicts: &DictSet) -> Result<T, String>;
   ```
   - MessagePack bằng `rmp_serde::to_vec_named` (giữ tên trường). Mã `0` đọc `serde_json`.
   - Thêm vào workspace `Cargo.toml`: `rmp-serde`, `postcard` (features `["alloc"]`, `default-features = false`), `lz4_flex` (default features). Thêm `zstd.workspace = true`, `rmp-serde`, `postcard`, `lz4_flex` vào `apps/desktop/src-tauri/Cargo.toml` (và `crates/adapters` cho P5). **Hỏi người dùng** trước khi thêm crate (ghi rõ 3 crate trong PR).
2. `image_history.rs`: dùng `sqlite::open` một lần và giữ connection sau `Mutex` (thay vì mở mới mỗi lần). Không đổi schema.
3. **P1.5 (đo, không đổi code sản phẩm):** benchmark trong test `#[ignore]` trên 1.000 message thật (mẫu từ `chats.db`): kích thước và thời gian encode/decode của JSON, mã 2, mã 3, mã 10. Ghi bảng vào PR. Nếu mã 3 giải nén + decode chậm hơn JSON thuần quá 1,5× thì báo người dùng trước khi làm P5.
4. **P1.6 (sau P5.2, hỏi trước):** dictionary zstd cho `chats.db`: khi bảng `messages` có ≥ 2.000 dòng, train dictionary 64 KB từ 1.000 mẫu `blocks` nhỏ hơn 4 KB (`zstd::dict::from_samples`), lưu bảng `codec_dicts(id INTEGER PRIMARY KEY, created INTEGER, bytes BLOB)`; dòng mới ghi mã 4 kèm `dict_id` (2 byte sau mã codec). Dictionary cũ không bao giờ xoá khi còn dòng dùng nó.

**Test:** migration chạy đúng thứ tự, mở lại không chạy lại; vòng tròn encode/decode cho mã 2, 3, 4, 10; giá trị < 512 B ra mã 2, ≥ 512 B ra mã 3; mã lạ → lỗi rõ ràng; struct thêm trường mới vẫn đọc được bản ghi mã 2/3 cũ (`#[serde(default)]`); `Journal::Delete` không tạo `-wal`.

---

### P2 — UI memory → SQLite trong project

(Người dùng đã đồng ý 2026-11-05. Làm trên `feat/dom-first-browser`.)

**Việc làm — `ui_memory.rs`:**

1. DB: `<project>/.agentdeck/ui-memory/memory.db`, `Journal::Delete`.
2. Schema (migration 1):
   ```sql
   CREATE TABLE elements (
     id INTEGER PRIMARY KEY, site TEXT NOT NULL, path_key TEXT NOT NULL, selector TEXT NOT NULL,
     name TEXT NOT NULL, kind TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 1,
     ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0,
     last_seen INTEGER NOT NULL, last_ok INTEGER NOT NULL DEFAULT 0,
     UNIQUE (site, path_key, selector));
   CREATE TABLE element_words (word TEXT NOT NULL, site TEXT NOT NULL, element_id INTEGER NOT NULL
     REFERENCES elements(id) ON DELETE CASCADE, PRIMARY KEY (site, word, element_id)) WITHOUT ROWID;
   CREATE TABLE recipes (
     id INTEGER PRIMARY KEY, site TEXT NOT NULL, goal_key TEXT NOT NULL, goal TEXT NOT NULL,
     steps BLOB NOT NULL, seen INTEGER NOT NULL DEFAULT 1, ok INTEGER NOT NULL DEFAULT 0,
     fail INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL, UNIQUE (site, goal_key));
   CREATE TABLE recipe_words (word TEXT NOT NULL, site TEXT NOT NULL, recipe_id INTEGER NOT NULL
     REFERENCES recipes(id) ON DELETE CASCADE, PRIMARY KEY (site, word, recipe_id)) WITHOUT ROWID;
   CREATE INDEX elements_site_seen ON elements(site, last_seen);
   ```
   `steps` dùng `codec::encode_keep(&Vec<String>, None)` (thường ra mã 2, không nén).
3. `remember_elements`: một transaction; `INSERT … ON CONFLICT(site, path_key, selector) DO UPDATE SET seen = seen + 1, last_seen = ?, name = ?, kind = ?`; xoá rồi chèn lại `element_words` của hàng đó chỉ khi `name`/`kind` đổi.
4. `recall`: `SELECT DISTINCT element_id FROM element_words WHERE site = ? AND word IN (…)` (giới hạn 400) → đọc các hàng đó → chấm điểm bằng `score_element` hiện có (giữ nguyên, có test). Recipe tương tự.
5. Prune: sau ghi, nếu `COUNT(*) WHERE site=?` > 1.500 → xoá theo luật hiện có (`prune()`), dùng `ORDER BY (ok >= 3 AND NOT broken), last_seen LIMIT excess`.
6. **Migration từ JSON:** khi mở DB lần đầu, nếu có `*.json` trong thư mục → nhập rồi đổi tên `*.json.imported`. Không có thì bỏ qua.
7. Giữ nguyên chữ ký `remember_elements`, `remember_recipe`, `recall` để `mcp.rs` không đổi.

**Test:** chuyển các test hiện có của `ui_memory.rs` (10 test) sang DB; thêm: nhập JSON cũ; không có `-wal` trong thư mục; 5.000 phần tử, recall < 20 ms (test `#[ignore]` đo, in thời gian).

---

### P3 — Usage log → SQLite

**Việc làm:**

1. DB chung app: `<home>/app.db` (mới, qua `sqlite::open`, WAL). Bảng:
   ```sql
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY, at INTEGER NOT NULL, chat TEXT, agent TEXT, model TEXT, project TEXT,
     ms INTEGER, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
     cost REAL, estimated INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX usage_at ON usage(at);
   CREATE INDEX usage_model_at ON usage(model, at);
   CREATE INDEX usage_project_at ON usage(project, at);
   ```
   Map đúng các trường của `UsageRecord` (`usage.ts:~250-268`) thành cột (nhóm B: không BLOB). Trường nào của `Tokens` chưa có cột thì thêm cột, không gom vào BLOB.
2. Lệnh Tauri: `usage_record(record)`, `usage_range(from, to, filters) -> Vec<UsageRecord>` (giới hạn 5.000), `usage_summary(from, to, group_by: "model"|"agent"|"project"|"day") -> Vec<Row>` (SUM/COUNT trong SQL).
3. `usage.ts`: `recordUsage` gọi `usage_record` (giữ hàng đợi `writing` để giữ thứ tự); `usageLog()` → thay bằng hàm có khoảng thời gian. Sửa `UsageView` và `ComposerQuota` (grep `usageLog`) dùng `usage_summary`/`usage_range` thay vì đọc cả rồi lọc trong JS.
4. Migration một lần: đọc `getPref('usage.log')`, gửi theo lô 1.000 qua `usage_import`, đặt `storage.migrated.usage = 1`, **không xoá** key cũ ở phiên bản này.
5. Giữ cap: xoá hàng cũ hơn 400 ngày (hỏi người dùng con số; hiện cap là 20.000 bản ghi).

**Test Rust:** ghi/đọc khoảng; summary theo model/ngày; import lô; index được dùng (`EXPLAIN QUERY PLAN` chứa `usage_at`).
**Test node:** hàm chuyển `UsageRecord` ↔ payload (thuần).
**Đo:** thời gian `recordUsage` và thời gian mở UsageView với 20.000 bản ghi, trước/sau.

---

### P4 — Audit log → SQLite

**Việc làm:**

1. Bảng trong `app.db`:
   ```sql
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, chat TEXT, project TEXT,
     agent TEXT, tool TEXT, status TEXT, ms INTEGER, image TEXT, body BLOB NOT NULL);
   CREATE INDEX audit_at ON audit(at);
   CREATE INDEX audit_day ON audit(day);
   CREATE INDEX audit_project_at ON audit(project, at);
   ```
   `body` = phần còn lại của dòng JSONL hiện tại, `codec::encode_keep` (mã 2/3). Ảnh vẫn là file trong `audit-images/`. Ghi qua hàng đợi gom 250 ms thành một transaction.
2. Viết lại thân các lệnh hiện có, **giữ tên và chữ ký** để frontend không đổi: `audit_append` (INSERT), `audit_read` (phân trang theo `at`/`id`, giữ con trỏ hiện tại), `audit_days` (`SELECT day, COUNT(*) … GROUP BY day`), `audit_prune` (`DELETE WHERE at < ?`, giữ 2 ngày như cũ), `audit_clear`. Bỏ `audit.index.json`.
3. Migration: nhập `audit.jsonl` (và `.bak-*` nếu có) một lần, đổi tên thành `audit.jsonl.imported`.

**Test:** append/read trang/ngày/prune; nhập JSONL mẫu (copy 20 dòng thật vào test, bỏ dữ liệu nhạy cảm).
**Kiểm tra tay:** tab Tasks (TasksView) hiển thị, load-more, lọc theo ngày như trước.

---

### P5 — Chat: hoàn tất chat ledger (`chats.db`) và đọc từ đó

Phase lớn, chia nhỏ, mỗi bước có cờ để quay lại. **Hỏi người dùng trước khi bắt đầu P5.3.**

1. **P5.1 — Bật dual-write mặc định** (`ledger.ts:12` `chat_index.dual_write`): mặc định `true` cho bản mới; vẫn tắt được. Thêm kiểm tra định kỳ (khi mở chat) so số message IDB và ledger; lệch → ghi `error_log` + đánh dấu chat cần đồng bộ lại.
2. **P5.2 — Lưu blocks dạng BLOB nén:** migration schema 2 trong `crates/adapters/src/chat_index/schema.rs`: thêm cột `blocks BLOB` (`codec::encode_keep`, mã 2/3), `preview TEXT`, `input_tokens INTEGER`, `output_tokens INTEGER`; giữ `blocks_json` để đọc dữ liệu cũ (mã 0); ghi mới vào `blocks`, đọc ưu tiên `blocks`. Một job nền chuyển dần dòng cũ (500 dòng/lần, khi app rảnh) sang `blocks` rồi đặt `blocks_json = ''`; xong thì `VACUUM` một lần. `codec.rs` cần dùng được từ `crates/adapters`: đặt module codec trong `crates/adapters` (crate desktop đã phụ thuộc nó) thay vì trong `src-tauri`. Chạy `PRAGMA journal_mode=WAL` + checkpoint (hiện "No WAL", một connection sau mutex — giữ một connection, thêm WAL).
3. **P5.3 — Đọc chat từ ledger:** mở chat → `chat_open(id, before_seq, limit=50)`; cuộn lên → trang tiếp. Bỏ việc nạp mọi `local.messages.*` lúc khởi động (`state.svelte.ts:585`); sidebar đọc danh sách chat từ bảng `chats`. IDB `local.messages.*` thành bản sao chỉ đọc 1 phiên bản để rollback.
4. **P5.4 — `chat.otherTurns` và archive vào ledger:** bảng `other_turns(chat_id, seq, blocks BLOB)` và `archive(chat_id, msg_id, at, tokens, snapshot BLOB)`; thay `history.svelte.ts:708-775` và `archive.ts:92-154`. Thêm cap cho archive (hỏi người dùng: theo tuổi hay theo dung lượng).
5. **P5.5 — Dọn:** phiên bản sau khi ổn định, xoá các store IDB `chats`, `archive`, key `chat.otherTurns`.

**Test:** test hiện có của `crates/adapters/src/chat_index/tests.rs` phải pass; thêm test schema 2 đọc cả hàng cũ (`blocks_json`) và mới (`blocks`); phân trang; `other_turns`/`archive`.
**Đo:** thời gian khởi động app (đến khi sidebar hiện), RAM của WebView sau khởi động, thời gian mở một chat 2.000 message — trước/sau.

---

### P6 — Index lịch sử provider và cache transcript

1. Chuyển scan cache `~/.agentdeck/history-index/{claude,codex}.json` (`crates/adapters/src/history/index_cache.rs`) vào bảng `history_files(path PRIMARY KEY, len, mtime, provider, session_id, title, updated, cwd, …)` trong `app.db`. **Sửa luôn lỗi đường dẫn cứng**: dùng home theo channel như mọi chỗ khác.
2. `history_list`: chỉ đọc/ghi các hàng có `len`/`mtime` đổi; trả về theo trang. Frontend `index.history` (IDB, `history.svelte.ts:194-334`) bỏ, đọc từ lệnh này.
3. (Tuỳ chọn, hỏi trước) Cache trang đã parse của transcript provider: bảng `history_pages(path, len, mtime, page, used INTEGER, data BLOB)` + `meta(format_version)` trong `app.db`; `data` là `codec::encode_cache` (mã 10, postcard + lz4), mỗi trang 50 message. Khoá hợp lệ khi `len` và `mtime` khớp file; lệch thì xoá các trang của file đó. `format_version` lệch thì xoá cả bảng. Cap 500 MB, xoá theo `used` cũ nhất. Mở lại một phiên đã parse không phải parse cả file JSONL (`history/mod.rs:261-299`).

**Test:** quét lần 2 không đổi gì thì không ghi; file đổi `mtime` thì cập nhật đúng một hàng.

---

### P7 — Việc nhỏ, không chuyển kho

1. `index.files.<root>|<dir>` (`FileExplorer.svelte:60-84`): thêm dọn LRU (giữ 2.000 key mới nhất) — vẫn ở IndexedDB, không chuyển sang SQLite.
2. Attachments (`<home>/attachments`): dọn file không còn chat nào tham chiếu và cũ hơn N ngày (câu hỏi 8). Tham chiếu lấy từ ledger (sau P5) hoặc quét `local.messages.*` (trước P5).
3. `chat.toolImages.*` (IndexedDB `images`): xoá key khi chat bị xoá.
4. Ghi chú trong `docs/development/storage.md` (một trang ngắn): bảng mục 2A sau khi xong và quy tắc chọn IndexedDB / SQLite / file, để người sau chọn đúng kho cho dữ liệu mới.

---

## 4. Thứ tự và phụ thuộc

```
P0 (index + trash)   ─ độc lập, làm trước
P1 (helper)          ─► P2 (UI memory) ─► (merge feat/dom-first-browser)
P1                   ─► P3 (usage) ─► P4 (audit) ─► P6 (history)
P1                   ─► P5.1 ─► P5.2 ─► [hỏi] P5.3 ─► P5.4 ─► P5.5 (phiên bản sau)
P7                   ─ bất kỳ lúc nào
```

Ước lượng thô: P0 1 ngày, P1 0,5 ngày, P2 1 ngày, P3 1 ngày, P4 1 ngày, P5 4–6 ngày, P6 1–2 ngày, P7 0,5 ngày.

---

## 5. Rủi ro

- **Mất dữ liệu khi migration:** luôn giữ kho cũ chỉ đọc 1 phiên bản; migration idempotent (chạy lại không nhân đôi: dùng khoá tự nhiên/`ON CONFLICT DO NOTHING`).
- **IPC chậm hơn IDB cho thao tác rất nhỏ:** chỉ chuyển kho lớn; gom lô ghi; không gọi lệnh trong `$derived`.
- **Khoá DB giữa nhiều cửa sổ/agent:** `busy_timeout` + một connection mỗi DB trong process.
- **DB trong project bị đồng bộ qua OneDrive/Dropbox:** dùng `Journal::Delete`; nếu lỗi `SQLITE_BUSY` kéo dài, báo lỗi rõ và không chặn agent (trả về "memory unavailable").
- **P0 xoá index đang dùng:** chỉ xoá theo `last_used` > 30 ngày hoặc root chặn; root đang mở trong app thì không xoá.

---

## 6. Definition of Done chung

- `cargo clippy --workspace -- -D warnings` sạch (VS dev shell; tắt app đang chạy từ cùng worktree trước khi build).
- Test Rust của module đổi pass; `cargo test -p ag-adapters` pass (cần `C:\Program Files\Git\usr\bin` ở **cuối** PATH); `pnpm --filter desktop check` 0 lỗi.
- **Số đo trước/sau** cho phase đó (dung lượng, thời gian, RAM) ghi trong PR; đo trên bản build `pnpm dev` cùng máy.
- Không `unwrap()` ngoài test. Mọi migration có test.
- Không xoá kho cũ trong cùng phiên bản với migration.
- File permission mới (lệnh Tauri mới) commit; file toml chỉ đổi line ending thì không.
- Release notes "What's new" + "Fixes".

---

## 7. Câu hỏi còn mở

1. **P0:** dọn trash: 14 ngày / 2 GB được không?
2. **P0:** có xoá ngay các db index của thư mục home/temp hiện có (≈ 3 GB) ở lần chạy đầu không?
3. **P3:** giữ usage theo tuổi (400 ngày?) hay theo số bản ghi (20.000 như hiện tại)?
4. **P5:** đồng ý bật dual-write mặc định (P5.1) và chuyển đọc sang ledger (P5.3)?
5. **P5.4:** cap cho archive?
6. **P1:** đồng ý thêm 3 crate `rmp-serde`, `postcard`, `lz4_flex`?
7. **P1.6:** làm zstd dictionary cho `chats.db` không?
8. **P7:** dọn attachment không còn chat nào dùng sau bao nhiêu ngày?

---

## 8. Danh sách file dự kiến đổi

| File | Phase |
| --- | --- |
| `apps/desktop/src-tauri/src/index.rs` | P0 |
| `apps/desktop/src-tauri/src/lib.rs` (trash prune lúc khởi động; lệnh mới usage/audit/history) | P0, P3, P4, P6 |
| `apps/desktop/src-tauri/src/sqlite.rs` (mới), `crates/adapters/src/codec.rs` (mới), `Cargo.toml` workspace + `apps/desktop/src-tauri/Cargo.toml` + `crates/adapters/Cargo.toml` (`zstd`, `rmp-serde`, `postcard`, `lz4_flex`) | P1 |
| `apps/desktop/src-tauri/src/image_history.rs` | P1 |
| `apps/desktop/src-tauri/src/ui_memory.rs` | P2 |
| `apps/desktop/src-tauri/src/usage.rs` (mới) + `src/lib/chat/runs/usage.ts`, `UsageView.svelte`, `ComposerQuota*.svelte` | P3 |
| `apps/desktop/src-tauri/src/audit.rs` (tách từ `lib.rs:939-1280`) | P4 |
| `crates/adapters/src/chat_index/{schema,store}.rs`, `src-tauri/src/chat_index.rs`, `src/lib/chat/index/*.ts`, `chat/session/{state,history}.svelte.ts`, `chat/content/archive.ts` | P5 |
| `crates/adapters/src/history/{index_cache,mod}.rs`, `chat/session/history.svelte.ts` | P6 |
| `components/files/FileExplorer.svelte` | P7 |
| `permissions/autogenerated/*.toml` mới | P3–P6 |
| `docs/…` (trang kho lưu trữ), `docs/release-notes/vX.Y.Z.md` | cuối |
