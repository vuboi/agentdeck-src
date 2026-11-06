# Plan: Memory theo project, browser DOM-first có trí nhớ UI, code index nhanh hơn

Ngày: 2026-11-05. Trạng thái: đề xuất, chưa code. Người viết plan không sửa code nào.

Người nhận: đọc `AGENTS.md` trước. Làm đúng thứ tự phase. Mỗi phase là một commit riêng. Cuối mỗi phase chạy các lệnh ở mục "Kiểm tra" của phase đó và ghi kết quả thật vào PR. Câu nào ghi "hỏi người dùng" thì dừng lại hỏi.

Số dòng `file:line` đọc trên nhánh `feat/spec-driven-plans` (commit `f982f00` = `main` `7a6859a` + 3 commit plans). Các file trong plan này không bị 3 commit đó đụng, trừ `run.svelte.ts` (lệch vài dòng). Lệch thì tìm theo tên hàm.

---

## 0. Mục tiêu

1. **Mỗi project một trí nhớ riêng, nằm trong thư mục project** (người dùng chốt 2026-11-05: "mỗi project là 1 memory riêng", không lưu trong AgentDeck). Áp cho cả memory dự án lẫn trí nhớ UI của Preview.
2. **Browser Preview thao tác bằng DOM trước, ảnh sau.** Agent dùng `browser_recall` → `browser_elements` / `browser_find` → `browser_click_element`. Chỉ chụp ảnh khi cần nhìn thật (canvas, lỗi hiển thị, kiểm tra giao diện) hoặc khi DOM không đủ.
3. **Trí nhớ UI tự cập nhật.** Bấm thành công thì tăng điểm; selector hỏng thì tự tìm lại và ghi selector mới. Session mới trong cùng project dùng lại ngay.
4. **Memory dự án dùng được qua MCP và tới cả worker.** Đọc theo mục, không chỉ 3.000 ký tự đầu.
5. **Code index sẵn sàng sớm và trả lời nhanh.** Index lần đầu khi mở project, không đợi tool call; không quét lại cả cây mỗi lần gọi.

### Ngoài phạm vi

- Không đổi cách lưu code index (SQLite trong thư mục home của AgentDeck). Đó là **cache dựng lại được**, không phải trí nhớ; xoá đi thì tự dựng lại. Nếu người dùng muốn index nằm trong project thì hỏi riêng.
- Không tự sửa `.gitignore` của project. Hướng dẫn người dùng tự quyết có commit `.agentdeck/` hay không.
- Không tích hợp MCP `codegraph` bên ngoài (xem P6).
- Không chạy agent thật trong test tự động.

---

## 1. Hiện trạng (đã đọc trong code)

### 1.1 Trí nhớ UI của Preview (page memory)

| Chỗ                                                                  | Đang làm gì                                                                           | Vấn đề                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/lib/browser/page-memory.ts:8-10`                   | IndexedDB `agentdeck-pages` trong webview của app, tối đa 3.000 phần tử mỗi site      | **Lưu trong AgentDeck**, không theo project, không thấy được, mất khi xoá dữ liệu app                           |
| `apps/desktop/src/lib/browser/page-memory-core.ts:45-51` `siteOf`    | Khoá theo `hostname`                                                                  | **Bỏ cổng**: mọi dev server `localhost:*` của mọi project dùng chung một "site" → trộn trí nhớ giữa các project |
| `page-memory-core.ts:113-128` `scoreElement`                         | Chấm theo từ khoá, trang hiện tại, số lần thấy                                        | Không có số lần thành công/thất bại; selector hỏng vẫn được gợi ý                                               |
| `apps/desktop/src/lib/browser/page-memory-bridge.ts`                 | Rust gửi event `page-memory`, webview trả lời qua `page_memory_reply`                 | Vòng qua webview chỉ để đọc/ghi một file; timeout 8s (`page_memory.rs:17`)                                      |
| `apps/desktop/src-tauri/src/page_memory.rs:25-48`                    | Tool `browser_recall`, `browser_remember`                                             | Mô tả tốt ("Use it BEFORE taking a screenshot")                                                                 |
| `page_memory.rs:102-135` `MEMO_JS`                                   | Sinh selector ổn định (id, data-testid, aria-label, name…) cho phần tử agent vừa thấy | Tốt, giữ nguyên                                                                                                 |
| `apps/desktop/src-tauri/src/mcp.rs:342-359` `remember_seen`          | Lưu phần tử sau `browser_elements` / `browser_find`                                   | Không lưu khi bấm theo `text`/`selector` thành công                                                             |
| `mcp.rs:361-441` `memory_tool`                                       | Recall + kiểm tra selector còn trên trang (`verify_js`)                               | Không ghi lại khi selector hết hiệu lực                                                                         |
| `mcp.rs:497-531`                                                     | `browser_click_element`: locate → click → chờ 400ms → `OVERLAY_NOTE_JS`               | Trả lời chỉ có overlay; không nói URL đổi, thông báo/toast, lỗi console mới → agent chụp ảnh để biết kết quả    |
| `apps/desktop/src/lib/chat/session/delegate-task.svelte.ts:66, 1870` | Khởi động bridge page memory                                                          | Sẽ bỏ khi chuyển sang Rust                                                                                      |

### 1.2 Câu hướng dẫn khiến agent chụp ảnh nhiều

| Chỗ                                                                        | Câu hiện tại                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp.rs:28` mô tả `browser_screenshot`                                     | "**Look before and after every action.**"                                                                                                                          |
| `mcp.rs:952` `instructions` MCP                                            | "Use these tools to see it and act on it as a user would: **screenshot, then click / type / scroll, then screenshot again**…"                                      |
| `mcp.rs:39` mô tả `browser_open`                                           | "…**then screenshot and act** in the same turn."                                                                                                                   |
| `mcp.rs:31` `browser_click`                                                | Bấm theo toạ độ "of the screenshot" — đúng, nhưng nên ghi là cách cuối                                                                                             |
| `crates/adapters/src/agent/claude.rs:25` và `codex.rs:27` (`WORK_CONTEXT`) | "Then keep going in this same turn: **screenshot, act on the page, screenshot again**." — prompt hệ thống của Claude và Codex                                      |
| `crates/adapters/src/agent/claude.rs:113`                                  | "…with the agentdeck tools: **browser_screenshot to look, browser_click** / browser_fill … (coordinates are CSS pixels of th[e screenshot])" — dạy bấm theo toạ độ |
| `apps/desktop/src-tauri/src/custom_chat.rs:615-617`                        | Đã đúng hướng DOM-first ("Do not guess coordinates", "After each action call browser_elements or browser_dom") — dùng làm mẫu                                      |

### 1.3 Memory dự án

| Chỗ                                                        | Đang làm gì                                                                                                                       | Vấn đề                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/desktop/src/lib/chat/content/project-memory.ts:6-28` | `.agentdeck/memory.md` trong project; 3.000 ký tự đầu vào prompt; dặn agent tự thêm bullet, đề xuất vào `.agentdeck/proposals.md` | Đã **theo project, trong project** — đúng hướng                |
| `apps/desktop/src-tauri/src/project_memory.rs:10, 47-92`   | Đọc/ghi, tối đa 64 KB, chỉ là lệnh Tauri                                                                                          | **Không có tool MCP**; agent phải tự mở file                   |
| `run.svelte.ts` (khối `memoryNote`, ~`:1096-1111`)         | Chỉ đưa memory vào khi `!resume && !isWorkerChat(...)`                                                                            | **Worker không nhận memory** → làm lại từ đầu, lặp lỗi đã biết |
| `project-memory.ts:19`                                     | Cắt cứng ở 3.000 ký tự                                                                                                            | Phần sau không có mục lục → agent không biết có gì để mở       |

### 1.4 Code index

| Chỗ                                                    | Đang làm gì                                                            | Vấn đề                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/index.rs:16, 150-180`      | Tree-sitter cho TS/JS/Svelte/Vue/Rust/Python/Go/Java/C#                | Chất lượng parse tốt                                                                                                                                      |
| `index.rs:52-76` `open`                                | SQLite ở `<home>/<channel>/index/<hash>.db`                            | Cache, giữ nguyên                                                                                                                                         |
| `index.rs:79-92` `set_root`                            | Ghi root của chat và **chạy index nền**                                | Chỉ được gọi khi agent kết nối MCP có `?root=` (`bridge.rs:405-406`) hoặc custom chat có cwd (`custom_chat.rs:741`). **Mở project trong app không index** |
| `index.rs:576-578` `run`                               | Mỗi tool `code_*` gọi `refresh(&root)` **đồng bộ**                     | Lần đầu: quét + parse cả repo trong lượt gọi tool đầu tiên → chậm, có thể timeout                                                                         |
| `index.rs:21, 431-538` `refresh`                       | `RECHECK = 2s`; quá 2s là **đi lại cả cây** (stat mọi file) dưới mutex | Repo lớn: mỗi lần gọi đều chậm; background refresh và tool call tranh mutex                                                                               |
| `index.rs:402-420` `skipped`                           | Bỏ node_modules, target, dist, .git… + `.gitignore` (crate `ignore`)   | Tốt                                                                                                                                                       |
| `index.rs:530-534`                                     | Xoá dòng của file đã bị xoá                                            | Đúng (không phải lỗi)                                                                                                                                     |
| UI                                                     | Không có trạng thái index (đang chạy / bao nhiêu file / lỗi)           | Người dùng không biết index đã sẵn sàng chưa                                                                                                              |
| `docs/bugs/2026-11-04-command-code-run-project.md:160` | Một số project có MCP ngoài `codegraph`, `serena` trong `.mcp.json`    | Trùng chức năng với `code_*`; agent có thể gọi cả hai                                                                                                     |

### 1.5 Routing

- `apps/desktop/src/lib/agents/task-roles.ts:170` `routesOf`: route cố định theo vai trò trong Settings.
- `apps/desktop/src/lib/tasks/scorecard.ts`: chỉ hiển thị trong `UsageView`, không dùng để gợi ý route.
- Đủ dùng; chỉ đề xuất nhỏ ở P7 (tuỳ chọn).

---

## 2. Quyết định thiết kế (đã chốt, đừng đổi khi chưa hỏi)

1. **Thư mục trí nhớ của project:** `<project>/.agentdeck/`. Đã dùng cho `memory.md`, `proposals.md`. Thêm `ui-memory/`.
2. **Project của một chat** lấy bằng `crate::index::root_of(chat, &json!({}))` (đăng ký qua `set_root`). Không có project → **không lưu gì** (không có chỗ dự phòng trong app data), tool trả lời rõ "no project folder for this chat".
3. **Khoá site trong một project:**
    - `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` → `local` (cổng đổi mỗi lần chạy dev nhưng vẫn là app của project).
    - Tên miền thật → hostname bỏ `www.` (như `siteOf` hiện tại).
4. **Rust giữ toàn bộ lưu trữ UI memory.** Bỏ IndexedDB và bridge webview. Logic chấm điểm chuyển từ `page-memory-core.ts` sang Rust (giữ đúng công thức, có test).
5. **Không migrate dữ liệu IndexedDB cũ.** Người dùng nói đó là lưu tạm. Sau khi chuyển, xoá DB `agentdeck-pages` một lần (P2.8).
6. **Ảnh là cách cuối.** Mọi mô tả tool và hướng dẫn nói cùng một thứ tự: recall → elements/find → click_element → đọc kết quả trả về → chỉ chụp khi cần nhìn.

---

## 3. Định dạng file trí nhớ UI

`<project>/.agentdeck/ui-memory/<site>.json` (ví dụ `local.json`, `github.com.json`). Tên file: site đã chuẩn hoá, chỉ `[a-z0-9.-]`, tối đa 100 ký tự.

```json
{
    "version": 1,
    "site": "local",
    "elements": [
        {
            "selector": "button[aria-label=\"Export\"]",
            "name": "Export",
            "kind": "button",
            "pathKey": "/reports/:id",
            "seen": 7,
            "ok": 5,
            "fail": 0,
            "lastSeen": 1793886000000,
            "lastOk": 1793886000000
        }
    ],
    "recipes": [
        {
            "goal": "export report csv",
            "steps": [
                "open /reports/:id",
                "click \"Export\" (button[aria-label=\"Export\"])",
                "click \"CSV\" (#format-csv)"
            ],
            "seen": 2,
            "ok": 2,
            "fail": 0,
            "lastUsed": 1793886000000
        }
    ]
}
```

Luật:

- Khoá phần tử: `(pathKey, selector)`. Khoá recipe: `goal` viết thường, trim.
- Tối đa 1.500 phần tử và 200 recipe mỗi site. Quá thì xoá theo `lastSeen` / `lastUsed` cũ nhất, nhưng **giữ** phần tử có `ok ≥ 3` trừ khi `fail > ok`.
- Phần tử có `fail ≥ 3` và `fail > ok` coi là hỏng: không gợi ý; quá 7 ngày kể từ `lastSeen` thì xoá.
- Ghi file nguyên tử (temp + rename) như `plans.rs::atomic_write`; có `Mutex` theo đường dẫn file. Kích thước file tối đa 2 MB; quá thì prune trước khi ghi.
- File JSON có thụt lề 1 dấu cách, phần tử sắp theo `pathKey` rồi `selector` để diff git gọn (nếu người dùng commit).

---

## 4. Các phase

### Phase 1 — Hướng dẫn DOM-first (chỉ đổi chữ)

**Mục đích:** giảm chụp ảnh ngay, không đổi hành vi code.

**Việc làm:**

1. `mcp.rs:28` `browser_screenshot`: thay câu "Look before and after every action." bằng:
   "Use it only when you must see the page: a visual check, a layout or colour problem, a canvas or chart, or when browser_elements and browser_find cannot find what you need. To find and operate controls use browser_recall, browser_elements, browser_find and browser_click_element instead; they cost far fewer tokens."
2. `mcp.rs:39` `browser_open`: thay "then screenshot and act in the same turn" bằng "then call browser_recall (what this project remembers about the page) or browser_elements, and act in the same turn."
3. `mcp.rs:31` `browser_click`: thêm "Last resort: prefer browser_click_element, which finds the element itself."
4. `mcp.rs:952` `instructions`: thay đoạn đầu về Preview bằng thứ tự:
   "To act on the page: browser_recall first (what this project remembers about the site), else browser_elements or browser_find; then browser_click_element / browser_fill / browser_type. Each click answers what changed (address, dialogs, messages, console errors), so you rarely need a screenshot. Take browser_screenshot only to check how something looks or when the DOM tools cannot find it. When a goal is reached, save the steps with browser_remember."
   Giữ nguyên phần sau câu đó (record, computer use, code_*, delegate, plans, artifacts).
5. `custom_chat.rs:615-617`: thêm "Call browser_recall before browser_elements." Câu "After each action call browser_elements or browser_dom again" đổi thành "After each action read what the click answered; call browser_elements again only when you need the new controls."
6. `crates/adapters/src/agent/claude.rs:25` và `codex.rs:27`: thay "Then keep going in this same turn: screenshot, act on the page, screenshot again." bằng "Then keep going in this same turn: browser_recall or browser_elements, act with browser_click_element / browser_fill, read what each action answers; screenshot only to check how it looks."
7. `crates/adapters/src/agent/claude.rs:113`: đổi thứ tự liệt kê thành "browser_recall / browser_elements / browser_find to find controls, browser_click_element / browser_fill / browser_key to act, browser_screenshot only to see how the page looks"; giữ browser_click (toạ độ) ở cuối, ghi "last resort".
8. Chạy test của crate adapters nếu có test so khớp chuỗi prompt: `cargo test -p ag-adapters`.

**Test:** test hiện có trong `mcp.rs` / `page_memory.rs` kiểm tên và mô tả tool (`the_tools_are_named_and_described`) — cập nhật chuỗi nếu test so khớp nguyên văn.

**Kiểm tra:** `cargo test -p agentdeck-desktop --lib mcp`, `cargo test -p agentdeck-desktop --lib page_memory`, clippy.

**Kiểm tra tay:** trong app, chat với Claude: "mở http://localhost:<port> rồi bấm nút X". Đếm số lần `browser_screenshot` trong transcript trước và sau thay đổi (ghi vào PR). Mục tiêu: 0–1 ảnh cho một thao tác bấm đơn giản.

---

### Phase 2 — UI memory lưu trong project (Rust), bỏ IndexedDB

**Việc làm — Rust, file mới `apps/desktop/src-tauri/src/ui_memory.rs`:**

1. Kiểu dữ liệu `SiteMemory { version, site, elements: Vec<Element>, recipes: Vec<Recipe> }` (serde, `rename_all = "camelCase"`).
2. Hàm thuần (có test):
    - `site_key(url: &str) -> Option<String>` theo quyết định 2.3.
    - `path_key(url: &str) -> String` — port đúng `pathKeyOf` (`page-memory-core.ts:54-74`).
    - `words(text: &str) -> Vec<String>` — port `wordsOf` (bỏ dấu, `đ`→`d`, stop words, tối đa 12).
    - `score_element(el, query_words, path_key) -> f64` — port `scoreElement`, **thêm**: `+ min(2, ok*0.5)`, phần tử hỏng (luật mục 3) trả 0.
    - `score_recipe(...)` — port `scoreRecipe`, recipe có `fail > ok` trả 0.
3. Hàm lưu trữ:
    - `file_for(root: &Path, site: &str) -> Result<PathBuf, String>`: `<root>/.agentdeck/ui-memory/<site>.json`, kiểm tra tên an toàn, canonicalize thư mục cha nằm trong root (mẫu `plans.rs::path_for`).
    - `load(root, site) -> SiteMemory` (không có file → rỗng; JSON hỏng → đổi tên file thành `<site>.json.bad-<ts>` và bắt đầu rỗng, log `tracing::warn!`).
    - `save(root, &SiteMemory)` nguyên tử + prune (mục 3).
    - `remember_elements(root, url, Vec<PageElement>)`, `remember_recipe(root, url, goal, steps)`, `recall(root, url, query, limit) -> RecallResult`, `mark(root, url, selector, ok: bool)`.
    - Cache trong RAM `HashMap<PathBuf, (mtime, SiteMemory)>`, đọc lại khi mtime đổi (agent khác hoặc người dùng sửa file).
4. `page_memory.rs`: giữ tên tool và mô tả (`browser_recall`, `browser_remember`). Thay `ask()`/`store()` (event qua webview) bằng gọi thẳng `ui_memory`. Xoá `PENDING`, `page_memory_reply`, `WAIT`. Giữ `MEMO_JS`, `verify_js`, `format_recall` (đổi chữ "AgentDeck's memory of this site" → "this project's memory of this site").
5. `mcp.rs:343-359` `remember_seen` và `mcp.rs:362-441` `memory_tool`: lấy `root` bằng `crate::index::root_of(chat, &json!({}))`. Không có root → `remember_seen` không làm gì; `memory_tool` trả lỗi "This chat has no project folder, so nothing is remembered. Use browser_elements or browser_find."
6. `lib.rs`: bỏ `page_memory::page_memory_reply` khỏi `generate_handler!` (`lib.rs:~2996`); thêm `mod ui_memory;`. File permission `page_memory_reply.toml` sẽ thành thừa — xoá file đó (build không sinh lại vì lệnh đã bỏ); kiểm tra `build.rs` không lỗi.
7. **Frontend:** xoá `page-memory.ts`, `page-memory-bridge.ts`; giữ `page-memory-core.ts` + test **chỉ nếu** còn chỗ dùng (grep). Nếu không còn chỗ dùng → xoá cả hai, vì logic đã sang Rust. Bỏ import và `void startPageMemoryBridge()` ở `delegate-task.svelte.ts:66, 1870`. Tìm chỗ Settings hiển thị `memoryStats` / nút "forget" (grep `forgetSite`, `memoryStats`); hiện không có chỗ gọi ngoài bridge → không cần UI thay thế.
8. **Dọn IndexedDB cũ:** một lần khi app khởi động, `indexedDB.deleteDatabase('agentdeck-pages')` (bọc try/catch), đánh dấu bằng pref `pageMemory.migrated = true` để không chạy lại. Đặt cạnh chỗ khởi động bridge cũ.

**Test Rust (`ui_memory.rs` `mod tests`):**

- `site_key`: `http://localhost:5173/x` và `http://127.0.0.1:4301/` → `local`; `https://www.GitHub.com/a` → `github.com`; `file:///x` → None.
- `path_key`: số, UUID, hex dài, id trộn → `:id` (copy các ca trong `page-memory-core.test.ts`).
- `words`: tiếng Việt có dấu (`"Xuất báo cáo"` → `["xuat","bao","cao"]`), stop words, tối đa 12.
- Ghi rồi đọc: phần tử thấy 2 lần → `seen = 2`; recipe cùng goal thay steps, `seen` tăng.
- Prune: 1.600 phần tử → còn ≤ 1.500, phần tử `ok ≥ 3` còn giữ.
- Phần tử hỏng không được gợi ý.
- JSON hỏng → file `.bad-*` được tạo, load trả rỗng.
- Hai project khác nhau, cùng `localhost` → hai file khác nhau, không trộn.
- `file_for` từ chối site có `..` hoặc ký tự lạ.

**Kiểm tra:** clippy, `cargo test -p agentdeck-desktop --lib ui_memory`, `cargo test -p agentdeck-desktop --lib page_memory`, `pnpm --filter desktop check`.

**Kiểm tra tay:**

1. Project A chạy dev server ở localhost. Bảo agent `browser_elements` → file `A/.agentdeck/ui-memory/local.json` xuất hiện, có phần tử.
2. Project B cũng ở localhost (cổng khác) → `browser_recall` không thấy phần tử của A.
3. Session mới trong A: `browser_recall "<tên nút>"` trả selector, không cần `browser_elements`.

---

### Phase 3 — Tự cập nhật trí nhớ và kết quả bấm đủ để khỏi chụp ảnh

**Việc làm — `mcp.rs` (khối `browser_click_element`, `:497-531`) và `browser_fill`:**

1. **Ghi kết quả:** sau khi bấm thành công theo `selector` hoặc `text` hoặc `index`, lấy selector ổn định của phần tử vừa bấm (chạy phần sinh selector của `MEMO_JS` cho đúng phần tử đó — tách hàm `selector(el)` thành helper dùng chung trong `PAGE_HELPERS`) rồi `ui_memory::mark(root, url, selector, ok=true)` và `remember_elements` cho phần tử đó.
2. **Tự sửa khi hỏng:** khi `locate_js` trả `element not found` cho một `selector`:
    - `mark(..., ok=false)`.
    - Nếu có `name` của selector trong memory → chạy `find_js(name)` (đã có, `mcp.rs:312`) và trả về trong cùng câu trả lời: "The remembered selector no longer matches. Elements named like it now: 1. … Use browser_click_element with one of these numbers." Kết quả find được `remember_seen` như bình thường → selector mới được lưu.
    - Không tự bấm phần tử thay thế (tránh bấm nhầm).
3. **Câu trả lời sau khi bấm** (thay `OVERLAY_NOTE_JS` bằng `AFTER_ACTION_JS` mới, giữ phần overlay):
    - `location.href` trước và sau (Rust đọc trước khi bấm) → "Address changed to …" nếu đổi.
    - `document.title` nếu đổi.
    - Overlay đang mở (giữ logic cũ).
    - Thông báo mới: text của `[role=alert]`, `[role=status]`, `[aria-live]`, `.toast`, `.Toastify__toast`, `[data-sonner-toast]` xuất hiện sau khi bấm (so với danh sách trước khi bấm), tối đa 3, mỗi cái ≤ 120 ký tự.
    - Phần tử đang focus (tag + name) nếu là ô nhập.
    - Số lỗi console mới từ lúc bấm (dùng route `/console` có sẵn, lấy `level=error`, đếm theo thời điểm).
    - Tổng câu trả lời ≤ 600 ký tự.
4. Làm tương tự (mục 3, rút gọn: address + messages + errors) cho `browser_fill`, `browser_key` (Enter), `browser_type`.

**Test:** tách phần định dạng câu trả lời thành hàm thuần `after_action_text(before: &AfterState, after: &AfterState) -> String` và test: không đổi gì → "No visible change."; đổi URL; có toast; có lỗi console; cắt 600 ký tự.

**Kiểm tra tay:** trên một app có form: điền và submit bằng `browser_fill` + `browser_click_element` → câu trả lời có thông báo thành công/lỗi của form, agent không cần chụp ảnh. Đổi `aria-label` của một nút trong code, reload, `browser_click_element selector=<cũ>` → câu trả lời liệt kê phần tử thay thế; file memory có `fail` tăng và selector mới.

---

### Phase 4 — Gợi ý trí nhớ ngay khi mở trang

**Việc làm:**

1. Sau `browser_open` và trong `browser_page`: nếu project có memory cho site → thêm vào câu trả lời 1 dòng: `This project remembers <N> controls and these goals on this site: "<goal1>", "<goal2>", "<goal3>". Use browser_recall.` (tối đa 5 goal, sắp theo `lastUsed`).
2. Không tự đổ danh sách phần tử (tốn token); chỉ nói có gì để recall.

**Test:** hàm thuần tạo dòng gợi ý: 0 goal → chỉ nói số controls; >5 goal → 5 cái mới nhất.

---

### Phase 5 — Memory dự án: MCP, mục lục, tới cả worker

**Việc làm — Rust (`project_memory.rs`) + MCP:**

1. Tool mới (thêm `TOOLS`, `tool_defs`, `call` theo mẫu `devtools.rs`, route trong `mcp.rs` cạnh `plans`):
    - `memory_read { section?: string }` → cả file (≤ 64 KB) hoặc chỉ một mục `## <section>` (so tên không phân biệt hoa thường, cho phép một phần tên).
    - `memory_add { section: string, text: string }` → thêm một bullet `- <text>` vào cuối mục (tạo mục nếu chưa có). Từ chối nếu: text > 300 ký tự, có dạng bí mật (khớp regex token/key: `sk-`, `ghp_`, `AKIA`, `-----BEGIN`, chuỗi hex/base64 ≥ 32 ký tự), file sẽ > 64 KB, hoặc bullet trùng (so sau khi chuẩn hoá) đã có.
    - `memory_propose { text }` → thêm bullet vào `proposals.md` (người dùng duyệt ở Settings như hiện nay).
    - Root lấy bằng `index::write_root_of(chat, args)` (giống plans/artifacts — chỉ ghi vào project của chat).
2. **Mục lục trong prompt** (`project-memory.ts` `memoryHint`): nếu file > 3.000 ký tự, thay vì chỉ cắt, đưa: phần đầu file đến hết mục đầu tiên (≤ 1.500 ký tự) + danh sách tên các mục `## …` + "Read a section with memory_read". File nhỏ giữ như cũ.
3. Câu hướng dẫn trong `memoryHint`: thay "add one short bullet to that file" bằng "add it with memory_add (or edit the file if the tool is not available)".
4. **Worker nhận memory:** trong khối `memoryNote` của `run.svelte.ts`, bỏ điều kiện `!isWorkerChat(session.id)`; với worker dùng bản ngắn: chỉ mục lục + "Read the project memory with memory_read before you start". Không đổi cho side chat (`/btw`).
5. Settings > Memory (`components/settings/sections/MemorySection.svelte`): không đổi UI ở phase này.

**Test Rust:** đọc mục; thêm bullet vào mục có sẵn / mục mới; từ chối trùng, bí mật, quá dài; file legacy không có `##` → `memory_add` tạo mục mới ở cuối.

**Test node:** `memoryHint` với file nhỏ (như cũ), file lớn có mục (có mục lục), worker (bản ngắn).

**Kiểm tra tay:** giao một việc cho worker (`delegate_task`) trong project có memory → transcript worker có câu memory, worker gọi `memory_read`.

---

### Phase 6 — Code index: sẵn sàng sớm, không quét lại mỗi lần, có trạng thái

**Việc làm — `index.rs`:**

1. **Index khi mở project:** lệnh Tauri mới `index_warm(root)` gọi `set_root("", root)` (chỉ chạy refresh nền, không gắn chat). Frontend gọi khi project được mở/chọn trong app (tìm chỗ đổi project đang mở, ví dụ effect theo `workspace.activeId` → `projectOf(session).path`), mỗi root một lần mỗi lần chạy app.
2. **Không chặn tool call lần đầu:** trong `run()` (`index.rs:576-578`): nếu index của root chưa từng xong (`checked == None`) và đang có refresh nền chạy → chờ tối đa 3 giây; quá thì trả lời ngay với kết quả đang có + dòng "Index is still building (<n> files so far); results may be incomplete." Không gọi `refresh` đồng bộ nếu đã có refresh nền đang chạy (thêm cờ `building: AtomicBool` trong `Index`).
3. **Bỏ quét lại cả cây mỗi 2 giây:** dùng watcher (crate `notify` — **chưa có** trong workspace `Cargo.toml`, đã kiểm 2026-11-05; **hỏi người dùng** trước khi thêm dependency):
    - Watch root (recursive), bỏ qua đường dẫn `skipped()` và `.gitignore`.
    - Sự kiện tạo/sửa/xoá file nguồn → đưa vào hàng đợi; một thread gom 500 ms rồi re-parse đúng những file đó.
    - `refresh` toàn cây chỉ chạy khi mở index lần đầu và khi watcher báo lỗi/tràn.
    - `RECHECK` đổi thành 60 s cho trường hợp watcher không chạy được (fallback).
4. **Trạng thái:** `code_index_status` thêm `building`, `last full refresh`, `watching: yes/no`, `files`, `symbols`. Lệnh Tauri `index_status(root)` trả cùng dữ liệu; hiển thị một dòng trong Settings hoặc tooltip (chọn chỗ có sẵn, ví dụ phần project context; **hỏi người dùng** nơi đặt nếu không có chỗ rõ ràng).
5. **`codegraph` / `serena` MCP ngoài:** không tích hợp. Trong `project_context` (`devtools.rs`), nếu `.mcp.json` của project có server tên `codegraph` hoặc `serena`, thêm dòng: "This project also has <name> MCP; prefer AgentDeck's code_* tools for symbol search (they share the index with every agent)." — **hỏi người dùng** trước khi làm mục này: có muốn ưu tiên code_* hay ưu tiên codegraph.

**Test Rust:**

- `building` chặn refresh đồng bộ thứ hai.
- Hàng đợi watcher: 3 sự kiện cùng file trong 500 ms → parse 1 lần (test hàm gom thuần, không cần watcher thật).
- File bị xoá qua watcher → symbols của nó biến mất.
- Test hiệu năng có sẵn (`index.rs` cuối file in thời gian `query`) vẫn chạy.

**Kiểm tra tay:** mở app, chọn project lớn (agentdeck) → trong vài giây `code_index_status` báo xong; gọi `code_search` ngay lần đầu không bị treo; sửa một file → `code_outline` file đó phản ánh thay đổi trong ~1 s.

---

### Phase 7 — (Tuỳ chọn, hỏi trước) Gợi ý routing từ scorecard

- Trong `UsageView` hoặc Settings > Task roles: nếu một model có rework ≥ 3 vòng trên ≥ 30% việc của một vai trò trong 14 ngày, hiện gợi ý "Consider routing <role> to <model khác có tỷ lệ tốt hơn>". Không tự đổi route.
- Chỉ làm khi người dùng đồng ý.

---

## 5. Thứ tự và phụ thuộc

```
P1 (chữ) ─► P2 (lưu trong project) ─► P3 (tự cập nhật + kết quả bấm) ─► P4 (gợi ý khi mở trang)
P5 (memory dự án)      độc lập, có thể làm song song với P2–P4 (khác file, trừ mcp.rs: chỉ thêm route)
P6 (code index)        độc lập
P7                      hỏi trước
```

Ước lượng thô: P1 0.25 ngày, P2 1–1.5 ngày, P3 1 ngày, P4 0.25 ngày, P5 1 ngày, P6 1–1.5 ngày.

---

## 6. Definition of Done chung

- `cargo clippy --workspace -- -D warnings` sạch (trong VS dev shell; tắt app AgentDeck đang chạy từ cùng worktree trước khi build, nếu không build script lỗi "file is being used by another process").
- Test Rust của module đổi pass; `pnpm --filter desktop check` 0 lỗi (3 cảnh báo a11y cũ là có sẵn).
- Không `unwrap()` ngoài test. Ghi file nguyên tử.
- Không ghi gì vào app data cho trí nhớ (UI memory, project memory). Chỉ code index (cache) nằm ở home folder.
- File permission mới sinh ra thì commit; file toml chỉ đổi line ending thì không commit.
- PR ghi: file đổi + lý do; kết quả lệnh kiểm tra; số ảnh chụp trước/sau P1 và P3 cho cùng một kịch bản.
- Xoá file tạm (`pnpm clean:junk`).

---

## 7. Câu hỏi còn mở

1. **P2:** `.agentdeck/ui-memory/` có nên commit vào git không? (đề xuất: để người dùng quyết; không tự sửa `.gitignore`).
2. **P6:** thêm crate `notify` được không?
3. **P6:** ưu tiên `code_*` của AgentDeck hay MCP `codegraph` khi project có cả hai?
4. **P6:** hiển thị trạng thái index ở đâu?
5. **P7:** có làm gợi ý routing không?

---

## 8. Danh sách file dự kiến đổi

| File                                                                      | Phase         | Đổi gì                                                                                                    |
| ------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/mcp.rs`                                       | 1, 2, 3, 4, 5 | Mô tả tool, instructions, `remember_seen`/`memory_tool` dùng root, kết quả sau khi bấm, route tool memory |
| `apps/desktop/src-tauri/src/custom_chat.rs`                               | 1             | Câu hướng dẫn browser                                                                                     |
| `crates/adapters/src/agent/claude.rs` (`:25`, `:113`), `codex.rs` (`:27`) | 1             | Bỏ "screenshot, act, screenshot again"; DOM-first                                                         |
| `apps/desktop/src-tauri/src/ui_memory.rs` (mới)                           | 2, 3, 4       | Lưu trữ, chấm điểm, prune, mark                                                                           |
| `apps/desktop/src-tauri/src/page_memory.rs`                               | 2             | Gọi `ui_memory` thay vì webview                                                                           |
| `apps/desktop/src-tauri/src/lib.rs`                                       | 2, 5, 6       | `mod ui_memory`, bỏ `page_memory_reply`, lệnh `index_warm`, `index_status`                                |
| `apps/desktop/src-tauri/permissions/autogenerated/page_memory_reply.toml` | 2             | Xoá                                                                                                       |
| `apps/desktop/src/lib/browser/page-memory*.ts`                            | 2             | Xoá (sau khi grep không còn chỗ dùng)                                                                     |
| `apps/desktop/src/lib/chat/session/delegate-task.svelte.ts`               | 2             | Bỏ bridge, thêm dọn IndexedDB một lần                                                                     |
| `apps/desktop/src-tauri/src/project_memory.rs`                            | 5             | `memory_read`, `memory_add`, `memory_propose`                                                             |
| `apps/desktop/src/lib/chat/content/project-memory.ts` (+ test)            | 5             | Mục lục, câu hướng dẫn, bản cho worker                                                                    |
| `apps/desktop/src/lib/chat/session/run.svelte.ts`                         | 5             | Worker nhận memory                                                                                        |
| `apps/desktop/src-tauri/src/index.rs`                                     | 6             | Warm, `building`, watcher, trạng thái                                                                     |
| `apps/desktop/src-tauri/src/devtools.rs`                                  | 6             | Dòng về codegraph/serena (nếu được đồng ý)                                                                |
| Frontend chỗ mở project                                                   | 6             | Gọi `index_warm`                                                                                          |
| `docs/user-guides/…`, `docs/release-notes/vX.Y.Z.md`                      | cuối          | Hướng dẫn + "What's new" và "Fixes"                                                                       |
