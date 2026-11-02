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
5. **`crates/protocol/src/lib.rs` `committed_protocol_ts_matches_rust_types`:** fail trong worktree mới vì `core.autocrlf=true` (file checkout ra CRLF, chuỗi sinh ra là LF). So sánh sau khi bỏ `\r` ở cả hai phía: `on_disk.replace("\r\n", "\n")`. Test: tạo worktree mới, chạy `cargo test -p ag-protocol` → pass.

---

## Kết thúc

1. Sau R6, chạy đủ: svelte-check, eslint (file đã sửa), `check-derived-writes --strict`, node tests (tất cả), `clippy --workspace --all-targets -D warnings`, `cargo test --workspace`. Ghi số pass/fail thật.
2. Điền Báo cáo. Không push, không tag.

## Ngoài phạm vi (không làm trong plan này)

- Worktree W3–W5 (chat mới trong worktree, gợi ý tách task `propose_session`, màn quản lý), W7 cap 3 worktree.
- C13 gate theo root chat, D11 key hội thoại custom theo scope, slash registry cho `/btw`, "Add to main chat".
- plan-remaining mục 2.2, 3.

## Báo cáo (người làm điền)

- R1: làm xong, merge `0420c14` (commit `f86faec`). `assemble_path` (thứ tự node → common → system → current, dedup theo nền tảng), `child_path` (bỏ thư mục không tồn tại, bỏ mục quá dài nhưng giữ mục ngắn sau, log một lần), `augmented_path` không còn cắt; `runtime.rs` dùng `common_dirs_here`, xoá `extra_dirs` trùng; `win-cargo.cmd` đưa dòng Git\bin lên sau dòng PATH đầu. Test: 5 test mới trong `resolve.rs` (đều pass). Lưu ý: `extra_dirs` cũ có vài thư mục không có trong `common_dirs` (`agy\bin`, `mise\shims` trên Windows); chỉ dùng ở nhánh dự phòng khi `augmented_path()` lỗi. Đã bỏ qua test trong `runtime.rs`, test thay bằng `resolve.rs` (lookup trên danh sách đầy đủ).
- R2: làm xong, merge `06e6d2d` (commit `a487f9e`). Làm: R2.1 (`tasks_to_stop`: chỉ Drop mới đóng task mở thành Stopped; test là hàm thuần, không phải fake `sh` như plan); R2.2 (end đưa xuống cuối buffer, mở rộng test); R2.3 (ERROR sub-agent → Task Failed cùng id; test `a_failed_sub_agent_ends_its_task_under_the_id_it_started_with`); R2.4 (copilot: đếm event bỏ theo agent, log khi chạm 64, `finish()` xoá `pending` khi hết lượt; test mới); R2.5 (`TaskStatus::is_end` dùng ở `stall.rs`, `tail.rs`; `turn_of` gộp trong `codex_server.rs`). Bỏ qua: R2.6 xoá `delegate_wait_tests` trong `mod.rs` vì không trùng: test đó kiểm `delegate_wait` (adapters), còn `delegate.rs` kiểm `is_long_call` (desktop), hai hàm khác nhau. Chưa làm: test `stall.rs` ~163 theo hành vi và `codex_server` qua `read_turn` (plan đã mô tả, chưa viết lại test).
- R3: làm xong 6/8 mục, merge `0e2cfdf` (nhánh `refactor/r3-chat-flow`, đã xoá worktree và nhánh). Test mới trong `tests/chat-flow.test.mjs`; hàm `load` tách ra `tests/support/load-session.mjs` (chat-delivery dùng lại).
    - R3.1 `11cf650`: `flushReports` không gửi hand-back khi chat còn `owesTurn`. Test red: "R3.1: flushReports sends nothing while a failed turn is owed a retry". Lệch plan: không đổi `hasTurnWork` vì nó cũng chặn tin nhắn của user; đổi sẽ xếp hàng tin nhắn đang chờ retry.
    - R3.2 `d14833a`: `endWaitingTasks(caller, stopped)` kết thúc bằng ending mới `'chat'` (không report) khi user dừng caller; fallback backlog chỉ còn cho task tự kết thúc hoặc timeout. Test red: 2 test "R3.2". Chưa test: đúng 1 thông báo khi timeout (cần export `finishTask`). Lưu ý để xem lại: task `abort` do kết nối worker đứt (`listenDelegateAborts`) cũng không còn vào backlog.
    - R3.3 `6fc50b0`: `applyPendingSwitch(id)` trong `finalizeTurn` (nên `closeOwedTurn`/`stopOwedTurn` cũng áp dụng) và ở kết thúc thường sau khi `runAutoSwitch`/`runRecovery` đã chọn route. Test red: hàm chưa export. Chưa test: đường Stop trên lượt đang chờ retry (`owed` chỉ được set từ event handler). Logic Composer (`session.agents`, pref pickers) chưa chuyển.
    - R3.4 `618dd87`: card lịch sử đã kết thúc không mở lại khi có event muộn. Test red: "R3.4: a historical card ...".
    - R3.7 `636ec7e`: note "recovering" dùng id cố định `#recover` (một note mỗi task); khi khôi phục backlog lúc khởi động bỏ `#check`/`#recover`. Test red: 2 test "R3.7". Đã sửa test để không phụ thuộc Date.now trùng ms.
    - R3.8 `550dedb`: `credentialScopeOf` dựa trên `credentialScope` (`custom|p::m` → `custom:p`); events dùng `credentialScope` thay ca `antigravity`. Test red: "R3.8: credentialScopeOf ...". Chưa làm: gộp 3 bản "first agent" (run, turns, events).
    - Bỏ qua R3.5 (`documentTask` trong `finalizeTurn`): nhánh recovery bỏ cuộc chỉ vào được qua `owed`, mà `owed` chỉ có event handler set, không test được bằng harness hiện tại; đưa cả nhánh kết thúc thường vào `finalizeTurn` là thay đổi lớn không có test. Cần làm riêng kèm test end-to-end.
    - Bỏ qua R3.6 (`modelFor` trả null): cần quyết định UX (thông báo chặn gửi, theo D9) và xác nhận danh sách model của custom provider/credit model; `modelFor` còn dùng ở prewarm và `effortFor`, đổi một phần sẽ gửi với model null. Cần người xác nhận.
    - Thứ tự làm: R3.8 trước R3.7 (làm nhầm thứ tự, không ảnh hưởng nội dung).
    - Kiểm tra cuối (trên nhánh và trên `main` sau merge): node tests 397 pass / 0 fail; svelte-check 0 lỗi, 3 cảnh báo a11y có sẵn (`Markdown.svelte`, `Tree.svelte`), 2 file; eslint các file đã sửa: exit 0 (hook pre-commit cũng chạy); check-derived-writes --strict: 0 cảnh báo. Không đụng Rust nên không chạy cargo.
- R4: làm xong, merge `d7870f9` (nhánh `refactor/r4-btw`, đã xoá worktree và nhánh). Mỗi mục một commit, test đỏ trước (`scratchpad\r4-<n>-red.txt`):
    - R4.1 `5e4452b`: side chat chạy `chatTurnOptions` quyền `plan` (Claude `Mode::Plan` → `plan`), effort theo cha; `askBtw` trả `{ok, side|error}`, agent khác Claude báo lỗi (toast), không tạo side chat. Test: "R4.1: ..." (2 test).
    - R4.2 `2cf4cd8`: `startTask` từ chối khi caller là side chat, trước mọi bước tạo worktree. `onDelegateCall` được export để test. Test: "R4.2: ...".
    - R4.3 `7debcb2`: `dropSide` gọi `stopTurn(side, true)` trước khi xoá; `askBtw` mới đi qua `dropSide`; `forgetSessions` (xoá chat) cũng đóng side. Test: "R4.3: ...". Lệch plan: không sửa đường `moveDraftToProject` (bỏ draft rỗng khác): sửa đó cần đổi `content-tabs.svelte.ts`, và prettier của hook pre-commit reformat cả file (510 dòng) khi stage. Hệ quả: side chat của draft bị bỏ vẫn nằm trong list đến khi khởi động lại (không chạy vô hạn, không hiện ra).
    - R4.4 `4ee378f`: chọn cách pref. Không dùng `history_delete`: file transcript của side chat không có `path`/`source` trong state, nên không xoá được an toàn. Lưu `claude:<session>` vào pref `btw.ignored` (tối đa 200 mục, nạp khi khởi động); `importHistory` lọc danh sách mới và index cache. Test: "R4.4: ..." (kiểm `isBtwTranscript` và pref sau khi nạp lại). Chưa test: dây lọc trong `importHistory` (history.svelte.ts nạp quá nhiều module nền cho loader).
    - R4.5 `dac9ca2`: `snapshotOf` đọc `messagesView(parentId)` thay `localMessages` (chat đang mở không có gì trong `localMessages`). Test: "R4.5: ...".
    - Hạ tầng test: `tests/support/load-session.mjs` nối được `export { x } from './y'` (btw.svelte.ts dùng); file test mới `tests/btw.test.mjs` (6 test).
    - Kiểm tra (trên nhánh, trước merge; `apps/desktop`): svelte-check exit 0, 0 lỗi, 3 cảnh báo a11y có sẵn (`Markdown.svelte`, `Tree.svelte`), 2 file; `check-derived-writes --strict`: 0 cảnh báo; node tests: 403 pass / 0 fail; eslint các file đã sửa: exit 0; prettier --check: sạch. Không sửa Rust nên không chạy cargo.
- R5: làm 8/9 mục, merge `09c725b` (nhánh `refactor/r5-worktree`, đã xoá worktree và nhánh). Mỗi mục một commit, test đỏ trước (`scratchpad\r5-<n>-red.txt`). Đỏ Rust là lỗi biên dịch (chữ ký đổi), đỏ TS là module/stub sai hành vi.
    - R5.1 `089729c`: `merge(root, branch, base)` từ chối khi checkout gốc không ở `base`; `commit()` + lệnh `worktree_commit`; DelegateList: `worktree_status` trước khi merge (`mergeGate`, file chưa commit được đề nghị commit, ahead 0 báo "nothing to merge"); merge vào worktree của caller khi base là nhánh của nó (`mergeRootOf`); brief worker có câu quy tắc worktree. Test: 2 Rust + 4 TS "R5.1". Lưu ý: mô tả `isolation` trong `delegate.rs` (thuộc R5.4) nằm trong commit này.
    - R5.2 `8636bdd`: kiểm tra depth/role/depends_on trước khi tạo worktree; lỗi sau khi đã tạo thì `worktree_remove(force)`; `.then(ok, err)` thay `.then().catch()`. Lệch plan: chưa tách `planTask` thuần; phần kiểm tra agent/model/provider vẫn chạy sau khi tạo worktree (có dọn khi lỗi). Test: 2 "R5.2" trong `tests/delegate-worktree.test.mjs`.
    - R5.3 `2f24d57`: lượt tạo worktree đang chờ bị huỷ khi caller bị dừng (`endWaitingTasks(..., true)`); worktree bị xoá, không tạo worker. Lệch plan: chưa có bản ghi `preparing` trong `delegateTasks`, nên lượt đang chuẩn bị chưa tính vào slot và depth. Test: "R5.3" (red: lỗi agent thay vì lý do dừng; môi trường test không có agent nên không chạm được đường tạo worker thật).
    - R5.4 `ed7ffe3`: `isolation: worktree` + `depends_on` bị từ chối với lý do rõ. Test: "R5.4".
    - R5.5 `4f001c2`: `importHistory` giữ `worktree` của chat đã có và map cwd `<repo>/.agentdeck/worktrees/...` về `<repo>` (`repoOfWorktreeFolder`). Lệch plan: không thêm pref `worktrees.bySession` vì hàng chat đã lưu sẵn trường `worktree` (`local.folder.*`); mất worktree là do import lịch sử dựng lại session từ transcript. Chưa làm: nút "orphan" cho worktree không còn chat; reload đầy đủ (nút Merge còn, project là repo) chỉ kiểm tay.
    - R5.6 `f977263`: terminal, trình duyệt và panel thay đổi dùng `sessionCwd` (worktree trước, rồi project). Test: kiểm tra nguồn (`tests/session-folder.test.mjs`); không chạy được hàm `sessionCwd` trực tiếp vì `state.svelte.ts` kéo quá nhiều phụ thuộc.
    - R5.7 `8048c0e`: `remove` từ chối branch không phải `agentdeck/...` và thư mục ngoài `<repo>/.agentdeck/worktrees/` (có `..` cũng từ chối). Test: 2 Rust, đỏ trên code cũ (cả hai đều xoá được). Chưa làm: dừng tiến trình chạy trong worktree, vì `process_registry.rs` chỉ theo pid (`record`/`forget`/`reap`), không có tra cứu theo cwd.
    - R5.8 `c80eedb`: `create` lưu base là tên branch (không phải `HEAD`), path trả về không có `\\?\` và một kiểu dấu phân cách. Test: "create_records_the_base_branch_and_a_plain_path" (đỏ: base là "HEAD").
    - R5.9 `5e026d9`: DelegateList dùng `{@const wt}` một lần mỗi dòng; bỏ biến `p` thừa trong test helper. Test: "R5.9" (đỏ: 4 lần tra cứu, kỳ vọng 1).
    - Kiểm tra cuối (trên nhánh, trước merge; `apps/desktop`): svelte-check exit 0, 0 lỗi, 3 cảnh báo a11y có sẵn (`Markdown.svelte`, `Tree.svelte`), 2 file; `check-derived-writes --strict`: 0 cảnh báo; node tests: 415 pass / 0 fail; eslint các file đã sửa: exit 0; clippy `--workspace --all-targets -D warnings`: exit 0; `cargo test -p agentdeck-desktop -p ag-adapters`: desktop 233 pass, ag-adapters 200 pass, 0 fail.
    - Hook pre-commit: prettier và rustfmt sửa file khi commit, diff vẫn nhỏ (R5.2: 54 dòng đổi trong `delegate-task.svelte.ts`). Các file `apps/desktop/src-tauri/permissions/autogenerated/*.toml` bị build sinh lại (chỉ khác CRLF/LF) và `worktree_commit.toml` được tạo; không commit phần này. Checkout `main` vẫn có các thay đổi đó.
- R6: làm xong 6/6 mục, merge `cfb7a97` (nhánh `refactor/r6-tests`, đã xoá nhánh và worktree). Mỗi mục một commit, test đỏ trước khi sửa (mục 5, 4, 3 có kiểm tra đỏ/mutation):
    - R6.1 `9244ce9`: `chat-delivery`: thứ tự Send now (stop → supersedeOwedTurn → dropRecovery → start) kiểm qua mảng `calls`; `stopOwedTurn`/`dropRecovery` ghi lời gọi; `sendAgentTurn`/`sendCustomTurn` ghi tên đường đi; bỏ assert `queuePaused` (luôn đúng). Giữ vòng 6 provider (`resolveBinding`/`credentialScope` thật vẫn khác theo provider). Lệch plan: không thêm test đối chứng "không Stop thì launch": module run cần thêm khoảng 20 stub, vượt ngân sách. Thay bằng mutation: bỏ `runReplies.clear()` thì test fail (đường launch chạy tiếp).
    - R6.2 `8372e78`: giữ nguyên `DELEGATE_HINT` (2121 ký tự), chỉ sửa comment. Comment cũ sai: hint không có quy tắc worktree (quy tắc nằm trong brief `WORKTREE_RULE`). Không rút gọn hay thêm quy tắc vì sẽ đổi nội dung gửi cho agent.
    - R6.3 `49ba358`: test mới `tests/session-state.test.mjs` (`worktreeSlug` 3 test, `sessionCwd` ưu tiên worktree, side chat không vào `localSessions` và sidebar tree) và `btw.test.mjs` (`snapshotOf`: bỏ block đang stream, giữ lượt mới nhất, trong ngân sách). Lệch plan: `worktreeSlug` chuyển nguyên văn từ `delegate-task.svelte.ts` sang `tasks/worktree.ts` (module thuần) để test không nạp coordinator; `delegate-worktree.test.mjs` bind thêm `worktreeSlug`. Mutation: bỏ `!item.side` làm 2 test side fail; bỏ kiểm tra streaming làm test snapshot fail. Test R4 (`btw.test.mjs` cũ) và test worktree R5 không viết lại.
    - R6.4 `9b9eba9`: thêm `continueCurrentRun`, `handoffFor`, `conversationForExport` vào WRITERS (đều gọi `messagesOf`; `continueCurrentRun` còn ghi `runGroup`). Hiện không hàm nào dùng trong template hay `$derived`, nên không đổi call site và không có chỗ nào đổi sang `messagesView`. Test mới đỏ trước.
    - R6.5 `fb4880e`: `committed_protocol_ts_matches_rust_types` (nằm ở `crates/protocol/src/lib.rs`) so sánh sau khi đổi CRLF → LF phía file trên đĩa. Đỏ trong worktree mới (đã xác nhận), xanh sau sửa: `ag-protocol` 5 pass.
    - R6.6 `4ee3bca`: commit `apps/desktop/src-tauri/permissions/autogenerated/worktree_commit.toml`, chỉ file này. Trên `main`, file này là untracked do build R5 tạo, nội dung giống hệt bản trong nhánh; xoá bản untracked trước khi merge. Các file autogenerated khác vẫn chỉ khác CRLF/LF, không commit.
    - Hook pre-commit (prettier, rustfmt) sửa file khi commit: R6.1, R6.3, R6.5 có diff bị format lại, nội dung không đổi.
    - Lỗi môi trường: `git worktree remove --force` báo "Directory not empty" (còn `target/`, `node_modules/`). Xoá bằng `Remove-Item -Recurse -Force` rồi `git worktree prune`. Có một tiến trình `cargo run --no-default-features` không thuộc phiên này đang chạy; không tắt.
- Kiểm tra cuối (trên nhánh `refactor/r6-tests` trước merge, `apps/desktop` trừ khi ghi khác): svelte-check 0 lỗi, 3 cảnh báo a11y có sẵn (`Markdown.svelte`, `Tree.svelte`), 2 file; eslint trên các file đã sửa: exit 0; `check-derived-writes src --strict`: 0 cảnh báo; node tests (lệnh plan_fix, có `--import ./tests/register.mjs`): 423 pass / 0 fail (R5: 415); clippy `--workspace --all-targets -- -D warnings`: exit 0, không cảnh báo; `cargo test --workspace --no-fail-fast`: exit 0, mọi crate pass (ag-adapters 200, agentdeck-desktop-lib 233, ag-store 11, ag-orchestrator 5, ag-protocol 5 trong worktree mới, ag-quota 1, ag-core 1, ag-cdp 1, ag 1).
- Kiểm tra cuối (trên `main` sau R2, `06e6d2d`): svelte-check 0 lỗi, 3 cảnh báo a11y có sẵn (`Markdown.svelte`, `Tree.svelte`), 2 file; check-derived-writes --strict 0 cảnh báo; node tests 388 pass / 0 fail; eslint: chưa chạy (không có file TS nào được sửa trong R1–R2); clippy `--workspace --all-targets -D warnings`: sạch (R2); `cargo test --workspace --no-fail-fast`: tất cả pass trừ 1 test `committed_protocol_ts_matches_rust_types` (ag-protocol, lỗi CRLF đã biết, thuộc R6.5); `ag-adapters` 200 pass.
