# Plan: Plan files + Artifacts dùng chung cho mọi provider (qua MCP `agentdeck`)

Ngày: 2026-11-05. Trạng thái: đề xuất, chưa code. Người viết plan không sửa code nào.

Người nhận: đọc `AGENTS.md` trước. Làm đúng thứ tự phase. Mỗi phase là một commit riêng. Cuối mỗi phase chạy các lệnh ở mục "Kiểm tra" của phase đó và ghi kết quả thật vào PR.

---

## 0. Mục tiêu

1. **Plan files**: có một chỗ trong AgentDeck để xem mọi file plan của project. Agent nào cũng đọc, tạo, cập nhật được plan qua MCP. Ví dụ: Claude lập plan, Codex đọc và làm theo, rồi đánh dấu bước đã xong.
2. **Artifacts**: giống Claude.ai Artifacts. Agent tạo nội dung xem được (HTML, Markdown, SVG, code), và nội dung hiện ở panel riêng cạnh chat. Mỗi lần sửa là một phiên bản mới. Provider nào cũng tạo được qua MCP. Provider không có MCP thì dùng fenced block.
3. **Mọi provider đều dùng được**. Claude và Codex được làm trước và kỹ nhất: tự lưu plan khi chạy plan mode, và được test end-to-end. Các provider khác (Gemini, OpenCode, Antigravity, Copilot, CommandCode, custom chat như z.ai/GLM, Ollama…) dùng chung tool MCP. Không viết nhánh riêng cho từng provider này.

### Ngoài phạm vi

- Không chia sẻ artifact ra internet và không publish.
- Không chạy React/JSX trong artifact. Chỉ HTML tĩnh, cho phép script trong sandbox.
- Không thêm thư viện UI lớn. Không thêm mermaid ở bản đầu (xem mục 9). Sơ đồ dùng artifact `svg`.
- Không sửa nội dung các file plan cũ trong `docs/plans/`.

---

## 1. Hiện trạng (đã kiểm tra trong code)

| Chỗ                                                                                       | Đang làm gì                                                                                   | Ghi chú                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/desktop/src/lib/chat/content/blocks.ts:62` `planOf()`                               | Đọc checklist của `TodoWrite` / `update_plan` và vẽ `PlanCard`                                | Không lưu file. Mất khi chat dài.                                                           |
| `apps/desktop/src/lib/chat/content/tool-kind.ts:21`                                       | Regex `PLAN` gồm cả `ExitPlanMode`                                                            | Chỉ dùng để chọn icon. Nội dung plan của `ExitPlanMode` không đi đâu cả.                    |
| `apps/desktop/src/lib/chat/slash.svelte.ts:145`                                           | `/plan` chỉ là prompt "đừng sửa file, đưa các bước"                                           | Kết quả nằm trong chat, không có file.                                                      |
| `crates/adapters/src/agent/permission.rs:113-114`                                         | `Mode::Plan`: chỉ cho phép `Action::Read`                                                     | Ghi plan qua MCP sẽ bị từ chối. Phải xử lý, xem P3.3.                                       |
| `crates/adapters/src/agent/codex_server.rs:39`                                            | Plan mode của Codex = sandbox `read-only`                                                     |                                                                                             |
| `apps/desktop/src-tauri/src/mcp.rs:574`                                                   | Danh sách tool MCP (`tool_defs` của từng module được nối vào)                                 | Thêm `plans::tool_defs()` và `artifacts::tool_defs()` ở đây.                                |
| `apps/desktop/src-tauri/src/mcp.rs:659-667`                                               | Route tool theo `is_tool()` của từng module                                                   | Thêm hai nhánh mới theo đúng mẫu `devtools`.                                                |
| `apps/desktop/src-tauri/src/mcp.rs:938`                                                   | `instructions` của server MCP, gửi lúc `initialize`                                           | Thêm một câu về plan và một câu về artifact.                                                |
| `apps/desktop/src-tauri/src/devtools.rs`                                                  | Module mẫu: `TOOLS`, `is_tool`, `tool_defs`, `call(name, args, chat)`                         | Copy cấu trúc này.                                                                          |
| `apps/desktop/src-tauri/src/index.rs:94` `root_of(chat, args)`                            | Tìm thư mục project của chat, hoặc lấy `args.root`                                            | Dùng lại hàm này, không tự viết.                                                            |
| `apps/desktop/src-tauri/src/custom_chat.rs:1243`                                          | Provider chat thuần (z.ai, OpenAI-compatible, Ollama…) lấy tool qua `crate::mcp::tool_list()` | Tool mới tự có ở đây, không cần sửa thêm.                                                   |
| `crates/adapters/src/agent/claude.rs:112-142`                                             | Claude nhận MCP `agentdeck` qua `mcpServers`, `allowed_tools` có `mcp__agentdeck`             | Tool mới tự có.                                                                             |
| `crates/adapters/src/agent/{codex,codex_server,opencode,antigravity,commandcode}.rs`      | Các CLI khác nhận URL MCP `agentdeck` (`mcp_url`, `agent/mod.rs:140`)                         | Phải kiểm tra từng provider có thấy tool mới không (P5).                                    |
| `apps/desktop/src/lib/chat/content/artifacts.ts` + `components/chat/ArtifactCards.svelte` | "Artifact" hiện tại = card cho file media/tài liệu được nhắc trong câu trả lời                | **Khác hẳn** tính năng mới. Không đổi tên, không gộp. Đặt tên mới để tránh trùng (mục 4.1). |
| `apps/desktop/src/lib/components/browser/NetworkPanel.svelte:483`                         | Có sẵn iframe `sandbox="" srcdoc=…`                                                           | Mẫu để render HTML an toàn.                                                                 |
| `apps/desktop/src/lib/app/text/markdown.ts:172` `renderMarkdown()`                        | marked + DOMPurify                                                                            | Dùng cho artifact Markdown.                                                                 |
| `apps/desktop/src/lib/chat/content/tools.ts`                                              | `TOOLS`: các tab của panel phải                                                               | Thêm tab `Plans` và `Canvas`.                                                               |
| `apps/desktop/src/lib/components/chat/ToolView.svelte`                                    | Map tab → component                                                                           | Thêm hai nhánh.                                                                             |
| `docs/plans/`, `docs/superpowers/plans/`                                                  | Plan viết tay, không có front-matter, tiêu đề là dòng `# `                                    | Phải đọc được mà không bắt sửa file.                                                        |

---

## 2. Quyết định thiết kế (đã chốt, đừng đổi khi chưa hỏi)

1. **Chỗ lưu plan**: ghi vào `<project>/docs/plans/<slug>.md`, để commit được và agent khác đọc được. Chỉ đọc (không ghi) thêm từ `docs/superpowers/plans/` và `~/.claude/plans/`.
2. **Chỗ lưu artifact**: `<project>/docs/artifacts/<id>/`, trong project đang làm việc, cạnh `docs/plans/`. Thư mục gồm `meta.json` và `v1.<ext>`, `v2.<ext>`… **Không** lưu vào app data của AgentDeck. **Không** tạo thư mục `.agentdeck/`. **Không** tự sửa `.gitignore` của người dùng (người dùng đã chốt 2026-11-05).
3. **Một nguồn sự thật**: Rust giữ toàn bộ logic đọc/ghi/parse. Cả tool MCP lẫn lệnh Tauri cho UI gọi cùng một hàm Rust. UI không tự parse front-matter.
4. **Tên tab**: `Plans` và `Canvas`. Không đặt tab "Artifacts", để khỏi lẫn với `ArtifactCards` đang có. Trong code Rust/MCP vẫn gọi là `artifact`, vì đó là từ agent quen.
5. **Ưu tiên provider**: Claude và Codex có tự-lưu plan (P3). Provider khác chỉ dùng tool MCP và fenced block fallback.

---

## 3. Định dạng dữ liệu

### 3.1 File plan

```markdown
---
title: Thêm tab Plans
status: draft # draft | approved | doing | done | dropped
agent: claude # provider id tạo plan (claude, codex, gemini, opencode, custom…)
chat: 7f3c… # id chat tạo plan, có thể trống
source: exit-plan-mode # mcp | exit-plan-mode | codex-plan-mode | slash | manual
created: 2026-11-05T09:12:00Z
updated: 2026-11-05T09:40:00Z
---

# Thêm tab Plans

Mục tiêu …

## Steps

- [ ] Bước 1 …
- [x] Bước 2 …
```

Quy tắc parse (Rust, `plans.rs`):

- Front-matter là phần nằm giữa hai dòng `---` ở **đầu file**. Chỉ đọc các key phẳng `key: value`, bỏ phần comment sau `#`. Không thêm crate YAML. Viết parser nhỏ và có test.
- Không có front-matter (file cũ) thì: `status = "unknown"`, `title` lấy từ dòng `# ` đầu tiên, không có thì lấy tên file. `agent`, `chat`, `source` để trống. `updated` lấy mtime của file.
- Step là mọi dòng khớp `^\s*[-*] \[( |x|X)\] (.+)$`, ở bất kỳ đâu trong file. `done/total` được đếm từ các dòng đó.
- Khi ghi, giữ nguyên thứ tự key và các key lạ. Chỉ thay key cần thay.

### 3.2 Artifact

`docs/artifacts/<id>/meta.json`:

```json
{
    "id": "a-20261105-091200-landing",
    "title": "Landing page draft",
    "kind": "html",
    "agent": "codex",
    "chat": "7f3c…",
    "created": "2026-11-05T09:12:00Z",
    "updated": "2026-11-05T09:30:00Z",
    "versions": [
        {
            "n": 1,
            "file": "v1.html",
            "at": "2026-11-05T09:12:00Z",
            "note": "first draft"
        },
        {
            "n": 2,
            "file": "v2.html",
            "at": "2026-11-05T09:30:00Z",
            "note": "dark mode"
        }
    ]
}
```

- `kind` là một trong `html | markdown | svg | code`. Đuôi file tương ứng: `.html .md .svg`, còn `code` lấy đuôi theo `language` (mặc định `.txt`).
- `id` = `a-<yyyymmdd>-<hhmmss>-<slug≤32>`. Chỉ dùng `[a-z0-9-]`.
- Giới hạn: một phiên bản ≤ 1 MB, tối đa 50 phiên bản cho mỗi artifact. Vượt 50 thì xóa bản cũ nhất, trừ `v1`. Ghi rõ việc xóa này trong kết quả tool.

---

## 4. Tool MCP (khách hàng chính: mọi agent)

Mọi tool đều nhận `root` không bắt buộc. Thiếu `root` thì dùng `crate::index::root_of(chat, args)`. Kết quả trả về là text ngắn, mỗi mục một dòng, theo cùng phong cách với `devtools`.

### 4.1 Plan: module `apps/desktop/src-tauri/src/plans.rs` (mới)

| Tool         | Input                                                                                | Output                                                                            | Ghi chú                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_list`  | `root?`, `status?`                                                                   | Mỗi dòng: `<id> \| <status> \| <title> \| <agent> \| <updated> \| <done>/<total>` | `id` = đường dẫn tương đối từ root (`docs/plans/x.md`). Plan global của Claude có `id` dạng `claude-global/<file>.md`. Sắp xếp theo `updated` giảm dần. Tối đa 100 dòng.                                                                                                                     |
| `plan_read`  | `id`, `root?`                                                                        | Nội dung file nguyên văn, cộng một dòng đầu `status=… steps=3/7 updated=…`        | Cắt ở 200 000 ký tự, có ghi chú là đã cắt.                                                                                                                                                                                                                                                   |
| `plan_write` | `title`, `body`, `status?`, `id?`, `agent?`, `base_updated?`, `root?`                | `saved docs/plans/<slug>.md (status=draft)`                                       | Không có `id` thì tạo mới, slug lấy từ title. Trùng tên thì thêm `-2`, `-3`… Có `id` thì ghi đè body và giữ `created`. Nếu `base_updated` khác `updated` trong file thì báo lỗi `plan changed since you read it (updated=…); plan_read again`. `body` không chứa front-matter, Rust tự thêm. |
| `plan_step`  | `id`, `step` (số thứ tự 1-based **hoặc** đoạn text của bước), `done` (bool), `root?` | `step 3/7 done; status=doing`                                                     | Đọc lại file ngay trước khi sửa. Sau khi sửa: tất cả xong thì `done`; có ít nhất một bước xong và đang `approved`/`draft` thì `doing`. Không tự đổi khi status là `dropped`.                                                                                                                 |

Description của tool phải dạy agent cách dùng. Ví dụ cho `plan_list`: "Plans saved for this project, shared by every AgentDeck agent. Call before starting multi-step work; follow an `approved` plan and tick steps with plan_step."

An toàn (bắt buộc, phải có test):

- `id` phải nằm trong `docs/plans/` (để ghi), hoặc trong `docs/plans/`, `docs/superpowers/plans/`, `claude-global/` (để đọc). Từ chối `..`, đường dẫn tuyệt đối, đuôi khác `.md`, symlink trỏ ra ngoài root. Dùng `canonicalize` rồi so prefix.
- Ghi atomic: ghi `*.tmp` cùng thư mục rồi `rename`.
- File `claude-global/*` là read-only: `plan_write` / `plan_step` trả lỗi `read-only plan`.
- `body` lớn hơn 256 KB thì từ chối.
- Không dùng `unwrap()` ngoài test (theo `AGENTS.md`).

Hàm public cho Tauri (cùng file):

```rust
pub fn list(root: &Path, status: Option<&str>) -> Result<Vec<PlanInfo>, String>;
pub fn read(root: &Path, id: &str) -> Result<(PlanInfo, String), String>;
pub fn write(root: &Path, req: WriteReq) -> Result<PlanInfo, String>;
pub fn set_step(root: &Path, id: &str, step: StepRef, done: bool) -> Result<PlanInfo, String>;
pub fn set_status(root: &Path, id: &str, status: &str) -> Result<PlanInfo, String>;
```

`PlanInfo { id, path (absolute), title, status, agent, chat, source, created, updated, done, total, read_only }` derive `Serialize`, dùng `#[serde(rename_all = "camelCase")]`.

### 4.2 Artifact: module `apps/desktop/src-tauri/src/artifacts.rs` (mới)

Tên file Rust là `artifacts.rs`. Phải chắc chắn không đụng `src/lib/chat/content/artifacts.ts` ở frontend; hai file không liên quan.

| Tool              | Input                                              | Output                                                                |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `artifact_create` | `title`, `kind`, `content`, `language?`, `root?`   | `artifact a-…-landing v1 (html) — shown in Canvas`                    |
| `artifact_update` | `id`, `content`, `note?`, `base_version?`, `root?` | `artifact a-… v3` (lệch `base_version` thì báo lỗi như `plan_write`)  |
| `artifact_list`   | `root?`                                            | Mỗi dòng: `<id> \| <kind> \| <title> \| v<n> \| <agent> \| <updated>` |
| `artifact_read`   | `id`, `version?`, `root?`                          | Nội dung của phiên bản đó, mặc định bản mới nhất                      |

Description của `artifact_create`: "Show the user a self-contained HTML page, SVG, Markdown document or code file in AgentDeck's Canvas panel, next to the chat. Use for previews, mockups, diagrams and reports the user should look at; use normal file edits for project source code. HTML runs sandboxed with no network: inline all CSS/JS."

Sau mỗi lần create/update, Rust phát event Tauri `artifact-changed` `{ root, id, version, chat }`. Để làm được việc này, `call` của module nhận thêm `app: &AppHandle`, khác với `devtools::call`. Sửa đúng chỗ route trong `mcp.rs` giống nhánh `delegate::call(app, …)`.

Plan cũng phát `plan-changed` `{ root, id }` sau mỗi lần ghi, để tab Plans tự tải lại. Vì vậy `plans::call` cũng nhận `app`.

### 4.3 Đăng ký trong `mcp.rs`

1. `mcp.rs:574`: thêm `.chain(crate::plans::tool_defs())` và `.chain(crate::artifacts::tool_defs())`.
2. `mcp.rs:~662`: thêm hai nhánh `if crate::plans::is_tool(name) { … }` và `if crate::artifacts::is_tool(name) { … }`, theo đúng mẫu `devtools`: `Ok` → `text_reply`, `Err` → `error_reply`.
3. `lib.rs`: thêm `mod plans;` và `mod artifacts;` theo thứ tự chữ cái trong danh sách `mod`.
4. `mcp.rs:938` `instructions`: nối thêm đúng hai câu, không viết lại câu cũ:
    - "Plans: plan_list shows plans every AgentDeck agent shares; follow an approved plan, tick its steps with plan_step, and save a new plan with plan_write when you plan multi-step work."
    - "artifact_create shows an HTML page, SVG, Markdown or code in the user's Canvas panel; update it with artifact_update instead of creating a new one."

### 4.4 Lệnh Tauri cho UI

Thêm vào `invoke_handler` trong `lib.rs`, đặt cùng nhóm với các lệnh khác. Các lệnh chỉ gọi hàm của mục 4.1 và 4.2:

- `plans_list(root, status?)`, `plans_read(root, id)`, `plans_set_status(root, id, status)`, `plans_set_step(root, id, step, done)`, `plans_save(root, title, body, agent, chat, source)` (dùng cho tự-lưu ở P3).
- `artifacts_list(root)`, `artifacts_read(root, id, version?)`, `artifacts_delete(root, id)` (UI phải hỏi xác nhận bằng `zModalService.danger`, theo memory của dự án).

---

## 5. UI

Trước khi code, đọc lại phần "UI style" và "Popovers" trong `AGENTS.md`. Copy style từ `components/tasks/ProjectActivityView.svelte`: đây là view theo project, có chọn project, gần nhất với tab mới.

### 5.1 Tab `Plans`: `apps/desktop/src/lib/components/plans/PlansView.svelte` (mới)

- `tools.ts`: thêm `{ value: 'Plans', label: 'Plans', icon: 'lucideClipboardList' as ZIconName }` ngay sau `Tasks`. Icon này đã có trong `app/platform/icons.ts:12` và `bundled-icons.ts`.
- `ToolView.svelte`: thêm `{:else if tool === 'Plans'} <PlansView />`.
- Bố cục từ trên xuống:
    1. Hàng đầu: `ProjectSelect` để chọn project, lấy project mặc định giống `ProjectActivityView`. Bên phải là bộ lọc status bằng `PickerPopover` `sm` (All / Draft / Approved / Doing / Done / Dropped) và nút refresh dạng icon.
    2. Danh sách. Mỗi hàng gồm:
        - Icon `AgentLogo` của `agent`. Không có agent thì dùng `lucideFileText`.
        - Dòng 1: tiêu đề, `text-sm font-medium`.
        - Dòng 2: `text-xs text-muted-foreground` gồm `status · 3/7 steps · 2h ago · docs/plans/x.md`.
        - Không dùng badge màu cho status, vì `AGENTS.md` cấm. Status chỉ là chữ.
    3. Mục "Claude (global)" ở cuối, đóng sẵn, chỉ đọc.
- Click vào hàng: `openProjectFile(path)` (`src/lib/files/file-viewer.svelte.ts:85`), mở trong viewer có sẵn. Viewer đã render Markdown, nên không làm viewer mới.
- Menu của hàng dùng `MenuButton` + `ZDropdownMenuItem`:
    - Open
    - Copy path
    - Set status → approved / doing / done / dropped
    - **"Run with…"**: chèn vào composer của chat đang mở câu `Follow the plan docs/plans/x.md: read it with plan_read, do the next unchecked step, tick it with plan_step.` Không tự gửi. Tìm hàm chèn text vào composer đang có (grep `insertText` hoặc `draft` trong `components/chat/Composer.svelte`). Nếu không có hàm public thì bỏ mục này và ghi vào PR.
- Tải lại khi: mở tab, đổi project, nhận event `plan-changed` cùng root, bấm refresh. Không dùng file watcher. File sửa tay sẽ được thấy khi bấm refresh hoặc mở lại tab.
- Trạng thái rỗng: copy kiểu khối "No … data yet" ở `ToolView.svelte`, chữ: "No plans yet. Ask an agent to /plan something."
- Store state: `src/lib/plans/plans.svelte.ts` (mới) dùng `$state`, có hàm `loadPlans(root)` và cache theo root. Không dùng store API cũ.

### 5.2 Tab `Canvas`: `apps/desktop/src/lib/components/canvas/CanvasView.svelte` (mới)

- `tools.ts`: `{ value: 'Canvas', label: 'Canvas', icon: 'lucidePanelsTopLeft' as ZIconName }`. **Kiểm tra icon có trong `icons.ts` và `bundled-icons.ts`.** Không có thì thêm vào cả hai file theo cách đang làm, hoặc chọn một icon đã có, ví dụ `lucideAppWindow`. Ghi icon đã chọn vào PR.
- Bố cục:
    1. Hàng đầu: `PickerPopover` `md` có `search` để chọn artifact (danh sách artifact của project, mới nhất ở trên, icon là `AgentLogo`). Kế bên là `PickerPopover` `sm` chọn phiên bản (`v3 · 09:30 · dark mode`). Bên phải có các nút icon:
        - Code/Preview (toggle)
        - Copy
        - Save as file…: dùng `file_write` sẵn có, đích là `docs/` hoặc chỗ người dùng chọn qua dialog lưu file đang có trong app
        - Open in Preview: chỉ cho `html`, mở bằng tab Preview hiện có, theo memory "Reuse Preview tab"
        - Delete
    2. Thân:
        - `html`: `<iframe sandbox="allow-scripts" srcdoc={content}>`. **Không** thêm `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`. Chèn vào đầu `srcdoc` một thẻ `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:">` để chặn mạng. Nền iframe để trắng giống `NetworkPanel.svelte:483`.
        - `svg`: cũng render bằng iframe như HTML (bọc trong `<html><body>`), **không** dùng `{@html}`, vì SVG có thể chứa script.
        - `markdown`: `renderMarkdown(content)` (`app/text/markdown.ts:172`, đã có DOMPurify), class giống câu trả lời chat.
        - `code`: dùng `CodeView.svelte` đang có, chỉ đọc.
        - Chế độ Code: `CodeView` chỉ đọc của nguồn, cho mọi kind.
        - Chọn hai phiên bản để so sánh: phase 2 tùy chọn, dùng `DiffView.svelte` nếu đơn giản. Không thì bỏ.
- Khi nhận `artifact-changed`: nếu Canvas đang mở artifact đó thì nhảy sang phiên bản mới. Nếu panel phải đang ở tab khác và artifact thuộc **chat đang mở**, thì chuyển `layout.activeTool = 'Canvas'` và chọn artifact đó. Giống Claude.ai: artifact mới thì tự mở. Không tự mở artifact của chat khác.
- Store: `src/lib/canvas/canvas.svelte.ts` (mới).

### 5.3 Card trong chat

- Trong `blocks.ts`, khi gom segment (gần `planOf`, dòng ~210): tool call có tên `artifact_create` / `artifact_update` (kể cả dạng `mcp__agentdeck__artifact_create`; xem cách `claude.rs:684` khớp hai dạng tên) thành segment mới `{ kind: 'artifact'; item: CommandBlock }`. Làm theo mẫu `proposal` (`blocks.ts:39`).
- Component mới `components/chat/CanvasCard.svelte`: một hàng phẳng có viền 1px. Bên trái là icon của kind, tiếp theo là tiêu đề và `v<n>`. Click thì mở tab Canvas tại artifact và phiên bản đó. Copy style từ `ProposalCard.svelte`.
- `AssistantMessage.svelte:171`: thêm nhánh render `CanvasCard`, cạnh `ProposalCard`.
- `tool-kind.ts` / `activity-kind.ts`: thêm icon cho `artifact_*` (`lucidePanelsTopLeft`) và `plan_*` (dùng `ICON.plan` có sẵn). Thêm test vào `tool-kind.test.ts`.

---

## 6. Provider: Claude và Codex trước, rồi tới các provider khác

### 6.1 Claude (ưu tiên 1)

1. **Tự lưu `ExitPlanMode`**: khi chat Claude có tool call `ExitPlanMode {"plan": "…"}`, frontend gọi `plans_save(root, title, body=plan, agent='claude', chat, source='exit-plan-mode')`.
    - Chỗ hook: nơi ToolCall event thành `command` block, trong `chat/session/events.svelte.ts` (khoảng dòng 1011, tìm chỗ tạo block `kind: 'command'`). Chỉ gọi **một lần** cho mỗi call id, khi block có đủ input (không gọi theo từng delta). Dùng `Set` các call id đã lưu.
    - `title`: dòng `# ` đầu của plan. Không có thì lấy 60 ký tự đầu của câu đầu.
    - Chống trùng: nếu đã có plan cùng `chat` và `source=exit-plan-mode` đang ở `draft` thì cập nhật plan đó thay vì tạo mới. Rust làm việc này trong `plans_save`.
    - Sau khi lưu: dưới block hiện link "Saved to docs/plans/x.md", mở bằng `openProjectFile`.
2. **Plan mode + MCP**: Claude ở `--permission-mode plan` vẫn gọi được `mcp__agentdeck__plan_*`. Kiểm tra thực tế (P5). Nếu CLI chặn thì để nguyên; tự-lưu ở bước 1 đã đủ.
3. **`~/.claude/plans/`**: chỉ liệt kê, chỉ đọc. Cần kiểm tra: AgentDeck chạy Claude qua Agent SDK (`apps/desktop/build/claude-agent/runner.mjs`). Thư mục này có được ghi khi chạy qua SDK không? Nếu không thì vẫn giữ mục "Claude (global)" cho plan từ Claude Code CLI chạy ngoài. **Không** đặt `plansDirectory` khi chưa hỏi người dùng.

### 6.2 Codex (ưu tiên 1)

1. **Tự lưu plan mode**: khi một turn Codex chạy với permission `plan` (`codex_server.rs:39`) và kết thúc thành công, lưu **câu trả lời cuối** làm plan (`source='codex-plan-mode'`, `agent='codex'`). Nếu trong turn có `update_plan` thì nối checklist cuối cùng vào cuối body thành `## Steps` với `- [ ]` / `- [x]`, dùng lại `planOf()`.
    - Chỗ hook: nơi frontend biết turn kết thúc và biết permission mode của turn (tìm `permission_mode` / `'plan'` trong `chat/session/turns.svelte.ts`, dòng 291 có map `plan: 'plan'`).
    - Chống trùng như Claude: cùng `chat`, `source`, đang `draft` thì cập nhật.
    - **Cần kiểm tra**: app-server của Codex có phát item hoặc notification riêng cho plan (ví dụ `turn/plan/updated`, hoặc item kiểu plan) không? Grep trong `codex_server.rs`. Nếu có thì dùng nội dung đó thay vì câu trả lời cuối. Ghi kết quả vào PR.
2. **Ghi plan khi đang read-only**: `permission.rs:113-114` từ chối mọi thứ không phải `Read` ở `Mode::Plan`. Cần tìm chỗ map tên tool → `Action` cho tool MCP. Cho `plan_write`, `plan_step`, `artifact_create`, `artifact_update` (tên có tiền tố `mcp__agentdeck__` hoặc không) được tính là được phép trong `Mode::Plan`, vì ghi plan chính là việc của plan mode. Chỉ thêm các tên này, không nới rộng chung. Thêm test trong `permission.rs`.
3. Codex nhận tool MCP qua URL `agentdeck`. Kiểm tra `codex.rs` / `codex_server.rs` không có allowlist tool nào chặn tên mới.

### 6.3 Provider khác (dùng chung, không viết nhánh riêng)

- Gemini, OpenCode, Antigravity, Copilot, CommandCode: nhận MCP `agentdeck` theo cơ chế sẵn có. Chỉ kiểm tra (P5), không sửa adapter trừ khi tool không hiện. Nếu không hiện thì ghi provider đó vào PR và hỏi lại, **không** tự sửa.
- Custom chat (z.ai/GLM, OpenAI-compatible, Ollama): `custom_chat.rs:1243` lấy `mcp::tool_list()`, nên tool tự có. Kiểm tra model nhỏ có gọi được không.
- **Fallback cho provider không gọi được MCP**: dùng fenced block, giống mẫu `agentdeck-ask` (`claude.rs:23`):
    ````
    ```agentdeck-artifact title="Landing" kind="html"
    <!doctype html>…
    ```
    ````
    Khi câu trả lời kết thúc và có block này, frontend gọi `artifacts_create` bằng lệnh Tauri (thêm lệnh này ở mục 4.4), rồi thay block trong hiển thị bằng `CanvasCard`. Viết parser trong một file TS thuần (`src/lib/canvas/fence.ts`), có test node như `artifacts.test.ts`. **Không** thêm câu dạy fallback vào prompt của Claude hoặc Codex, vì hai provider này dùng MCP. Chỉ thêm vào system prompt của custom chat nếu có chỗ prompt chung (grep `ASK_CONTEXT` trong `custom_chat.rs`).

### 6.4 `/plan` (mọi provider)

Sửa prompt ở `slash.svelte.ts:150` thành:

> "Make a plan for: $ARGUMENTS\n\nDo not edit project files. Read what you need, then write the plan: goal, steps in order as `- [ ]` checkboxes, the files each step touches, risks, and how each step is verified. Save it with plan_write (status draft) and give me its path. If plan_write is not available, write it to docs/plans/<short-slug>.md instead. Ask me about anything that changes the plan."

Thêm slash `/plans`: "List this project's plans with plan_list and tell me which is approved and what step is next." Thêm cùng chỗ, cùng kiểu với các slash khác.

---

## 7. Thứ tự làm (phase)

### P1. Backend plan (Rust)

1. `plans.rs`: parser front-matter, steps, list/read/write/set_step/set_status, các tool MCP, event `plan-changed`.
2. Đăng ký trong `mcp.rs` (tool_defs, route, instructions) và `lib.rs` (mod, lệnh Tauri).
3. Unit test trong `plans.rs`, dùng `tempfile` nếu workspace đã có (kiểm tra `Cargo.toml`; không có thì dùng `std::env::temp_dir()` + thư mục riêng và tự xóa):
    - parse file có và không có front-matter
    - đếm steps, `plan_step` theo số và theo text, tự đổi status
    - từ chối `../x.md`, đường dẫn tuyệt đối, `.txt`, ghi vào `claude-global/`
    - `base_updated` lệch thì báo lỗi
    - tạo trùng title thì có `-2`
4. Kiểm tra: `pnpm check` (cargo check + clippy `-D warnings` + svelte-check), `node scripts/cargo.mjs test -p agentdeck-desktop plans`.

### P2. Tab Plans (UI)

1. `plans.svelte.ts`, `PlansView.svelte`, `tools.ts`, `ToolView.svelte`.
2. Kiểm tra: `pnpm check`, `pnpm lint`. Chạy app (`pnpm dev`, xem memory "Build and run"), mở tab Plans với project `agentdeck`: thấy các file `docs/plans/*.md` cũ, status `unknown`, tiêu đề đúng. Chụp màn hình và so với tab Tasks/Activity về khoảng cách và font.

### P3. Claude và Codex

1. Tự lưu `ExitPlanMode` (6.1). 2. Tự lưu plan mode của Codex (6.2.1). 3. Cho phép `plan_*`/`artifact_*` trong `Mode::Plan` (6.2.2) và test. 4. `/plan`, `/plans` (6.4).
2. Kiểm tra: test `permission.rs`. Chạy thật: chat Claude ở plan mode yêu cầu plan nhỏ, thấy file mới trong `docs/plans/` và trên tab Plans. Làm tương tự với Codex. Sau đó trong chat Codex gõ "follow docs/plans/<file>.md, do step 1": Codex gọi `plan_read`, `plan_step`, và tab Plans hiện `1/n`.

### P4. Artifacts / Canvas

1. `artifacts.rs` + MCP + lệnh Tauri + test (giới hạn kích thước, xoay vòng 50 phiên bản, `base_version`, id an toàn).
2. `canvas.svelte.ts`, `CanvasView.svelte`, `CanvasCard.svelte`, segment `artifact` trong `blocks.ts`, icon trong `tool-kind.ts`.
3. Fallback `agentdeck-artifact` (`fence.ts` + test).
4. Kiểm tra bảo mật bằng tay. Tạo artifact HTML chứa:
    - `fetch('https://example.com')`: phải bị CSP chặn, có lỗi trong console của iframe
    - `window.parent.document`: phải lỗi cross-origin
    - `<a target=_top href=…>`: không điều hướng được app
    - `<form>`: không submit được

    Ghi kết quả vào PR.

5. Kiểm tra: `pnpm check`, `pnpm lint`, test node của `fence.ts`. Chạy thật: Claude và Codex mỗi bên tạo một artifact HTML rồi update một lần; Canvas tự mở và có v1, v2. Chụp màn hình.

### P5. Kiểm tra provider khác

Với mỗi provider đã cài trên máy: Gemini, OpenCode, Antigravity, Copilot, CommandCode, một custom chat (z.ai/GLM nếu có key, hoặc Ollama).

- Hỏi "call plan_list" và "create an html artifact showing hello".
- Ghi bảng kết quả vào PR: provider | thấy tool? | plan_list ok? | artifact ok? | fallback fence cần không?
- Provider nào không có máy hoặc không đăng nhập: ghi "chưa kiểm tra", không đoán.

### P6. Tài liệu

- `docs/user-guides/` (theo cách đặt tên trong thư mục): một trang ngắn về Plans và Canvas.
- Release notes của bản kế tiếp (`docs/release-notes/v0.1.xx.md`), mục "What's new". Bug sửa kèm (nếu có) vào mục "Fixes", theo memory "Release notes list fixes too".
- Xóa mọi file test hoặc ảnh chụp tạm: `pnpm clean:junk`, rồi `pnpm clean:junk:delete` nếu cần.

---

## 8. Danh sách file

Mới:

- `apps/desktop/src-tauri/src/plans.rs`
- `apps/desktop/src-tauri/src/artifacts.rs`
- `apps/desktop/src/lib/plans/plans.svelte.ts`
- `apps/desktop/src/lib/components/plans/PlansView.svelte`
- `apps/desktop/src/lib/canvas/canvas.svelte.ts`
- `apps/desktop/src/lib/canvas/fence.ts` + `fence.test.ts`
- `apps/desktop/src/lib/components/canvas/CanvasView.svelte`
- `apps/desktop/src/lib/components/chat/CanvasCard.svelte`
- `docs/user-guides/<plans-canvas>.md`

Sửa:

- `apps/desktop/src-tauri/src/lib.rs`: `mod`, `invoke_handler`
- `apps/desktop/src-tauri/src/mcp.rs`: tool list, route, instructions
- `crates/adapters/src/agent/permission.rs`: cho `plan_*`/`artifact_*` trong `Mode::Plan`, kèm test
- `apps/desktop/src/lib/chat/content/tools.ts`: hai tab
- `apps/desktop/src/lib/components/chat/ToolView.svelte`: hai nhánh
- `apps/desktop/src/lib/chat/content/blocks.ts`: segment `artifact`
- `apps/desktop/src/lib/components/chat/AssistantMessage.svelte`: render `CanvasCard`
- `apps/desktop/src/lib/chat/content/tool-kind.ts` + test, `apps/desktop/src/lib/chat/runs/activity-kind.ts`: icon
- `apps/desktop/src/lib/chat/session/events.svelte.ts`: tự lưu `ExitPlanMode`
- `apps/desktop/src/lib/chat/session/turns.svelte.ts` (hoặc nơi biết turn kết thúc): tự lưu plan Codex
- `apps/desktop/src/lib/chat/slash.svelte.ts`: `/plan`, `/plans`
- `apps/desktop/src/lib/app/platform/icons.ts` + `bundled-icons.ts`: chỉ khi icon Canvas chưa có
- `docs/release-notes/v0.1.xx.md`

---

## 9. Quyết định của người dùng (2026-11-05)

1. **Artifact lưu trong project đang làm việc**: `<project>/docs/artifacts/`. Không lưu vào AgentDeck. Áp dụng ở mục 2.2 và 3.2.
2. **Mermaid: chưa làm.** Bản đầu không thêm mermaid. Agent cần sơ đồ thì tạo artifact `svg`. Chỉ xem lại khi người dùng yêu cầu.
3. **"Set status" ghi front-matter vào plan cũ: làm.** Plan cũ không có front-matter (status `unknown`). Khi người dùng bấm Set status (hoặc agent gọi `plan_step` / `plan_write` với `id` của file đó), Rust chèn khối front-matter lên đầu file và giữ nguyên toàn bộ nội dung cũ. `title` lấy từ dòng `# ` đầu, `created` lấy mtime cũ, `source: manual`. Không tự ghi khi chỉ liệt kê hoặc đọc. Thêm test: file cũ sau khi set status thì nội dung phía dưới front-matter giống hệt trước.

## 10. Definition of Done

- [ ] `pnpm check` sạch: cargo check, clippy `-D warnings`, svelte-check.
- [ ] `pnpm lint` sạch.
- [ ] `node scripts/cargo.mjs test --workspace` pass, gồm test mới của `plans.rs`, `artifacts.rs`, `permission.rs`.
- [ ] Test node mới (`fence.test.ts`, `tool-kind.test.ts`) pass.
- [ ] Ảnh chụp tab Plans và tab Canvas, đã so với tab Tasks/Activity.
- [ ] Claude và Codex: tự lưu plan ở plan mode chạy thật; Codex làm theo plan của Claude và tick step.
- [ ] Bảng kiểm tra provider ở P5.
- [ ] Kết quả 4 phép thử bảo mật iframe.
- [ ] Không còn file rác (`pnpm clean:junk` rỗng).
- [ ] PR liệt kê từng file đã đổi, mỗi file một dòng lý do.
