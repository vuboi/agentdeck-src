# Plan: Spec-driven development cho AgentDeck (plan được duyệt, gắn vào lúc chạy, có kiểm chứng)

Ngày: 2026-11-05. Trạng thái: đề xuất, chưa code. Người viết plan không sửa code nào.

Người nhận: đọc `AGENTS.md` trước. Làm đúng thứ tự phase. Mỗi phase là một commit riêng (hoặc một PR riêng). Cuối mỗi phase chạy các lệnh ở mục "Kiểm tra" của phase đó và ghi kết quả thật vào PR. Phase nào có câu "hỏi người dùng" thì dừng lại hỏi, không tự quyết.

Mọi số dòng `file:line` trong plan này đọc từ nhánh `main` tại commit `7a6859a` (worktree `E:\WORK\PROJECTS\agentdeck-merge`). Tạo nhánh mới từ `main` mới nhất. Nếu số dòng đã lệch, tìm theo tên hàm, đừng đoán.

---

## 0. Mục tiêu

Hiện tại plan trong AgentDeck chỉ là một file checklist. Agent có thể code khi plan còn là draft, tự đặt plan sang `approved`, và tick bước mà không cần bằng chứng. Plan này biến plan thành một "hợp đồng" có ba tính chất:

1. **Duyệt là thật.** Chỉ người dùng đặt được `approved`. Sửa nội dung một plan đã duyệt thì plan quay về `draft` và phải duyệt lại.
2. **Plan gắn vào lúc chạy.** Một chat gắn với một plan. Khi plan còn draft, chat đó tự chạy ở chế độ `plan` (chỉ đọc). Có nút "Approve & run" để bắt đầu làm theo plan.
3. **Có kiểm chứng.** Mỗi bước có thể có dòng `verify:`. Tick bước đó thì agent phải đưa `evidence` (bằng chứng: lệnh đã chạy và kết quả). Auto review chấm theo các bước và tiêu chí của plan, không chỉ theo câu hỏi của người dùng.

Phase 6 (làm sau, chỉ khi người dùng đồng ý) thêm: template spec kiểu Requirements/Design/Tasks, constitution, truy vết bước → file/commit, archive.

### Ngoài phạm vi

- Không viết lại workflow presets thành graph chạy cứng (`workflows.svelte.ts:1` đã chốt: "never execute a fixed node graph").
- Không thêm crate YAML. Front matter vẫn là `key: value` phẳng, parser tự viết trong `plans.rs`.
- Không ép mọi chat phải có plan. Cổng duyệt (phase 3) là tuỳ chọn, mặc định tắt.
- Không sửa nội dung các plan cũ trong `docs/plans/`. Plan cũ phải đọc được như trước.
- Không thêm thư viện UI. Theo đúng quy tắc UI trong `AGENTS.md` (ZPopover, `Menu`, `MenuButton`, token có sẵn, không màu mới).

---

## 1. Hiện trạng (đã đọc trong code)

| Chỗ | Đang làm gì | Liên quan phase |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/plans.rs:13-18` | `WRITE_DIR = "docs/plans"`, `MAX_BODY = 256 KB`, 4 tool MCP, `MUTATION_LOCK` | 1, 2, 5 |
| `plans.rs:20-35` `PlanInfo` | id, path, title, status, agent, chat, source, created, updated, done, total, read_only | 1, 3 |
| `plans.rs:37-47` `WriteReq` | title, body, status, id, agent, chat, source, base_updated | 2 |
| `plans.rs:171` `parse_fm`, `:222` `update_key`, `:230` `render_fm` | Parser front matter phẳng | 1 |
| `plans.rs:240` `counts`, `:709` `step_line`, `:713` `step_text` | Đếm bước `- [ ]` / `- [x]` | 1, 5 |
| `plans.rs:476-606` `write` | `status` lấy từ tham số, mặc định `draft`. **MCP truyền `status: "approved"` thì được luôn** (`:483-486`, `:780`) | 2 |
| `plans.rs:487-514` | Auto-save cùng chat (`source` = `exit-plan-mode` / `codex-plan-mode`) cập nhật draft cũ | 2, 3 |
| `plans.rs:631-643` `set_status` | Chỉ gọi từ Tauri `plans_set_status` (UI). Không ghi ai duyệt, lúc nào | 2 |
| `plans.rs:645-707` `set_step` | Tick bước; tự đổi status `draft/approved → doing`, đủ bước → `done`. **Không cần bằng chứng** | 5 |
| `plans.rs:726-733` `tool_defs` | Mô tả 4 tool MCP | 2, 5 |
| `plans.rs:735-828` `call` | Route MCP. `plan_write` emit `plan-changed` | 2, 5 |
| `apps/desktop/src-tauri/src/mcp.rs:952` | `instructions` của server MCP: "follow an approved plan, tick its steps with plan_step…" | 2, 5 |
| `apps/desktop/src-tauri/src/lib.rs:717-789` | Lệnh Tauri `plans_list/read/set_status/set_step/save` | 2, 3 |
| `crates/adapters/src/agent/permission.rs:10-21, 95-102, 117-131` | 5 mode; mode `Plan` chỉ cho `Read` và `PlanWrite` (plan/artifact) | 3 |
| `apps/desktop/src/lib/chat/session/turns.svelte.ts:288-321` | `PERMISSION_MODE`, `chatTurnOptions`, `turnOptionsOf(sessionId)` | 3 |
| `apps/desktop/src/lib/chat/session/run.svelte.ts:805` | `const permission = turnOptionsOf(session.id).permission;` → dùng ở `:808` (`runReplies`), `:995`, `:1185` | 3 |
| `run.svelte.ts:450, 485` | Prewarm cũng đọc `turnOptionsOf(...).permission` | 3 |
| `run.svelte.ts:1093-1129` | Ghép hint đầu cuộc trò chuyện (`agentdeckLead(openHint, delegateHint, reminder, styleHint, memoryNote, profileNote, routing, LANGUAGE_RULE)`) | 4, 6 |
| `apps/desktop/src/lib/components/chat/Composer.svelte:354-421` | State `permission` của từng chat, ghi vào `chatTurnOptions` | 3 |
| `apps/desktop/src/lib/chat/session/events.svelte.ts:1633-1700+` `autoSavePlan` | Claude `ExitPlanMode` → plan draft `source: exit-plan-mode`; Codex ở mode plan → `source: codex-plan-mode` | 3 |
| `apps/desktop/src/lib/plans/plans.svelte.ts` | `plansCache[root]`, `loadPlans(root, refresh)` | 3 |
| `apps/desktop/src/lib/components/plans/PlansView.svelte:113-157` | Menu: Open, Copy path, Set status (Approved/Doing/Done/Dropped) | 2, 3, 4 |
| `apps/desktop/src/lib/chat/slash.svelte.ts:144-159` | `/plan`, `/plans` là template prompt | 1, 4 |
| `apps/desktop/src/lib/tasks/auto-review.ts:54-74` `reviewBrief` | Brief cho reviewer: chỉ request + file đổi | 5 |
| `apps/desktop/src/lib/chat/session/delegate-task.svelte.ts:1787-1827` `maybeAutoReview` | Gọi `reviewBrief(askText(source), paths, round)` | 5 |
| `apps/desktop/src-tauri/src/delegate.rs:189-295` `DelegateArgs`, `parse_delegate` | Tham số `delegate_task`: agent, model, role, task, wait, timeout_s, continue, depends_on, isolation | 4 |
| `apps/desktop/src-tauri/src/devtools.rs:29-35, 398-479` `run_checks` | Chạy script lint/typecheck/test/build của project | 5 |
| `apps/desktop/src/lib/app/platform/automation.svelte.ts:12-31` | Store setting `automation` (compress, orchestrate, prehandle, review), lưu pref `chat.automation` | 3 |
| `apps/desktop/src-tauri/src/project_memory.rs` | `.agentdeck/memory.md`, `.agentdeck/proposals.md` (chỉ lệnh Tauri, không có MCP) | 6 |

Lỗ hổng chính, sắp theo phase:

- **P2:** agent tự duyệt được (`plan_write` với `status: approved`). Sửa plan đã duyệt không đưa về draft.
- **P3:** không có gì ngăn code khi plan còn draft.
- **P4:** plan không nối với chat chạy, `delegate_task`, worktree.
- **P5:** tick bước không cần bằng chứng; reviewer không biết plan.

---

## 2. Quyết định thiết kế (đã chốt, đừng đổi khi chưa hỏi)

1. **Một nguồn sự thật vẫn là Rust.** Mọi luật về status, duyệt, bằng chứng nằm trong `plans.rs`. Frontend chỉ hiển thị và gọi lệnh. MCP và Tauri gọi cùng một hàm Rust.
2. **Định dạng plan tương thích ngược.** Thêm key front matter và dòng con dưới bước, không đổi cú pháp bước `- [ ] …`. Plan cũ không có key mới vẫn đọc, list, tick được.
3. **Duyệt chỉ đến từ người dùng.** Đường duyệt duy nhất là lệnh Tauri `plans_set_status` (UI). Tool MCP không bao giờ đặt được `approved`, `doing`, `done`.
4. **Cổng duyệt trong chat là tuỳ chọn** (`automation.requirePlanApproval`, mặc định `false`). Khi bật, chỉ áp cho chat đang gắn với một plan draft. Cách chặn: ép permission của lượt chat thành `plan`. Không thêm cơ chế chặn mới ở adapter, vì mode `plan` đã được mọi adapter hiểu (`permission.rs`).
5. **Bằng chứng là text, không phải chạy lại.** Rust không tự chạy test để xác minh `evidence`. Nó chỉ bắt buộc có `evidence` khi bước có `verify:`, và lưu lại. Reviewer (P5) đọc evidence và đối chiếu.
6. **Không thêm tool MCP mới nếu thêm tham số là đủ.** `plan_step` thêm `evidence`; `delegate_task` thêm `plan_id` + `plan_step`.

---

## 3. Định dạng plan v2

### 3.1 Front matter (thêm key, không bắt buộc)

```markdown
---
title: Thêm export CSV cho báo cáo
status: draft
agent: claude
chat: 3f2a…            # chat tạo plan (có sẵn)
source: exit-plan-mode # có sẵn
created: 2026-11-05T10:00:00.000Z
updated: 2026-11-05T10:05:00.000Z
approved_at: 2026-11-05T10:06:00.000Z   # MỚI: lúc người dùng duyệt; xoá khi plan về draft
run_chat: 9c1b…                          # MỚI: chat đang làm theo plan (P4)
gate: off                                # MỚI, tuỳ chọn: chat gắn plan này không bị ép mode plan (P3)
---
```

- `approved_at`: chỉ `set_status(..., "approved")` ghi. `write` xoá khi đưa plan về `draft`.
- `run_chat`: chỉ lệnh Tauri mới ở P4 ghi.
- `gate`: chỉ nhận `off`. Không có key = cổng áp dụng bình thường.

### 3.2 Bước và dòng con

```markdown
- [ ] Thêm hàm `toCsv(rows)` trong src/lib/report/csv.ts
  - files: src/lib/report/csv.ts, src/lib/report/csv.test.ts
  - verify: `pnpm --filter desktop test csv` pass
- [x] Nút Export trong ReportPage
  - verify: bấm Export tải file .csv có header đúng
  - evidence: 2026-11-05T11:20:00.000Z · claude · chạy pnpm test csv: 4 passed; mở app bấm Export, file có 3 cột
```

Luật parse (viết trong Rust, có test):

- Bước là dòng `step_line` như hiện nay (`plans.rs:709`).
- Dòng con của một bước là các dòng ngay sau nó, thụt vào sâu hơn bước, bắt đầu bằng `- ` hoặc `* `, rồi `files:` / `verify:` / `evidence:` (không phân biệt hoa thường, cho phép khoảng trắng quanh `:`).
- Dòng con dừng ở dòng trống, dòng bước tiếp theo, hoặc dòng thụt bằng/nông hơn bước.
- Dòng con khác (ví dụ ghi chú tự do) giữ nguyên, không đụng.
- **Quan trọng:** dòng con `- verify:` không được bị đếm là bước. `step_line` đòi `[ ]` / `[x]` nên đã không đếm, nhưng phải có test khẳng định.

---

## 4. Các phase

### Phase 1 — Parser bước v2 (Rust, chưa đổi hành vi)

**Mục đích:** có hàm đọc bước kèm `files/verify/evidence` để các phase sau dùng. Không đổi output của tool nào.

**Việc làm** (`apps/desktop/src-tauri/src/plans.rs`):

1. Thêm struct:
   ```rust
   #[derive(Clone, Debug, Default, Serialize, PartialEq)]
   #[serde(rename_all = "camelCase")]
   pub struct PlanStep {
       pub number: usize,        // 1-based, như plan_step
       pub text: String,         // = step_text(line)
       pub done: bool,
       pub files: Vec<String>,   // tách theo dấu phẩy, trim, bỏ rỗng, bỏ dấu backtick bao quanh
       pub verify: Option<String>,
       pub evidence: Option<String>,
       /// Byte offset của dòng bước và hết khối dòng con, để P5 chèn evidence đúng chỗ.
       #[serde(skip)]
       pub span: (usize, usize),
   }
   pub fn steps(body: &str) -> Vec<PlanStep>
   ```
2. `steps()` dùng đúng `step_line` / `step_text` hiện có. Không viết parser bước thứ hai.
3. Thêm `pub fn front_key(text: &str, name: &str) -> Option<String>` nếu cần cho P2/P3; nếu đã đủ với `parse_fm` + `key` thì không thêm.
4. Thêm vào `PlanInfo` (`plans.rs:22`): `approved_at: String` (rỗng nếu chưa có), `run_chat: String`, `gate: String`. Điền trong `info()` (`plans.rs:271`). Frontend `PlanInfo` (`apps/desktop/src/lib/plans/plans.svelte.ts:5-18`) thêm `approvedAt`, `runChat`, `gate`.

**Test** (trong `mod tests` của `plans.rs`):

- Bước không có dòng con → `files` rỗng, `verify`/`evidence` là `None`.
- Bước có `files`, `verify`, `evidence` (thụt 2 và 4 dấu cách, có `\r\n`) → đọc đúng.
- Dòng con `- verify:` không bị đếm vào `counts()` (`total` không đổi).
- Hai bước liền nhau, bước 1 có dòng con, bước 2 không → bước 2 không "ăn" dòng con của bước 1.
- Danh sách lồng bên trong một bước (`  - [ ] sub`) vẫn là bước riêng như hiện nay (giữ đúng hành vi `counts`).
- Plan cũ ví dụ `docs/plans/plan-plans-artifacts.md` (copy một đoạn vào test) parse không lỗi.

**Kiểm tra:**

```bash
cargo test -p agentdeck-desktop --lib plans
```

```bash
cargo clippy --workspace -- -D warnings
```

Chạy hai lệnh trong VS dev shell (xem `docs` / memory build: crate desktop cần `Launch-VsDevShell.ps1`, PATH có `~/.cargo/bin`).

**Xong khi:** test mới pass, test cũ của `plans.rs` không đổi và vẫn pass, chưa có thay đổi hành vi nào nhìn thấy được.

---

### Phase 2 — Duyệt là thật (Rust + menu Plans)

**Mục đích:** agent không tự duyệt được; sửa plan đã duyệt thì phải duyệt lại.

**Việc làm — Rust (`plans.rs`):**

1. Tách nguồn ghi. `write()` nhận thêm biết ai gọi. Cách tối thiểu: dùng `req.source` có sẵn. Định nghĩa:
   - `source == "mcp"` → **agent**.
   - `source ∈ {"exit-plan-mode", "codex-plan-mode"}` → **auto-save**, cũng coi như agent.
   - Lệnh Tauri `plans_save` (`lib.rs:767`) truyền `source` từ frontend; frontend hiện truyền `exit-plan-mode` / `codex-plan-mode`. Không có đường UI nào ghi body với quyền người dùng ⇒ coi mọi `write()` là agent. **Không thêm tham số mới.**
2. Trong `write()` (`plans.rs:483-486`):
   - Nếu `req.status` là `approved`, `doing` hoặc `done` → trả lỗi: `"only the user can set a plan to approved/doing/done; save it as draft and ask the user to approve it in Plans"`.
   - Cho phép `draft` và `dropped` như cũ.
3. Sửa plan đã duyệt: trong `write()`, khi `existing` có status `approved` hoặc `doing`:
   - Nếu body mới khác body cũ (so sau khi chuẩn hoá `\r\n` → `\n` và trim cuối) → đặt status `draft`, xoá `approved_at`, giữ `run_chat`.
   - Nếu body giống hệt → giữ status (agent ghi lại y nguyên không làm mất duyệt).
   - Kết quả trả về tool phải nói rõ: `saved <id> (status=draft — the plan changed after approval, ask the user to approve it again)`.
   - Plan status `done` sửa body → cũng về `draft` (đây là mở lại plan). Plan `dropped` sửa body → giữ `dropped`.
4. `set_status()` (`plans.rs:631`):
   - `approved` → ghi `approved_at = now()`.
   - `draft` → xoá `approved_at`.
   - Các status khác giữ `approved_at` như cũ.
   - Thêm `touch_updated(&mut fm)` trước `atomic_write`. Hiện `set_status` (`plans.rs:631-643`) **không** gọi nó, nên `updated` không đổi khi duyệt và `base_updated` của agent không phát hiện được.
5. Cập nhật mô tả tool (`plans.rs:728-731`):
   - `plan_write`: thêm "Status can only be draft or dropped. Approval is the user's: after saving, tell the user to approve it in the Plans tab. Changing an approved plan sends it back to draft."
   - `plan_list`: giữ, thêm "Only work on code for a plan whose status is approved or doing."
6. Cập nhật `instructions` MCP (`mcp.rs:952`), câu về Plans thành: "Plans: plan_list shows plans every AgentDeck agent shares. Only the user approves a plan (in the Plans tab); do not start code changes for a plan that is still draft. While working on an approved plan, tick each step with plan_step, and pass evidence for steps that have a verify line. Save a new plan with plan_write when you plan multi-step work."

**Việc làm — UI (`PlansView.svelte`):**

7. Hàng plan: thêm thông tin `approved <ago>` khi `approvedAt` có giá trị (cùng dòng meta hiện tại `:182-186`, dùng `ago()` có sẵn). Không thêm badge màu.
8. Menu (`:126-157`): thêm item đầu tiên `Approve` (icon `lucideCheck`) khi `status === 'draft'` và không `readOnly`. Bấm → `setStatus(row, 'approved')`. Giữ submenu Set status như cũ.
9. Không thêm modal xác nhận cho Approve (duyệt đảo ngược được bằng Set status → Draft).

**Test Rust:**

- `plan_write` qua đường `call()` hoặc `write()` với `status: Some("approved")` → lỗi đúng câu.
- `write()` lên plan `approved` với body khác → status `draft`, không còn `approved_at`.
- `write()` lên plan `approved` với body giống hệt (khác `\r\n`) → vẫn `approved`.
- `set_status(approved)` → có `approved_at`; `set_status(draft)` → mất `approved_at`; `updated` tăng sau mỗi lần.
- Auto-save (`source: exit-plan-mode`) cập nhật draft cùng chat vẫn chạy như test hiện có (`autosave_updates_same_chat_source_draft_and_keeps_created`).

**Kiểm tra:** như P1, cộng:

```bash
pnpm --filter desktop check
```

```bash
node --experimental-strip-types --experimental-vm-modules --test apps/desktop/src/lib/chat/session/plan-save.test.mjs
```

**Kiểm tra tay** (app thật, `pnpm dev`):

1. Trong một chat, bảo agent: "dùng plan_write lưu plan 2 bước với status approved". Kết quả tool phải là lỗi, Plans tab không có plan approved mới.
2. Trong Plans tab, bấm Approve một plan draft → status approved, meta hiện "approved vừa xong".
3. Bảo agent sửa body plan đó bằng plan_write → Plans tab hiện plan về draft.

**Xong khi:** 3 bước tay đúng, test pass. Ghi ảnh chụp Plans tab vào PR.

---

### Phase 3 — Cổng duyệt trong chat (tuỳ chọn, mặc định tắt)

**Mục đích:** chat gắn với một plan draft thì không sửa code được cho đến khi người dùng duyệt.

**Định nghĩa "chat gắn với plan"** (viết thành hàm thuần, có test):

Một plan P gắn với chat C nếu P không `readOnly`, và (`P.runChat === C.id`) hoặc (`P.chat === C.id` và `P.source` là `exit-plan-mode`, `codex-plan-mode` hoặc `mcp`). Nếu có nhiều plan gắn, lấy plan có `updated` mới nhất.

**Cổng bật khi** tất cả đúng:

- `automation.requirePlanApproval === true`,
- chat C không phải worker và không phải side chat (`isWorkerChat(id)`, `session.side`),
- có plan P gắn với C, `P.status === 'draft'`, `P.gate !== 'off'`.

Khi cổng bật: permission thực của lượt = `'plan'`, bất kể Composer đang chọn gì. Composer **không** đổi lựa chọn của người dùng; chỉ lượt chạy bị ép.

**Việc làm:**

1. `apps/desktop/src/lib/app/platform/automation.svelte.ts:12-17`: thêm `requirePlanApproval: false`. Pref cũ không có key → giữ `false` (do `Object.assign`).
2. File mới `apps/desktop/src/lib/plans/plan-gate.ts` (thuần, không import store, để node test được):
   ```ts
   export type GatePlan = Pick<PlanInfo, 'id' | 'status' | 'chat' | 'runChat' | 'source' | 'gate' | 'updated' | 'readOnly'>;
   export function boundPlan(plans: GatePlan[], chatId: string): GatePlan | null;
   export function gated(input: { enabled: boolean; worker: boolean; plan: GatePlan | null }): boolean;
   export function effectivePermission(chosen: Permission, isGated: boolean): Permission; // isGated ? 'plan' : chosen
   ```
3. File mới `apps/desktop/src/lib/plans/plan-gate.svelte.ts` (nối store):
   ```ts
   export function gatePlanOf(sessionId: string): PlanInfo | null; // đọc plansCache[projectOf(session).path]
   export function permissionOf(sessionId: string): Permission;     // effectivePermission(turnOptionsOf(id).permission, gated(...))
   ```
   - `projectOf` / `sessionCwd`: dùng hàm có sẵn trong `chat/sessions.svelte`. Lấy root bằng `projectOf(session)?.path` giống `autoSavePlan` (`events.svelte.ts:1653`).
   - Nếu `plansCache[root]` chưa có, gọi `void loadPlans(root)` và coi như chưa gắn (không chặn). Ghi chú điều này trong comment.
4. `run.svelte.ts`:
   - `:805` → `const permission = permissionOf(session.id);`
   - `:450` và `:485` (prewarm) → `PERMISSION_MODE[permissionOf(session.id)]`.
   - Không đổi chỗ khác. `:995` và `:1185` đã dùng biến `permission` ở `:805` — kiểm tra lại scope; nếu không cùng scope thì đổi theo cùng cách.
   - `runReplies.set(... permission ...)` ở `:808` nhận permission thực ⇒ `autoSavePlan` của Codex (`events.svelte.ts:1686`) sẽ tự lưu plan khi chat bị ép mode plan. Đây là hành vi mong muốn; ghi trong PR.
5. Nạp plan cho chat đang mở: khi chat active đổi, gọi `loadPlans(root)` (một `$effect` trong `plan-gate.svelte.ts` hoặc trong component Chat; chọn chỗ có sẵn effect theo `workspace.activeId`, đừng tạo effect toàn cục mới nếu đã có chỗ phù hợp).
6. Lắng nghe `plan-changed` (đã có trong `PlansView.svelte:94`) — cần thêm một listener ở module scope trong `plan-gate.svelte.ts` để refresh `plansCache` khi tab Plans không mở (giống cách `canvas.svelte.ts` lắng nghe `artifact-changed` ở module scope). Chỉ đăng ký khi `inTauri() && !isPreviewCopy()`.
7. **UI — dải báo trong chat** (Composer hoặc ngay trên Composer, tìm chỗ hiện cảnh báo có sẵn như queue/limit để copy style):
   - Khi `gated` → một dòng: `Plan "<title>" chưa duyệt — chat chạy ở chế độ Plan (chỉ đọc).` + nút `Approve` + nút `Open plan` + menu `…` có `Run without approval` (ghi `gate: off`).
   - Nút Approve gọi `plans_set_status(root, id, 'approved')`.
   - `Open plan` dùng `openProjectFile(plan.path, root)`.
   - Style: `border`, nền phẳng, chữ `text-sm`, icon `lucideClipboardList`. Không màu mới, không badge.
   - Trigger chọn permission của Composer: khi gated, hiển thị tooltip "Đang bị ép Plan bởi plan chưa duyệt" (không đổi giá trị chọn).
8. **Rust — ghi `gate: off`:** thêm lệnh Tauri `plans_set_gate(root, id, gate: Option<String>)` trong `lib.rs` gần `plans_set_status`, gọi hàm mới `plans::set_gate(root, id, off: bool)` (khoá `MUTATION_LOCK`, `ensure_frontmatter`, `update_key("gate","off")` hoặc xoá key, `touch_updated`, emit `plan-changed`). Đăng ký trong `generate_handler!` (`lib.rs:2781`). `build.rs` tự sinh permission; commit file `permissions/autogenerated/plans_set_gate.toml` mới sinh ra.
9. **Công tắc:** công tắc Auto review hiện nằm trong popover model của chat (`apps/desktop/src/lib/components/chat/ModelPicker.svelte:546`, bind `automation.review`). Thêm công tắc "Require approved plan" ngay dưới nó, cùng markup. Mô tả ngắn: "A chat that saved a plan stays in Plan mode until you approve that plan." Quy tắc "sửa ModelPicker thì sửa ImageGenerator" trong `AGENTS.md` nói về cấu trúc danh sách model; công tắc này chỉ thuộc chat, không thêm vào ImageGenerator. Nếu không chắc, hỏi người dùng.

**Test node** (`apps/desktop/src/lib/plans/plan-gate.test.ts`, chạy bằng `node --experimental-strip-types --test`):

- `boundPlan`: chọn theo `runChat` trước; theo `chat`+source; bỏ plan `readOnly`; nhiều plan → `updated` mới nhất; plan source `manual` không gắn qua `chat`.
- `gated`: tắt setting → false; worker → false; plan approved/doing/done/dropped → false; `gate: off` → false; draft → true.
- `effectivePermission('yolo', true) === 'plan'`, `effectivePermission('yolo', false) === 'yolo'`.

**Kiểm tra:** `pnpm --filter desktop check`, test node mới, `cargo test -p agentdeck-desktop --lib plans`, clippy.

**Kiểm tra tay** (bật setting trước):

1. Chat mới ở mode Yolo. Gõ `/plan thêm hàm cộng vào file tạm`. Agent lưu plan draft (qua `plan_write` hoặc auto-save).
2. Gõ "làm đi". Agent không sửa được file (Claude: báo bị từ chối / thoát plan mode bị chặn; Codex: sandbox read-only). Dải báo hiện.
3. Bấm Approve trên dải báo. Gõ "làm đi" lần nữa → agent sửa file được (mode Yolo trở lại).
4. Tắt setting → không còn dải báo, không bị ép.
5. Thử với cả **Claude** và **Codex**. Ghi kết quả từng provider vào PR (bảng: provider | bị chặn khi draft? | chạy khi approved?).

**Rủi ro cần kiểm khi làm:**

- Claude ở mode `plan` kết thúc bằng tool `ExitPlanMode`. Trong frontend, `ExitPlanMode` hiện chỉ được dùng để tự lưu plan (`events.svelte.ts:1662`) và chọn icon (`tool-kind.ts:25`, `activity-kind.ts:123`); không có card riêng. Trước khi làm, chạy thử Claude ở mode plan trong app và ghi lại: `ExitPlanMode` có hỏi người dùng không, hỏi ở đâu, và lượt kết thúc thế nào. Nếu người dùng chấp nhận thoát plan mode mà plan vẫn draft, lượt sau vẫn bị ép `plan` — có thể gây vòng lặp khó hiểu. **Hỏi người dùng** trước khi chọn: (a) chấp nhận thoát plan mode = duyệt plan luôn, hay (b) chỉ dải báo "Approve" mới duyệt.
- Lượt đang chạy khi người dùng bấm Approve: không đổi permission giữa lượt. Lượt sau mới áp.

**Xong khi:** 5 bước tay đúng cho Claude và Codex, test pass.

---

### Phase 4 — Plan nối vào lúc chạy ("Approve & run", `delegate_task` biết plan)

**Mục đích:** từ một plan đã duyệt, bắt đầu làm bằng một nút; worker được giao một bước của plan thì biết đó là bước nào và tiêu chí gì.

**Việc làm — Rust:**

1. `plans.rs`: hàm `set_run_chat(root, id, chat: &str)` (khoá, `update_key("run_chat", chat)`, `touch_updated`, ghi). Lệnh Tauri `plans_set_run_chat` trong `lib.rs`, đăng ký `generate_handler!`, commit file permission sinh ra.
2. `plans.rs`: hàm `step_brief(root, id, number) -> Result<String, String>` trả text ngắn cho worker:
   ```
   Plan <id> "<title>" (status=<status>), step <n>/<total>: <text>
   Files: <files hoặc "not listed">
   Verify: <verify hoặc "not listed">
   When this step is done and verified, report the evidence (commands run and their result). Do not tick plan steps yourself; the lead ticks them with plan_step.
   ```
3. `delegate.rs`:
   - `DelegateArgs` (`:191`) thêm `plan_id: Option<String>`, `plan_step: Option<usize>`.
   - `parse_delegate` (`:235`): đọc `plan_id` (text), `plan_step` (số ≥ 1, chấp nhận chuỗi số như `seconds_of` đang làm). Có `plan_step` mà không có `plan_id` → lỗi `"plan_step needs plan_id"`.
   - Mô tả tool trong `tool_defs` (`:112-130`): thêm 2 thuộc tính, mô tả: "plan_id and plan_step: the approved plan and the 1-based step this worker does. AgentDeck adds the step, its files and its verify line to the task."
   - Ở chỗ dựng prompt cho worker (tìm nơi `task` được gửi sang frontend `onDelegateCall` / payload JSON `:503`): thêm `plan_id`, `plan_step` vào payload. **Ghép brief ở Rust** bằng `plans::step_brief` trước `task`, để mọi provider nhận giống nhau. Nếu plan không tồn tại hoặc status không phải `approved`/`doing` → lỗi trả về agent: `"plan <id> is <status>; only an approved plan can be delegated"`.
   - Test trong `delegate.rs`: parse có/không plan; `plan_step` thiếu `plan_id` lỗi; chuỗi `"2"` thành 2.
4. MCP instructions (`mcp.rs:952`): thêm "When you hand a step of an approved plan to another agent, pass plan_id and plan_step to delegate_task."

**Việc làm — UI:**

5. `PlansView.svelte` menu: thêm `Approve & run` (khi draft) và `Run` (khi approved). Hành động:
   - (Approve & run) gọi `plans_set_status(approved)`.
   - Tạo chat mới trong project của plan (tìm hàm tạo chat có sẵn, ví dụ hàm mà nút "New session" gọi; dùng lại, đừng viết mới), agent = agent mặc định của chat mới.
   - Gọi `plans_set_run_chat(root, id, newChatId)`.
   - Gửi prompt đầu tiên (template, đặt trong `slash.svelte.ts` cạnh `/plan` để dễ sửa):
     ```
     Work on the approved plan <id> ("<title>"). Read it with plan_read. Do the steps in order. After each step, run its verify line, then tick it with plan_step and pass evidence (the commands you ran and their result). If a step turns out wrong, stop and tell me; do not rewrite the plan without asking.
     ```
   - Chuyển màn hình sang chat mới.
6. Thêm slash `/run-plan <id>` dùng cùng template (cho người gõ tay). Nếu không có id → template bảo agent gọi `plan_list` và hỏi người dùng chọn plan approved.
7. Hàng plan trong PlansView: nếu có `runChat` và chat đó còn tồn tại trong `workspace.sessions` → thêm item menu `Open chat` (focus chat đó).

**Hint đầu cuộc trò chuyện (tuỳ chọn trong phase này, làm nếu ít rủi ro):**

8. `run.svelte.ts:1093-1129`: khi chat có plan gắn (hàm `gatePlanOf` P3) và status `approved`/`doing`, thêm một `planNote` vào `agentdeckLead(...)`: `This chat works on plan <id> (<done>/<total> steps). Read it with plan_read before changing code.` Chỉ khi `!resume`, giống `memoryNote`.

**Kiểm tra:** clippy, `cargo test -p agentdeck-desktop --lib delegate`, `cargo test -p agentdeck-desktop --lib plans` (cargo chỉ nhận một filter mỗi lần), `pnpm --filter desktop check`, test node.

**Kiểm tra tay:**

1. Plan draft 2 bước có `verify:`. Bấm `Approve & run` → chat mới mở, prompt đầu gửi đi, agent `plan_read` rồi làm bước 1.
2. Plans tab: hàng plan có `Open chat` mở đúng chat.
3. Trong một chat khác, bảo agent: "giao bước 2 của plan <id> cho codex" → agent gọi `delegate_task` có `plan_id`, `plan_step`; worker nhận brief có dòng Verify.
4. Đặt plan về draft, thử lại bước 3 → `delegate_task` báo lỗi "only an approved plan can be delegated".

**Xong khi:** 4 bước tay đúng.

---

### Phase 5 — Kiểm chứng: evidence khi tick, reviewer chấm theo plan

**Mục đích:** bước có `verify:` không tick được nếu thiếu bằng chứng; auto review đối chiếu với plan.

**Việc làm — Rust (`plans.rs`):**

1. `set_step(root, id, step, done, evidence: Option<&str>, agent: &str)`:
   - Đổi chữ ký; cập nhật mọi chỗ gọi (`call()` `:815`, lệnh Tauri `plans_set_step` `lib.rs:742`).
   - Khi `done == true` và bước có `verify` (dùng `steps()` của P1) và `evidence` rỗng/thiếu → lỗi: `"step <n> has a verify line: pass evidence (the commands you ran and their result)"`.
   - Khi có `evidence`: cắt còn tối đa 2000 ký tự, thay xuống dòng bằng `; `, rồi ghi/ thay dòng con `evidence:` của bước đó: `  - evidence: <now()> · <agent hoặc "user"> · <text>`. Dùng `span` của `PlanStep` để chèn ngay sau khối dòng con của bước (hoặc thay dòng evidence cũ). Thụt lề = thụt của bước + 2 dấu cách.
   - Khi `done == false`: giữ dòng evidence (lịch sử), không xoá.
   - Lệnh Tauri (UI tick tay) truyền `evidence: None`, `agent: ""` — **UI được tick không cần evidence** (người dùng tự chịu). Chỉ MCP bị bắt buộc. Thực hiện bằng tham số `require_evidence: bool` (MCP: true, Tauri: false) thay vì so `agent`.
2. `call()` `plan_step`: đọc `args["evidence"]` (text), `args["agent"]` (text, tuỳ chọn). Trả về thêm `; evidence saved` khi có.
3. `tool_defs` `plan_step`: thêm thuộc tính `evidence` (string) và `agent` (string). Mô tả: "For a step with a verify line, done=true needs evidence: the commands you ran and what they showed."
4. `plan_read` output (`:757-773`): không đổi định dạng (agent vẫn đọc body thô có dòng con).

**Việc làm — auto review (`apps/desktop/src/lib/tasks/auto-review.ts`, `delegate-task.svelte.ts:1787-1827`):**

5. `reviewBrief(request, paths, round, plan?: { id: string; title: string; steps: { number: number; text: string; done: boolean; verify?: string; evidence?: string }[] })`.
   - Khi có `plan`: thêm một đoạn sau "User's request":
     ```
     Plan <id> "<title>" this work follows:
     - [x] 1. <text> — verify: <verify> — evidence: <evidence>
     - [ ] 2. <text> — verify: <verify>
     For each ticked step, check the change does what the step says and its verify line holds (run it when it is cheap). A ticked step whose verify does not hold is a FAIL. Do not fail unticked steps.
     ```
   - Cắt mỗi dòng ở 300 ký tự, tối đa 40 bước (giống `PATHS_MAX`).
   - Hàm vẫn thuần (không import store); test được bằng node.
6. Lấy dữ liệu bước cho reviewer: cần bước đã parse. Thêm lệnh Tauri `plans_steps(root, id) -> Vec<PlanStep>` gọi `plans::steps(&body)`. Trong `maybeAutoReview` (async được không? hiện là sync `function`): đổi thành gọi `void` một hàm async nhỏ lấy steps rồi `startTask(...)`. Giữ nguyên điều kiện `shouldAutoReview`. Chat không gắn plan → không đổi gì.
7. Test node cho `reviewBrief` có/không plan (thêm vào test hiện có của auto-review nếu có; nếu chưa có, tạo `auto-review.test.ts`).

**Kiểm tra:** clippy, `cargo test -p agentdeck-desktop --lib plans`, `pnpm --filter desktop check`, test node.

**Kiểm tra tay:**

1. Plan approved, bước 1 có `verify:`. Bảo agent tick bước 1 không kèm evidence → tool lỗi đúng câu.
2. Agent chạy verify rồi tick có evidence → file plan có dòng `- evidence: …` dưới bước 1, Plans tab đếm 1/N.
3. Tick tay từ UI (nếu có nút; nếu chưa có thì gọi `plans_set_step` qua devtools) → không cần evidence.
4. Bật Auto review, để agent sửa ≥ 2 file trong chat gắn plan → brief của reviewer (xem trong chat worker) có đoạn "Plan … this work follows".

**Xong khi:** 4 bước tay đúng.

---

### Phase 6 — (Làm sau, hỏi người dùng trước khi bắt đầu) Spec nhiều lớp, constitution, truy vết, archive

Mỗi mục dưới đây là một commit riêng. Không làm mục nào khi chưa được đồng ý.

**6.1 Template spec (`/spec`):**

- Slash mới `/spec <mô tả>` trong `slash.svelte.ts`: prompt yêu cầu agent viết plan có 3 phần trong cùng một file:
  - `## Requirements`: user story + acceptance criteria dạng EARS (`WHEN <điều kiện> THE SYSTEM SHALL <hành vi>`), đánh số `R1`, `R2`…
  - `## Design`: quyết định, file/module chạm vào, dữ liệu, rủi ro.
  - `## Tasks`: checklist `- [ ]`, mỗi bước có `- verify:` và `- covers: R1, R2`.
- Rust: `steps()` đọc thêm dòng con `covers:`. `plan_write` cảnh báo (không lỗi) nếu có `## Requirements` mà có R không được bước nào `covers` — trả trong text kết quả.
- PlansView: hàng plan có `R x/y covered` khi plan có Requirements.
- Giữ `/plan` gọn cho việc nhỏ.

**6.2 Constitution:**

- File `docs/constitution.md` của project (người dùng tự viết; AgentDeck không tự tạo).
- Khi tồn tại: `run.svelte.ts` thêm `constitutionNote` (đầu cuộc trò chuyện, không resume, không worker) cắt 3000 ký tự, giống `memoryNote`. Có setting bật/tắt cạnh "project memory".
- Reviewer brief (P5) thêm "Also check the project's constitution at docs/constitution.md" khi file tồn tại.

**6.3 Truy vết bước → file/commit:**

- Khi `plan_step` done qua MCP, nếu chat có worktree/branch, ghi thêm dòng con `- changed: <danh sách file từ git diff --name-only so với lúc approved>`. Cần lưu `approved_commit` (HEAD lúc duyệt) trong front matter ở P2.4. **Đây là phần lớn**, cần thiết kế riêng; chỉ làm sau khi 1–5 ổn định.

**6.4 Archive:**

- Plan `done` hoặc `dropped` quá 14 ngày: PlansView có nút "Archive" → chuyển file sang `docs/plans/archive/YYYY-MM-DD-<slug>.md`. `list()` bỏ qua thư mục `archive/` trừ khi lọc "Archived".
- Không tự archive.

**6.5 Memory/proposals qua MCP:**

- Tool `memory_read`, `memory_propose(text)` (ghi vào `.agentdeck/proposals.md`, người dùng duyệt ở Settings như hiện nay). Không cho agent ghi thẳng `memory.md` qua MCP.

---

## 5. Thứ tự và phụ thuộc

```
P1 (parser) ──► P2 (duyệt thật) ──► P3 (cổng trong chat) ──► P4 (approve & run, delegate) ──► P5 (evidence, reviewer)
                                                                                                    │
                                                                                                    ▼
                                                                                         P6 (hỏi trước, từng mục)
```

- P1 → P2 bắt buộc theo thứ tự (P2 dùng `approved_at` của P1).
- P3 cần P2 (status draft đáng tin).
- P4 có thể làm song song với P3 nếu hai người làm, **nhưng** cả hai sửa `PlansView.svelte` và `lib.rs` → làm tuần tự để tránh conflict.
- P5 cần P1 (`steps()` + `span`).

Ước lượng thô cho một người quen codebase: P1 0.5 ngày, P2 0.5–1 ngày, P3 1–1.5 ngày, P4 1–1.5 ngày, P5 1 ngày.

---

## 6. Definition of Done chung (mỗi phase)

- `cargo clippy --workspace -- -D warnings` sạch (chạy trong VS dev shell).
- `cargo test -p agentdeck-desktop --lib plans` (và `cargo test -p agentdeck-desktop --lib delegate` khi P4) pass.
- `pnpm --filter desktop check` 0 lỗi (3 cảnh báo a11y cũ ở `Markdown.svelte`, `Tree.svelte` là có sẵn).
- Test node mới pass: `node --experimental-strip-types --experimental-vm-modules --test <file>`.
- Không `unwrap()` ngoài test. Lỗi Rust trả `String` như code hiện có trong `plans.rs`.
- File `permissions/autogenerated/*.toml` **mới** (lệnh Tauri mới) được commit. Các file toml chỉ đổi line ending (CRLF) do build sinh ra thì **không** commit.
- UI: chụp màn hình sau thay đổi, so với Plans tab / Canvas tab cạnh bên (AGENTS.md: "After a UI change, screenshot it").
- Xoá file test tạm (`pnpm clean:junk` để liệt kê).
- PR ghi: danh sách file đổi + lý do một dòng mỗi file; kết quả thật của từng lệnh kiểm tra; bảng provider (Claude, Codex) cho P3.

---

## 7. Câu hỏi còn mở (hỏi người dùng khi tới phase đó)

1. **P3:** `ExitPlanMode` của Claude khi cổng bật: chấp nhận trong card = duyệt plan (a), hay card chỉ cho "Approve plan" (b)?
2. **P3:** cổng nên mặc định tắt (đề xuất) hay bật cho người dùng mới?
3. **P4:** "Approve & run" mở chat mới (đề xuất) hay chạy tiếp trong chat đã tạo plan?
4. **P5:** UI tick tay có nên cũng bắt nhập evidence không? (đề xuất: không).
5. **P6:** làm mục nào trước? (đề xuất 6.1 rồi 6.2).

---

## 8. Danh sách file dự kiến đổi

| File | Phase | Đổi gì |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/plans.rs` | 1, 2, 3, 4, 5 | `PlanStep`, `steps()`, key mới, luật duyệt, `set_gate`, `set_run_chat`, `step_brief`, evidence |
| `apps/desktop/src-tauri/src/lib.rs` | 3, 4, 5 | Lệnh `plans_set_gate`, `plans_set_run_chat`, `plans_steps`; đổi chữ ký `plans_set_step` |
| `apps/desktop/src-tauri/src/mcp.rs` | 2, 4 | Câu Plans trong `instructions` |
| `apps/desktop/src-tauri/src/delegate.rs` | 4 | `plan_id`, `plan_step` |
| `apps/desktop/src-tauri/permissions/autogenerated/plans_set_gate.toml`, `plans_set_run_chat.toml`, `plans_steps.toml` | 3, 4, 5 | Sinh bởi build, commit |
| `apps/desktop/src/lib/plans/plans.svelte.ts` | 1 | `PlanInfo` thêm `approvedAt`, `runChat`, `gate` |
| `apps/desktop/src/lib/plans/plan-gate.ts` (+ `.test.ts`) | 3 | Hàm thuần |
| `apps/desktop/src/lib/plans/plan-gate.svelte.ts` | 3, 4 | Nối store, listener `plan-changed` |
| `apps/desktop/src/lib/app/platform/automation.svelte.ts` | 3 | `requirePlanApproval` |
| `apps/desktop/src/lib/chat/session/run.svelte.ts` | 3, 4 | `permissionOf`, `planNote` |
| `apps/desktop/src/lib/components/chat/Composer.svelte` (hoặc component dải báo gần nó) | 3 | Dải báo plan chưa duyệt |
| `apps/desktop/src/lib/components/plans/PlansView.svelte` | 2, 4 | Approve, Approve & run, Run, Open chat |
| `apps/desktop/src/lib/components/settings/…` (nơi có công tắc Auto review) | 3 | Công tắc mới |
| `apps/desktop/src/lib/chat/slash.svelte.ts` | 4 (6.1) | Template run plan, `/run-plan` (`/spec`) |
| `apps/desktop/src/lib/tasks/auto-review.ts` (+ test) | 5 | `reviewBrief` nhận plan |
| `apps/desktop/src/lib/chat/session/delegate-task.svelte.ts` | 5 | `maybeAutoReview` lấy steps |
| `docs/user-guides/plans-and-canvas.md` | 2–5 | Cập nhật hướng dẫn: duyệt, cổng, evidence |
| `docs/release-notes/vX.Y.Z.md` | cuối | "What's new" + "Fixes" (theo quy ước release notes) |
