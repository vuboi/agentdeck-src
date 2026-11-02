# plan_next: phần còn lại sau v0.1.66

Ngày: 2026-11-03. Base: `main` (sau `469f3c1 chore: release v0.1.66`). Người làm: Haiku 5.5.
Quy tắc làm việc, lệnh kiểm tra: như `docs/plans/plan_fix.md` mục 0 và `docs/plans/plan_refactor.md` mục 0. Tóm tắt:

- mỗi nhóm N một nhánh `next/n<k>-<tên>`, worktree riêng `E:\WORK\PROJECTS\agentdeck-n<k>`, tạo từ `main`;
- test tái hiện trước, lưu output đỏ ở scratchpad `C:\Users\boi.vn\AppData\Local\Temp\claude\C--Users-boi-vn\64bd1fc4-578e-4ca0-9e2d-e3dca90e182d\scratchpad\n<k>-<m>-red.txt`;
- mỗi mục một commit, merge `--no-ff` vào `main`, xoá worktree;
- Edit tool cho file CRLF; không `--no-verify`; không push/tag/release;
- module `.svelte.ts` thật chạy trong test qua `apps/desktop/tests/support/load-session.mjs`.

Quyết định đã chốt (không hỏi lại):

- **D-A (R3.6):** model đã lưu của chat không còn trong danh sách → chặn gửi, báo "The model <x> is no longer available. Pick a model." Không âm thầm dùng model khác.
- **D-B (R3.2):** task kết thúc vì worker mất kết nối (`listenDelegateAborts`) hoặc caller kết thúc lượt bình thường → **vẫn** đưa report vào backlog cho caller. Chỉ không report khi người dùng bấm Stop (`'chat'`), hoặc ending thuộc `user`/`caller`/`cascade`.

---

## N1. Luồng chat (TS) — `apps/desktop/src/lib/chat/session/`

1. **D-B:** `delegate-task.svelte.ts`. Xem `NO_REPORT_ENDINGS` (~:136), `finishTask` (~:1341), `listenDelegateAborts` (~:1802). Ending `'abort'` do mất kết nối → fallback `toCaller()` (backlog). Ending `'chat'` (người dùng dừng caller) → không report.
    - Test: abort do mất kết nối → `backlog.get(caller)` có đúng 1 report.
    - Test: người dùng dừng caller → backlog rỗng.
    - Test: Rust timeout → đúng 1 thông báo. Export `finishTask` hoặc viết hàm thuần `reportPlan(ending)` để test được.
2. **D-A (R3.6):** `turns.svelte.ts` `modelFor` (~:639). Tách hàm thuần `pickModel(saved, list): { model } | { missing: saved }`.
    - Đường gửi: `missing` → không gửi, hiện lỗi như trên trong chat. Tìm chỗ hiện lỗi gửi sẵn có, ví dụ thông báo khi agent không có.
    - Prewarm và `effortFor`: dùng `pickModel`, khi `missing` thì bỏ qua prewarm, không gửi model null.
    - Test: custom provider A bị xoá trên chat đang dùng A → không gọi `sendAgentTurn`/`sendCustomTurn`, có lỗi.
    - Test: model còn → giữ nguyên hành vi.
3. **R3.5:** `events.svelte.ts`. Gộp kết thúc bình thường (~:1785-1905) và `finalizeTurn` (~:557) thành một hàm. Hàm này cập nhật cả `documentTask`.
    - Làm từng bước:
        - đưa cập nhật `documentTask` (~:1756) vào `finalizeTurn`, chạy test;
        - cho nhánh kết thúc bình thường gọi `finalizeTurn`, xoá dòng trùng (`failSessionWork`, `onDelegateDone`, `finishWorkflowTurn`, `endWaitingTasks`, `releaseBrowserChat`, `recordProjectActivity`).
    - Giữ nguyên thứ tự các bước như ở nhánh thường.
    - Test qua loader:
        - lượt thường kết thúc → mỗi bước trên được gọi đúng 1 lần;
        - recovery bỏ cuộc → `documentTask.status = 'error'`.
4. **R3.3 còn thiếu:**
    - Chuyển logic đổi model của Composer (`session.agents`, `rememberMixed`, pref pickers) vào `applyPendingSwitch`. Composer gọi hàm đó.
    - Test: chọn model khi đang retry, Stop → `session.agent` = model đã chọn.
5. **R3.8 còn thiếu:**
    - Gộp 3 bản "first agent"/reset hội thoại (`run.svelte.ts:~582`, `turns.svelte.ts` `forgetUnstartedConversation`, `events.svelte.ts:~1480-1497`) vào một hàm trong `turns.svelte.ts`.
    - Test: kết quả của 3 chỗ gọi không đổi (snapshot state trước/sau).

## N2. Worktree và `/btw` còn thiếu

1. **`planTask` thuần** (`delegate-task.svelte.ts` `startTask`):
    - Tách toàn bộ kiểm tra (depth, role, route, depends_on, agent, model, provider restricted, side caller, worktree + depends_on) thành `planTask(call, caller, state)` trả về `{ ok: true, plan } | { ok: false, error }`.
    - `startTask` chỉ tạo worktree khi `ok`.
    - Test: mỗi lý do từ chối có 1 test, và không gọi `worktree_create`.
2. **Bản ghi `preparing`:**
    - Trước `await makeWorkerWorktree`, tạo `delegateTasks[id]` với `state: 'preparing'`. Tính vào slot (`MAX_WORKERS`) và depth.
    - Huỷ khi caller dừng (thay cơ chế R5.3 hiện tại). Card hiện "Preparing worktree…".
    - Test: 4 task worktree cùng lúc với `MAX_WORKERS=4` thì task thứ 5 phải chờ; Stop trong lúc preparing → record bị xoá, worktree bị xoá.
3. **Dừng tiến trình trước khi xoá worktree:**
    - `crates/adapters/src/agent/runner.rs` có `pids_of_chat(chat)`. Thêm command Rust `stop_chat_processes(chat_id)` nếu chưa có (kiểm tra lib.rs/process_guard có sẵn `kill_tree_now`): kill tree từng pid của chat worker.
    - `DelegateList.svelte` `finishWorktree`: gọi `stopTurn(childId)` + `stop_chat_processes(childId)` trước `worktree_remove`.
    - Test Rust: pid đã claim cho chat → hàm trả về danh sách pid đúng. Test TS (hàm thuần): thứ tự gọi stop → remove.
4. **Worktree mồ côi:**
    - Lúc khởi động (sau khi nạp session), với mỗi project có `.agentdeck/worktrees`, gọi `worktree_list(root)`. Path không có session nào trỏ tới → đưa vào danh sách `orphanWorktrees[projectId]`.
    - UI: menu chuột phải project trong sidebar thêm "Clean up worktrees (N)". Bấm → confirm (dùng dialog xác nhận sẵn có của app nếu có, không thì `confirm`) → `worktree_remove(force=true)` cho từng mục.
    - Test: hàm thuần `orphansOf(listed, sessions)`.
5. **`/btw` draft (R4 còn thiếu):** `state.svelte.ts` `moveDraftToProject` (~:888, ~:917) bỏ draft rỗng thì gọi `dropSide` cho side chat của draft đó. Hook prettier có thể format lại file: chấp nhận được, ghi lại trong commit message. Test.

## N3. Gợi ý tách task (`propose_session`, Phase 7 H3 lát đầu)

Nguồn: `docs/plans/plan-fix-structure.md` mục H3 (~:902), `docs/plans/plan-worktree-suggest.md` mục 2–3.2.
Lát đầu chỉ gồm: agent đề xuất → card trong chat → người dùng duyệt → các task chạy song song trong worktree.

1. **Tool MCP** `propose_session` (Rust, cùng chỗ `delegate.rs` khai báo `delegate_task`, `tool_defs`):
    ```
    propose_session {
      title: string,                         // < 60 ký tự
      tasks: [{ title, brief, write_scope: string[], depends_on?: string[] }], // 2..4 task
      isolation?: 'worktree' | 'shared'      // mặc định worktree
    }
    ```
    - Trả về ngay "Proposed to the user; wait for their choice." (không chặn).
    - Event gửi frontend: dùng cơ chế giống `delegate_task` (`call`, chat id).
    - Mô tả tool dạy agent khi nào đề xuất: ≥ 2 việc độc lập, `write_scope` rời nhau, không đề xuất cho việc ≤ 2 file.
    - Test Rust: parse hợp lệ/không hợp lệ (thiếu tasks, > 4 task, title dài).
2. **Kiểm tra phía TS** (hàm thuần `checkProposal`): hai task có `write_scope` chồng nhau (cùng file, hoặc thư mục cha/con) → đánh dấu "chạy tuần tự". Có `depends_on` → tuần tự. Test: 3 fixture (rời nhau, chồng nhau, phụ thuộc).
3. **Card trong chat** `components/chat/ProposalCard.svelte`, render như segment của message (theo cách `PlanCard`/`TaskCards`):
    - Hiển thị: title, danh sách task (title, scope), nhãn "parallel"/"sequential".
    - Nút: **Split into worktrees**, **Do it in this chat**, **Dismiss**.
    - Split → với mỗi task gọi đường `delegate_task` nội bộ (`startTask` qua một hàm tạo call giả, hoặc tách `launchTask(plan)` từ R-N2.1): `isolation: 'worktree'`, `wait: false`, agent = agent của chat cha.
    - Do it in this chat → gửi tin "Go ahead in this chat." vào chat cha.
    - Dismiss → ẩn card.
    - Trạng thái card lưu trong block của message (không ghi state trong render).
4. **Hint:** thêm 1–2 câu về `propose_session` vào `DELEGATE_HINT` (`tasks/delegate-task.ts`). Cập nhật test ngưỡng độ dài với lý do đúng.
5. Test: `checkProposal`; render card (kiểm tra nguồn hoặc hàm thuần quyết định nút); Split tạo đúng N lời gọi với `isolation: 'worktree'`.

## N4. Hiển thị hai file native (plan-remaining mục 2.2, giai đoạn 1)

Nguồn: `docs/plans/chat-history-mapping/plan-remaining.md` mục 2.1–2.2. Làm đúng các bước 1–4 và các test node ở đó:

- lưu `paths` trong `chat.mixed`;
- `applyHistory` gom alias khác provider;
- `readTranscript` đọc mọi file, gộp theo `at`, khử trùng theo `message.id`, cache theo `stamp`;
- `conversationForExport` dùng cùng hàm gộp.

Trước khi sửa, kiểm tra điều "Chưa xác nhận" ở 2.1 (lượt Codex có nằm trong `otherTurns` không) và ghi kết quả.

## N5. Ledger ghi song song (plan-remaining mục 3.2 bước 1–3)

Nguồn: `plan-remaining.md` mục 3.

- Cờ `chat_index.dual_write` (pref, mặc định tắt).
- Khi bật:
    - `chat_save` khi tạo chat;
    - `chat_append` các lượt đã `done` (debounce 500 ms, gom theo chat);
    - `chat_bind` khi bind file native mới;
    - `chat_delete` khi xoá.
- Shadow read: khi mở chat, so số lượt IndexedDB và `chat_open`; lệch → `logError('app', 'chat index mismatch', …)`. Không hiển thị từ ledger.
- Test:
    - cờ tắt → không gọi lệnh nào;
    - cờ bật → đúng lệnh, đúng thứ tự, debounce gom 3 lượt thành 1 lần `chat_append`;
    - so sánh lệch → có log.
- Không làm bước 4–5 (chuyển đọc, xoá legacy).

---

## Kết thúc

Sau N5 chạy đủ:

- svelte-check;
- eslint (các file sửa);
- `check-derived-writes --strict`;
- node tests (tất cả);
- `& .\scripts\win-cargo.cmd clippy --workspace --all-targets -- -D warnings`;
- `test --workspace`.

Ghi số pass/fail thật vào Báo cáo. Không push, không tag.

## Báo cáo (người làm điền)

- N1: nhánh `next/n1-chat-flow`, merge `--no-ff` vào main: `fc21f37`. Worktree và nhánh đã xoá.
    - Mục 1 (D-B): `b268613` `fix(chat): an aborted task still reports to its caller`. `toCaller` chỉ bỏ report khi ending thuộc `NO_REPORT_ENDINGS`. `finishTask` được export cho test. Test đỏ: `C:\Users\boi.vn\AppData\Local\Temp\claude\C--Users-boi-vn\64bd1fc4-578e-4ca0-9e2d-e3dca90e182d\scratchpad\n1-1-red.txt`. Sửa test cũ "R3.2: a task aborted with its caller leaves no report" thành test D-B (test cũ ngược với D-B). Hai test timeout (một reply, hoặc một báo cáo backlog) đã pass trên code cũ, giữ làm chốt hành vi.
    - Mục 2 (D-A): `416db6c` `fix(chat): a saved model no longer offered blocks the send`. `pickModel` và `chatModel` (turns); `startTurn` không chạy và báo "The model <x> is no longer available. Pick a model."; `prewarmChat` bỏ qua; `effortFor` trả null. Test đỏ: `C:\Users\boi.vn\AppData\Local\Temp\claude\C--Users-boi-vn\64bd1fc4-578e-4ca0-9e2d-e3dca90e182d\scratchpad\n1-2-red.txt`. Commit sau bổ sung: `6d8d395` (bind `chatModel`, `firstAgentOf` trong `chat-delivery.test.mjs`, sau khi mục 2 và 5 làm 6 test của nó lỗi).
    - Mục 3 (R3.5): bỏ qua, không làm. Lý do: nhánh kết thúc thường và `finalizeTurn` khác điều kiện, không chỉ trùng lặp. `failSessionWork`, `onDelegateDone`, `finishWorkflowTurn`, `finishWorkflowIntegration`, `endWaitingTasks` đều đổi theo `recovering` và `error`. `recordProjectActivity` khác `status` (completed/failed/stopped), `request`/`note`. `documentTask` cần `event.kind` và `event.message`, `finalizeTurn` không có. Gộp sẽ đổi kết quả, và test "mỗi bước đúng 1 lần" cần harness `handleAgentEvent` với hơn 80 binding. Cần người xem thiết kế trước.
    - Mục 4 (R3.3, phần đổi model): `0bd013a` `refactor(chat): one place changes a chat's route`. Composer đặt pending rồi gọi `applyPendingSwitch`, hàm này lập danh sách agent và `rememberMixed` cho cả đổi tức thì lẫn đổi khi turn kết thúc. Phần ghi pref `composer.pickers` vẫn ở Composer (đó là bộ nhớ picker của UI, không phải route). Test đỏ: `C:\Users\boi.vn\AppData\Local\Temp\claude\C--Users-boi-vn\64bd1fc4-578e-4ca0-9e2d-e3dca90e182d\scratchpad\n1-4-red.txt`. Test: 2 test mới, gồm đổi trong lúc retry rồi Stop.
    - Mục 5 (R3.8, một phần): `50d3080` `refactor(chat): one rule for a chat's first agent`. Gộp công thức `first` thành `firstAgentOf` (turns, run, events). Phần reset hội thoại không gộp: `events` xoá vô điều kiện và để `id=''`, `forgetUnstartedConversation` chỉ bỏ hội thoại chưa bắt đầu và xoá khỏi `agentIds`. Gộp sẽ đổi kết quả. Test ghim `forgetUnstartedConversation`. Test đỏ: `C:\Users\boi.vn\AppData\Local\Temp\claude\C--Users-boi-vn\64bd1fc4-578e-4ca0-9e2d-e3dca90e182d\scratchpad\n1-5-red.txt`.
    - Kiểm tra (trên nhánh, trước merge): svelte-check 0 lỗi, 3 cảnh báo a11y có sẵn (Markdown.svelte, Tree.svelte). eslint trên các file sửa: exit 0. check-derived-writes --strict: 0 cảnh báo. node tests (toàn bộ `*.test.ts`, `*.test.mjs`): 435 pass, 0 fail. Không đụng Rust nên không chạy clippy/cargo test.
- N2: nhánh `next/n2-worktree-btw`, merge `--no-ff` vào main: `ba4949a`. Worktree và nhánh đã xoá (thư mục phải xoá bằng `Remove-Item -Recurse -Force`, rồi `git worktree prune`).
    - Mục 1 (`planTask`): `8f296ce` `refactor(chat): check a delegate_task call before any worktree is made`. Kiểm tra mới ở `src/lib/tasks/delegate-plan.ts` (hàm thuần, `PlanState` truyền vào). `startTask` chỉ tạo worktree khi `ok`. Hệ quả đổi hành vi: call bị từ chối vì agent/model/route không tạo worktree rồi xoá nữa (trước đây có). Đọc danh sách agent muộn (chỉ khi call qua được kiểm tra không cần agent). Test đỏ (tích hợp): `C:\Users\boi.vn\AppData\Local\Temp\claude\C--Users-boi-vn\64bd1fc4-578e-4ca0-9e2d-e3dca90e182d\scratchpad\n2-1-red.txt` (`worktree_create` bị gọi 1 lần dù call bị từ chối). Test đơn vị planner (`delegate-plan.test.ts`, 18 test, mỗi lý do 1 test) viết sau khi cài planner, không đỏ trước. Sửa fixture: `R5.3` cần một agent cài sẵn (claude); loader của 3 file test thêm binding `planTask`.
    - Mục 2 (`preparing`): bỏ qua, không làm. Lý do: slot của Rust (`delegate_enter`) chỉ đếm worker đã bắt đầu, sau khi có worktree. Tính bản ghi `preparing` vào slot cần hàng đợi phía TS trước khi tạo worktree, đổi thứ tự với `requestTaskSlot`. Không chạy app để kiểm tra được, nên không làm.
    - Mục 3 (dừng tiến trình trước khi xoá worktree): `24cc5bf` `feat(tasks): stop a worker's processes before its worktree is removed`. Rust: `process_guard::chat_pids_to_stop` và command `stop_chat_processes` (đăng ký trong `generate_handler!`, file `permissions/autogenerated/stop_chat_processes.toml` chỉ có lệnh mới). TS: `removeWorkerWorktree` (`src/lib/tasks/worktree.ts`): stop turn → end process → remove; process không dừng được thì giữ thư mục. `DelegateList.finishWorktree` dùng hàm này. Stop được đặt ngay trước `worktree_remove` (sau bước merge, đúng với plan). Test đỏ: Rust `n2-3-red.txt` (lỗi biên dịch: hàm chưa có), TS `n2-3-ts-red.txt` (chưa có export). Chưa kiểm tra nút Merge/Discard trên app.
    - Mục 4 (worktree mồ côi): bỏ qua, không làm. Lý do: "Clean up" dùng `worktree_remove(force=true)` và `branch -D`, có thể mất commit chưa merge. Danh sách mồ côi tính lúc khởi động từ session, mà session có thể chưa nạp xong, nên worktree của worker đang chạy có thể bị coi là mồ côi. `worktree_list` chỉ trả đường dẫn, còn `worktree_remove` cần tên nhánh, nên phải đổi API Rust. Không chạy app để kiểm tra được.
    - Mục 5 (draft `/btw`): `683a9dd` `fix(chat): an empty draft dropped by a move closes its /btw side chat`. `moveDraftToProject` gọi `dropSide` cho side của draft rỗng bị bỏ, sau vòng lặp (vì `dropSide` gán lại `workspace.sessions`). Import `btw.svelte` vào `state.svelte` tạo vòng import. Đã kiểm tra: phần đầu module `btw.svelte.ts` không dùng export của state lúc nạp. Test đỏ: `n2-5-red.txt` (side không bị đóng). Test: `tests/draft-side.test.mjs` (2 test, gồm draft có chữ thì giữ nguyên).
    - Kiểm tra (trên nhánh, sau mục 5): svelte-check 0 lỗi, 3 cảnh báo a11y có sẵn (Markdown.svelte, Tree.svelte). eslint trên các file sửa: exit 0 (hook pre-commit cũng chạy eslint và prettier). check-derived-writes --strict: 0 cảnh báo. node tests (toàn bộ `*.test.ts`, `*.test.mjs`): 455 pass, 0 fail. clippy `--workspace --all-targets -- -D warnings`: exit 0. `test -p agentdeck-desktop`: 234 pass, 0 fail. `test -p ag-adapters`: 200 pass, 0 fail (khi chạy riêng).
    - Lệnh `test -p agentdeck-desktop -p ag-adapters` (chạy gộp) KHÔNG pass: `agent::tail::tests::a_replaced_turn_stops_waiting_for_the_tail` (ag-adapters) fail 2/2 lần. Không do N2: khi tạm trả Rust về HEAD trước N2 và chạy lại gộp, lỗi y hệt. Chạy `-p ag-adapters` riêng (song song và `--test-threads=1`) đều pass. Test này không đụng `crates/` ở nhánh này. Chưa sửa (ngoài phạm vi N2). Cần xem riêng: test dùng agent id toàn cục (`faketail`), lỗi chỉ xuất hiện khi build gộp. Thử chạy gộp trên main không được: build ở `agentdeck-merge` lỗi `os error 32` (file đang bị tiến trình khác dùng, trong build.rs), không tắt tiến trình nào.
- N3:
- N4:
- N5:
- Kiểm tra cuối:
