# plan_fix: dòng lệnh đang chạy, stream text, review 3 plan

Ngày: 2026-11-03. Người giao: phiên Opus. Người làm: Haiku 5.5.
Base: `main` (HEAD lúc viết: `5d03099`). Repo làm việc: `E:\WORK\PROJECTS\agentdeck-merge` (checkout của `main`).

Đã xong trước plan này (không làm lại):

- `7bf0ea0`, `948b636`: lỗi "This message could not be drawn" (groupState ghi state lúc render).
- `5d03099`: node chạy từ đường dẫn `\\?\` (lỗi `EISDIR ... lstat 'E:'`).
- `cf8ee49`: PATH của tiến trình con (servers, codex-auth).

---

## 0. Quy tắc bắt buộc (đọc trước)

1. Làm trên nhánh riêng, trong worktree riêng:
    ```bash
    git -C /e/WORK/PROJECTS/agentdeck-merge worktree add /e/WORK/PROJECTS/agentdeck-anim -b fix/command-line-smooth main
    ```
    Chép các thư mục bị ignore cần cho build: `cp -r /e/WORK/PROJECTS/agentdeck-merge/apps/desktop/build /e/WORK/PROJECTS/agentdeck-anim/apps/desktop/`. Sau đó `cd apps/desktop && pnpm install --frozen-lockfile --prefer-offline`.
2. Môi trường: Windows, Git Bash. Trước lệnh cargo/pnpm: `export PATH="$HOME/.cargo/bin:/c/Program Files/Git/usr/bin:$PATH"`. Cargo chạy qua `scripts\win-cargo.cmd` (PowerShell: `& .\scripts\win-cargo.cmd test -p agentdeck-desktop`).
3. File trong repo dùng CRLF. Sửa bằng Edit tool, không dùng `sed -i` với chuỗi có `\` hay xuống dòng.
4. Không dùng `--no-verify`. Hook pre-commit (eslint, prettier, rustfmt) phải pass. Hook lỗi "mise ERROR cannot find binary path": chạy commit với `export PATH="$HOME/.cargo/bin:$PATH"`.
5. Không ghi state trong `$derived` hoặc template (xem `apps/desktop/scripts/check-derived-writes.mjs`). `$state(...)` chỉ được dùng để khởi tạo khi khai báo (`const x = $state(...)`), không được gán lại `x = $state(...)`.
6. Mỗi task một commit, có test. Message tiếng Anh, kết thúc bằng dòng attribution phiên của bạn chỉ định.
7. Gặp lỗi không rõ nguyên nhân: dừng task đó, ghi vào mục "Báo cáo" cuối file, làm task tiếp theo.

### Lệnh kiểm tra (chạy sau mỗi task, ghi kết quả thật)

```bash
cd apps/desktop
pnpm exec svelte-check --tsconfig ./tsconfig.json          # 0 errors
pnpm exec eslint <các file đã sửa>                          # sạch
node scripts/check-derived-writes.mjs src --strict          # 0 warning
FILES=$(find src tests -name "*.test.ts" -o -name "*.test.mjs" | sort)
node --import ./tests/register.mjs --experimental-strip-types --experimental-vm-modules --test $FILES   # fail 0
```

Rust chỉ cần khi sửa file `.rs`: `& .\scripts\win-cargo.cmd clippy --workspace --all-targets -- -D warnings` và `test --workspace`.

---

## Task A. Dòng lệnh đang chạy luôn swap trong cùng một `SwapLine`

### Vấn đề

`apps/desktop/src/lib/components/chat/CommandGroup.svelte`, trong nút tiêu đề nhóm (tìm `{#if runningStep}`):

```svelte
{#if runningStep}
    <SwapLine text={runningLine} shimmer class="font-medium" />
{:else if working}
    <ZShimmerText class="truncate font-medium" zText={summarize(items)} />
{:else}
    <span class="truncate font-medium">{summarize(items)}</span>
{/if}
```

Giữa hai lệnh, `runningStep` rỗng trong vài ms nên nhánh đổi sang `ZShimmerText`. `SwapLine` bị huỷ, lệnh sau tạo `SwapLine` mới với `shown=''`, nên chữ hiện thẳng (không trượt) và độ rộng nhảy. Demo (mục C) mượt vì luôn đổi chữ trong một `SwapLine`.

### Sửa

1. Thay 3 nhánh trên bằng một `SwapLine` duy nhất:
    ```svelte
    <SwapLine
        text={runningStep ? runningLine : summarize(items)}
        shimmer={Boolean(runningStep) || working}
        class="font-medium"
    />
    ```
2. `apps/desktop/src/lib/components/ui/SwapLine.svelte`: kiểm tra prop `shimmer` đổi giữa chừng có render đúng không. Nhánh `{#if shimmer}` nằm trong `{#key shown}`, nên chỉ đổi khi `shown` đổi. Nếu cần, đưa `shimmer` vào key: `{#key `${shown}|${shimmer}`}`. Chọn cách không làm chữ nhảy khi chỉ shimmer đổi. Ghi lý do vào comment.
3. Khi nhóm vừa xong lệnh cuối (chuyển sang summary), `HOLD_MS = 420` vẫn giữ lệnh cuối đủ lâu để đọc. Không đổi hằng số này.
4. Header live (`<SwapLine text={current.label} shimmer class="stream-label" />`, tìm `{#if live}`) giữ nguyên.

### Test

- Thêm `apps/desktop/tests/swap-line.test.mjs`. Dùng `svelte/compiler` `compile` + `svelte/server` `render` (hoặc JSDOM nếu repo đã có; kiểm tra `package.json` trước, không thêm dependency mới). Nếu không render được component trong node, chuyển sang test nguồn: đọc `CommandGroup.svelte`, khẳng định chỉ có một `<SwapLine` trong nút tiêu đề (không nằm trong `{#if runningStep}`). Ghi trong test vì sao (để tránh regression).
- Chạy app (mục E) và quan sát: lệnh nối tiếp nhau phải trượt lên, không nháy, width ease.

---

## Task B. Mỗi token không dựng lại cả câu trả lời (`segments` ổn định)

### Vấn đề

`apps/desktop/src/lib/chat/content/blocks.ts:35` `segments(blocks)` được gọi trong `AssistantMessage.svelte:25`: `const parts = $derived(segments(message.blocks));`.

- `segments` đọc `text` của mọi block (`block.text.trim()` ở nhánh thinking, `askAsStep(block.text)` ở nhánh response, `pending.map(t => t.text.trim()).join(...)` ở `flush`). Vì vậy `$derived` phụ thuộc vào text của mọi block, và mỗi delta (~4 ký tự, vài chục lần/giây) chạy lại toàn bộ.
- Mỗi lần chạy tạo object `Segment` mới và mảng `items` mới. Mọi `CommandGroup` của câu trả lời nhận prop mới và tính lại `summarize`, `groupIcon`, rows.
- `askAsStep(block.text)` quét toàn bộ text đang dài lên, thành O(n²) trên câu trả lời dài.

### Sửa (theo thứ tự, mỗi bước chạy test)

1. **`askAsStep` chỉ cho block đã xong:** ở nhánh response, chỉ gọi `askAsStep(block.text)` khi `!block.streaming`. Câu hỏi chỉ thành step sau khi câu trả lời đã viết xong (đúng ý nghĩa: card câu hỏi cũng chỉ hiện lúc đó). Kiểm tra `QuestionCard`/`askAsStep` có phụ thuộc thời điểm khác không, ghi lại nếu có.
2. **Thinking rỗng:** `if (!block.text.trim()) continue;` đọc text. Đổi thành chỉ bỏ block thinking rỗng khi `!block.streaming` (block đang stream giữ lại, dù đang rỗng, sẽ có text ngay). Test: thinking rỗng đã xong vẫn bị bỏ, thinking đang stream không làm vỡ nhóm.
3. **Gộp nhiều thinking:** `flush()` tạo block mới `{ kind: 'thinking', text: join(...) }` mỗi lần. Giữ cache theo danh sách block nguồn (WeakMap từ block đầu tiên sang `{ parts: ThinkingBlock[], merged }`). Chỉ tạo object mới khi số phần hoặc text đổi. Text vẫn phải cập nhật khi stream, nên `merged` có thể là getter: `get text() { return parts.map(...).join(...) }`. Cách này làm phụ thuộc text chuyển vào `Markdown` của block đó, không còn nằm ở `segments`.
4. **Giữ object cũ khi cấu trúc không đổi:** `AssistantMessage.svelte` đổi sang `$derived.by` với cache trước đó. So từng segment mới với segment cũ cùng vị trí: cùng `kind`, cùng danh sách block (so tham chiếu từng phần tử `items`/`block`) thì dùng lại object cũ. Viết hàm thuần `reuseSegments(prev: Segment[], next: Segment[]): Segment[]` trong `blocks.ts` để test được.
5. Kiểm tra lại `stateKey` của `CommandGroup` (`"{workspace.activeId}:{message.id}:{position}"`) vẫn ổn định.

### Test (`apps/desktop/src/lib/chat/content/blocks.test.ts` hoặc `tests/segments.test.ts`)

- Cùng `blocks`, chỉ nối thêm text vào response cuối đang stream: `reuseSegments(prev, segments(blocks))` trả về **cùng** object cho mọi segment `commands` (`assert.equal(next[i], prev[i])`).
- Thêm một tool call mới: segment cũ giữ nguyên tham chiếu, chỉ có segment mới ở cuối.
- `askAsStep`: response đang stream có câu hỏi thì không tạo step; khi `streaming=false` thì tạo đúng 1 step.
- Hiệu năng: 2000 delta vào một response 20 000 ký tự, đo thời gian `segments` + `reuseSegments`. Ghi số đo trước/sau vào commit message. Không assert thời gian cứng (máy chậm), chỉ assert số lần gọi `askAsStep` (dùng hàm đếm, inject qua tham số hoặc spy) bằng 0 khi đang stream.

---

## Task C. Trang demo dev `/dev/swap-line`

Trang demo cũ (`src/routes/swap-line-test/+page.svelte`, phiên `53b3e285`) đã bị xoá, chưa từng commit. Nội dung đã được khôi phục ở `C:\Users\boi.vn\AppData\Local\Temp\claude\swapdemo\swap-line-test__page.svelte`.

1. Tạo `apps/desktop/src/routes/dev/swap-line/+page.svelte` từ file đó (đổi comment đầu: không còn "Delete before commit"; ghi đây là trang so sánh chỉ có ở dev).
2. Chỉ có ở dev: trong `+page.ts` cùng thư mục, `export const load = () => { if (!import.meta.env.DEV) error(404); }` (import `error` từ `@sveltejs/kit`). Kiểm tra `svelte.config.js`/adapter static: route không được prerender vào bản build. Nếu adapter static bắt prerender, đặt `export const prerender = false` và xác nhận `pnpm build` không có file `dev/swap-line`.
3. Thêm kịch bản thứ hai "reply thật": render `AssistantMessage` với một message giả có text đang stream + 3 nhóm lệnh xen kẽ + lệnh đang chạy đổi mỗi 150–1500 ms (dùng `applyAgentEvent` từ `src/lib/chat/agent-reply.ts` để sinh `blocks` như app thật). Nút chuyển giữa hai kịch bản.
4. Ghi cách mở trong `docs/development/running-locally.md`: `pnpm dev`, rồi mở `http://127.0.0.1:<port>/dev/swap-line` trong cửa sổ dev (hoặc thêm lệnh menu dev nếu đã có cơ chế; không thêm UI cho bản phát hành).

Test: `svelte-check` 0 lỗi. Không cần unit test riêng.

---

## Task D. Review code các commit của 3 plan (chỉ đọc, báo cáo)

Phạm vi: các commit sau `ad8ef6d` thuộc 3 plan:

| Plan                                             | File plan                                           | Commit                       |
| ------------------------------------------------ | --------------------------------------------------- | ---------------------------- |
| Phase 0 (fallback, sub-agent, delegate, routing) | `docs/plans/plan-fix-structure.md` mục Phase 0      | `6549ca0`                    |
| Lỗi còn lại chat-history                         | `docs/plans/chat-history-mapping/plan-remaining.md` | `ded11ae` (chỉ mục 1.1 xong) |
| Worktree cho worker delegate                     | `docs/plans/plan-worktree-suggest.md`               | `244e9cf`                    |
| (thêm) `/btw`                                    | `docs/plans/plan-btw-command.md`                    | `b1f4a8a`                    |

Với mỗi commit:

1. `git show --stat <hash>` rồi đọc diff từng file.
2. Đối chiếu với mục "Chấp nhận"/"Kiểm thử" của plan tương ứng: mục nào đã làm, mục nào thiếu, mục nào làm khác plan.
3. Tìm lỗi thật, ưu tiên:
    - ghi state trong `$derived`/template;
    - `$state` sai chỗ;
    - race khi tạo/xoá worktree (`worktree.rs`, `delegate-task.svelte.ts` `makeWorkerWorktree`);
    - merge khi checkout chính dirty;
    - xoá branch chưa merge;
    - đường dẫn Windows (`\\?\`, khoảng trắng, `/` và `\` lẫn lộn);
    - prompt/tool schema của `delegate_task` (`isolation`) khớp giữa Rust (`delegate.rs`) và TS (`tasks/delegate-task.ts`);
    - `/btw` có thật sự chỉ đọc không (plan ghi chưa cấm tool);
    - test có kiểm tra đúng hành vi hay chỉ khớp output hiện tại.
4. Không sửa trong task này, trừ lỗi rõ ràng, nhỏ (≤ 10 dòng), có test tái hiện. Commit riêng: `fix(review): ...`.
5. Viết báo cáo `docs/reviews/review-2026-11-03.md`: mỗi phát hiện một dòng `file:line — mức (cao/trung/thấp) — vấn đề — đề xuất`, rồi bảng "plan item → trạng thái (xong / thiếu / khác plan)".

---

## Task E. Kết thúc

1. Chạy đủ mục "Lệnh kiểm tra" + Rust:
    ```powershell
    & .\scripts\win-cargo.cmd clippy --workspace --all-targets -- -D warnings
    & .\scripts\win-cargo.cmd test --workspace
    ```
2. Merge vào `main` trong `E:\WORK\PROJECTS\agentdeck-merge`: `git merge --no-ff fix/command-line-smooth`. Conflict: dừng, ghi vào Báo cáo, không tự giải quyết phần không hiểu.
3. Không push, không tag, không release. Phiên điều phối sẽ làm release.
4. Ghi "Báo cáo" bên dưới: commit hash từng task, kết quả lệnh kiểm tra (số pass/fail thật), việc chưa làm và lý do.

## Ngoài phạm vi (không làm)

- `each_key_duplicate` ("duplicate key `Working`", log cũ đến 02/11 00:39): chưa tái hiện. Chỉ ghi lại nếu gặp.
- plan-remaining mục 2.2 (gộp hai file native), mục 3 (ledger dual-write), Phase 7 H3 (`propose_session`): plan riêng.

## Báo cáo (người làm điền)

Worktree: `E:\WORK\PROJECTS\agentdeck-anim` (nhánh `fix/command-line-smooth`, từ `main` e653b23). Merge `--no-ff` vào main: `2cf22bf`. Phiên điều phối đổi phạm vi: bỏ Task D, chỉ làm A, B, C, E.

- Task A: `ee3444e` `fix(chat): keep the running command line in one SwapLine`. Nhóm lệnh có một `SwapLine` cho cả tiêu đề (`CommandGroup.svelte`). `SwapLine` giữ `{#key shown}` (không đưa `shimmer` vào key, để đổi shimmer không replay animation; có comment). Test: `apps/desktop/tests/swap-line.test.mjs` (kiểm tra nguồn, không render DOM). Chưa quan sát bằng mắt trên app (xem "Chưa làm").
- Task B: `a98966c` `perf(chat): stop re-rendering the whole reply on every delta`. `askAsStep` chỉ chạy khi block response đã xong (đúng với `ChatBlock`, vốn chỉ parse câu hỏi khi `!block.streaming`), kết quả cache theo block. Thinking rỗng chỉ bỏ khi đã xong. Thinking gộp giữ object, text đọc lúc render. `reuseSegments` + `lastParts` trong `AssistantMessage`. Test: `src/lib/chat/content/blocks.test.ts` (6 test). Đo 2000 delta vào câu trả lời 20 000 ký tự (không có khối câu hỏi): `segments` trước 3.2 đến 6.1 ms, sau 0.8 đến 2.0 ms; số lần gọi `askAsStep` khi đang stream: trước mỗi delta, sau 0. Trường hợp chậm nhất (câu trả lời có khối câu hỏi) chưa đo.
- Task C: `9853908` `feat(dev): add /dev/swap-line comparison page`. `src/routes/dev/swap-line/+page.ts` (404 ngoài DEV, `prerender = false`) và `+page.svelte` (hai kịch bản: dòng lệnh; reply thật qua `applyAgentEvent` + `AssistantMessage`). Đã kiểm tra: `vite build` không tạo `dev/swap-line` trong `build/`; `vite dev` trả 200 cho `/dev/swap-line`. Cách mở đã ghi trong `docs/development/running-locally.md`.
- Task D: chuyển cho Opus (phiên điều phối tự review; không làm trong plan này, không có `docs/reviews/review-2026-11-03.md`).
- Task E: merge `2cf22bf` (`--no-ff`, main đã có thêm `0b0b6d8` của phiên Opus, không xung đột). Không push, không tag, không release.
    - svelte-check: 0 lỗi (3 cảnh báo a11y có sẵn ở `Markdown.svelte` và `Tree.svelte`, không đụng file nào của plan).
    - eslint trên các file đã sửa: exit 0. check-derived-writes --strict: 0 cảnh báo.
    - node tests (lệnh trong plan): 388 pass, 0 fail (lần chạy cuối, trạng thái `9853908`).
    - clippy `--workspace --all-targets -- -D warnings`: exit 0.
    - `cargo test --workspace --no-fail-fast`: mọi crate pass (adapters 193, desktop-lib 227, store 11, orchestrator 5, ...) trừ 1 test: `ag-protocol::tests::committed_protocol_ts_matches_rust_types` FAIL. Nguyên nhân: git `core.autocrlf=true` trên Windows, `packages/protocol-ts/src/index.ts` trong index là LF nhưng worktree là CRLF, test so sánh chuỗi thô. Lỗi có sẵn trên main, không do plan này. Chưa sửa (ngoài phạm vi). Cách sửa gợi ý: so sánh sau khi chuẩn hoá `\r\n` hoặc thêm `.gitattributes` `packages/protocol-ts/src/index.ts text eol=lf`.
    - Lưu ý: hook pre-commit (prettier) đã format lại toàn bộ `blocks.ts` và `AssistantMessage.svelte` lúc commit Task B. Diff thô 832 dòng (`blocks.ts`); bỏ khoảng trắng (`git diff -w`) còn 488 dòng.

Chưa làm / lý do:

- Quan sát app bằng mắt (Task A, mục E "chạy app và quan sát": lệnh trượt lên, không nháy, width ease) chưa làm. Chỉ kiểm tra route trả 200 bằng HTTP, không mở cửa sổ app.
- Task A test chưa render DOM; dùng kiểm tra nguồn theo fallback của plan.
- Task D: chuyển cho Opus theo chỉ đạo.
- Không có lỗi nào làm dừng task A, B, C, E.
