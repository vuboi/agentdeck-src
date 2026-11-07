# Plan: đồng bộ thông tin giữa các task chạy song song

Ngày: 2026-11-04. Base: `main`. Thay plan fix theme cũ (đã xong, commit `aea7771`).
Phạm vi: lane chính / lane listener trong một chat, delegated task (`delegate_task`), sub-agent của CLI, lượt tự động báo kết quả nền, session song song.

## 1. Vấn đề

Ngoài đời, hai người cùng sửa một tài liệu mà không báo nhau thì người sau làm theo bản cũ trong đầu và xoá việc của người trước.
AgentDeck đang đúng như vậy: nhiều run cùng ghi một thư mục, không run nào biết run kia đã đổi gì, cũng không biết yêu cầu nào của user là mới nhất.

Muốn hết lỗi cần đủ ba thứ, như một team làm việc tử tế:

1. **Một sổ chung**: ai đổi file nào, theo yêu cầu nào, lúc nào.
2. **Báo đúng người, đúng lúc**: run đang làm trên file đó phải được báo ngay, không đợi xong việc.
3. **Luật ai thắng**: yêu cầu mới nhất của user thắng. Không run nào được hoàn tác nó mà không hỏi.

Thêm một lưới an toàn: nếu vẫn có ghi đè thì user phải thấy và khôi phục được bằng một nút.

## 2. Kịch bản thật (flow log `dev.agentdeck.desktop.dev/logs/debug.log`, giờ VN)

Chat `claude:8a9681cf…`, Codex GPT 5.6 Luna, project `msg-new-template`, màn ABR Helios.

| Giờ      | Run                     | Việc                                                                                  |
| -------- | ----------------------- | ------------------------------------------------------------------------------------- |
| 11:48:39 | chính `mw1mzikw6sb2`    | Bắt đầu "button group Áp dụng / Reset bộ lọc"                                         |
| 11:51:12 | chính                   | Edit `en.json`, `vi.json`: nhãn dài                                                   |
| 11:52:48 | chính                   | Chạy cùng lúc 4 lệnh: lint, format, tsc, `git diff --check` (đều xong trong vài giây) |
| 11:52:48 | app                     | `queue: sending one waiting message`: tin "ghi ngắn gọn" được nhả sang lane listener  |
| 11:52:48 | listener `mw1n4ukvt1n0` | Conversation Codex **mới** (`resume=false`), không biết task chính đang làm gì        |
| 11:53:11 | listener                | Edit `en.json`, `vi.json`: "Áp dụng lọc / Reset lọc"                                  |
| 11:53:20 | listener                | Xong                                                                                  |
| 11:54:37 | chính                   | `git diff -- lib…`: thấy nhãn ngắn, coi là lệch so với ý định của nó                  |
| 11:54:51 | chính                   | Edit `en.json`, `vi.json`: **đưa về nhãn dài**, xoá yêu cầu mới của user              |
| 11:55:36 | chính                   | Xong, báo cáo vẫn ghi "Reset bộ lọc"                                                  |

Không có lỗi tool nào. Mỗi run đều làm "đúng" theo thông tin nó có. Lỗi nằm ở chỗ thông tin không được truyền giữa các run.

## 3. Các nơi làm việc song song (đã đọc code)

| Kênh                                                                                 | Thư mục        | Conversation                                                           | Biết gì về run khác                                                                                                            |
| ------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Lane `primary` + `listener` cùng chat                                                | chung          | listener mở conversation mới (`chat/session/binding.ts:78`, `fresh()`) | listener chỉ có digest lúc bắt đầu; primary không biết gì                                                                      |
| `delegate_task` worker, `isolation: shared` (mặc định)                               | chung          | chat worker riêng                                                      | worker chỉ thấy text `task`; parent chỉ thấy report do worker tự viết                                                          |
| `delegate_task` worker, `isolation: worktree`                                        | worktree riêng | chat worker riêng                                                      | tách file, chỉ gặp nhau lúc merge                                                                                              |
| Sub-agent của Claude (`Agent`, có thể `run_in_background`)                           | chung          | trong tiến trình CLI                                                   | AgentDeck thấy event con qua `parent_tool_use_id` (`claude.rs:244`) và event `Task`; không có đường gửi tin tới sub-agent      |
| Sub-agent của Codex (`spawnAgent`, app-server)                                       | chung          | thread riêng của app-server                                            | AgentDeck thấy thread con (`codex_server.rs:81`, `collab` :223); thread con có turn riêng nên có thể steer được (cần kiểm tra) |
| Lượt tự động báo kết quả nền (`beginAutoTurn`, `chat/session/events.svelte.ts:1194`) | chung          | conversation chính                                                     | chỉ có report của task nền                                                                                                     |
| Session song song (`propose_session`)                                                | worktree riêng | riêng                                                                  | tách file                                                                                                                      |
| User sửa tay trong editor                                                            | chung          | không                                                                  | không run nào biết                                                                                                             |

## 4. Nguyên nhân gốc

- **R1. Nhả tin sang listener sai lúc.** `isLongRunningWork` (`chat/runs/run-lanes.ts:31`) đoán việc nền theo từ khoá (`check`, `run`, `test`, `lint`…). Vì vậy `git diff --check` bị coi là việc nền, và lane chính bị đánh dấu `waiting` dù vẫn đang sửa file. Được gọi ở `events.svelte.ts:1411`, `activity.svelte.ts:486`, `chat-work.ts:95`.
- **R2. Không có sổ thay đổi chung.** `fileWrites` (`chat/runs/activity.svelte.ts:100`) chỉ là một bộ đếm `tick`, không lưu ai sửa file nào, theo yêu cầu nào. Trong khi đó dữ liệu đã có sẵn trong `FileChange` (`path`, `before`, `after`) của từng tool call.
- **R3. Không có kênh báo tin giữa các run đang chạy.**
    - `agent_inject` (`src-tauri/src/agent_runs.rs:545`) chỉ nhận provider dạng `ResponseAssociation::PerMessage`.
    - Claude, Codex, Copilot là `NativeSteer { MergedIntoActive }` (`crates/adapters/src/agent/mod.rs:~350`) nên bị từ chối.
    - Thực tế Codex app-server đã có `turn/steer` (`codex_server.rs:691`), và Claude đã có warm inbox. Đường truyền có sẵn, chỉ bị khoá vì nó được thiết kế cho tin của user cần một reply riêng. Một thông báo hệ thống không cần reply riêng.
- **R4. Không có thứ tự yêu cầu.** Run không biết yêu cầu nào của user mới hơn yêu cầu nó đang làm.
- **R5. Không phát hiện ghi đè.** Ghi đè xảy ra im lặng; user chỉ thấy khi tự kiểm tra lại.
- **R6. Worker và parent lệch nhau.** Worker `shared` ghi cùng thư mục với parent. Parent chỉ nhận report do worker tự viết, không có danh sách file thật đã đổi.
- **R7. Sub-agent là chỗ hở lớn nhất.**
    - `spawnAgent` và `Agent` chạy nền được tính là việc nền (`background: true`, `isBackgroundWait`). Lane chính chuyển `waiting` và tin mới của user đi sang listener, **trong khi sub-agent vẫn đang sửa file**. Đây đúng là kịch bản mục 2, chỉ khác người ghi đè là sub-agent.
    - Sub-agent nhận prompt một lần lúc được spawn. Sau đó nó không biết user hay run khác đã đổi gì.
    - Claude không có đường gửi tin tới sub-agent đang chạy. Codex có thread riêng nhưng AgentDeck chưa dùng.
    - Khi sub-agent xong, parent nhận kết quả do sub-agent tự kể. Parent không biết trong lúc đó user đã đổi gì.
    - Lượt tự động sau khi sub-agent nền của Claude xong (`AutoTurn`, `tail.rs`) là CLI tự nói. AgentDeck không chèn prompt vào đó được, nên thông báo đang chờ có thể bị lỡ.

## 5. Nguyên tắc

- **N1. Sổ chung theo thư mục làm việc.** Mọi lần ghi file của mọi run (primary, listener, worker, sub-agent, user) đều vào một ledger theo project root.
- **N2. Yêu cầu mới nhất của user thắng.** Mỗi run mang `intentSeq` của tin user khởi động nó. Run có `intentSeq` cũ không được hoàn tác thay đổi của run có `intentSeq` mới hơn.
- **N3. Báo ngay, báo đúng người.** Một thay đổi được báo cho mọi run khác đang chạy mà đã đọc hoặc sửa file đó trong turn hiện tại:
    - giữa turn nếu provider cho phép;
    - nếu không thì ở đầu turn kế tiếp của conversation đó.
- **N4. Báo cả ý định, không chỉ file.** Khi user gửi yêu cầu mới trong lúc run chính đang chạy, run chính được báo ngay nội dung yêu cầu, kể cả trước khi file nào bị đổi.
- **N5. Không chặn cứng, nhưng không im lặng.** CLI ghi file trực tiếp nên AgentDeck không chặn trước được. Bù lại: báo trước, phát hiện sau, cho user khôi phục.
- **N6. Có bằng chứng.** Flow log ghi đủ để dựng lại timeline như mục 2 mà không phải đoán.

## 6. Thiết kế

### 6.1 Change ledger

File mới:

- `src/lib/chat/runs/change-ledger.ts`: logic thuần, node test được.
- `src/lib/chat/runs/change-ledger.svelte.ts`: state.

```ts
type RunRef = {
    sessionId: string;
    turn: string;
    lane: 'primary' | 'listener' | 'worker' | 'subagent' | 'auto' | 'user';
    intentSeq: number; // seq của tin user khởi động run (chat.ledger), worker: của parent
};
type LedgerWrite = {
    root: string; // project root, chuẩn hoá bằng src/lib/files/paths.ts
    path: string; // chuẩn hoá, so sánh không phân biệt hoa thường trên Windows
    run: RunRef;
    at: number;
    before: string; // từ FileChange.before
    after: string; // từ FileChange.after (giới hạn 200 KB/file, chỉ file text)
    callId: string;
};
type LedgerRead = { root: string; path: string; run: RunRef; at: number };
```

- **Nguồn ghi:** event `tool_call` / `tool_result` có `change` trong `applyAgentEvent` (`chat/agent-reply.ts`), cho cả event `Scoped` của sub-agent (tính về run cha). Worker có `sessionId` riêng nhưng dùng chung `root` khi `isolation: shared`.
- **Nguồn đọc:** tool đọc file rõ ràng (Read, view, `Get-Content`/`cat` một path cụ thể), đủ để biết run nào đang "giữ" file.
- **User sửa tay:** lưu file trong editor (`openProjectFile`) ghi vào ledger với `lane: 'user'` và `intentSeq` mới nhất.
- `fileWrites.tick` giữ nguyên cho chỗ đang dùng; ledger là lớp mới bên cạnh.

### 6.2 Kênh báo tin (R3)

Thêm Rust command `agent_notify(session, text) -> 'steered' | 'queued'`:

- Nhận cả `NativeSteer { MergedIntoActive }` và `AppQueue`, vì thông báo không cần reply riêng.
- Đường đi theo provider:

| Provider                                           | Giữa turn                             | Kiểm tra                                                      |
| -------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| Codex (app-server)                                 | `turn/steer` (`codex_server.rs:691`)  | xác nhận path `exec`/app-server nào đang dùng cho chat thường |
| Claude                                             | warm inbox stream-json                | đã có `warm::inject`                                          |
| Copilot                                            | `NativeSteer`                         | xác nhận đường inject                                         |
| Custom chat                                        | `InjectSlot` inbox, đọc giữa các bước | đã có                                                         |
| OpenCode (`Parallel`), Antigravity (`NativeQueue`) | không                                 | chỉ ở đầu turn kế                                             |

- **Không gửi được giữa turn:** thông báo vào hàng chờ `pendingNotices[conversation]`, được chèn vào đầu prompt turn kế của đúng conversation đó (`run.svelte.ts`, cạnh chỗ `forkContext`). Worker đang chờ `continue` cũng dùng đường này.
- Gộp thông báo: một lần cho mỗi đợt thay đổi, mỗi run. Diff tối đa ~40 dòng mỗi file, còn lại ghi "và N dòng khác".
- Mẫu (gửi cho agent, tiếng Anh):

```
[AgentDeck] While you were working, another run changed files in this project:
- libs/assets/i18n/en.json, libs/assets/i18n/vi.json — by a side run for the user's newer request #12: "ghi ngắn gọn Áp dụng lọc / Reset lọc"
<short diff>
This is the user's latest intent. Re-read these files before you edit them and keep these changes; build on them.
If your own plan conflicts with them, stop and ask the user instead of reverting.
```

### 6.3 Khi nào báo (N3, N4)

1. **Yêu cầu mới của user vào lane listener** trong lúc primary đang chạy:
    - báo primary ngay: "The user also asked meanwhile: … It is handled by a side run; do not undo its result.";
    - prompt listener có: yêu cầu primary đang làm và các file primary đã sửa trong turn hiện tại.
2. **Một run ghi file P:** báo mọi run khác đang chạy cùng `root` mà đã đọc hoặc ghi P trong turn hiện tại.
3. **Worker `shared` xong:** report gửi parent tự gắn thêm "Files changed by this worker (from AgentDeck's ledger): …", không dựa vào lời worker tự kể (R6).
4. **`depends_on`:** worker phụ thuộc nhận danh sách file mà worker trước đã đổi, kèm report.
5. **Sub-agent của CLI:** xem 6.9.
6. **User sửa tay một file mà run đang giữ:** báo run đó như mục 2.

### 6.4 Chặn nhả tin sai lúc (R1)

- Bỏ đoán theo từ khoá trong `isLongRunningWork`. Chỉ coi là chờ việc nền khi:
    - provider báo rõ: `background: true`, `run_in_background`, `delegate_task` với `wait=false`, event `task` của provider; hoặc
    - một lệnh shell đã chạy quá **20 giây**. Đo bằng thời gian thật từ `tool_call`, không đoán theo tên lệnh.
- Ngoài hai trường hợp trên, tin của user vào queue như thường.
- Ghi lý do quyết định vào flow log: `deliver=listener reason=shell>20s call=…` hoặc `deliver=queue reason=…`.

### 6.5 Phát hiện ghi đè và khôi phục (R5)

- Run B ghi P sau khi run A ghi P, với A ≠ B và `A.intentSeq > B.intentSeq` → ghi nhận xung đột:
    - `B.after === A.before`: B đã **hoàn tác** hoàn toàn thay đổi của A;
    - ngược lại: B **ghi đè** lên bản của A.
- **UI:** dòng cảnh báo trong reply của B, cạnh `TurnChanges`, kèm hai nút:
    - "Khôi phục bản của <A>": ghi lại `A.after`, và chỉ ghi khi file hiện tại vẫn bằng `B.after`;
    - "Giữ bản này".
- Nếu B còn đang chạy: gửi thêm thông báo qua 6.2 rằng nó vừa hoàn tác yêu cầu mới hơn của user.
- Không tự khôi phục khi chưa hỏi user (xem câu hỏi mở 1).

### 6.6 Trạng thái hiển thị

- Lane primary đang `waiting` và có listener chạy bên dưới: live line của primary hiện "Waiting for progress…" kèm số giây, cùng style với "Thinking".
- Khi một thông báo đã tới được run: thêm một dòng step "Synced 2 changes from side run" trong group của run đó, để user thấy các run có nói chuyện với nhau.
- Thông báo đang chờ turn kế: step hiện "Will tell <run> on its next turn".

### 6.7 Delegate thiếu `agent` (cùng khu vực, lỗi đang gặp)

- Trạng thái 2026-11-04: code **chưa sửa**, `delegate.rs:254` và `delegate-task.ts:100` vẫn trả lỗi "agent is required".
- `delegate_task` thiếu `agent`, `role` và `continue`: dùng agent của chat gọi (`caller.agent`).
    - Rust `parse_delegate` (`src-tauri/src/delegate.rs:251`) và TS `parseDelegateArgs` (`tasks/delegate-task.ts:96`) trả `agent` rỗng thay vì lỗi.
    - `planTask` (`tasks/delegate-plan.ts:174`) thêm `|| caller.agent`.
- Mô tả schema của `agent`: "left out: the calling agent".
- Header `TaskCards.svelte:188` tách số task failed ra riêng, không gộp vào "complete".

### 6.9 Sub-agent của CLI (R7)

1. **Ledger ghi sub-agent bằng danh tính riêng.**
    - `lane: 'subagent'`, `subId`: `tool_use_id` của Claude hoặc `threadId` con của Codex, `label` (`subagent_type`/`description` hoặc prompt), cùng run cha.
    - Nguồn: event con có `change` (Claude qua `parent_tool_use_id`, Codex qua `child_events`).
    - Kiểm tra: Edit/Write của sub-agent Claude có mang `change` như ở run cha không. Nếu không có thì ít nhất ghi path từ input của tool.
2. **Kênh báo tới sub-agent.**
    - **Codex:** steer thẳng thread con (`turn/steer` với `threadId` và turn id của con). Cần lưu turn id của từng thread con trong `codex_server.rs`, và thử xem app-server có nhận steer cho thread con không.
    - **Claude:** không có kênh tới sub-agent. Báo cho run cha (steer), nội dung: "sub-agent <label> có thể vẫn đang sửa <path>, user vừa đổi file đó; khi nó báo xong, đọc lại file và giữ thay đổi của user". Phần còn lại dựa vào phát hiện ghi đè (6.5).
3. **Nhả tin sang listener khi chỉ còn sub-agent chạy.**
    - Vẫn cho nhả (đó là lúc user rảnh tay), nhưng prompt của listener phải có: sub-agent nào đang chạy, làm gì, đã ghi những file nào.
    - Nếu yêu cầu mới cần sửa file mà sub-agent đang giữ: listener vẫn làm, và mục 2 ở trên báo ngay cho sub-agent (Codex) hoặc run cha (Claude).
    - Phương án chặt hơn để chọn (câu hỏi mở 4): vào queue nếu sub-agent đang chạy đã từng ghi file.
4. **Khi sub-agent xong:** AgentDeck gửi cho run cha bản tóm tắt lấy từ ledger, gồm file sub-agent đã đổi và file user/listener đã đổi trong lúc đó. Run cha không phải dựa vào lời sub-agent tự kể.
5. **`AutoTurn` sau sub-agent nền của Claude:** thông báo đang chờ được gửi qua `tail::deliver` (`tail.rs:138`) trước khi CLI tự mở lượt. Nếu không kịp, gửi vào lượt kế tiếp của chat. Cần thêm một dạng "deliver không tạo reply riêng" cho thông báo.
6. **Ghi đè do sub-agent:** cảnh báo ở 6.5 ghi rõ người ghi đè là sub-agent nào (`Explore · Scan docs`), hiện dưới reply của run cha và trên card "Subagent & background activity".
7. **Trạng thái:** run cha chỉ còn chờ sub-agent thì hiện "Waiting for 1 background task · Explore" (`waitingLabel` đã có). Khi có listener chạy bên dưới, giữ dòng này ở reply trên (6.6).

### 6.10 Flow log

Thêm các dòng sau:

- `ledger write path=… run=… lane=… intent=…`
- `notify run=… via=steer|queued files=…`
- `conflict path=… writer=… over=… kind=revert|overwrite`
- `deliver=queue|listener reason=…`

## 7. Thứ tự làm

Mỗi nhóm là một nhánh `sync/w<k>-<tên>`. Viết test tái hiện trước, merge `--no-ff`.

| Nhóm | Việc                                                                                                                                     | Test chứng minh                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| W0   | Test tái hiện đúng timeline mục 2 bằng logic thuần (ledger + gating)                                                                     | Đỏ trước khi sửa                                                                                                                        |
| W1   | 6.7 delegate thiếu agent + header failed                                                                                                 | `delegate.rs` test, `delegate-task.test.ts`, test `planTask`                                                                            |
| W2   | 6.4 gating                                                                                                                               | `git diff --check`, lint → queue; shell 25 giây → listener; `run_in_background` → listener                                              |
| W3   | 6.1 ledger + ghi từ event (primary, listener, worker, sub-agent)                                                                         | Node test: ghi, đọc, chuẩn hoá path Windows                                                                                             |
| W4   | 6.2 `agent_notify` + hàng chờ đầu turn                                                                                                   | `ag-adapters`: notify nhận `MergedIntoActive`; TS: pending được chèn đúng conversation                                                  |
| W5   | 6.3 các trigger                                                                                                                          | Timeline mục 2: primary nhận thông báo trước 11:54:51                                                                                   |
| W5b  | 6.9 sub-agent: ledger theo `subId`, steer thread con Codex, báo run cha của Claude, tóm tắt khi sub-agent xong, deliver trước `AutoTurn` | Node test: event con có `change` vào ledger đúng `subId`; `ag-adapters`: steer thread con; timeline mục 2 với người ghi đè là sub-agent |
| W6   | 6.5 phát hiện ghi đè + UI khôi phục                                                                                                      | Timeline mục 2: xung đột `kind=revert`, nút khôi phục trả đúng nhãn ngắn                                                                |
| W7   | 6.6 trạng thái hiển thị                                                                                                                  | Ảnh chụp app thật                                                                                                                       |
| W8   | 6.8 flow log, cập nhật `docs/development`                                                                                                | Đọc log của một lần chạy thử                                                                                                            |

W2 tự nó đã chặn đúng kịch bản mục 2. W3 đến W6 xử lý khi có việc nền thật (`pnpm dev`, build dài, worker `wait=false`).

## 8. Kiểm tra

- `node --experimental-strip-types --test` cho các file test liên quan.
- `pnpm check` (svelte-check).
- `cargo test -p ag-adapters` và `cargo clippy --workspace -- -D warnings`. Crate desktop cần VS dev shell (whisper-rs-sys).
- Chạy lại kịch bản trên app thật:
    1. Task chính sửa nhãn rồi chạy lint. Gửi "ghi ngắn gọn" → tin vào **queue**, không vào listener.
    2. Task chính chạy `pnpm dev` (việc nền thật), gửi yêu cầu sửa nhãn → listener làm; primary nhận thông báo, không hoàn tác.
    3. Ép hoàn tác (prompt primary cố tình đổi lại) → cảnh báo xung đột hiện, nút khôi phục đúng.
    4. Worker `shared` sửa file parent đang giữ → parent nhận thông báo; report có danh sách file từ ledger.
    5. Claude spawn sub-agent nền sửa `en.json`. Trong lúc đó user gửi "ghi ngắn gọn" (vào listener) → run cha được báo. Nếu sub-agent vẫn ghi đè thì cảnh báo hiện tên sub-agent.
    6. Như bước 5 với Codex `spawnAgent` → thread con nhận steer và không hoàn tác.

## 9. Giới hạn và rủi ro

- Không chặn trước được ghi file của CLI, chỉ báo trước và phát hiện sau.
- CLI có thể bỏ qua thông báo steer. Lưới an toàn ở 6.5 bắt các trường hợp đó.
- Chi phí token: thông báo được gộp và cắt diff.
- Bộ nhớ: lưu `after` tối đa 200 KB/file, chỉ trong phiên; ledger bị xoá khi đóng chat.
- OpenCode và Antigravity chỉ được báo ở đầu turn kế.
- Đọc file qua lệnh shell tuỳ ý (pipe, script) không bắt hết được, nên "ai đang giữ file" là gần đúng. Ghi file thì chính xác, vì lấy từ `change`.

## 10. Câu hỏi mở

1. Có xung đột thì AgentDeck **hỏi** (card + nút) hay **tự khôi phục** bản của yêu cầu mới hơn? Đề xuất: hỏi.
2. Listener có được sửa file mà primary đang giữ không? Đề xuất: được, và primary được báo ngay (6.3). Phương án chặt hơn: đưa tin đó vào queue.
3. Ngưỡng 20 giây cho shell chạy lâu có hợp lý với project của bạn không?
4. Khi chỉ còn sub-agent đang chạy và nó đã từng ghi file: tin mới vẫn vào listener (kèm báo cho sub-agent / run cha) hay vào queue? Đề xuất: vào listener và báo, vì đó là lúc user rảnh tay.

## 11. Trạng thái triển khai (2026-11-04)

Đã làm (code + test node; `pnpm check` 0 lỗi, 188/188 test chat/tasks pass):

- W1: delegate thiếu `agent` dùng agent của chat gọi (TS + Rust + schema); header card tách số `failed`.
- W2: `isLongRunningWork` không còn đoán theo từ khoá; shell chạy quá 20 giây mới nhả lane (`SHELL_WAIT_MS`, timer trong `events.svelte.ts`); dev server (`browser_serve`) vẫn nhả ngay.
- W3: ledger ghi file (`runs/change-ledger.ts` + `.svelte.ts`), ghi từ `tool_call`/`tool_result` có `change`, sub-agent của Claude ghi dưới `subId`; ledger đọc (`readPathOf`).
- W4: `agent_notify` (Rust, `agent_runs.rs`) + hàng chờ đầu turn (`notices.svelte.ts`, chèn vào prompt ở `run.svelte.ts`).
- W5: trigger 1 (user nhắn side run), 2 (file đổi → run khác đã đọc/ghi file đó), 3 (worker xong → parent nhận danh sách file từ ledger).
- W6: phát hiện ghi đè (`revert`/`overwrite`), báo writer, card `LedgerConflicts.svelte` trên composer, nút khôi phục (`restore.ts`, chỉ khi file còn đúng bản của writer).
- W7: live line "Waiting for progress" khi lane chính chờ và side run đang chạy.
- W8 (một phần): flow log `ledger write`, `conflict`, `notify`, `deliver`.

Chưa làm / cần kiểm:

- W5b: Codex `turn/steer` tới thread con và `deliver` trước `AutoTurn` của Claude. Chưa có.
- Trigger 4 (`depends_on`: prompt worker có danh sách file của dependency, lấy từ ledger) và trigger 6 (user lưu file trong editor: ghi vào ledger như run mới nhất, báo các run đang giữ file) đã làm ở lượt sau.
- Dòng "Synced N changes" và "Will tell <run> on its next turn" (6.6) chưa có.
- Rust (`agent_notify`, `lib.rs`) chưa compile: crate desktop không build được trên máy này (whisper-rs-sys).
- Chưa chạy app thật: kịch bản mục 8 chưa tái hiện.
- Work tray: shell > 20 giây không còn được đưa vào tray (`activity.svelte.ts` dùng `isLongRunningWork`, nay chỉ còn dev server).
- Docs trong `docs/development` chưa cập nhật.
- Chưa commit.

### Cập nhật lượt sau

- Tray: shell chạy quá 20 giây được đưa lên Work tray (`promoteShellCall`), không còn mất.
- Dòng "Will tell the next turn about N changes" trên composer khi có thông báo đang chờ (`LedgerConflicts.svelte`). Dòng "Synced N changes" trong group chưa làm.
- Docs: `docs/development/change-sync.md`.
- `pnpm check`: 0 lỗi (cần `NODE_OPTIONS=--max-old-space-size=8192`, mặc định hết bộ nhớ). Test chat/tasks: 190/190.
- Rust desktop: `cargo check -p agentdeck-desktop` thất bại do artifact trong `target/` hỏng (rustc `STATUS_STACK_BUFFER_OVERRUN` ở build script của tauri-plugin-fs, `can't find crate tauri`). Chưa xác minh được Rust desktop. Cần `cargo clean` (hoặc xoá `target/`) rồi build lại trong VS dev shell.
- Chưa làm và lý do: W5b Codex steer tới thread con (cần protocol app-server thật để xác minh `expectedTurnId` của thread con); deliver `AutoTurn` của Claude (cần đường mới trong `tail.rs`); dòng "Synced N changes" trong group.

---

# AgentDeck Harness Core and DeepSeek Harness Integration Plan

## Goal

Build a provider-neutral Harness Core for stable sessions, streams, tools, approvals, sub-agents, process cleanup, and UI state. Integrate DeepSeek Harness through ACP or SDK JSON-RPC as first external runtime.

## Scope

- Preserve Svelte 5 and Tauri.
- Preserve existing provider behavior.
- Do not embed Cordis or replace AgentDeck persistence wholesale.
- Add dsh profile, skill, plugin, MCP, and UI integration behind opt-in.

## Audit conclusions

DeepSeek Harness source audit found the most useful patterns: scoped plugin lifecycle, profile/bundle composition, explicit turn/step state, durable event projection, versioned resume, bidirectional approvals, parent/child sessions, serialized stream delivery, quiescent shutdown, typed desktop readiness/fatal recovery, and UI capability contributions.

AgentDeck already has useful foundations: Rust process ownership, provider adapters, event protocol, stream coalescing, MCP settings, recovery, delegation, child-agent state, and Tauri IPC. The work should add contracts around those pieces instead of replacing them.

## Architecture

AgentDeck UI -> canonical runtime events/snapshots -> Harness Core -> provider adapters -> existing CLIs or dsh ACP/SDK.

Harness Core capabilities:

- SessionStore
- AgentRuntime
- EventBus
- ToolRegistry
- ApprovalBroker
- ChildAgentRegistry
- McpRegistry
- ProcessRuntime
- ProviderAdapter registry

## Runtime contract

State: created, starting, ready, running, waiting_tool, waiting_approval, stopping, completed, failed, cancelled.

Events: session_started, turn_started, step_started, assistant_delta, tool_started, tool_progress, tool_finished, approval_requested, approval_resolved, subagent_started, subagent_finished, file_changed, turn_completed, turn_failed, turn_cancelled, session_status.

Each event carries stable session, turn, step, tool-call, and parent-child identifiers where applicable. Durable events and live notifications are separate. UI coalescing must preserve sequence and terminal settlement.

Each session owns its process, child agents, MCP attachments, approvals, subscriptions, and cleanup. Close means cancel, drain, stop, flush, and dispose in dependency order.

## Phase 0: baseline

- Keep all unrelated changes in the original checkout.
- Record Rust, Svelte, package, and native runtime checks.
- Freeze event IDs, lifecycle states, errors, approval, cancellation, and cleanup contracts.
- Do not change existing provider behavior.

Acceptance: clean isolated worktree, recorded baseline, contract types compile.

## Phase 1: Harness Core

- Add provider-neutral runtime seams at the current Rust adapter boundary.
- Add disposer-based registration and per-session scope.
- Keep existing providers behind compatibility adapters.
- Add runtime snapshots for UI reads.
- Add fake provider full-turn test.

Acceptance: one terminal result, idempotent cancel, no process/subscription leak.

## Phase 2: events, replay, recovery

- Version canonical event envelope.
- Project transcript, activity, tool cards, approvals, child agents, and usage.
- Reconcile interrupted streams and tool calls on reload.
- Keep current persistence/index where sufficient.
- Make resume a real session runtime operation, not a hidden continuation prompt.

Acceptance: deterministic replay, no duplicate messages, recoverable interruption, preserved parent-child identity.

## Phase 3: process supervisor

- Centralize start, stderr drain, stall detection, timeout, cancellation, tree cleanup, and exit classification.
- Preserve Windows console suppression and integrated terminal behavior.
- Prevent duplicate runtime processes per session.
- Add bounded restart diagnostics.
- Normalize existing CLI adapters incrementally.

Acceptance: noisy stderr cannot block, silent process gets clear error, cancel closes process tree, existing providers do not regress.

## Phase 4: dsh ACP/SDK adapter

- Add DeepSeek Harness provider descriptor.
- Start dsh --profile acp or dsh --profile sdk through ProcessRuntime.
- Implement newline-delimited JSON-RPC framing, correlation, notifications, malformed-frame handling, and shutdown.
- Implement initialize, session creation, prompt receipt, session.event, status, wait, resume, working-directory, cancel, and shutdown.
- Map dsh assistant, tool, approval, sub-agent, error, status, and completion events to canonical events.
- Send AgentDeck approval decisions back to dsh.

Acceptance: early prompt receipt, incremental stream, tool/approval cards without dsh-specific branches, same-session resume, no orphan process.

## Phase 5: dsh plugin and skill bridge

- Add settings for executable, profile, home, model, and workspace.
- Add profile health/version checks.
- Add plugin discovery and compatibility diagnostics.
- Support explicit local/package plugin operations.
- Keep install, enable, disable, and reset separate from chat execution.
- Display profile capabilities: tools, MCP, sub-agents, approval, and UI metadata.
- Prevent plugins from silently changing AgentDeck global providers or permissions.

Acceptance: disposable profile loads a plugin and exposes its tool; invalid plugin fails before ready; reset restores known composition.

## Phase 6: MCP, sandbox, workspace policy

- Make MCP lifecycle provider-neutral and session-scoped.
- Expose health, testing, failure, retry, and usage to existing MCP UI.
- Define read-only, workspace-write, and workspace-write plus private-temp modes.
- Keep Windows ACL/job support behind platform capabilities.
- Control inherited environment, stdio, handles, and working-directory boundaries.

Acceptance: MCP operations observable, session close cleans owned servers, workspace boundaries hold, Windows native process does not flash a console.

## Phase 7: UI update

Keep Svelte 5 and Tauri. Learn from dsh desktop/Web UI:

- Session shell phases: blank, loading, active, waiting, error.
- Tool cards with lifecycle, progress, output, and retry.
- Approval cards with detail, warning, allow-once, reject, expiry, and transport retry.
- Root/child session sidebar with stable identity.
- One-shot child session with read-only composer.
- Settings contributed by capability/profile metadata.
- Typed host readiness and fatal recovery.
- Runtime-event-based loading/error state, not text heuristics.
- Per-session stream coalescing while preserving event order.

Acceptance: runtime screenshot checks for chat, tool, approval, child session, settings, loading, and error; every UI state maps to event/snapshot.

## Phase 8: verification and rollout

- Fake runtime tests: slow/broken stream, approval, tool failure, child agent, duplicate/out-of-order event, cancel, crash, resume.
- Fake JSON-RPC ACP/SDK server tests.
- Disposable dsh profile smoke tests.
- Svelte, Rust, focused adapter, Preview, and native Windows checks.
- Feature flag or provider opt-in first.
- Remove compatibility paths only after replay, protocol, and cleanup pass.

## Risks and stop conditions

- dsh is developer preview; pin audited version and isolate profiles.
- Do not migrate all providers before canonical replay and cleanup are stable.
- Require restart if plugin reload cannot prove quiescence.
- Keep sandbox capability disabled when platform proof is incomplete.
- Stop if event replay is nondeterministic, approval correlation is unsafe, cancel/resume is unstable, existing providers regress, or UI state cannot be traced to runtime facts.

## Expected checks

    pnpm exec svelte-check
    pnpm exec vitest run <focused frontend tests>
    pnpm test --filter <focused package>
    cargo test -p <focused crate>
    cargo check -p <focused crate>
    pnpm dev

Runtime proof must distinguish static checks, fake protocol tests, disposable dsh smoke tests, Preview UI checks, and native Tauri checks.

## Implementation status (2026-11-07)

### Master completion checklist

- [x] Provider-neutral Harness lifecycle for CLI, custom API, Copilot, OpenCode, Command Code, Kimi, MiniMax, Z.AI, and local model routes.
- [x] Shared MCP/OfficeCLI route for workbook and office-tool calls.
- [x] MCP Store dsh plugin install/remove bridge.
- [x] Stream coalescing, stale turn protection, live Harness status, and caret hidden from the reply UI.
- [x] Regional cloud presets and local host discovery for Ollama, LM Studio, llama.cpp, vLLM, and Jan.
- [x] Durable canonical event store with deterministic replay and interrupted-turn recovery contract.
- [x] Approval broker with provider request correlation, expiry, resolve, reject, and retry transport contract.
- [x] Session-scoped child Harness runtimes with parent/child event identity and cleanup contract.
- [x] Process supervisor state contract with stderr accounting, stall detection, tree cleanup, and bounded restart policy.
- [ ] dsh SDK/ACP provider adapter with prompt receipt, event stream, resume, approval, cancellation, and shutdown.
- [x] dsh profile/plugin capability health and version diagnostics in MCP Store.
- [ ] Provider health, quota, latency telemetry, routing fallback, and offline/local preference policy.
- [ ] MCP session lifecycle, sandbox modes, inherited environment policy, and Windows handle/ACL proof.
- [ ] Google Sheets OAuth/MCP connector for online spreadsheets; `.xlsx` remains covered by OfficeCLI.
- [ ] Runtime UI for tool progress/retry, approval expiry, child sessions, recovery, transport errors, and settings capabilities.
- [x] Contract, protocol, provider, frontend, Preview, and native Windows verification matrix documented.

- MCP Store integration started: `apps/desktop/src-tauri/src/store/dsh.rs` delegates plugin installation and removal to the official `dsh plugin --profile sdk` commands and reads `$DSH_HOME/profiles/sdk/package.json` for the installed list.
- DSH compatibility boundary: dsh keeps ownership of profile composition, manifest format, dependency resolution, and external bundle lifecycle. AgentDeck does not rewrite dsh manifests, repackage bundles, or model dsh plugins as native MCP providers.
- MCP Store UI started: `DshPluginStore.svelte` is embedded in the existing MCP Store section and supports package, git, and local plugin specs plus removal.
- Phase 0: isolated worktree retained; existing provider behavior untouched.
- Phase 1 started: `crates/orchestrator/src/harness.rs` now owns the provider-neutral session lifecycle, ordered event envelope, runtime snapshot, tool/approval/child-agent transitions, and idempotent cancellation boundary.
- Phase 1 evidence: `cargo fmt --all` and `cargo test -p ag-orchestrator` pass; 9 unit tests pass.
- Phase 1 runtime wiring: existing `agent_runs` now projects every provider `AgentEvent` through `HarnessRuntime` while preserving the legacy `agent-event` stream. Envelopes carry `harness_state` and monotonic `harness_seq`; parallel tools, multiple approvals, child tasks, completion, failure, and cancellation share one lifecycle boundary.
- Phase 1 regression proof: focused Harness tests pass, including parallel-tool waiting; `pnpm -r --if-present run check` passes with 0 Svelte errors and 0 warnings.
- Phase 4 foundation started: `crates/adapters/src/dsh_protocol.rs` now provides incremental NDJSON framing, CRLF handling, malformed-frame diagnostics, and newline encoding; 3 focused tests pass.
- Phase 4 transport boundary extended: JSON-RPC request correlation, notification separation, pending-response tracking, and shutdown state now require actual process exit before a future resume/restart. Focused adapter tests: 5 pass.
- Phase 4 protocol decision: use dsh SDK as the primary runtime path for early `session/prompt` receipt and durable `session.event`; retain ACP compatibility for standard session, permission, cancel, and resume semantics. SDK cancellation remains a supervisor restart boundary until dsh exposes a wire-level `session/cancel`.
- Phase 2 durable foundation: `ag-orchestrator` now includes append-only JSONL `HarnessEventLog`, deterministic sequence/session validation, replay, and interrupted-turn detection. It also exports provider-neutral approval, child-session tree, and process-supervisor contracts with focused unit tests.
- Phase 4 protocol foundation: `dsh_protocol` now exposes typed SDK/ACP lifecycle method names and notification classification for session events, approvals, user questions, and subagents. Actual dsh process execution remains pending until the CLI is installed in the runtime environment.
- DSH Store diagnostics: MCP Store now shows dsh CLI availability, version, sdk profile existence, and capabilities before plugin installation.
- Approval UI integration: pending permission cards now show a 120-second expiry countdown and auto-deny when the transport leaves an approval unanswered, preventing indefinitely blocked turns.
- Recovery routing integration: `RoutingProfile.allowedProviders` and custom connector `requiredCapabilities` now filter fallback routes before recovery chooses a provider; the existing quota and installed-CLI gates still apply.
- Phase 2 started: `agent-event` now preserves Harness metadata through the frontend frame queue, applies stale turn/sequence protection, and projects lifecycle facts into a dedicated `harnessStates` store. Live reply status consumes `waiting_tool`, `waiting_approval`, `starting`, and `stopping` without replacing the existing tool/task reducer.
- Phase 2 lifecycle safety: scoped child events no longer mutate the parent Harness terminal state; cancellation emits a separate `agent-harness` terminal envelope for the frontend.
- Provider coverage extended: custom OpenAI-compatible turns, Copilot SDK turns, and OpenCode server turns now accept the shared Harness event sink; legacy `agent-event` emission remains intact and each path emits terminal Harness status.
- Provider matrix extended: official Kimi, MiniMax, Z.AI, Command Code and regional China API presets share the custom provider adapter and Harness path; local discovery now probes Ollama, LM Studio, llama.cpp, vLLM, and Jan. OfficeCLI remains the shared MCP route for Word, Excel/Sheets, and PowerPoint, so custom API providers inherit the same tool surface through the existing MCP Store/config bridge.
- Phase 7 stream UI slice: live AgentEvent chunks now coalesce at 32ms to match the Markdown reveal cadence, and streamed replies expose `aria-busy` while text is still arriving; the visual caret is hidden. Existing block reuse, word-safe reveal, and deferred code highlighting remain intact.
- dsh ACP/SDK process adapter, MCP sandbox policy, provider fallback telemetry, Google Sheets OAuth, full runtime UI projection, and native runtime proof remain pending.
- Verification: `cargo test -p ag-orchestrator` passed with 14 tests; `cargo test -p ag-adapters dsh_protocol -- --nocapture` passed with 6 tests; `pnpm --dir apps/desktop run check` passed with 0 errors and 0 warnings; `cargo fmt --all -- --check` and `git diff --check` passed. Desktop Cargo validation remains blocked by the native `whisper-rs-sys` build: missing `stdbool.h`, then bundled binding ABI assertions (`_G_fpos_t`, `_G_fpos64_t`, `_IO_FILE`) under the current toolchain. Evidence is recorded in `docs/development/harness-verification.md`.
