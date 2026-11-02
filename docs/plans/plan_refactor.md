# plan_refactor: sửa lỗi và tối ưu code các commit gần đây

Ngày: 2026-11-03. Nguồn: review (Opus) các commit `6549ca0`, `244e9cf`, `b1f4a8a`, `0597378`, `ded11ae`, `e07a440`, `6277bef`, `b3b33a1`, `cf8ee49`. Người làm: Haiku 5.5.
Làm SAU `plan_fix.md` (base = `main` đã có merge của `fix/command-line-smooth`).

Mọi đường dẫn tương đối với `E:\WORK\PROJECTS\agentdeck-merge`. Số dòng là lúc review: tìm theo tên hàm nếu lệch.

---

## 0. Quy tắc (giống plan_fix.md mục 0, đọc lại)

- Mỗi phần R1…R6 là một nhánh riêng `refactor/r<N>-<tên>` trong worktree `E:\WORK\PROJECTS\agentdeck-r<N>` tạo từ `main`. Xong phần nào: test đủ, merge `--no-ff` vào `main`, xoá worktree, rồi mới sang phần sau (phần sau dựa trên `main` mới).
- Mỗi mục có **test tái hiện lỗi trước** (test fail trên code cũ), rồi mới sửa. Ghi tên test vào commit message.
- Cargo qua `scripts\win-cargo.cmd`. Node test bằng lệnh trong plan_fix.md. Không `--no-verify`. Edit tool cho file CRLF.
- Không đổi hành vi ngoài mục đang sửa. Không thêm dependency.
- Mục không làm được: ghi lý do trong "Báo cáo" cuối file, làm mục sau.
- Không push, không tag, không release.

---

## R1. PATH cho tiến trình con (Rust, `crates/adapters/src/agent/resolve.rs`)

Hiện trạng (`build_augmented_path`): thứ tự System32 → SystemRoot → thư mục có node → common → PATH cha; dedup bằng `to_lowercase()`; cắt ở 8000 ký tự bằng `break`. Giá trị này dùng cả cho env tiến trình con lẫn cho tra cứu (`connectors/runtime.rs` `search_path()` → `which()`).

1. **Tách hàm thuần** `fn assemble_path(system: &[PathBuf], node_dirs: &[PathBuf], common: &[PathBuf], current: &[PathBuf], windows: bool) -> Vec<PathBuf>`. Thứ tự mới: `node_dirs`, `common`, **rồi** `system`, rồi `current`. Lý do: System32 đứng trước làm `curl.exe`/`find.exe`/`sort.exe`/WSL `bash.exe` của Windows thắng bản scoop/WinGet. System32 vẫn nằm sớm, không bị cắt.
2. **Dedup đúng nền tảng:** chuẩn hoá bỏ dấu phân cách cuối (`\` hoặc `/`); chỉ so không phân biệt hoa thường khi `windows == true`.
3. **Giới hạn độ dài chỉ cho env con:** `augmented_path()` (dùng cho tra cứu) trả về danh sách đầy đủ, không cắt. Thêm `fn child_path(list: &[PathBuf], max: usize) -> OsString` cho `augmented_path_env()`: bỏ mục không phải thư mục tồn tại; với mục làm vượt `max` thì `continue` (bỏ mục đó, giữ mục ngắn phía sau), không `break`. Nếu có mục bị bỏ: ghi log một lần (dùng cơ chế log sẵn có của crate; nếu crate chưa có `tracing`, bỏ phần log và ghi chú ở Báo cáo).
4. `apps/desktop/src-tauri/src/connectors/runtime.rs` `search_path()`: dùng `augmented_path()` (đầy đủ). `extra_dirs()` lặp lại `resolve::common_dirs`: thay bằng một hàm public từ adapters (ví dụ `ag_adapters::agent::runner::common_dirs_here()`), xoá bản lặp.
5. `scripts/win-cargo.cmd`: đưa dòng thêm `Git\bin` lên ngay sau dòng `set "PATH=%SystemRoot%\System32;..."` (đầu file), để không bị cmd cắt ở 8191.

Test (`resolve.rs` tests):

- `assemble_path` đúng thứ tự node → common → system → current.
- Dedup: Windows gộp `C:\A\` và `c:\a`; Unix giữ `/opt/A` và `/opt/a`.
- `child_path`: mục dài ở giữa bị bỏ, mục ngắn sau đó vẫn còn; tổng độ dài ≤ max.
- `which` (runtime.rs, hoặc test của `augmented_path`) tìm được thư mục nằm ở vị trí > 9000 ký tự trong PATH cha.
- Chạy lại `servers::tests` (4 test) và `ag-adapters` toàn bộ: phải pass.

---

## R2. Tail, sub-agent và copilot (Rust)

1. **`crates/adapters/src/agent/tail.rs:458-480` (cao):** khi kết thúc tail, chỉ gửi `Stopped` cho task còn mở nếu `matches!(fate, Fate::Drop)`. Với `Fate::Park`, tiến trình còn sống và được tái dùng: chỉ flush event đang giữ, không đóng task. Test: Fake `sh` khởi động một Task, gửi stop khi im lặng (Park) → không có `Stopped`; Drop → có `Stopped`.
2. **`tail.rs:279` (trung):** khi buffer giữ đầy, thay `held[at] = event` bằng `held.remove(at); held.push(event);` để kết thúc task nằm sau progress của chính nó. Mở rộng test `a_full_hold_keeps_a_task_end_ahead_of_its_progress`: end là phần tử cuối.
3. **`crates/adapters/src/agent/antigravity.rs:~679` (trung):** nhánh step `ERROR`: nếu `is_subagent_tool(raw_name)` thì gửi `Task { id: <cùng id lúc Started>, status: Failed }`. Kiểm tra luôn: sub-agent thứ 2 trở đi nhận id `call#N` có Started tương ứng không. Nếu không, dùng cùng quy tắc id cho Started và kết thúc. Test fixture: `invoke_subagent` rồi `ERROR` → Task Failed cùng id.
4. **`apps/desktop/src-tauri/src/copilot.rs:638-660` (thấp):** event giữ cho sub-agent chưa có `subagent.started`: khi hết lượt, ghi log số event bị bỏ theo agent và xoá `pending`; ghi log khi chạm giới hạn 64. Test: giữ event không có start, kết thúc lượt → `pending` rỗng.
5. **Refactor:**
    - Thêm `TaskStatus::is_end()` (Done | Failed | Stopped) trong `agent/mod.rs`. Thay các chỗ viết tay: `stall.rs:~97`, `tail.rs` `hold()` và theo dõi `open`, set `closed` của codex.
    - Gộp trích turn id trong `codex_server.rs` `fail_once` (~:400) và `foreign_turn` (~:622) thành một hàm.
6. **Test chỉ lặp code (sửa cho có nghĩa):**
    - `stall.rs:~163`: test theo hành vi (event vào → stall/không), không lặp lại danh sách `matches!`.
    - `codex_server.rs` `a_failed_turn_reports_turn_failed_once`: test qua `read_turn` với input có `Error` rồi `turn/completed`, đếm số lỗi gửi ra = 1.
    - `a_child_still_open…`: test qua `read_turn` rằng child Stopped được gửi trước Done của cha.
    - Xoá `delegate_wait_tests` trùng trong `mod.rs` (đã có `delegate.rs` `only_a_blocking_delegate_call_is_streamed`).

---

## R3. Luồng chat phase 0 (TS, `apps/desktop/src/lib/chat/`)

1. **(cao) Retry bị nuốt bởi hand-back:** `session/turns.svelte.ts:~391` `hasTurnWork` trả false khi đang chờ retry (`owesTurn` true). `deliverReport` → `sendNextQueued` → `flushReports` (`delegate-task.svelte.ts:~1484`) gửi hand-back im lặng → `supersedeOwedTurn` xoá `owed` → retry không bao giờ chạy.
   Sửa: `hasTurnWork(id)` trả true khi `owesTurn(id)`; `supersedeOwedTurn` chỉ gọi cho send không im lặng (`silent=false`).
   Test: owe turn, đang chờ retry, gọi `deliverReport` cho caller đó → không có hand-back send; retry vẫn gửi phần tiếp.
2. **(cao) Report sau khi abort/stop:** `delegate-task.svelte.ts:~1333` `finishTask` fallback `toCaller()` khi `replyDelegateCall` trả false, kể cả khi task kết thúc vì `'abort'`.
   Sửa: chỉ dùng backlog fallback khi `run.ending` là `undefined` hoặc `'timeout'`. `endWaitingTasks` (~:1757) truyền `'caller'` (không report) khi caller bị người dùng dừng (`userStoppedAt`/`manuallyStopped`). Rust timeout: không vừa gửi lỗi vừa hand-back (chọn một).
   Test: task wait=true, dừng caller → `backlog.get(caller)` rỗng; timeout → đúng 1 thông báo.
3. **(trung-cao) `pendingSwitch`** (`session/events.svelte.ts:~1908`): viết một hàm `applyPendingSwitch(id)` dùng chung với logic của Composer (`session.agents`, `rememberMixed`, pref pickers). Gọi nó:
    - ở cuối `finalizeTurn`, `closeOwedTurn`, `stopOwedTurn`;
    - ở kết thúc bình thường, **sau** khi đã quyết định `runAutoSwitch`/`runRecovery` (không trước).
      Test: chọn model mới khi đang retry, bấm Stop → `session.agent` = model đã chọn, `pendingSwitch[id]` bị xoá; auto-switch tài khoản không bị huỷ vì đổi model.
4. **(trung) Card cũ mở lại** (`chat/agent-reply.ts:~100` `applyTaskEvent`): nếu `!call.tasks && call.task && ENDED.has(call.task.status)` thì bỏ qua event. Test: card lịch sử `task.status='done'`, không có `tasks`, event progress tới → vẫn `done`.
5. **(trung) `finalizeTurn` thiếu `documentTask`** (`events.svelte.ts:~557`): đưa cập nhật `documentTask` (~:1756) vào `finalizeTurn`. Cho nhánh kết thúc bình thường (~:1785-1905) gọi chung `finalizeTurn`, xoá bản lặp (`failSessionWork`, `onDelegateDone`, `finishWorkflowTurn`, `endWaitingTasks`, `releaseBrowserChat`, `recordProjectActivity`). Test: document task, recovery bỏ cuộc → `status='error'`.
6. **(trung) `modelFor`** (`turns.svelte.ts:~639`): khi model đã lưu không còn, trả `null` và chặn gửi với thông báo "pick a model" (đúng D9), không âm thầm dùng `list[0]`. Test: xoá custom provider A trên chat dùng A → không gửi sang B.
7. **(trung) `noteWorkerRecovering`** (`delegate-task.svelte.ts:~1537`): một ghi chú "recovering" cho mỗi task trong một đợt recovery (dùng id cố định `#recover`, không kèm timestamp). Khi khôi phục backlog lúc khởi động (`BACKLOG_KEY`), bỏ các mục `#check`/`#recover`. Test: 3 lần retry → 1 mục backlog; restore → không còn mục `#recover`.
8. **(thấp, refactor)** `chat/recovery/turn-failure.ts:~121` `credentialScopeOf`: dựng trên `agents/credential-scope.ts` (`credentialScope`). `events.svelte.ts:~1666-1684`: thay map tay `antigravity ? 'agy'` bằng `credentialScope`. Gộp 3 bản "first agent" / reset hội thoại (`run.svelte.ts:~582`, `turns.svelte.ts` `forgetUnstartedConversation`, `events.svelte.ts:~1480-1497`) vào một hàm. Test: các test hiện có pass; thêm test `credentialScopeOf('custom', 'p::m') === 'custom:p'`.

---

## R4. `/btw` (TS)

File: `chat/session/btw.svelte.ts`, `btw-command.ts`, `components/chat/BtwPanel.svelte`, `ComposerDock.svelte`, `session/history.svelte.ts`, `session/delegate-task.svelte.ts`.

1. **(cao) Chỉ đọc thật:** khi tạo chat phụ, đặt `chatTurnOptions[side]` với chế độ quyền chỉ đọc của Claude (permission mode `plan`; kiểm tra tên mode trong `crates/adapters/src/agent/permission.rs` `Mode::parse` và `claude()`). Chỉ cho `/btw` với agent `claude` (agent khác: báo "chưa hỗ trợ" thay vì chạy). Test: options của side chat có mode chỉ đọc; agent khác → không tạo side chat.
2. **(cao) Không delegate từ chat phụ:** trong `startTask`, caller có `.side` → trả lỗi "side chats cannot delegate". Test.
3. **(cao) Đóng là dừng:** `dropSide` gọi `stopTurn(side.id, true)` trước khi xoá. `/btw` mới thay cái cũ cũng đi qua `dropSide`. Xoá hoặc chuyển project chat cha → gọi `dropSide` (tìm `deleteSession(s)` và nơi đổi project). Test: `askBtw` rồi `dropSide` → `stopTurn` được gọi với id chat phụ.
4. **(cao) Không rò file lịch sử:** sau khi đóng, file `claude:<agentSession>` của chat phụ không được import thành chat thường. Lưu danh sách id bị bỏ qua (pref, ví dụ `btw.ignored`), `history.svelte.ts` (~:305 alias) lọc theo danh sách đó. Hoặc xoá file provider đó nếu có lệnh xoá an toàn sẵn có (`history_delete`). Chọn một, ghi lý do. Test: sau `dropSide`, import history không có dòng của chat phụ.
5. **(trung) Snapshot rỗng:** `snapshotOf` (~:26) đọc `localMessages[parentId]`. Đổi sang `messagesView(parentId)` (chỉ đọc; KHÔNG dùng `messagesOf`). Test: cha chỉ có tin trong `messagesById` → snapshot không rỗng.

---

## R5. Worktree cho worker (Rust + TS)

File: `apps/desktop/src-tauri/src/worktree.rs`, `chat/session/delegate-task.svelte.ts`, `chat/session/state.svelte.ts`, `components/tasks/DelegateList.svelte`, `components/terminal/Terminal.svelte`, `components/browser/BrowserView.svelte`, `components/chat/CommandGroup.svelte`.

1. **(cao) Merge an toàn:**
    - `worktree.rs` `merge(root, branch, base)`: kiểm tra `git rev-parse --abbrev-ref HEAD` ở root bằng `base`, khác thì Err "the main checkout is on <x>, not <base>". Lưu ý base có thể là branch worktree của caller: khi đó merge vào worktree của caller (root = path worktree caller).
    - `DelegateList.svelte` `finishWorktree`: gọi `worktree_status` trước. `dirtyFiles > 0` → không merge, báo "the worker left uncommitted changes" kèm lựa chọn "Commit them in the worktree" (thêm lệnh Rust `worktree_commit(path, message)` = `git add -A && git commit -m`). `ahead == 0` → "nothing to merge".
    - Thêm câu vào brief của worker (nơi tạo prompt worker trong `delegate-task.svelte.ts`) khi `isolation: worktree`: "You work in your own git worktree. Commit your changes on its branch before you report."
    - Test Rust: base khác HEAD → Err; worktree dirty, merge → Err (hoặc UI chặn: test qua hàm thuần quyết định hành động từ status).
2. **(cao) Tạo worktree sau khi kiểm tra hợp lệ:** tách phần kiểm tra của `startTask` (depth, role, depends_on, agent, model, provider restricted: ~:517-668) thành hàm thuần `planTask(call, caller): { ok: true, plan } | { ok: false, error }`. Chỉ `makeWorkerWorktree` khi `ok`. Lỗi sau khi đã tạo → `worktree_remove(force=true)`. Dùng `.then(onOk, onErr)` thay `.then().catch()` để lỗi trong `startTask` không bị báo nhầm là "Could not create a worktree". Test: depth vượt giới hạn + `isolation: worktree` → `worktree_create` không được gọi.
3. **(cao) Race khi đang tạo:** trước `await`, tạo record task ở trạng thái `preparing` (tính vào slot và depth). Sau `await`, nếu task đã bị stop/caller đã dừng → xoá worktree, không tạo worker. Test: `invoke` stub trả promise hoãn; `stopTurn(caller)`; resolve → không có worker session, worktree bị xoá.
4. **(trung) `depends_on`:** từ chối `isolation: worktree` cùng `depends_on` (lỗi rõ: worktree tạo từ base nên không thấy thay đổi của task trước). Cách tối thiểu, an toàn; ghi vào mô tả tool trong `delegate.rs`. Test.
5. **(cao) Mất `worktree` sau reload:**
    - Lưu map `sessionId → WorktreeInfo` vào pref (ví dụ `worktrees.bySession`) khi tạo; xoá khi merge/discard.
    - Lúc khởi động, nạp lại và gắn vào session; đối chiếu với `worktree_list(root)`. Worktree có trong list nhưng không có session nào trỏ tới thì hiện ở chat cha dưới dạng "orphan" với nút Discard (tối thiểu: log + nút trong DelegateList nếu card còn).
    - History import: cwd nằm dưới `<repo>/.agentdeck/worktrees/` → map về project gốc `<repo>` (`crates/adapters/src/history` nơi gán project từ cwd).
    - Test: reload sau khi worker trả lời → nút Merge vẫn có, `projectOf(worker)` là project gốc.
6. **(trung) Thư mục làm việc:** `Terminal.svelte:~182`, `BrowserView.svelte:~172`, `CommandGroup.svelte:~236-241` dùng `sessionCwd(session)` thay `projectOf(session).path`. Merge root vẫn dùng project gốc. Test: hàm `folder()`/tương đương với session có `worktree` → trả path worktree.
7. **(trung) `remove` có rào chắn:** `worktree.rs` `remove`: path phải nằm dưới `<root>/.agentdeck/worktrees/`, branch phải bắt đầu bằng `agentdeck/`, ngược lại Err. Trước khi remove, dừng tiến trình chạy trong worktree (`process_registry`, tìm theo cwd nếu có API; nếu không có API, ghi ở Báo cáo). Test: `remove(.., "main", true)` → Err; path ngoài thư mục → Err.
8. **(thấp)** `create`: resolve base `HEAD` thành tên branch/SHA trước khi lưu (`git rev-parse --abbrev-ref HEAD`, nếu `HEAD` thì `rev-parse HEAD`). Chuẩn hoá path trả về (một kiểu dấu phân cách, không `\\?\`; dùng `ag_adapters::agent::runner::without_verbatim` và thay `/` bằng `\` trên Windows). Test: base trả về không phải `HEAD`.
9. **(thấp, refactor)** `DelegateList.svelte`: `{@const wt = worktreeOf(block.childId)}` một lần mỗi dòng. `worktree.rs` tests: bỏ biến `p` thừa trong `repo()`.

---

## R6. Test harness và test thiếu

1. **`apps/desktop/tests/chat-delivery.test.mjs`:**
    - Test "Send now" (~:183-211): assert theo đối số của stub, ví dụ `f.stops[0][0] === 'chat'`, và `starts` xảy ra sau `stops` (ghi thứ tự vào một mảng `calls` chung). Bỏ assert `queuePaused === undefined` (luôn đúng).
    - Stub `supersedeOwedTurn`, `stopOwedTurn`, `dropRecovery`: ghi lại lời gọi (`calls.push(['supersedeOwedTurn', id])`) và thêm assert ở test liên quan, thay vì `() {}` rỗng.
    - `sendAgentTurn` và `sendCustomTurn`: hai stub khác nhau để test (~:293) phân biệt được đường đi.
    - Vòng lặp 6 provider: giữ nếu stub có khác theo provider; nếu không, chạy 1 provider + 1 custom.
2. **`tests/delegate-task.test.ts:~513`:** comment nâng ngưỡng 1500 → 2500 sai lý do (hint không chứa quy tắc isolation). Hoặc rút gọn `DELEGATE_HINT` về < 1500, hoặc thêm câu quy tắc worktree vào hint (dùng cho R5.1) rồi sửa comment đúng lý do. Chọn một, ghi lý do.
3. **Test thiếu (thêm):** `worktreeSlug` (tiếng Việt có dấu, ký tự đặc biệt, độ dài ≤ 20, không có `-` ở đầu/cuối); `sessionCwd` ưu tiên worktree; `snapshotOf`; side chat không có trong `localSessions`/sidebar tree.
4. **`scripts/check-derived-writes.mjs`:** thêm vào `WRITERS` các hàm bọc có gọi `messagesOf` (tìm bằng grep `messagesOf(` trong `src/lib/**/*.ts`, các hàm export chỉ để đọc nhưng gọi `messagesOf`). Nếu một hàm như vậy được dùng trong template, đổi nó sang `messagesView`.

---

## Kết thúc

1. Sau R6, chạy đủ: svelte-check, eslint (file đã sửa), `check-derived-writes --strict`, node tests (tất cả), `clippy --workspace --all-targets -D warnings`, `cargo test --workspace`. Ghi số pass/fail thật.
2. Điền Báo cáo. Không push, không tag.

## Ngoài phạm vi (không làm trong plan này)

- Worktree W3–W5 (chat mới trong worktree, gợi ý tách task `propose_session`, màn quản lý), W7 cap 3 worktree.
- C13 gate theo root chat, D11 key hội thoại custom theo scope, slash registry cho `/btw`, "Add to main chat".
- plan-remaining mục 2.2, 3.

## Báo cáo (người làm điền)

- R1:
- R2:
- R3:
- R4:
- R5:
- R6:
- Kiểm tra cuối:
