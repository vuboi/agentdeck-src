# Kế hoạch sửa cấu trúc: fallback, sub-agent, delegate, routing và đổi model/provider

Ngày lập: 2026-11-02. Mốc mã nguồn: commit `649fd90` (nhánh `feat/smooth-command-swap`).
Tài liệu này dành cho agent/người thực hiện. Nó dựa trên một lượt rà soát mã nguồn (chỉ đọc), chưa sửa gì.

## 0. Đọc trước khi làm

### 0.1 Quy tắc bắt buộc

- Đọc `AGENTS.md` ở gốc repo. Môi trường Windows: Rust dùng `~/.cargo/bin` (`export PATH="$HOME/.cargo/bin:$PATH"` trong bash), Node 24, pnpm 10, không dùng npm/yarn.
- Khi đụng tới provider/agent: đọc `docs/development/adding-agent-provider.md`.
- Svelte 5 runes, TypeScript strict. Rust: `thiserror` trong lib, `anyhow` trong bin, không `unwrap()` ngoài test, log bằng `tracing`.
- Không gọi mạng trong test. Không commit secret. Xóa file rác test trước khi xong (`pnpm clean:junk`).
- Mỗi Phase là một PR riêng (Phase 0 có thể chia nhỏ hơn theo nhóm). Không trộn refactor với thay đổi hành vi trong cùng một commit.
- Số dòng trong tài liệu này là theo commit `649fd90` và có thể đã lệch. Luôn tìm lại theo tên hàm/biến trước khi sửa.
- Mỗi mục có ghi độ tin cậy: **Cao** (đã đọc code xác nhận), **TB** (suy ra từ code, chưa tái hiện), **Chưa chắc** (cần kiểm chứng trước). Với mục TB/Chưa chắc: viết test tái hiện hoặc đọc kỹ để xác nhận rồi mới sửa. Nếu không đúng, ghi lại trong PR và bỏ qua.

### 0.2 Quyết định đã chốt với chủ dự án (không thay đổi)

1. **Giữ tính năng tự đổi tài khoản/key (auto account switch).** Đây là toggle opt-in theo từng connector (`connectors.autoSwitch[...]`) và theo từng custom provider (`provider.autoSwitch`). Spec: `docs/superpowers/specs/2026-10-30-auto-account-provider-switch-design.md`. Không xóa `runAutoSwitch`, `autoSwitchConnectorAccount`, `autoSwitchProviderKey`, `credential-switch.ts`, các setting và toggle trong composer.
2. Khi toggle **tắt**: recovery chỉ được đổi provider (chuỗi fallback), không bao giờ đổi tài khoản, và không coi quota của tài khoản khác là "còn chỗ".
3. Khi toggle **bật** và thử hết mọi tài khoản/key mà vẫn lỗi: khôi phục credential gốc, hiện resume card, **không** chuyển sang provider khác. Đây là hành vi đúng theo spec (dòng 19, 37, 71). Không "sửa" nó.
4. Sửa các comment đang nói ngược với quyết định 1: `apps/desktop/src/lib/chat/recovery/turn-failure.ts:1-4` ("Accounts are never switched here") và comment quanh `events.svelte.ts:176`. Comment mới phải nói: đổi tài khoản chỉ xảy ra qua auto-switch opt-in trong `events.svelte.ts`, còn `planRecovery` chỉ lo retry/đổi provider.

### 0.3 Lệnh kiểm tra (DoD) — chạy hết và báo kết quả thật ở cuối mỗi PR

```bash
pnpm check
```

```bash
cargo clippy --workspace -- -D warnings
```

```bash
cargo test -p ag-adapters
```

```bash
cargo test -p agentdeck-desktop
```

```bash
pnpm --filter ./apps/desktop test:account-switch
```

Test TS không có vitest. Chạy file test lẻ bằng:

```bash
node --experimental-strip-types --test apps/desktop/src/lib/chat/recovery/turn-failure.test.ts
```

Test trong `apps/desktop/tests/` (`*.test.ts`, `*.test.mjs`) chạy cùng cách. Test mới đặt cạnh file nguồn (`foo.test.ts`) hoặc trong `apps/desktop/tests/`, theo kiểu đang có.

Một số test desktop đã lỗi sẵn trước kế hoạch này (parser Bing, Access denied của test server, index SQLite readonly — xem `docs/development/chat-delivery-audit.md`). Ghi rõ lỗi nào có sẵn, lỗi nào mới.

## Sự cố khẩn — "This message could not be drawn. It is saved; open the chat again to retry."

Làm trước mọi phase. Hiện cứ gửi tin nhắn là gặp lỗi này.

### Bằng chứng (đã đọc, độ tin cậy Cao)

- Thông báo đến từ `snippet failed()` của `<svelte:boundary>` bao mỗi row trong `apps/desktop/src/lib/components/chat/Chat.svelte:~927-1042`. `onerror` ghi `logError('app', 'chat row failed to draw', …)` vào `%APPDATA%/<identifier>/logs/errors.log`.
- Log của bản `dev.agentdeck.desktop.local`, lúc 15:21–15:26Z ngày 2026-11-02 (sau commit `21cdfb2` lúc 15:15Z):
    - `https://svelte.dev/e/state_unsafe_mutation`, stack `… at Ei.set (…DiJCDTr3.js)` (một `SvelteMap.set`);
    - row lỗi là `local-…`, tức tin nhắn vừa gửi.
- Bản `.dev` lúc 14:29–14:46Z cùng lỗi `state_unsafe_mutation`, row `m2` và `local-…`.
- Lỗi khác, cũ hơn, trên row Codex lịch sử (`codex-827`, `codex-2100`): `Cannot read properties of undefined (reading 'findLast')` / `(reading 'map')`. Dữ liệu row thiếu mảng (nghi `blocks` hoặc `items` undefined).
- Commit `21cdfb2` đã sửa một phần: thêm `messagesView()` (chỉ đọc) và đổi 3 chỗ gọi (`pendingInput`, `openQuestions`, context lookup của composer). Nhưng `messagesOf` (`chat/session/run.svelte.ts:~1377`) vẫn **ghi** khi đọc:
    - `messagesById.set(sessionId, list)` (đây là `SvelteMap.set` trong stack);
    - `localMessages[sessionId] ??= []`;
    - `setMessages(...)` khi chat đang mở dùng mock.
      Còn 26 chỗ gọi `messagesOf(` trong `chat/session/*.ts`. Ít nhất một chỗ vẫn được gọi trong lúc vẽ row (template / `$derived`).
- Không xác định được chỗ gọi cụ thể từ log, vì `onerror` chỉ ghi 3 dòng stack (`error.stack?.split('\n').slice(1, 4)`), toàn là nội bộ Svelte.
- Lưu ý: phiên Phase 0 đang sửa trực tiếp checkout này (chưa commit). Nếu chạy `pnpm dev` từ thư mục này, HMR sẽ nạp code đang sửa dở. Tái hiện lỗi trên `main` sạch hoặc trong worktree riêng.

### Các bước sửa

**R1. Ghi đủ stack. — Cao**

- `Chat.svelte` `onerror`: ghi toàn bộ `error.stack` (giới hạn ~40 dòng), cộng loại row (`role`, các `block.kind`) và id chat. Không ghi nội dung tin nhắn.

**R2. Tái hiện trong `pnpm dev` để biết chỗ gọi. — Cao**

- Chạy bản dev (code chưa minify) trên `main` sạch, gửi một tin nhắn, đọc `%APPDATA%/dev.agentdeck.desktop.dev/logs/errors.log`.
- Tạm thời thêm vào đầu `messagesOf` một guard chỉ ở dev: `if (import.meta.env.DEV && $effect.tracking()) console.error(new Error('messagesOf during a reactive read'))`. Lỗi này in ra stack của chỗ gọi thật. Xóa guard sau khi tìm được chỗ gọi, hoặc giữ ở dạng R3.

**R3. Sửa tận gốc: đọc không bao giờ ghi. — Cao**

- Tách `messagesOf` thành hai hàm:
    - `messagesView(id)`: thuần, dùng cho mọi đường đọc;
    - `ensureMessages(id)`: tạo và lưu list, chỉ gọi ở đường ghi (gửi, áp event, nạp lịch sử, fork, xóa).
- Rà 26 chỗ gọi `messagesOf(`. Chỗ nào chỉ đọc thì đổi sang `messagesView`. Chỗ nào ghi thì gọi `ensureMessages`.
- Bỏ nhánh ghi `setMessages` khi mock khỏi đường đọc, chuyển vào chỗ nạp chat.
- Rà cùng kiểu lỗi ở các module `.svelte.ts` khác: getter dùng `SvelteMap.set`, `??=` trên `$state`, hoặc gán state bên trong hàm được gọi từ template/`$derived`. Ví dụ đã sửa trước đây là `voiceOf` (commit `801f3c1`).
- Giữ guard dev của R2 trong `ensureMessages` để phát hiện sớm khi có người gọi nó từ đường đọc.

**R4. Row lịch sử thiếu mảng. — TB**

- Tìm trong bản dev chỗ gọi `.findLast` / `.map` trên dữ liệu row (nghi `message.blocks`, các `items` của segment, `task.children`).
- Chuẩn hóa khi nạp lịch sử Codex: mọi message có `blocks: []`, mọi block có mảng con mặc định. Sửa ở chỗ chuyển đổi lịch sử (`crates/adapters/src/history` hoặc `chat/session/history.svelte.ts`), không chặn ở UI.

**R5. UI của boundary. — Thấp**

- Thêm nút "Thử vẽ lại" để row tự vẽ lại (đổi key của boundary), thay vì bắt người dùng mở lại chat.

**R6. Kiểm chứng.**

- Bản dev: gửi 10 tin nhắn liên tiếp, có tool call, sub-agent, delegate; mở lại chat Codex lịch sử có row `codex-827` → không còn dòng "chat row failed to draw" mới trong `errors.log`.
- `pnpm check` 0 lỗi.
- Node test cho `messagesView` / `ensureMessages`: đọc không tạo entry mới trong `messagesById`.

## 1. Chẩn đoán: bốn nguyên nhân gốc

Phần lớn lỗi "lúc được lúc không", giật, lỗi vặt khi đổi model/provider/connector đến từ bốn nguyên nhân lặp lại ở cả bốn luồng:

1. **Không có nguồn sự thật duy nhất.**
    - Agent/model của chat nằm ở 5 nơi: `SessionItem.agent/model`, pref `composer.pickers`, `chatTurnOptions`, `turnOptions` toàn cục, `lastChat`. Danh tính hội thoại với CLI rải thêm ở 6 field (`state.svelte.ts:84-103`).
    - Vòng đời task delegate: 6 map trong TS (`delegateTasks`, `taskRuns`, `slotStarts`, `taskWaiters`, `pendingTaskAsks`, `backlog`, cùng `delegateRuns`) và 2 map trong Rust (`PENDING`, `GATE`).
    - Trạng thái sub-agent theo dõi 4 lần với 4 luật ghép id: `block.task` của card, `status`+`nativeTaskId` của activity, set `backgroundTools`, `updateHistoricalTask`.
    - State recovery rải: `recoveries`, `resumes`, `credentialAttempts`, `manuallyStopped`, `resumeAutoChoice`, `resumeSince`.
2. **Hiểu biết về provider bị chép khắp nơi.** Danh sách provider viết tay ở ~9 chỗ; scope credential của Antigravity có 3 tên (`agy`, `antigravity`, `switch:agy`); "đây có phải sub-agent" quyết ở 8 chỗ; thêm một provider đụng ~20 chỗ.
3. **Lỗi được phân loại bằng regex trên chuỗi text**, ở nhiều chỗ, và có phân loại sai.
4. **Không bảo đảm bước kết thúc (finalize) luôn chạy**: recovery thoát sớm làm treo chat cha; sub-agent con không bao giờ được đóng; report delegate có thể mất không báo.

Thứ tự thực hiện: Phase 0 (sửa lỗi điểm) → 1 (registry provider) → 2 (lỗi có cấu trúc) → 3 (state machine) → 4 (contract sub-agent) → 5 (tách file lớn, chuyển sở hữu delegate sang Rust).

Phase 6 (định dạng brief, danh sách bước và report của sub-agent/worker) độc lập với Phase 1–5. Có thể làm ngay sau nhóm C của Phase 0. Riêng mục E9 (sub-agent native) cần Phase 4.

Phase 7 (harness điều phối công việc: task list ghim, ô "bước tiếp theo", tách phiên theo phase rồi báo về chat chính, gợi ý rà plan và commit) làm sau Phase 6. Phần tách phiên (H3) dùng lại state machine task của Phase 3.2. Các mục H1, H2, H5 làm được sớm hơn.

Phase 8 (git worktree cho phiên, gợi ý tách worktree, merge về chat chính) làm sau Phase 7 H3. Riêng W1, W2, W4 (worktree thủ công) làm được ngay sau Phase 1.

Mục "Sự cố khẩn" (lỗi vẽ tin nhắn) ở đầu tài liệu làm trước tất cả.

---

## Phase 0 — Sửa lỗi điểm (mỗi mục độc lập, nhỏ)

Mỗi mục: sửa + một test tái hiện (nếu viết được bằng node test thuần) + ghi trong PR. Chia PR theo nhóm A/B/C/D.

### Nhóm A — Fallback / recovery

Tệp chính: `apps/desktop/src/lib/chat/session/events.svelte.ts`, `sending.svelte.ts`, `turns.svelte.ts`, `apps/desktop/src/lib/chat/recovery/turn-failure.ts`.

Bối cảnh luồng hiện tại: `handleEventNow` (~`events.svelte.ts:1425-1470`) gọi `classifyFailure`; nếu limit/auth và toggle bật → `autoSwitchRequested` → `runAutoSwitch` (~`:482`). Ngược lại `recoveryFor` (~`:326`) → `planRecovery` (`turn-failure.ts:52`) → retry/fallback/stop. Khi đang recovery, các bước kết thúc bị bỏ qua (`failSessionWork`, `onDelegateDone`, workflow finish, `releaseBrowserChat`, project activity — ~`:1510`, `:1539`, `:1583`, `:1618`). Dispatch ở ~`:1662-1678`: `runRecovery` (~`:454`) hoặc `runAutoSwitch`.

**A1. Recovery thoát sớm làm treo chat cha / worker delegate. — Cao**

- Vấn đề: `runRecovery` có các nhánh `return` sớm (~`:457`, `:466` khi `!target`, `:473`). Vì finalizer đã bị bỏ qua lúc phát hiện lỗi, sẽ không ai gọi `onDelegateDone`, `endWaitingTasks`, `releaseBrowserChat`, `sendNextQueued`. `!target` xảy ra được vì `recoveryTarget` tính lại route sau thời gian chờ, lúc đó `agentHasRoom` có thể đã đổi.
- Sửa: tách hàm `finalizeTurn(sessionId, outcome)` gom tất cả các bước kết thúc đang bị skip. Gọi nó ở mọi nhánh thoát sớm của `runRecovery`, và khi `runAutoSwitch` kết thúc ở trạng thái thất bại mà không gửi lượt mới. Làm tương tự nếu `runAutoSwitch` có nhánh return sớm nào.
- Chấp nhận: test mô phỏng worker delegate gặp lỗi limit, recovery không tìm được target → `onDelegateDone` được gọi với kết quả failed, hàng đợi chạy tiếp.

**A2. Không Stop được trong lúc chờ retry. — Cao**

- Vấn đề: chat được đặt idle (~`:1650`) nên `isRunning` false, nút Stop không có đích. `setTimeout` (~`:460`) không lưu handle; chỉ gửi tin mới mới hủy được.
- Sửa: lưu handle timer + `AbortController` trong record recovery của session. Trong thời gian chờ, composer coi chat là đang chạy (hiện nút Stop). `stopTurn(sessionId)` hủy timer, xóa record, gọi `finalizeTurn(sessionId, 'stopped')`.
- Chấp nhận: test với fake timer — bấm stop trong lúc chờ → không có `send` nào được gọi sau đó.

**A3. Hàng đợi bị giữ trong lúc recovery. — TB**

- Vấn đề: dispatch (~`:1662-1678`) không gọi `sendNextQueued`. Tin người dùng xếp hàng chờ 3–12 s rồi chạy sau continuation ẩn, có thể mâu thuẫn với nội dung continuation.
- Sửa: nếu có tin người dùng trong hàng đợi khi recovery bắt đầu, ưu tiên tin đó (hủy continuation ẩn, vì tin mới đã reset `recoveries` ở `sending.svelte.ts:~659`). Nếu không có, giữ hành vi hiện tại.
- Chấp nhận: test — lỗi transient + có một tin trong hàng → tin đó được gửi, continuation không được gửi.

**A4. Continuation cũ có thể bị gửi muộn/gửi trùng. — TB**

- Vấn đề: prompt continuation được dựng trước khi gọi `send`. `send` có thể hoãn qua `waitForCredential(...).then(send)` (`sending.svelte.ts:~571`) hoặc `afterSwitch` (`:~611`) mà không kiểm tra lại `recoveries[sessionId] === state`. Nếu lượt của người dùng chạy xong ở giữa, continuation cũ với `lastRequest` cũ vẫn chạy.
- Sửa: record recovery mang `generation` (số tăng dần). Mọi send ẩn từ recovery truyền `generation`; trước khi thực sự dispatch (sau mọi `await`), kiểm tra generation còn khớp, nếu không thì bỏ.
- Chấp nhận: test — hoãn send qua credential lane, trong lúc đó gửi tin người dùng → continuation bị bỏ.

**A5. Fallback có thể ở lại cùng provider/tài khoản đang bị limit. — Cao**

- Vấn đề: route có khóa `provider|model|effort` (~`:246`), `nextAgent` chỉ loại đúng khóa đó. Sau lỗi limit của Claude, chuỗi có thể nhảy sang `claude|sonnet` hoặc `claude|opus|low` cùng tài khoản; cache usage chưa cập nhật nên `agentHasRoom` vẫn true → lỗi lại và tốn một hop `MAX_HOPS`. Prompt "taking over" cũng sai trong trường hợp này (`same = action !== 'fallback'`, ~`:474`).
- Sửa: với lỗi `limit`/`auth`, loại mọi route có cùng credential scope (dùng helper ở D1/Phase 1 nếu đã có; tạm thời so `provider` và với custom thì so `providerId`). Lỗi `transient`/`other` vẫn có thể thử model khác cùng provider.
- Chấp nhận: test `availableRecoveryRoutes`/`nextAgent` — sau limit trên `claude|opus`, route kế tiếp không phải `claude|*`.

**A6. Model fallback của CLI làm lệch danh sách `tried`. — TB**

- Vấn đề: `noteModelFallback` (~`:366-376`) đổi `session.model` giữa turn → `currentRecoveryRoute` tạo khóa mới, tốn thêm một mục trong `tried` và điểm bắt đầu chuỗi (`indexOf = -1`) quay về đầu.
- Sửa: route hiện tại của recovery lấy từ `reply.agent/reply.model` của lượt đã chạy (xem D2), không lấy từ `session.model` đã bị đổi; hoặc ghi cả route gốc lẫn route CLI tự đổi vào `tried`.

**A7. Retry/fallback làm mất ảnh và file đính kèm. — Cao**

- Vấn đề: `lastRequest` (~`:774`) chỉ giữ text.
- Sửa: lưu cả attachment refs (ảnh, file) của tin gốc trong record recovery và truyền lại khi gửi continuation. Nếu provider đích không nhận ảnh, giữ hành vi hiện có của send cho provider đó (không tự chế).

**A8. Hai bản `forgetUnstartedConversation`. — Cao**

- `events.svelte.ts:~790` và `turns.svelte.ts:~379`. Gộp còn một (để ở `turns.svelte.ts` hoặc module conversation riêng), các nơi gọi dùng chung.
- Đồng thời: khi fallback rời khỏi một route, xóa id hội thoại chưa bắt đầu của route đó (hiện chỉ retry mới xóa), để khi quay vòng lại không resume một hội thoại không tồn tại.

**A9. Lỗi `NO_CONVERSATION` bị coi là `other` và retry. — Chưa chắc**

- Kiểm tra: khi resume một id không tồn tại, lỗi có đi vào nhánh retry vô ích không. Nếu có: phân loại riêng, xóa id rồi gửi lại như hội thoại mới kèm digest.

**A10. Codex có thể phát hai lỗi cho một turn. — Chưa chắc**

- `crates/adapters/src/agent/codex_server.rs:~428-441`: notification `error` không có `willRetry` và `turn/completed` thất bại đều phát `turn.failed`. Hiện chỉ không gây hại vì `replies` đã bị xóa. Sửa: adapter chỉ phát một lần cho mỗi turn id (cờ `failed_emitted`).

### Nhóm B — Sub-agent

Tệp chính: `crates/adapters/src/agent/*.rs`, `apps/desktop/src-tauri/src/{copilot.rs,opencode_serve.rs}`, `apps/desktop/src/lib/chat/session/events.svelte.ts`, `activity.svelte.ts`, `work.svelte.ts`, `apps/desktop/src/lib/chat/content/agent-reply.ts` (tìm lại vị trí bằng `applyAgentEvent`, `updateHistoricalTask`).

**B1. Sub-agent của Antigravity (agy) treo "running" vĩnh viễn trong Work tray. — Cao**

- Vấn đề: event start dùng id là chỉ số bước (`antigravity.rs:~620-631`, `id: index.to_string()`), event done dùng `conversation_id` (`:~767-772`). Card transcript khớp theo `tool_use_id` nên đóng được; activity (`activity.svelte.ts:~573-583`) so `nativeTaskId` → tạo thêm dòng "done" mới, dòng cũ giữ trạng thái background.
- Sửa: start và done dùng cùng một `id` (đề xuất: `call`/index của bước). Đưa `conversation_id` vào field riêng (vd. `summary` hoặc field mới nếu đã có Phase 4) — không dùng làm id. Nếu một bước liệt kê nhiều `subagents[]`, xem B6.
- Chấp nhận: mở rộng test fixture `antigravity.rs` (~`:1077`, fixture `crates/adapters/tests/fixtures/agy/subagent.jsonl`) để khẳng định id của Started và Done trùng nhau.

**B2. Codex không đóng child thread khi turn cha kết thúc. — Cao**

- Vấn đề: `codex_server.rs:~761-781` return khi parent Done/Error mà không kết thúc các child còn mở; notification muộn bị drain bỏ (~`:596`).
- Sửa: giữ danh sách child đang mở theo turn; khi parent kết thúc, phát `Task { status: Stopped/Done }` (dùng trạng thái hiện có gần nghĩa nhất — "detached" nếu có, nếu không là stopped) cho mỗi child còn mở trước khi phát Done của parent.

**B3. Progress đến muộn sau Stop mở lại card. — Cao**

- Vấn đề: `stopChatWork` đặt task card = `stopped` (`turns.svelte.ts:~483`), nhưng guard event muộn trong `agent-reply.ts` (~`:61`, `:218`) chỉ bỏ qua khi `done`/`failed`.
- Sửa: thêm `stopped` vào cả hai guard. Kiểm tra tương tự trong `activity.svelte.ts`.
- Chấp nhận: test `tests/agent-reply.test.ts` — stop rồi nhận progress → trạng thái vẫn `stopped`.

**B4. Text của sub-agent không được gom batch → giật. — Cao**

- Vấn đề: `STREAMED` trong `events.svelte.ts:~1024-1028` chỉ có `delta`, `thinking`, `tool_output_delta`. Event `scoped` bọc delta của child được áp ngay từng token: tìm card cha, nối chuỗi output 20 KB (`activity.svelte.ts:~431-434`), và effect Work tray (`work.svelte.ts:~71-90`) dựng lại danh sách tới 1000 mục + `JSON.stringify`.
- Sửa: coi `scoped` có event con thuộc loại streamed là streamed (gom cùng `COALESCE_MS`, giữ thứ tự). Trong `work.svelte.ts`, bỏ `JSON.stringify` so sánh, chỉ chiếu lại khi trạng thái/nhãn đổi, không chiếu lại theo từng delta output.
- Chấp nhận: đo trong `pnpm dev` với Codex/Copilot chạy 2+ sub-agent song song: không còn khung hình > 50 ms do `handleEventNow` (ghi số liệu trước/sau trong PR). Xem memory: profile app thật qua WebView2 CDP cổng 9222.

**B5. Event con bị rơi hoặc gắn nhầm cha. — TB**

- `agent-reply.ts:~199-209`: event con đến trước card cha bị bỏ không log → giữ lại trong buffer theo `parent` (giới hạn số lượng/thời gian), áp khi card cha xuất hiện; log `console.warn` nếu hết hạn.
- `codex_server.rs:~170-176`: đoán cha bằng `unresolved.last()`, sai khi hai spawn chạy song song → ghép theo id call trong notification nếu có; nếu giao thức không cho, ghi rõ giới hạn bằng comment và test.
- `copilot.rs:~638-647`: fallback về agent id không bao giờ khớp card → dùng tool call id.

**B6. Một card chỉ giữ một task. — TB**

- Codex có thể sinh nhiều child trong một spawn; agy liệt kê `subagents[]`. Tất cả dùng chung `call.task`, Done đầu tiên đóng băng nó (`agent-reply.ts:~215-238`). Sửa tạm ở Phase 0: card giữ map `tasks[id]`, trạng thái card = tổng hợp (running nếu còn child chạy). Giải pháp chính thức ở Phase 4.

**B7. Tail làm mất event kết thúc task. — TB**

- `crates/adapters/src/agent/tail.rs:~340-358`, `:~377-389`: giữ Task event cho tới khi CLI viết nội dung thật, bỏ im lặng các event vượt 64, bỏ event đang giữ khi park process; khi drop process thì đóng reply nhưng không phát end cho task đang mở.
- Sửa: khi park/drop, flush các Task đang giữ và phát end (stopped) cho task còn mở. Khi vượt 64, log `tracing::warn!` và giữ các event Done/Failed (ưu tiên giữ event kết thúc, bỏ progress).

**B8. `stall.rs` thiếu tên tool sub-agent. — Cao**

- `crates/adapters/src/agent/stall.rs` (`starts_sub_agent`, ~`:37`) không có `invoke_subagent`, `browser_subagent`, và `task` của Copilot → sub-agent im lặng bị áp giới hạn 2 h thay vì 20 phút. Thêm vào (một dòng). Phase 1/4 sẽ gom thành một hàm.

### Nhóm C — Delegate

Tệp chính: `apps/desktop/src-tauri/src/delegate.rs`, `apps/desktop/src/lib/chat/session/delegate-task.svelte.ts`, `delegation.svelte.ts`, `apps/desktop/src/lib/tasks/delegate-task.ts`, `apps/desktop/src/lib/agents/agent.ts`.

Bối cảnh: tool MCP khai báo ở `delegate.rs:45-91`; lời gọi được giữ trong `PENDING` (oneshot, id `dlg-N`, `:276-281`), emit `agent-delegate`, chờ tối đa `timeout_s + 60 s` (`:224-234`). Webview: `onDelegateCall` → `startTask` (`delegate-task.svelte.ts:~378-764`) → `requestTaskSlot` (`:~788-818`, gate cap 4 ở `delegate.rs:~400-456`) → worker chạy → `onDelegateDone` → `finishTask` (`:~1042-1143`) → `delegate_reply` (wait=true) hoặc `deliverReport` → `backlog` → `flushReports` (wait=false).

**C1. Giá trị trả về của `delegate_reply` bị bỏ qua → report mất im lặng. — Cao**

- `agent.ts:~577`, `delegate-task.svelte.ts:~1127`. Nếu Rust đã bỏ lời gọi (timeout dự phòng, client MCP của CLI đóng kết nối) thì report hoàn tất biến mất.
- Sửa: nếu `delegate_reply` trả về false (hoặc lỗi), chuyển sang `deliverReport` để đưa vào backlog và hand-back cho chat cha.

**C2. Pause chỉ dừng timer bên TS. — Cao**

- Pause xóa timer TS (`:~1198`) nhưng `tokio::time::timeout` của Rust (`delegate.rs:~361`) vẫn chạy → pause lâu hơn timeout trả lỗi cho chat cha rồi abort task đang pause (`:~1528-1529`).
- Sửa: thêm lệnh Tauri `delegate_extend(id, extra_s)` hoặc cặp `delegate_pause(id)`/`delegate_resume(id)`; Rust dùng deadline có thể dời (`tokio::time::Sleep::reset` hoặc vòng `select!` với kênh điều khiển). Đăng ký permission tương ứng trong `src-tauri/permissions` như các lệnh `delegate_*` khác.

**C3. Đồng hồ timeout bắt đầu quá sớm. — Cao**

- Timer bắt đầu khi tạo task (`:~628`), trước khi có slot và trước khi `depends_on` xong.
- Sửa: bắt đầu timer khi task chuyển sang `running`. Phía Rust: khi task đang chờ slot/phụ thuộc, gia hạn deadline (dùng cơ chế C2).

**C4. Gate "fail-open" trong TS. — Cao**

- `enterWorkerSlot(...).catch(() => true)` (`:~801`, `:~1231`) cấp slot mà Rust không ghi nhận. Lỗi của `releaseWorkerSlot` bị nuốt mọi nơi → slot rò cho tới khi reload.
- Sửa: lỗi `enterWorkerSlot` → thử lại một lần, sau đó đánh dấu task `failed` với lý do rõ ràng (không tự cấp slot). Lỗi `releaseWorkerSlot` → log và thử lại; `delegate_ready` khi reload vẫn reset gate như hiện tại.
- Lưu ý: comment Rust nói `GATE` khi poisoned "stays fail-open" — giữ nguyên hành vi Rust, chỉ bỏ fail-open ở TS.

**C5. Fallback sang custom provider làm hỏng `continue=`. — Cao**

- `moveChatTo` đặt `task.agentId = agent` (`events.svelte.ts:~437`) → thành `'custom'`, không phải id dòng → `continue=<task>` sau đó thất bại ở `findAgent` (`delegate-task.svelte.ts:~475-481`, `tasks/delegate-task.ts:~135`).
- Sửa: lưu id provider thật (cùng định dạng mà `findAgent` chấp nhận, vd. id của custom provider).

**C6. Fallback bỏ qua kiểm tra rò rỉ free-tier. — TB**

- `privateContentIn` chỉ chạy lúc start (`delegate-task.svelte.ts:~547`); chuỗi fallback (`events.svelte.ts:~232-247`) không lọc provider bị hạn chế. Prompt của worker là tin người dùng, `run.svelte.ts:~838-842` vẫn gửi tới provider bị hạn chế.
- Sửa: với chat là worker delegate, lọc route bị hạn chế khỏi chuỗi fallback, hoặc chạy lại `privateContentIn` trước `moveChatTo`. Xác nhận bằng test trước.

**C7. Task được khôi phục sau restart không báo cho chat cha. — Cao**

- `backlog` không được lưu. Khi khởi động lại, task đang chạy và report chưa giao bị đánh dấu "stopped" (`:~157-171`), chat cha không bao giờ được báo, trái với mô tả tool "is delivered to you anyway" (`delegate.rs:~72`).
- Sửa Phase 0 (tạm): khi khôi phục, với mỗi task chưa giao report mà chat cha còn tồn tại, đưa một report "stopped: app restarted" vào backlog. Lưu `backlog` cạnh `delegate.tasks` (cùng cơ chế persist). Giải pháp đầy đủ ở Phase 5.

**C8. Worker đang recovery thì chat cha chỉ thấy "Still working". — TB**

- `onDelegateDone` bị bỏ khi worker đang recovery (`events.svelte.ts:~1589`). Sau A1 (`finalizeTurn`), khi recovery kết thúc thất bại thì cha được báo. Thêm: gửi một check-in trạng thái "recovering: <lý do>" để cha biết (dùng kênh watchdog check-in sẵn có).

**C9. `task_stop` không lan xuống cháu. — TB**

- Lan truyền chỉ theo `delegateRuns` có `run.main === sessionId` (`turns.svelte.ts:~541-557`); cháu gắn vào run của gốc (`:~610-612`) → `task_stop` trên con để cháu `wait=false` chạy tiếp, report đi vào chat worker không có ai chờ, tạo hand-back mồ côi (`delegate-task.svelte.ts:~1135-1142`, `:~1281`).
- Sửa: lan truyền theo cây `caller → childId` (dùng caller của task record). Dừng một worker → dừng mọi hậu duệ; report của hậu duệ đã bị dừng thì bỏ, không tạo hand-back.

**C10. Abort lời gọi `task_ask` dừng cả task. — TB**

- `:~1516-1526`: kết nối MCP của CLI worker rớt khi đang hỏi → dừng cả task. Sửa: chỉ hủy câu hỏi đang chờ, task giữ `running`; nếu worker thật sự chết thì watchdog xử lý.

**C11. Hằng số và parse đối số bị chép đôi. — Cao**

- Cap 4 (`tasks/delegate-task.ts:7` và `delegate.rs:~396`), thời gian chờ câu hỏi 15 phút (`:~934` và `delegate.rs:~27`), giới hạn timeout; parse đối số ở `delegate.rs:~137` và `tasks/delegate-task.ts:~33`. Sửa Phase 0: Rust là nguồn; TS đọc qua một lệnh `delegate_limits` lúc init (hoặc sinh hằng số bằng specta). Ít nhất thêm test so khớp hai bên.

**C12. Cờ `background` không nhất quán. — Cao**

- `custom_chat.rs:~976-977` đặt `background = true` cho cả `wait=false` và `wait=true`; các adapter khác chỉ đánh dấu lời gọi chờ (`adapters/src/agent/mod.rs:~496`, `claude.rs:~628`). Sửa cho custom_chat giống các adapter khác, và gom logic vào một hàm dùng chung trong `adapters/src/agent/mod.rs`.

**C13. Gate là theo từng chat → nổ số worker. — TB**

- Mỗi chat worker là một "owner" riêng nên với độ sâu 4 có thể tới ~4⁴ CLI chạy cùng lúc (`delegate.rs:~407`, `:~419`). Sửa: gate theo chat gốc (root của cây) + một cap toàn cục cấu hình được. Cần chủ dự án xác nhận con số cap trước khi đổi hành vi; trong PR, đưa ra số đề xuất.

### Nhóm D — Routing và đổi model/provider/connector

Tệp chính: `apps/desktop/src/lib/chat/session/{turns,sending,run,state,events}.svelte.ts`, `apps/desktop/src/lib/agents/{models.svelte.ts,connectors.svelte.ts,account-epoch.svelte.ts}` (tìm `account-epoch`), `apps/desktop/src/lib/components/chat/{Composer,ModelPicker}.svelte`.

**D1. Một helper `credentialScope`. — Cao**

- Ánh xạ agent → scope bị chép ~6 lần (`sending.svelte.ts:~564`, `events.svelte.ts:~490, ~525, ~565, ~1431`, `run.svelte.ts:~316`); bản trong `prewarmChat` không xử lý custom provider. Antigravity có 3 tên: lane `agy`, epoch `antigravity`, busy `switch:agy`.
- Sửa: tạo `credentialScope(agent, model): string` (vd. `apps/desktop/src/lib/agents/credential-scope.ts`, thuần, có test). Trả về `agy` cho antigravity, `custom:<providerId>` cho custom. Dùng cho lane, epoch, busy key, auto-switch.
- Hệ quả trực tiếp: `switchingAgent('antigravity')` (`turns.svelte.ts:~340`) kiểm tra `switch:antigravity` nhưng lock tên `switch:agy` (`connectors.svelte.ts:~988`) → bước chờ không bao giờ có hiệu lực. Sửa bằng helper này. — Cao.

**D2. Đường xử lý lỗi đọc model hiện tại thay vì model của lượt đã chạy. — Cao**

- Đổi model giữa turn được phép (ModelPicker không có guard; `Composer.svelte:~497` ghi ngay). Khi lỗi, code đọc `session.agent/model`: scope auto-switch (`events.svelte.ts:~1426-1446`), xoay key (`:~538-570`), nhãn recovery (`:~1468`), `forgetUnstartedConversation` (`:~789-801`), `noteModelFallback` (`:~366-370`) → có thể xoay nhầm tài khoản/key của provider khác.
- Sửa: tất cả các nơi trên dùng `reply.agent`/`reply.model` (route của lượt đang kết thúc). Nếu reply chưa lưu đủ (providerId của custom), thêm vào lúc tạo reply.
- Chấp nhận: test — turn chạy trên Codex, người dùng đổi sang Claude giữa chừng, Codex lỗi limit với auto-switch bật → scope xoay là codex.

**D3. Đổi model/provider khi đang chạy: hoãn tới khi turn kết thúc. — Cao**

- Sửa: khi chat đang chạy, thay đổi picker được ghi vào `pendingSwitch[sessionId]` và áp khi turn kết thúc (hiển thị trong picker là "sẽ áp sau lượt này"). Không chặn UI.

**D4. `modelFor` vừa ghi state vừa không chờ danh sách model. — Cao**

- `turns.svelte.ts:~608-630`. Trước khi danh sách live tải xong, send/prewarm thay model đã lưu (không có trong danh sách khởi đầu) bằng model đầu tiên. Trong `reloadModels` sau khi đổi tài khoản, danh sách bị làm rỗng (`models.svelte.ts:~419-427`) → `modelFor` trả `null` → turn chạy model mặc định của CLI và `conversationModel` bị xóa (`run.svelte.ts:~539`).
- Sửa: `modelFor` thuần (không ghi). Nếu `modelsReady[provider]` chưa true → dùng model đã lưu như cũ (tin model đã lưu). `reloadModels` giữ danh sách cũ cho tới khi danh sách mới về (thay thế nguyên khối, không làm rỗng trước).

**D5. Race khi đổi tài khoản: `busy` được nhả trước khi epoch/warm reset xong. — TB**

- `task()` xóa `busy` trong `finally` (`connectors.svelte.ts:~566`) trước khi `accountSwitched` chạy (`:~1328`, `:~1000`). Effect flush `afterSwitch` (`turns.svelte.ts:~343-359`) có thể gửi trước với epoch cũ và CLI ấm cũ. Reset warm là dynamic import async (`account-epoch.svelte.ts:~23`).
- Sửa: trong hàm đổi tài khoản, `await` bump epoch + reset warm (import tĩnh hoặc await import) **bên trong** `task()` trước khi nhả `busy`.

**D6. Epoch tài khoản đọc là 0 trước khi số đếm tải xong. — TB**

- `account-epoch.svelte.ts:~10-18`: turn sớm thấy "đổi tài khoản" không có thật → mở hội thoại mới, rồi lại mở mới khi số đếm tải xong. Sửa: `startTurn`/`prewarmChat` chờ promise tải số đếm (có timeout ngắn) trước khi so epoch; trước khi tải xong không coi là đổi.

**D7. Quyền và effort theo chat không được khôi phục sau reload. — Cao**

- Chỉ Composer đang mở ghi `chatTurnOptions` (`Composer.svelte:~375`) → turn nền (queue, recovery, `scheduleResume`) rơi về `turnOptions` toàn cục (`turns.svelte.ts:~298`). Chat nền đặt `ask` có thể chạy với `yolo` của chat đang mở.
- Sửa: khi tải session, nạp `chatTurnOptions` từ `composer.pickers` cho mọi chat. `turnOptionsOf(sessionId)` không bao giờ dùng giá trị của chat khác; nếu chat không có giá trị riêng thì dùng mặc định an toàn nhất (không dùng giá trị chat đang hiển thị).

**D8. Effort của fallback bị mất. — Cao**

- `moveChatTo` gửi `effort` (`events.svelte.ts:~425`, `:~441-450`) nhưng listener trong Composer bỏ qua (`Composer.svelte:~453-469`); effort picker đã lưu ghi đè `chatTurnOptions` sau đó. Sửa: listener áp cả `effort` và ghi vào `composer.pickers`.

**D9. Ba bộ tự sửa model tranh nhau. — Cao**

- Effect của ModelPicker (`ModelPicker.svelte:~135-143`, `~219-232`), `modelFor`, listener `agent-moved`. `currentSource` rơi về custom source đầu tiên hoặc `sources[0]` (claude) → connector bị xóa/tắt âm thầm thành connector khác, hoặc chat thành `agent='custom'` với model Claude.
- Sửa Phase 0: ModelPicker không tự ghi lại session; nếu source hiện tại không còn, hiển thị trạng thái "provider không khả dụng" và để người dùng chọn. Phase 3 bỏ hẳn (D-transition).
- Nhớ quy tắc `AGENTS.md`: `ModelPicker.svelte` và `ImageGenerator.svelte` phải sửa đồng bộ nếu đổi UI/thứ tự.

**D10. `prewarmChat` chép lại logic của `startTurn`. — Cao**

- `run.svelte.ts:~310-395` và `~460-600`. Phase 0: trích phần chọn id hội thoại thành một hàm dùng chung. Phase 3 thay bằng `resolveTurn`.

**D11. Custom provider dùng chung một khóa hội thoại. — Cao**

- Mọi custom provider dùng `agentIds.custom`/`agentModels.custom` (`state.svelte.ts:~100`); `accountEpoch` theo agent chứ không theo provider (`run.svelte.ts:~545-590`). Chuyển từ custom A sang B phải dựa vào heuristic "đổi model". Sửa: khóa theo `credentialScope` (D1), có migration đọc khóa cũ `custom` một lần.

**D12. Chat mới luôn có id `claude:<uuid>`. — Chưa chắc**

- `newSession` (`state.svelte.ts:~896-927`) đặt id `claude:${uuid}` và `agentSession = uuid` kể cả agent khác. Codex/Copilot nhận uuid của Claude; `resume=false` làm gần như vô hại. Kiểm tra Copilot trước khi sửa. Nếu sửa: không gán `agentSession` cho tới khi provider xác nhận id (`AgentEvent::Session`).

**D13. Đường custom bỏ `preface`/`context`. — Chưa chắc**

- `run.svelte.ts:~663-669`, `~816-875`: chỉ gửi `dispatchBody` nhưng vẫn xóa `forkContext`. Xác nhận có chủ ý hay không (fork chat sang custom provider có mất ngữ cảnh không). Nếu là lỗi: gửi kèm như các provider khác.

**D14. `RoutingProfile` chỉ được dùng trong xoay key custom. — Cao**

- Được lưu (`connectors.svelte.ts:~205-226`, `~2250`) và chỉ đọc ở `~2051-2090` khi sắp xếp key. Ghi rõ phạm vi trong UI cài đặt (đây là chiến lược xoay key), hoặc nối vào chọn route nếu chủ dự án muốn. Không tự mở rộng hành vi.

---

## Phase 1 — Một nguồn sự thật cho provider

Mục tiêu: thêm provider = thêm một mục descriptor + adapter, không phải sửa 20 nơi.

### 1.1 `ProviderDescriptor` registry

Tạo `apps/desktop/src/lib/agents/provider-descriptors.ts` (mở rộng `provider-registry.ts` đang có thay vì tạo song song — đọc `provider-registry.ts` trước, dùng skill/quy tắc tái sử dụng):

```ts
export type RuntimeKind = 'cli' | 'sdk' | 'http';
export type ProviderDescriptor = {
  id: ProviderId;                 // 'claude' | 'codex' | 'copilot' | 'opencode' | 'antigravity' | 'command-code' | 'workbuddy' | 'muse-code' | 'custom'
  label: string;
  icon: string;                   // key cho AgentLogo
  runtime: RuntimeKind;
  credentialScope: (model: string | null) => string; // xem D1
  accountConnector?: AccountConnectorId;             // 'agy' | 'claude' | ...
  liveModel: boolean;             // đổi model không cần hội thoại mới
  prewarm: boolean;
  namesOwnSession: boolean;       // provider tự sinh session id
  resume: boolean;
  modelSource: 'static' | 'live' | 'custom';
  effort: 'none' | 'levels' | 'budget';
  subAgentTools: readonly string[]; // tên tool tạo sub-agent (dùng cho stall/chat-work)
  inFallbackChain: boolean;
};
export const PROVIDERS: readonly ProviderDescriptor[] = [...];
```

- Sinh từ registry: `Agent`, `ProviderId`, `BuiltInAgent`, `AGENT_TEXT`, `AGENT_ICON`, `CLI_OF` (`events.svelte.ts:~180`), `CHAIN_AGENTS` (`ContinueSection.svelte:~20`), các danh sách trong `send()` (`sending.svelte.ts:~628-638`, `~676`), danh sách prewarm (`run.svelte.ts:~322`), `modelsReady`/`loadModels` (`models.svelte.ts:~361-381`), source rows (`:~202-252`), danh sách agent cứng trong `delegate-task.svelte.ts` (`:~258-266`, `:~497-506`).
- `liveModel` đang định nghĩa ở cả TS (`sending.svelte.ts:~860`) và Rust (`Provider::live_model`): Rust là nguồn, xuất sang TS cùng cách `endpoints.json` hoặc qua `ChatResponseCapabilities`.
- WorkBuddy vừa là agent CLI vừa là custom provider ẩn cùng id `workbuddy` (`connectors.svelte.ts:~1159-1203`, lọc ở `models.svelte.ts:~259`) → route `workbuddy|…` luôn đi CLI (`events.svelte.ts:~208`). Đặt id khác cho bản custom ẩn (vd. `workbuddy-api`) với migration.
- URL WorkBuddy và Muse Code đang hard-code ở TS và Rust: chuyển vào `apps/desktop/src/lib/agents/endpoints.json`.
- Cập nhật `docs/development/adding-agent-provider.md` theo checklist mới (ngắn hơn).

### 1.2 `ModelRef` — một định dạng model

```ts
export type ModelRef = { provider: string; model: string; effort?: string }; // provider = descriptor id hoặc custom providerId
export function parseModelRef(text: string): ModelRef | null;
export function formatModelRef(ref: ModelRef): string;
```

- Thay 4 cách mã hóa: `custom` + `pid::model` trong chat, `pid|model|effort` trong route, tiền tố `credit:`, tên model trần trong reply (đoán provider ở `provider-registry.ts:~108-121`).
- `modelLabel` (`models.svelte.ts:~442`) nhận `ModelRef`, không tìm qua mọi catalogue (id trùng như `gpt-5.6-terra` có ở cả Codex và WorkBuddy).
- Migration: đọc định dạng cũ khi tải session/route/pref, ghi định dạng mới. Có test cho mọi định dạng cũ.
- Danh sách model Claude đang ở cả `models.svelte.ts` và `crates/adapters/src/models.rs:~47-62`; giá ở cả `usage.ts` và `model_prices.rs`. Chọn Rust làm nguồn, xuất sang TS (specta hoặc JSON sinh ra).

### 1.3 Gom luật "đây là sub-agent"

- Một hàm Rust `classify_child(tool_name, input) -> Option<ChildKind>` trong `crates/adapters/src/agent/mod.rs`, thay các chỗ: `claude.rs:~323`, `antigravity.rs:~700`, `opencode.rs:~23` (và `~447/449/479` — đường CLI chỉ kiểm `"subagent"` trong khi `is_subagent` nhận cả `"task"`), `copilot.rs:~382`, `stall.rs:~37`, `mod.rs:~539`.
- Frontend (`events.svelte.ts:~836`, `chat-work.ts:~68` regex `/agent|task|spawn/i`) đọc cờ từ event thay vì đoán lại.

Chấp nhận Phase 1: không đổi hành vi (refactor thuần). Toàn bộ DoD xanh. `git grep` không còn danh sách provider viết tay ngoài registry (liệt kê ngoại lệ còn lại trong PR).

---

## Phase 2 — Lỗi có cấu trúc

### 2.1 Rust phát lỗi có loại

Trong `crates/adapters/src/agent/mod.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind { RateLimited, QuotaExhausted, Auth, Missing, Transient, NoConversation, Stopped, Other }

AgentEvent::Error {
    message: String,
    kind: ErrorKind,
    status: Option<u16>,
    retry_after_ms: Option<u64>,
    reset_at: Option<i64>, // unix ms
}
```

- Mỗi adapter điền `kind` từ dữ liệu có cấu trúc khi có (HTTP status, mã lỗi JSON của CLI, `willRetry` của Codex `codex_server.rs:~428`, `is_retry_notice` `codex.rs:~68`); chỉ khi không có mới rơi về một hàm phân loại text dùng chung (chuyển regex từ `turn-failure.ts` sang Rust, giữ test).
- `crates/quota` hiện là stub: không cần dùng ở phase này.
- Sửa các phân loại sai đã biết:
    - "Service unavailable, try again in 5 seconds" đang bị coi là limit (`LIMIT` có `try again (?:at|in) \d`, `resets? in`) → phải là `Transient`.
    - HTTP 429 theo phút → `RateLimited` (retry có backoff, dùng `retry_after`), không phải `QuotaExhausted`.
    - `\b50[0234]\b`, `\b401\b` khớp bất kỳ số nào trong text → chỉ dùng khi là status thật hoặc ở dạng "HTTP 401"/"status 401".
    - Codex "Codex stopped the turn" (`codex_server.rs:~444`) → `Stopped`, không retry.
- `interrupt::stopped` (`interrupt.rs:~138`) đang biến Error thành Done: giữ, nhưng gắn `stopped_by_user: true` vào Done để frontend không phải đoán bằng thời gian (`userStoppedAt`, `events.svelte.ts:~964-969`).

### 2.2 Frontend một bộ phân loại

- `classifyFailure(event) -> { kind, retryAfterMs?, resetAt?, gate? }`, gọi **một lần** cho mỗi event lỗi và truyền kết quả xuống (hiện gọi 2–3 lần: `events.svelte.ts:~1426`, `~1466`, trong `recoveryFor`).
- Gộp: `NO_CONVERSATION` (`events.svelte.ts:~191`), `classifyLimitGate` (`limit-gate.ts:~13`), `parseResetAt` (`limit-reset.ts:~6`), `event.message === 'stopped'` (`events.svelte.ts:~1627`, `activity.svelte.ts:~635`).
- `planRecovery`: `RateLimited` → retry với backoff (không đổi provider, không kích hoạt auto-switch); `QuotaExhausted`/`Auth` → auto-switch nếu toggle bật, nếu không → fallback provider; `Transient` → retry.
- Cập nhật `turn-failure.test.ts` và thêm test Rust cho từng adapter với lỗi mẫu trong fixture.

Lưu ý tương thích: `AgentEvent` TS hiện viết tay ở `apps/desktop/src/lib/agents/agent.ts:~10-60`. Ở phase này thêm field mới vào type viết tay (optional), Phase 4 mới chuyển sang type sinh tự động.

---

## Phase 3 — State machine thuần cho recovery, delegate, turn

Nguyên tắc: reducer thuần `reduce(state, event) -> { state, effects[] }` trong file `.ts` không phụ thuộc Svelte/Tauri, test bằng node. Lớp `.svelte.ts` mỏng giữ `$state` và thực thi effect.

### 3.1 Recovery coordinator

Tạo `apps/desktop/src/lib/chat/recovery/coordinator.ts` (thuần) + `coordinator.svelte.ts` (adapter).

```
idle
  → retry_wait { until, generation }          (Transient/RateLimited)
  → switching_credential { candidates, tried } (QuotaExhausted/Auth + toggle bật)
  → fallback_pending { target: ModelRef }      (QuotaExhausted/Auth + toggle tắt, hoặc lỗi khác)
  → running { turnId, generation }
  → done | stopped | exhausted(resumeCard)
```

- Mỗi trạng thái chờ có `AbortController`; composer coi `retry_wait`/`switching_credential`/`fallback_pending` là đang chạy (Stop dùng được).
- `generation` được kiểm tra trước mọi dispatch (A4).
- Mọi trạng thái cuối đều phát effect `finalize` (A1).
- Lưu attachment của tin gốc (A7).
- `switching_credential` bao bọc logic auto-switch hiện tại (`runAutoSwitch`, `rotateCredential` trong `credential-switch.ts:~24`) — giữ đúng spec 2026-10-30: hết ứng viên → khôi phục credential gốc → `exhausted` với resume card, **không** sang provider khác.
- Thay thế: `recoveries`, `resumes`, `credentialAttempts`, `manuallyStopped`, `resumeAutoChoice`, `resumeSince`. `checkResumes` (poll 30 s, `events.svelte.ts:~771`) chuyển vào coordinator.
- Test bằng fake timers: abort trong lúc chờ; có tin trong hàng; target biến mất sau thời gian chờ; continuation cũ; worker delegate được finalize; auto-switch thành công; auto-switch hết ứng viên.

### 3.2 Delegate task state machine

Tạo `apps/desktop/src/lib/tasks/delegate-machine.ts` (thuần).

```
task:   queued → blocked(dep) → running ⇄ paused | awaiting_answer | awaiting_approval | recovering
                                 → done | failed | stopped | timed_out
report: pending → delivering → delivered | failed
```

- Thay các lần ghi `record.state` rải rác, trạng thái `'waiting'` bị dùng nhiều nghĩa, và các cờ trên `TaskRun`.
- Timer chạy chỉ ở trạng thái `running` (C3); pause gửi effect `extendDeadline` sang Rust (C2).
- Hủy lan theo cây `caller → children` (C9).
- Test: dependency, pause/resume quá timeout, worker lỗi giữa chừng có recovery, restart app với report chưa giao, dừng con có cháu.

### 3.3 Turn resolution và chuyển đổi tường minh

- `resolveTurn(session): { ref: ModelRef, credentialScope, epoch, conversation: { id, resume, reason } }` — một hàm dùng cho cả `prewarmChat` và `startTurn` (D10).
- Khóa hội thoại theo `(credentialScope, model trừ khi liveModel)` thay cho `agentIds[agent]`/`agentModels[agent]` (D11). Migration từ khóa cũ.
- `switchChat(sessionId, ref, cause: 'user' | 'fallback' | 'auto-switch')`: điểm duy nhất thay đổi agent/model/effort của chat; hoãn khi đang chạy (D3).
- `SessionItem` là nơi duy nhất giữ picker. Bỏ bản sao `composer.pickers` (migration một lần), bỏ `window` events `agent-moved`, bỏ các effect tự sửa (D9). `chatTurnOptions` đọc từ `SessionItem`.
- Gộp `runStates`/`run-state.ts` (đang không phải nguồn sự thật — xem `docs/development/chat-flow-review-notes.md`) vào đây hoặc xóa; không để hai bộ trạng thái song song.

---

## Phase 4 — Một contract event cho sub-agent

### 4.1 Contract trong `crates/protocol`

Hiện có hai contract: `EventKind` trong `crates/protocol` (sinh TS bằng specta, `pnpm gen:types`) không có task/child; luồng thật dùng `AgentEvent` với type TS viết tay. Hợp nhất:

```rust
ChildStarted  { child_id, parent_call_id, kind: ChildKind /* agent | shell */, label, model }
ChildProgress { child_id, tools: Option<u32>, summary: Option<String> }
ChildEvent    { child_id, event: Box<AgentEvent> }
ChildEnded    { child_id, outcome: ChildOutcome /* done | failed | stopped | detached */, summary: Option<String>, usage: Option<Usage> }
```

- Thay `Task`, `Scoped`, `ToolModel` và cờ `background` (giữ đọc ngược tương thích trong một release nếu transcript cũ lưu event cũ — kiểm tra `history.svelte.ts` có lưu event thô không).
- Xóa type viết tay trong `agent.ts`, dùng type sinh tự động.
- Thống nhất cái gì thuộc child: hiện Claude bọc gần như mọi thứ (`claude.rs:~246`, gồm cả Error/Done/PermissionDenied/Session), Codex (`codex_server.rs:~90-100`) và Copilot (`copilot.rs:~720-735`) chỉ bọc text/thinking/tool. Quy tắc mới: `ChildEvent` chỉ chứa text, thinking, tool call, tool result; kết thúc của child luôn là `ChildEnded`; usage của child nằm trong `ChildEnded.usage` (Codex hiện bỏ usage của child ở `codex_server.rs:~318`).

### 4.2 `ChildRegistry` trong adapters

Một struct theo turn, dùng chung cho mọi adapter, bảo đảm:

1. `ChildStarted` luôn đến trước mọi `ChildEvent`/`ChildEnded` của cùng `child_id`.
2. Mỗi child kết thúc đúng một lần, kể cả khi parent kết thúc, stop, kill, park, drop (thay B2, B7).
3. Event của child đến trước khi biết cha được giữ lại tới khi biết (B5).

### 4.3 Chuyển code provider về `crates/adapters`

- Copilot (`src-tauri/src/copilot.rs:~325-422`, `~614-735`) và OpenCode server (`src-tauri/src/opencode_serve.rs:~543-600`): chuyển phần map event vào `crates/adapters` (phần quản lý process/pool có thể ở lại `src-tauri`).
- Codex app-server: map thẳng notification → `AgentEvent`, bỏ bước dựng lại JSON của `codex exec` rồi parse lại (`codex_server.rs:~378-383`).

### 4.4 Một child reducer ở frontend

- Reducer thuần khóa theo `(session, child_id)`. Card transcript, activity log, lanes và Work tray đều đọc từ đây.
- Bỏ `updateHistoricalTask` (`agent-reply.ts:~51-77`, bản chép của case task trong `applyAgentEvent`), `backgroundTools` (set trộn id tool call và id task), so khớp `nativeTaskId`.
- Card hỗ trợ nhiều child (B6).

### 4.5 Test hợp đồng theo provider

Fixture log ghi sẵn cho từng provider (Claude, Codex, Copilot, OpenCode, agy, Command Code): nhiều child trong một call, child lồng nhau, stop khi child đang chạy. Mỗi test khẳng định: mỗi child kết thúc đúng một lần; mọi `ChildEvent` có cha đã biết; không child nào còn mở sau khi turn kết thúc.

Chưa xác minh (ghi lại khi làm): Claude sub-agent có stream text từng phần không; chỉ số bước agy có reset giữa các turn không; `turn/interrupt` của Codex có dừng child thread không.

---

## Phase 5 — Tách file lớn, chuyển sở hữu delegate sang Rust

### 5.1 Tách `events.svelte.ts` (~1741 dòng)

- `chat/session/intake.svelte.ts`: nhận envelope, batching, lọc lượt cũ (stale turn).
- `chat/session/reply-reducer.ts`: áp event vào reply (thuần).
- `chat/session/lanes.svelte.ts`: state machine lane.
- `chat/session/activity-projection.ts`: chiếu activity.
- Recovery đã ra ở Phase 3.
  `handleEventNow` chỉ còn điều phối.

### 5.2 Tách `delegate-task.svelte.ts` (~1531 dòng)

- `delegate-catalog.ts` (danh sách agent, routing — sinh từ registry Phase 1)
- `delegate-scheduler.svelte.ts` (client gate, dependency)
- `delegate-reports.svelte.ts` (backlog, flush, lưu bền)
- `delegate-ask.svelte.ts` (hỏi/đáp)
- `delegate-watchdog.svelte.ts`
- `delegate-bridge.svelte.ts` (listener + init gọi tường minh, không side effect khi import — hiện có ở `:~153`, `:~1507-1531`)

Phá vòng import `delegate-task` ↔ `events` ↔ `turns` ↔ `run` ↔ `sending` bằng cách cho các module dưới phát sự kiện/callback thay vì import ngược.

### 5.3 Rust sở hữu delegate (dài hạn)

- Rust giữ task record, deadline, gate, hàng report, và lưu bền chúng. Dùng lại `crates/orchestrator` (đã có state machine run/step/attempt với `WaitingInput`, `Cancelled`; hiện không crate nào phụ thuộc, chỉ khai báo ở `Cargo.toml:~36`).
- Event Rust → webview có ack hoặc replay: khắc phục race khi `agent-delegate` được emit trước khi `listenDelegateCalls` đăng ký (`delegate-task.svelte.ts:~1509-1510`) hoặc trong lúc reload (lời gọi treo tới 7260 s).
- Webview chỉ chiếu trạng thái và chạy lượt chat. Bỏ hằng số chép đôi (C11).
- Khi app restart: report "stopped: app restarted" tự động gửi cho mọi chat cha còn sống.

### 5.4 Việc nhỏ còn tồn từ các ghi chú cũ (làm trong phase phù hợp)

Từ `docs/development/chat-flow-review-notes.md`:

- `persistLocal()` được gọi không có session id ở mọi nơi → mỗi lần lưu serialize toàn bộ chat local; `dirtyChats` gần như không dùng. Sửa: truyền session id, chỉ lưu chat bẩn.
- `work.svelte.ts` chiếu lại toàn bộ công việc nền mỗi delta (xem B4).
- `callerOf` có thể chọn nhầm chat khi nhiều chat chạy và link không ghi tên chat.
- Xóa entry `activeWorkflowByMain` trong `finishWorkflowIntegration` khi run kết thúc.
- Send bị hoãn (`waitForCredential`, `afterSwitch`) nên hiện thành một mục hàng đợi có thể hủy.
- `bindTasks`/`originatingRun` đoán theo khớp text của task (`delegate-task.svelte.ts:~338-365`, `~563-573`) → dùng tool-call id.

---

## Phase 6 — Brief, danh sách bước và report của sub-agent/worker

Mục tiêu: worker (task delegate) và sub-agent làm việc theo kiểu Claude Code:

- nhận một brief rõ ràng;
- liệt kê các bước và cập nhật trạng thái từng bước khi làm (chat cha thấy được tiến độ);
- trả về chat cha một report đầy đủ, có cấu trúc: trạng thái, các bước, thay đổi, bằng chứng, kết quả kiểm tra, việc còn mở.

Tài liệu này (cấu trúc mục, ID, file, vấn đề, cách sửa, điều kiện chấp nhận) là mẫu tham khảo cho mức chi tiết mong muốn.

### 6.0 Hiện trạng (đã đọc code, độ tin cậy Cao)

- **Brief (cha → worker):** chỉ có một chuỗi `task` tự do (schema ở `apps/desktop/src-tauri/src/delegate.rs:~49-66`). Hướng dẫn viết brief nằm rải trong mô tả tool `delegate_task` (`delegate.rs:~48`) và `DELEGATE_HINT` (`apps/desktop/src/lib/tasks/delegate-task.ts:~444`): "self-contained goal, paths/resources, constraints and evidence-first handoff". Không có khuôn mẫu, không có kiểm tra.
- **Prompt cho worker:** `delegate-task.svelte.ts:~685-686` ghép câu mở đầu + `REPORT_RULE` + quy tắc ngôn ngữ.
- **Report (worker → cha):** `REPORT_RULE` (`tasks/delegate-task.ts:~238`) yêu cầu `## Handoff` ≤600 từ, "telegraphic", gồm các dòng `STATUS: done|blocked / RESULT / FILES / FACTS / OPEN`. Có ba chỗ lệch nhau:
    - `parseHandoff` (`:~207`) đọc thêm `VERIFY` và `needs-plan-change`, nhưng rule không yêu cầu hai trường này;
    - `handbackPrompt` (`sending.svelte.ts:~103`) dò `VERDICT: FAIL`, một trường không có trong rule;
    - cả report bị nén thành một khối chữ: `RESULT` là văn bản rút gọn, không có danh sách bước, không có kết quả lệnh kiểm tra.
- **Cắt report:** `reportDigest` cắt ở `DIGEST_MAX = 4800` ký tự. Nếu worker không viết `## Handoff`, chỉ giữ **phần cuối** của câu trả lời (`…${clean.slice(-DIGEST_MAX)}`), có thể mất phần quan trọng ở đầu. `handbackPrompt` cắt thêm ở `HANDBACK_ANSWER_MAX = 8000`.
- **Hand-back cho cha:** `handbackPrompt` chỉ ghép `### <label>\n<text>`. Không có agent/model, verdict, thời gian, số tool, file đã sửa, lệnh đã chạy.
- **Hiển thị:**
    - `TaskCards.svelte:~156` in report thô trong `<p class="whitespace-pre-wrap">`;
    - dòng tóm tắt (`:~100`) lấy `firstLine(card.report)`, thường ra `STATUS: done` thay vì nội dung;
    - danh sách bước của worker (TodoWrite / `update_plan` / `Plan`, parse bởi `planOf` trong `chat/content/blocks.ts:~21`, vẽ bởi `PlanCard.svelte`) chỉ hiện trong chat của worker. Card ở chat cha, Work tray (`BackgroundTasks.svelte`) và `DelegateList.svelte` không thấy tiến độ.
- **Sub-agent native** (Task của Claude, spawn của Codex…): AgentDeck không viết brief cho chúng. Kết quả chỉ hiện qua `Task.summary`.

### 6.1 Định dạng chuẩn (nguồn sự thật duy nhất)

Tạo `apps/desktop/src/lib/tasks/handoff-format.ts`. File này là nguồn duy nhất cho khuôn brief, khuôn report, parser và formatter. `REPORT_RULE`, `parseHandoff`, `handoffOf`, `reportDigest` chuyển vào đây (hoặc re-export từ `tasks/delegate-task.ts` để không vỡ import cũ).

**Khuôn brief** (cha viết, AgentDeck bọc lại khi gửi cho worker):

```
## Brief
GOAL: <một câu: kết quả cần có>
CONTEXT: <những gì đã biết / đã loại trừ; worker không thấy hội thoại của cha>
SCOPE: <file/thư mục được đọc; file được sửa (write scope) hoặc "read-only">
CONSTRAINTS: <quy tắc dự án, những gì không được đụng>
DONE WHEN: <điều kiện hoàn thành kiểm chứng được: lệnh, test, đầu ra>
```

**Khuôn report** (worker viết ở cuối câu trả lời). Tên mục luôn bằng tiếng Anh để parser đọc được; nội dung viết theo ngôn ngữ của người dùng (giữ `WORKER_LANGUAGE_RULE_BASE`).

```
## Handoff
STATUS: done | partial | blocked | needs-plan-change | failed
SUMMARY: <1–3 câu, trả lời thẳng GOAL>

### Steps
- [x] <bước> — <kết quả>
- [ ] <bước chưa xong/bỏ> — <lý do>

### Changes
- `path/to/file` — <đổi gì> (hoặc "none (read-only)")

### Evidence
- `path:line` — <sự thật quan sát được>

### Verify
- `<lệnh>` → <kết quả thật: pass/fail, số test, lỗi ngắn nhất>  (hoặc "not run: <lý do>")

### Open
- <rủi ro / câu hỏi / việc còn lại, ≤5 mục>
```

Quy tắc trong `REPORT_RULE` mới:

- Không bịa kết quả kiểm tra. Lệnh chưa chạy thì ghi "not run".
- `partial` nghĩa là có phần đã xong và dùng được; `blocked` nghĩa là không đi tiếp được nếu thiếu quyết định hoặc tài nguyên.
- Report đầy đủ nhưng không lặp lại brief và không có câu đệm.
- Bỏ yêu cầu "telegraphic".

Giữ ngắn: `REPORT_RULE` và `DELEGATE_HINT` được gửi kèm mỗi prompt worker và lượt đầu mỗi chat. Đo số token trước và sau, ghi vào PR.

### 6.2 Các mục việc

**E1. `handoff-format.ts` + parser hai phiên bản. — Cao**

- `parseHandoff(answer)` trả về:

    ```ts
    type HandoffReport = {
        version: 1 | 2;
        status:
            | 'done'
            | 'partial'
            | 'blocked'
            | 'needs-plan-change'
            | 'failed'
            | 'unknown';
        summary: string;
        steps: { done: boolean; text: string; note?: string }[];
        changes: { path: string; note: string }[];
        evidence: string[];
        verify: { command: string; result: string; ok: boolean | null }[];
        open: string[];
        raw: string;
    };
    ```

- Đọc được cả định dạng cũ (`STATUS:/RESULT:/FILES:/FACTS:/VERIFY:/OPEN:` → `version: 1`, `RESULT` thành `summary`, `FILES` thành `changes`, `FACTS` thành `evidence`), vì transcript đã lưu vẫn chứa định dạng cũ.
- Bỏ dò `VERDICT: FAIL` trong `handbackPrompt`, dùng `status` từ parser. Vẫn giữ nhận dạng `VERDICT: FAIL` trong parser nếu workflow/reviewer còn sinh ra nó: tìm `VERDICT` trong `WorkflowView`/`delegation.svelte.ts` trước khi bỏ.
- Có `formatHandoff(report)` để tạo lại markdown chuẩn (dùng cho E5 và test).
- Test: bảng ca mẫu gồm định dạng mới, định dạng cũ, thiếu mục, heading viết thường, có code fence trong mục, nội dung tiếng Việt, report không có `## Handoff`.

**E2. Brief có cấu trúc trong `delegate_task`. — Cao**

- Thêm vào schema (`delegate.rs:~49-66`) các trường **tùy chọn**: `goal` (string), `scope` (array of string: path), `done_when` (string). `task` vẫn bắt buộc, để không vỡ lời gọi cũ.
- AgentDeck ghép prompt cho worker theo thứ tự: câu mở đầu (`delegate-task.svelte.ts:~686`), khối `## Brief` (từ các trường có giá trị, cộng `task`), `REPORT_RULE`, quy tắc ngôn ngữ.
- Parse đối số ở cả Rust (`delegate.rs:~137`) và TS (`tasks/delegate-task.ts:~33`). Liên quan C11: nếu chưa gộp thì sửa cả hai chỗ và thêm test so khớp.
- Sửa mô tả tool và `DELEGATE_HINT`: thay đoạn "self-contained goal, paths/resources…" bằng tham chiếu ngắn tới khuôn brief. Có test kỳ vọng nội dung mô tả tool (xem `chat-flow-review-notes.md` mục `delegate.rs`): cập nhật test đó.
- Kiểm tra mềm (không chặn): nếu `task` < ~200 ký tự **và** không có `scope`/path nào, kết quả `delegate_task` trả kèm một dòng nhắc "brief thiếu scope/done_when". Không từ chối lời gọi.

**E3. Worker liệt kê bước và cập nhật tiến độ. — Cao (phần hiển thị) / TB (phần provider)**

- `REPORT_RULE`/prompt worker thêm: "Với việc từ 3 bước trở lên, lập danh sách bước bằng công cụ plan của bạn (TodoWrite, update_plan, todowrite…) trước khi làm và cập nhật khi xong từng bước."
- Kiểm tra provider nào có công cụ plan và tên tool tương ứng. Đã có regex `PLAN = /^(Plan|TodoWrite|update_plan|ExitPlanMode)$/` trong `chat/content/tool-kind.ts:~21`. Cần kiểm tra OpenCode (`todowrite`), Copilot, Antigravity, Command Code và thêm tên vào regex nếu thiếu.
- Custom provider (vòng tool của AgentDeck, `apps/desktop/src-tauri/src/custom_chat/tools.rs`) chưa có tool plan: thêm tool `update_plan { items: [{content, status}] }` với cùng shape `PlanItem` (`chat/content/blocks.ts:~13`). Tool không làm gì ngoài việc được ghi lại như các tool khác.
- Khi worker gọi tool plan, cập nhật `TaskRecord.steps: PlanItem[]` (lấy bản mới nhất, dùng `planOf`) trong `delegate-task.svelte.ts`. Lưu bền cùng record.

**E4. Report không bao giờ mất phần đầu; ngân sách theo mục. — Cao**

- Thay `reportDigest`:
    - Có `## Handoff`: giữ toàn bộ nếu ≤ `REPORT_MAX` (đề xuất 12 000 ký tự, khai báo một chỗ). Nếu dài hơn, cắt theo thứ tự ưu tiên: luôn giữ `STATUS`, `SUMMARY`, `Steps`, `Verify`, `Open`; rút gọn `Changes` (tối đa N dòng + "… và K file khác"); cắt `Evidence` trước tiên.
    - Không có `## Handoff`: lấy **phần đầu** (đoạn mở) cộng **phần cuối**, đánh dấu chỗ cắt, rồi bổ sung "Run facts" (E5) để cha vẫn có dữ liệu.
- Mỗi chỗ cắt ghi rõ: `(đã cắt: câu trả lời đầy đủ ở chat <childId>; gọi task_status với full=true)`.
- Thêm tham số `full: boolean` cho `task_status` (`delegate.rs:~84`). Khi true, trả về câu trả lời cuối đầy đủ của worker (giới hạn cứng, vd. 40 000 ký tự).
- Bỏ lần cắt thứ hai (`HANDBACK_ANSWER_MAX`) hoặc đặt nó ≥ `REPORT_MAX`, để không cắt hai lần với hai giới hạn khác nhau.

**E5. "Run facts" do AgentDeck ghi, không phụ thuộc lời worker. — Cao**

- Khi task kết thúc, AgentDeck dựng từ dữ liệu đã ghi nhận của chat worker:
    - agent/model, verdict, thời gian chạy, token/chi phí (`runs/usage.ts`), số tool call;
    - file đã sửa: tool ghi file (`Edit`, `Write`, `MultiEdit`, `apply_patch`, `str_replace`…; dùng phân loại sẵn có trong `chat/content/tool-kind.ts`);
    - lệnh đã chạy kèm trạng thái ok/fail (command block);
    - trạng thái cuối của `steps` (E3).
- Đưa vào hand-back và vào kết quả `wait=true` thành mục `### Run facts (AgentDeck)`, ngắn gọn (tối đa ~15 dòng).
- So khớp và ghi cảnh báo một dòng khi lời worker không khớp dữ liệu thật. Ví dụ:
    - report ghi `Verify … pass` nhưng lệnh đó fail trong log;
    - có file bị sửa mà không nằm trong `Changes`;
    - `STATUS: done` nhưng còn bước `in_progress`/`pending`.
- Khi có cảnh báo, `handbackPrompt` coi như "trouble" (nhánh `owner`).

**E6. Hand-back và kết quả `wait=true` theo một khuôn. — Cao**

- `handbackPrompt` (`sending.svelte.ts:~106`): mỗi task in ra:

    ```
    ### <label> — <agent>/<model> · <verdict> · <took> · task <id> · chat <childId>
    <formatHandoff(report) hoặc phần đã cắt theo E4>
    ### Run facts (AgentDeck)
    ...
    ```

- `formatTaskResult` (`tasks/delegate-task.ts:~279`) cho `wait=true` dùng cùng thân như trên. Header `[task … · chat … · …]` giữ nguyên định dạng vì `parseTaskResult` đọc lại header này sau reload.
- Nhánh `light` của `handbackPrompt` vẫn bảo cha không làm lại việc. Thêm yêu cầu: cha trả lời người dùng bằng các bước đã làm, thay đổi và kết quả kiểm tra từ report, không chỉ một câu tóm tắt.

**E7. Hiển thị report có cấu trúc. — Cao**

- `TaskCards.svelte`:
    - dòng tóm tắt dùng `summary` (không dùng `firstLine(report)`);
    - phần mở rộng hiện: huy hiệu `status`, `summary`, danh sách bước bằng `PlanCard` (dùng lại component, không viết lại), `Changes` (mỗi path mở bằng `openProjectFile` — quy tắc `AGENTS.md`), `Verify` (tô màu theo `ok`), `Open`, `Run facts` thu gọn;
    - fallback: report không parse được thì hiện văn bản thô như hiện nay.
- Khi task đang chạy: hiện tiến độ bước, dạng `2/5 · <bước in_progress>`, ở card, ở Work tray (`BackgroundTasks.svelte`, dữ liệu qua `work.svelte.ts`/`chat-work.ts`) và ở `DelegateList.svelte`. Lưu ý B4: chỉ chiếu lại khi `steps` đổi, không theo từng delta.
- Tuân thủ quy tắc UI trong `AGENTS.md`: Z-UI, không thêm thư viện UI lớn, hover không đè trạng thái active.

**E8. Quy ước trong `AGENTS.md` của repo. — Cao**

- Thêm mục ngắn "Brief và report của sub-agent". Mục này dành cho các agent đang phát triển repo này, và mô tả định dạng mà AgentDeck dạy cho worker:
    - khuôn brief và khuôn report (trỏ tới `apps/desktop/src/lib/tasks/handoff-format.ts` làm nguồn, không chép toàn văn);
    - khi đổi định dạng, phải sửa cùng lúc: `handoff-format.ts`, mô tả tool trong `delegate.rs`, `DELEGATE_HINT`, test parser, `TaskCards.svelte`.

**E9. Sub-agent native (sau Phase 4). — TB**

- AgentDeck không viết brief cho sub-agent native. Thêm một câu vào `DELEGATE_HINT`: "Khi giao việc cho sub-agent của chính bạn, yêu cầu nó kết thúc bằng mục `## Handoff` theo cùng khuôn." Đo token trước khi thêm.
- Khi có `ChildEnded.summary` (Phase 4), chạy `parseHandoff` lên nó. Nếu parse được, card sub-agent native dùng cùng cách hiển thị của E7; nếu không, giữ văn bản thô.
- Danh sách bước: nếu provider stream tool plan của child dưới dạng `ChildEvent`, chiếu vào card giống E3. Cần kiểm chứng provider nào làm được việc này.

**E10. Workflow/role dùng cùng khuôn. — TB**

- Các bước workflow (`WorkflowView.svelte`, `delegation.svelte.ts`) và prompt theo role (`agents/task-roles.ts`, ví dụ role `review` có thể sinh `VERDICT`) phải dùng cùng `REPORT_RULE`. Tìm mọi chỗ tự chế khuôn report riêng và thay bằng tham chiếu tới `handoff-format.ts`.

### 6.3 Điều kiện chấp nhận Phase 6

- Test parser (E1) và test ngân sách cắt (E4) chạy xanh bằng `node --experimental-strip-types --test`.
- Test hiện có `apps/desktop/tests/delegate-task.test.ts`, `handback.test.ts`, `src/lib/tasks/delegate-task.test.ts` vẫn xanh hoặc được cập nhật có lý do.
- Chạy app thật với một lead giao 2 worker (một Claude, một Codex), mỗi worker làm việc 3+ bước có sửa file và chạy test:
    - card ở chat cha hiện tiến độ bước khi đang chạy;
    - report hiện đủ các mục;
    - path mở được file;
    - hand-back cho cha có header, report và Run facts;
    - cha trả lời người dùng có nêu các bước, thay đổi và kết quả kiểm tra.
- Cố ý cho worker ghi "pass" khi lệnh fail (sửa prompt thử) → cảnh báo E5 xuất hiện và cha đi vào nhánh `owner`.
- Mở một transcript cũ có report định dạng v1 → vẫn hiển thị đúng.

---

## Phase 7 — Harness điều phối công việc (kiểu Claude Code desktop)

### 7.0 Mục tiêu

AgentDeck chủ động điều phối một chat làm việc dài, giống cách Claude Code desktop làm:

1. **Task list ghim:** danh sách bước của lượt hiện tại ghim dưới tin nhắn mới nhất, cập nhật khi agent làm.
2. **Ô "bước tiếp theo"** cuối mỗi lượt có làm việc: tóm tắt 2–3 câu (đã xong gì, còn gì chưa làm hoặc chưa kiểm), cộng **một** câu hỏi quyết định và 1–2 nút trả lời (ví dụ "Commit", "Làm phase 2", "Để sau").
3. **Tách phiên theo phase:**
    - plan nhiều phase → mỗi phase lớn được đề xuất chạy trong một phiên riêng (fork hoặc phiên mới với brief), để context của chat chính gọn;
    - phiên phase xong thì report về chat chính;
    - chat chính cập nhật plan và đề xuất phase kế tiếp;
    - các phase độc lập (không đụng cùng file) có thể chạy song song.
4. **Gợi ý giữa chừng:** việc phức tạp thì gợi ý tách phiên; context sắp đầy thì gợi ý tách hoặc nén; plan vừa lập thì gợi ý rà lại plan; làm xong có thay đổi file thì gợi ý commit.
5. **Người dùng luôn quyết định.** Không tự commit, không tự push, không tự mở phiên khi người dùng chưa đồng ý. Ngoại lệ duy nhất: người dùng đã bật chế độ tự động trong Settings.

### 7.1 Hiện trạng có thể dùng lại (đã đọc code)

- **MCP server của AgentDeck** (`apps/desktop/src-tauri/src/mcp.rs`, danh sách `TOOLS` ở `:~23`, định tuyến ở `:~653-668`) đã được gắn cho Claude, Codex, OpenCode, Copilot. Grep `mcpServers|mcp_servers` thấy trong `crates/adapters/src/agent/{claude,codex,codex_server,opencode,mod}.rs`, `src-tauri/src/copilot.rs`. Cần kiểm tra Antigravity và Command Code. Custom provider có bộ tool riêng ở `src-tauri/src/custom_chat/tools.rs`.
  → Thêm tool harness mới ở đây là mọi CLI đều dùng được, không cần sửa từng adapter.
- **Fork chat:** `forkSession(sourceId, fromMessageId?)` (`chat/session/sending.svelte.ts:~953`) chép tin nhắn và tạo digest (`forkDigest`, `:~911`). Sidebar đã có cây Project > Session > Fork (`chat/session/tree.svelte.ts:~18-126`, `parentId`).
- **Worker delegate** (Phase 0 nhóm C, Phase 3.2, Phase 6): đã có chat con, task record, report, hand-back về chat cha (`flushReports`, `handbackPrompt`). Phiên phase **phải dùng lại** cơ chế này, không làm cơ chế thứ ba.
- **Plan:** `PlanCard.svelte` vẽ TodoWrite / `update_plan` / `Plan` inline trong tin nhắn (`AssistantMessage.svelte:~51`, `planOf` trong `chat/content/blocks.ts:~21`). Slash `/plan` (`chat/slash.svelte.ts:~145`) lập plan không sửa file. Có permission mode `plan` (`turns.svelte.ts:~280`).
- **Commit:** slash `/commit` (`slash.svelte.ts:~63`) có prompt commit + push đầy đủ quy tắc. Changes panel (`src-tauri/src/changes.rs`) đọc git status/diff cho mọi agent.
- **Kiểm tra dự án:** tool `run_checks` (`src-tauri/src/devtools.rs:~15`).
- **Workflow do người dùng định nghĩa:** `components/tasks/flow/FlowEditor.svelte`, `WorkflowView.svelte`, `chat/session/delegation.svelte.ts`. Đây là luồng khác (flow cố định). Phase 7 không thay nó, nhưng phiên phase phải hiện được trong `WorkflowView` nếu dùng chung task record.

### 7.2 Thiết kế tổng thể

Có hai nguồn tín hiệu:

- **Agent chủ động:** agent gọi tool harness qua MCP (`next_step`, `propose_session`, `report_back`, `chapter`).
- **Harness tự suy ra:** áp cho provider không gọi tool, hoặc khi agent quên. Các tín hiệu suy ra: git có thay đổi sau lượt; plan còn bước `pending`; context gần đầy; plan vừa được lập.

Cả hai đều đổ vào **một store duy nhất** theo chat: `chat/harness/harness.svelte.ts`, giữ `{ plan, nextStep, proposals[], chapters[] }`. Store được lưu bền cùng session. UI chỉ đọc store này.

Quy tắc ưu tiên:

- Nếu agent đã gọi `next_step` trong lượt, harness không tự suy ra ô bước tiếp theo nữa.
- Riêng nút "Commit" có thể được harness thêm vào nếu git có thay đổi mà agent không đề cập. Tối đa 2 nút.

### 7.3 Các mục việc

**H1. Task list ghim theo lượt. — Cao**

- Lấy plan mới nhất của lượt đang chạy (`planOf` trên tool plan: TodoWrite / `update_plan` / `todowrite`…, xem E3) đưa vào `harness.plan`.
- Hiển thị ghim phía trên composer: thu gọn thành `3/5 · <bước in_progress>`, mở ra là `PlanCard` (dùng lại component).
- Bước nào được giao cho phiên/worker thì hiện tên phiên và trạng thái sống của phiên (link mở phiên).
- Hết lượt mà mọi bước đã `completed`: ẩn ghim. Còn bước dở: giữ ghim, đánh dấu "chưa xong".
- Thêm tool `update_plan` cho custom provider (cùng mục E3).

**H2. Ô "bước tiếp theo" (next step box). — Cao**

- Tool MCP mới:

    ```
    next_step {
      recap: string,          // 2–3 câu, ≤300 ký tự: điều đã đúng/đã đổi, còn gì chưa làm hoặc chưa kiểm
      ask?: string,           // một câu hỏi quyết định, ≤100 ký tự, không kèm lý do hay liệt kê lựa chọn
      actions?: [             // 1–2 nút chính, nút đầu là đề xuất; thêm tối đa 4 mục vào menu "Thêm"
        { label: string,      // 1–3 từ
          action: string,     // id trong catalog hành động (H11), vd. 'git.commit', 'check.run', 'ui.preview',
                              // hoặc 'slash:<tên>' (slash command có thật), hoặc 'reply'
          args?: object,      // tham số của hành động (file, lệnh, role, model…)
          prompt?: string,    // với 'reply'/'slash': nội dung gửi kèm
          primary?: boolean }
      ],
      blocked?: boolean       // true: việc dừng cho tới khi người dùng trả lời
    }
    ```

- Danh sách hành động **không cố định trong schema**: `action` là id tra trong catalog H11. Agent có thể gọi `list_actions` (H11) để xem các hành động đang khả dụng cho dự án và provider này. Id không có trong catalog (hoặc slash không tồn tại) thì bị bỏ, ghi log, không làm hỏng ô.

- Mô tả tool dạy agent:
    - gọi một lần ở cuối mọi lượt có sửa file, chạy lệnh hoặc giữ task list;
    - không gọi cho câu trả lời ngắn;
    - recap không trỏ tới chỗ khác trong hội thoại ("xem ở trên");
    - câu trả lời đầy đủ vẫn viết sau khi gọi tool.
- UI: `chat/harness/NextStepBox.svelte` dưới tin nhắn cuối.
    - 1–2 nút chính, cộng nút "Thêm (n)" mở `Menu`/`MenuButton` (theo quy tắc `AGENTS.md`), nhóm theo loại hành động, mỗi dòng có icon.
    - Bấm nút thì chạy hành động qua bộ thực thi của catalog (H11). Hành động rủi ro hỏi xác nhận trước (H11, mức rủi ro).
- `blocked: true`: sidebar đánh dấu chat "đang chờ bạn" (dùng trạng thái chưa đọc sẵn có nếu có).
- Harness tự suy ra (khi agent không gọi tool, hoặc để bổ sung vào menu "Thêm"):
    - lượt có tool call sửa file → recap dựng từ Run facts (E5), không do LLM viết;
    - các nút lấy từ bộ luật gợi ý H12 (git thay đổi → Commit, kiểm tra fail → Sửa lỗi, file UI đổi → Mở Preview…);
    - ghi rõ trên UI đây là gợi ý do AgentDeck tạo (nhãn nhỏ).

**H3. Tách phiên theo phase (phase session). — Cao (thiết kế) / TB (chi tiết provider)**

- Tool MCP mới:

    ```
    propose_session {
      title: string,                 // <60 ký tự, tên việc
      brief: string,                 // khuôn Brief của Phase 6 (GOAL/CONTEXT/SCOPE/CONSTRAINTS/DONE WHEN)
      context: 'fork' | 'fresh',     // fork: mang theo hội thoại (khi hội thoại còn ngắn và việc dựa vào nó); fresh: chỉ brief
      phase?: string,                // tham chiếu bước trong task list (H1)
      parallel_group?: string,       // các đề xuất cùng nhóm có thể chạy song song (không đụng chung file)
      agent?: string, model?: string, role?: string   // như delegate_task; bỏ trống = theo task role
    }
    ```

- UI: thẻ đề xuất `SessionProposalCard.svelte` trong tin nhắn, có hai nút "Phiên mới" và "Làm ở đây".
    - Đề xuất hết hạn sau 7 ngày.
    - Khi phiên không còn cần thì agent hoặc người dùng gỡ thẻ (`dismiss_proposal { id }`).
- Khi người dùng chấp nhận:
    - Tạo phiên con hiển thị trong sidebar dưới chat chính (`parentId`, `kind: 'phase'`). Phiên dùng lại `forkSession` (với `fork`) hoặc phiên mới chỉ có brief (với `fresh`).
    - Phiên đó là **task record của Phase 3.2** với `mode: 'session'`:
        - người dùng thấy và chat trực tiếp trong đó được;
        - không có timeout;
        - không chiếm slot worker (hoặc có cap riêng, cấu hình được);
        - không tự chạy nền như `delegate_task`.
    - Gửi brief làm lượt đầu, kèm `REPORT_RULE` (Phase 6) và hướng dẫn "khi phase xong, gọi `report_back`".
- Tool `report_back { report }` (chỉ có trong phiên phase) gửi report theo khuôn Handoff về chat chính. Report đi qua cùng đường `deliverReport` → backlog → `handbackPrompt`, có Run facts (E5).
    - Người dùng cũng có nút "Báo về chat chính" trong phiên phase. AgentDeck dựng report từ câu trả lời cuối + Run facts.
- Chat chính nhận report:
    - cập nhật bước tương ứng trong task list (H1);
    - nhánh `owner` / `light` như E6;
    - kết thúc bằng `next_step`, thường là "Làm phase N+1?" với nút "Phiên mới" (đề xuất tiếp) hoặc "Làm ở đây".
- Song song:
    - Các đề xuất cùng `parallel_group` hiện chung một nhóm với nút "Chạy tất cả".
    - Mỗi phiên song song chạy trong git worktree riêng, nếu dự án là git repo và người dùng bật. Nếu không có worktree, brief phải ghi rõ write scope rời nhau và "không commit, không đổi branch".
    - Chủ dự án cần quyết định trước khi làm phần worktree; xem 7.5.
- Phiên phase kết thúc lượt mà không báo về: chat chính thấy trạng thái phiên trong task list (H1), không bị chặn.

**H4. Gợi ý tách phiên giữa chừng. — TB**

- Mô tả tool `propose_session` dạy agent khi nào đề xuất:
    - việc là một nhiệm vụ riêng, có kết quả riêng (branch, PR, thay đổi ở module khác);
    - việc lớn mà phần lớn context hiện tại không cần;
    - sau khi người dùng duyệt một plan có ≥2 bước độc lập.
- Khi nào **không** đề xuất: việc vài tool call; một phần của chính việc đang làm (dùng `delegate_task` hoặc sub-agent).
- Harness tự suy ra:
    - context của chat ≥ ~70% giới hạn (dùng `chatTokens` / `DEFAULT_CONTEXT_LIMIT` trong `sending.svelte.ts`) → ô bước tiếp theo thêm gợi ý "Tách phiên mới với tóm tắt" (fresh, brief dựng từ task list + Run facts) hoặc "Nén context" (dùng cơ chế `automation.compress` sẵn có).
    - Chỉ gợi ý một lần mỗi ngưỡng, có thể tắt trong Settings.

**H5. Gợi ý commit. — Cao**

- Điều kiện: lượt kết thúc, git có thay đổi (`changes.rs`), không có lượt nào đang chạy trong cùng repo, và kiểm tra gần nhất (nếu đã chạy) không fail.
- Nút "Commit" gửi một lượt dùng prompt slash `/commit` sẵn có (agent tự xem diff, viết message theo repo, tôn trọng hook). Không gọi git trực tiếp từ UI, để hook và quy tắc dự án được tôn trọng.
- Tách bạch commit và push. Prompt `/commit` hiện commit **và push**. Thêm biến thể "commit, không push" làm mặc định cho nút. Push là nút riêng (`kind: 'push'` hoặc lượt sau), luôn xác nhận.
- Với phiên phase chạy song song không có worktree: không gợi ý commit trong phiên con, chỉ gợi ý ở chat chính sau khi tích hợp.

**H6. Gợi ý rà lại plan. — TB**

- Khi một lượt tạo plan (slash `/plan`, permission mode `plan`, `ExitPlanMode`, hoặc tool plan có ≥4 bước mà chưa bắt đầu làm), ô bước tiếp theo có nút "Rà plan".
- Bấm "Rà plan" chạy một lượt rà soát plan:
    - mặc định bằng agent/model của role `review` hoặc `plan` trong Settings > Tasks (`agents/task-roles.ts`), qua `delegate_task wait=true`;
    - prompt rà: thứ tự phụ thuộc, bước nào tách song song được, rủi ro, bước thiếu kiểm chứng, phạm vi file chồng nhau;
    - kết quả trả về theo khuôn Handoff.
- Chat chính gộp góp ý và đề xuất plan đã sửa, sau đó hỏi duyệt.

**H7. Chương (chapter) cho chat dài. — Thấp, tùy chọn**

- Tool `chapter { title, summary? }` để agent đánh dấu chuyển giai đoạn (khám phá → làm → kiểm). UI là mục lục nổi để nhảy tới. Không chặn các mục khác.

**H8. Lời dạy cho agent (giữ ngắn). — Cao**

- Hướng dẫn chủ yếu nằm trong mô tả các tool MCP (chỉ tốn token khi CLI nạp danh sách tool).
- Thêm vào `DELEGATE_HINT` (hoặc một `HARNESS_HINT` riêng gửi ở lượt đầu) tối đa 2–3 câu: "Cuối lượt có làm việc thì gọi `next_step`. Việc lớn có phase độc lập thì `propose_session` thay vì làm hết trong chat này. Không tự commit." Đo token trước/sau, ghi vào PR.
- Custom provider: thêm cùng các tool vào `custom_chat/tools.rs`.

**H9. Lưu bền và đồng bộ. — Cao**

- `harness` store lưu cùng session (cùng chỗ với `delegate.tasks`). Reload app thì ô bước tiếp theo, đề xuất và task list vẫn còn.
- Đề xuất đã được chấp nhận hoặc gỡ không hiện lại.
- Phiên phase đang chạy khi app restart: hiện "Kiểm tra trạng thái" như Work tray hiện nay, và báo về chat chính "stopped: app restarted" (C7).

**H10. Cài đặt. — Cao**

- Settings > Automation (hoặc mục `ContinueSection.svelte` hiện có), mỗi gợi ý một toggle, mặc định bật:
    - gợi ý commit;
    - gợi ý tách phiên;
    - gợi ý rà plan;
    - gợi ý khi context gần đầy;
    - harness tự suy ra ô bước tiếp theo.
- Toggle "Tự chạy phase kế tiếp khi phase trước báo xong", mặc định **tắt**. Khi bật: chat chính tự chấp nhận đề xuất kế tiếp, không cần bấm. Không áp cho commit/push, hai việc đó luôn cần bấm.
- Toggle theo **nhóm** hành động của catalog (H11) thay cho danh sách toggle cố định ở trên: bật/tắt từng nhóm, và từng hành động trong nhóm.

**H11. Catalog hành động mở rộng được. — Cao**

Gợi ý không giới hạn ở commit / tách phiên / rà plan. Mọi việc AgentDeck và agent làm được đều có thể thành một hành động trong catalog.

- File: `apps/desktop/src/lib/chat/harness/actions.ts` (thuần) và `actions.svelte.ts` (bộ thực thi). Mỗi hành động:

    ```ts
    type HarnessAction = {
        id: string; // 'git.commit', 'check.fix', 'ui.preview'…
        group: ActionGroup; // nhóm hiển thị và toggle
        label: string; // 1–3 từ
        icon: string; // lucide icon; agent thì AgentLogo
        run:
            // cách thực thi
            | { via: 'reply'; prompt: string } // gửi một lượt cho chat này
            | { via: 'slash'; name: string; args?: string } // slash có thật (builtin, của CLI, của project)
            | { via: 'delegate'; role: string; brief: string } // delegate_task theo role (Settings > Tasks)
            | { via: 'session'; brief: string; context: 'fork' | 'fresh' } // đề xuất phiên H3
            | { via: 'app'; command: string; args?: object } // hành động app, không qua LLM
            | { via: 'switch'; ref: Partial<ModelRef> }; // đổi model/effort cho lượt sau (Phase 3.3)
        risk: 'safe' | 'confirm' | 'irreversible'; // confirm/irreversible: hỏi qua zModalService
        available: (signals: Signals) => boolean; // có hiện trong ngữ cảnh này không
    };
    ```

- `risk`:
    - `safe`: chạy ngay khi bấm (xem diff, mở file, chạy kiểm tra, review chỉ đọc).
    - `confirm`: hỏi xác nhận một bước (đổi branch, revert file, cài skill/MCP, tạo PR).
    - `irreversible`: hỏi xác nhận nêu rõ hậu quả, bằng `zModalService.danger` (push, release, tag, xóa file, deploy).
    - Không hành động `confirm`/`irreversible` nào chạy tự động, kể cả khi bật các toggle tự động.
- Tool MCP `list_actions { group? }` trả về các hành động đang khả dụng (`id`, `label`, `group`, `risk`, một dòng mô tả), để agent chọn id cho `next_step`. Mô tả tool `next_step` chỉ liệt kê tên nhóm (giữ ngắn token).
- Slash động: `slash:<tên>` hợp lệ nếu tên có trong slash builtin (`chat/slash.svelte.ts`) hoặc trong `commands_list` (lệnh của CLI, của người dùng, của project; `src-tauri/src/slash_commands.rs:~355`). Vì vậy lệnh tùy chỉnh của người dùng và của project tự động thành gợi ý được.
- **Catalog khởi đầu**, theo nhóm. Ánh xạ tới tính năng có sẵn; mục ghi "mới" là chưa có trong app.

| Nhóm       | Hành động (id → cách chạy)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`      | `git.diff` xem thay đổi → app: Changes panel (`changes_list`, `change_diff`) · `git.commit` → slash `commit` biến thể không push (H5) · `git.push` (irreversible) · `git.branch` tạo branch trước khi commit khi đang ở nhánh mặc định (confirm; `git_branches`/`git_switch`) · `git.revert_file` (irreversible; `change_revert`) · `git.pr` mở PR bằng `gh` nếu có (confirm; reply prompt) · `git.sync_base` cập nhật từ nhánh gốc (confirm) |
| `check`    | `check.run` chạy kiểm tra dự án (tool `run_checks`) · `check.fix` sửa lỗi kiểm tra vừa fail (slash `fixbug` kèm output) · `check.test_add` viết test cho phần vừa sửa (slash `test`) · `check.lint_format` chạy format/lint của dự án · `check.junk` dọn file rác (lệnh của dự án nếu có, vd. `pnpm clean:junk`)                                                                                                                              |
| `review`   | `review.code` (slash `review` hoặc delegate role `review`) · `review.security` (slash `security` / role `security`) · `review.perf` (slash `perf`) · `review.second_opinion` hỏi model khác rà lại kết quả (delegate, chọn provider khác) · `review.plan` rà plan (H6)                                                                                                                                                                        |
| `ui`       | `ui.preview` mở/khởi động dev server và Preview (`browser_serve`/`browser_open`) · `ui.audit` (`ui_audit`, slash `ui-review`) · `ui.mobile` kiểm bố cục mobile (`browser_device`) · `ui.screenshot` chụp trước/sau · `ui.guide` quay video hướng dẫn (`browser_record_*`) · `ui.layout` (slash `layout`)                                                                                                                                      |
| `run`      | `run.dev_server` · `run.logs` xem log server (tool `server_logs`) · `run.stop_server` · `run.rerun` chạy lại lệnh cuối · `run.terminal` mở terminal ở thư mục dự án (`pty_shells`)                                                                                                                                                                                                                                                            |
| `debug`    | `debug.investigate` (slash `debug`) · `debug.error_log` mở log lỗi app (`error_log_read`) · `debug.bundle` lưu gói debug (`debug_bundle_save`) · `debug.retry` thử lại lượt lỗi · `debug.other_provider` chuyển provider cho lượt sau (switch)                                                                                                                                                                                                |
| `plan`     | `plan.make` (slash `plan`) · `plan.split_sessions` tách phase thành phiên (H3) · `plan.run_parallel` chạy các phase độc lập song song · `plan.continue` làm bước kế trong task list · `plan.plan_mode` chuyển sang permission `plan` trước khi sửa nhiều file                                                                                                                                                                                 |
| `docs`     | `docs.update` (slash `docs`) · `docs.explain` giải thích phần vừa sửa (slash `explain`) · `docs.release_notes` cập nhật release notes theo quy ước dự án · `docs.export` xuất Word/PDF (officecli) · `docs.document` (slash `document`)                                                                                                                                                                                                       |
| `release`  | `release.cut` (slash `release`, irreversible) · `release.check` (vd. `pnpm release:check` nếu dự án có)                                                                                                                                                                                                                                                                                                                                       |
| `work`     | `work.delegate` giao một phần cho role phù hợp · `work.open_worker` mở chat worker · `work.stop_stuck` dừng worker treo (confirm) · `work.return_result` trả kết quả đã lưu · `work.continue_worker` gửi chỉnh sửa cho worker (`continue=`)                                                                                                                                                                                                   |
| `context`  | `context.new_session` tách phiên mới có tóm tắt · `context.compress` nén context · `context.chapter` đánh dấu chương                                                                                                                                                                                                                                                                                                                          |
| `model`    | `model.stronger` dùng model/effort mạnh hơn cho lượt sau (khi lặp lỗi) · `model.cheaper` model rẻ hơn cho việc nhẹ · `model.fast` bật fast mode nếu provider có                                                                                                                                                                                                                                                                               |
| `research` | `research.quick` (slash `research`) · `research.deep` (slash `deep-research`) · `research.docs_lookup` tra tài liệu thư viện (MCP tài liệu nếu đã cài)                                                                                                                                                                                                                                                                                        |
| `memory`   | `memory.save` lưu quy ước vừa học vào `.agentdeck/memory.md` · `memory.proposals` duyệt đề xuất mới trong `.agentdeck/proposals.md` (`project_proposals_read/write`)                                                                                                                                                                                                                                                                          |
| `content`  | `content.open_file` mở file vừa tạo (`openProjectFile`) · `content.image` tạo ảnh minh họa (`image_generate`) · `content.email` (slash `email`) · `content.export_chat` (`export_chat`)                                                                                                                                                                                                                                                       |
| `tools`    | `tools.install_skill` cài skill phù hợp từ Store khi agent thiếu công cụ (confirm; `store_sync`) · `tools.connect_mcp` kết nối MCP (confirm)                                                                                                                                                                                                                                                                                                  |
| `session`  | `session.rename` đặt tên chat · `session.archive` lưu trữ khi xong · `session.notify` báo khi việc dài xong (`system_notify`) · `session.keep_awake` giữ máy thức trong việc dài (`keep_awake_set`)                                                                                                                                                                                                                                           |
| `followup` | `followup.task` việc phát hiện ngoài phạm vi (bug thấy khi làm việc khác) → thẻ đề xuất phiên riêng (H3), hết hạn sau 7 ngày                                                                                                                                                                                                                                                                                                                  |

- Thêm hành động mới = thêm một mục vào catalog, có test `available()`. Không sửa `NextStepBox`, không sửa schema tool.
- Mỗi id có test: `available` đúng với tín hiệu mẫu; `run` gọi đúng đích (mock invoke/send); `risk` đúng nhóm.

**H12. Bộ luật gợi ý theo tín hiệu (harness tự suy ra). — Cao**

- File `apps/desktop/src/lib/chat/harness/signals.ts` (thuần): gom tín hiệu cuối lượt:
    - file đã sửa và loại file (mã, test, UI `.svelte/.tsx/.vue/.css/.html`, docs, cấu hình, lockfile, migration, file nhạy cảm như auth/secret/dependency);
    - lệnh đã chạy và kết quả, kiểm tra gần nhất pass/fail, số lần fail liên tiếp;
    - git: branch, có phải nhánh mặc định, dirty, ahead/behind, có upstream;
    - dev server đang chạy hay không, Preview đang mở trang nào;
    - lỗi của lượt (loại lỗi Phase 2), recovery đang chạy;
    - plan: số bước, bước `pending`, plan vừa lập chưa làm;
    - context % (`chatTokens`), thời gian lượt, worker/phiên con đang chạy hoặc treo;
    - năng lực dự án: script trong `package.json` (`test`, `lint`, `build`, `release:check`…), `Cargo.toml`, thư mục release notes, `gh` có sẵn, MCP/skill đã cài;
    - provider/model hiện tại và khả năng của nó (registry Phase 1).
- File `suggest.ts` (thuần): bảng luật `tín hiệu → hành động + điểm`. Luật khởi đầu, ví dụ:
    - code đổi + chưa chạy kiểm tra → `check.run`; kiểm tra fail → `check.fix` (điểm cao), fail ≥2 lần → thêm `model.stronger`, `review.second_opinion`;
    - code đổi + kiểm tra pass → `git.commit`; đang ở nhánh mặc định → `git.branch` trước;
    - file UI đổi → `ui.preview`, `ui.audit`, `ui.mobile`;
    - file auth/secret/dependency đổi → `review.security`;
    - mã nguồn đổi mà không có file test nào đổi → `check.test_add`;
    - public API/README liên quan đổi → `docs.update`; dự án có release notes và có `feat`/`fix` chưa ghi → `docs.release_notes`;
    - plan vừa lập ≥4 bước chưa làm → `review.plan`, `plan.split_sessions`; còn bước `pending` → `plan.continue`;
    - context ≥70% → `context.new_session` / `context.compress` (một lần mỗi ngưỡng);
    - lượt dài > N phút → `session.notify` lần sau;
    - worker treo theo watchdog → `work.stop_stuck`;
    - lỗi thiếu công cụ ("command not found", thiếu MCP) → `tools.install_skill` / `tools.connect_mcp`;
    - agent học được quy ước mới (ghi trong report Open/Facts) → `memory.save`;
    - việc xong, không còn bước nào → `session.archive` (điểm thấp, chỉ trong menu "Thêm").
- Xếp hạng: điểm của luật + ưu tiên của agent (agent gọi `next_step` thì nút của agent đứng đầu) + lịch sử người dùng (H13). Hiện 2 nút chính, phần còn lại vào "Thêm" (tối đa 6).
- Chống ồn: một gợi ý bị bỏ qua hoặc gỡ trong chat này thì không hiện lại cho tới khi tín hiệu đổi; cooldown theo id; không gợi ý hành động đã làm trong lượt (vd. đã commit).

**H13. Người dùng và dự án tự thêm gợi ý. — TB**

- **Luật của người dùng** (Settings > Automation > Gợi ý): chọn trigger (file khớp glob bị sửa / lệnh fail / cuối lượt có thay đổi / từ khóa trong yêu cầu) → hành động (slash, prompt `reply`, delegate theo role). Ví dụ: "sửa `*.sql` → chạy slash `migration-check`".
- **Luật của dự án**: file `.agentdeck/actions.json` (cạnh `memory.md`, `proposals.md`), commit cùng repo để cả nhóm dùng chung. Cùng schema với luật người dùng. Đọc khi mở dự án; lỗi schema thì báo trong Settings, không làm hỏng ô.
- **Học từ thói quen**, chỉ lưu cục bộ: đếm số lần chấp nhận/bỏ qua theo `(dự án, action id)`. Gợi ý hay bị bỏ thì hạ điểm; gợi ý hay được bấm thì nâng điểm. Có nút "Đặt lại" trong Settings.
- Agent đề xuất hành động mới: nếu agent dùng `reply` cùng một prompt nhiều lần, Settings hiện đề xuất "Lưu thành hành động" (người dùng quyết định).

### 7.4 Tệp dự kiến

- Rust:
    - `apps/desktop/src-tauri/src/harness.rs`: định nghĩa tool `next_step`, `propose_session`, `dismiss_proposal`, `report_back`, `chapter`; emit event `agent-harness` tới webview kèm chat id (lấy từ URL MCP như `delegate.rs`);
    - đăng ký trong `mcp.rs`;
    - permission trong `src-tauri/permissions`.
- TS:
    - `apps/desktop/src/lib/chat/harness/harness.ts`: reducer thuần + suy luận, có test node;
    - `harness.svelte.ts`: store + listener;
    - `signals.ts`: gom tín hiệu cuối lượt, thuần, có test (H12);
    - `suggest.ts`: các luật harness tự suy ra và xếp hạng, thuần, có test (H12);
    - `actions.ts` + `actions.svelte.ts`: catalog và bộ thực thi hành động (H11);
    - `user-rules.ts`: đọc luật của người dùng và `.agentdeck/actions.json` (H13).
- Rust: thêm tool `list_actions` trong `harness.rs`. Tool đọc catalog do webview đăng ký lúc khởi động (catalog có hàm `available` nên phải chạy ở TS; Rust chỉ hỏi webview qua event có ack, hoặc giữ bản danh sách tĩnh do webview đẩy xuống khi tín hiệu đổi).
- UI:
    - `apps/desktop/src/lib/components/chat/harness/NextStepBox.svelte`, `SessionProposalCard.svelte`, `PinnedPlan.svelte`;
    - dùng Z-UI, nút theo quy tắc `AGENTS.md`;
    - icon agent bằng `AgentLogo`.
- Phiên phase: mở rộng task record (Phase 3.2) với `mode: 'worker' | 'session'`. Không tạo store riêng.

### 7.5 Quyết định đã chốt (2026-11-02)

1. Phiên phase song song dùng git worktree riêng. Chat chính merge (có hỏi người dùng), dọn worktree sau khi merge.
2. Cap 3 phiên phase chạy cùng lúc.
3. Nút "Commit" chỉ commit, không push. Push là hành động riêng, luôn xác nhận.

### 7.6 Điều kiện chấp nhận Phase 7

- Test node cho reducer harness và luật suy ra:
    - có thay đổi git → có nút Commit;
    - plan còn bước → nút "Làm tiếp";
    - agent đã gọi `next_step` → harness không chèn thêm ô thứ hai;
    - đề xuất hết hạn;
    - ngưỡng context chỉ gợi ý một lần;
    - mỗi luật của H12 với tín hiệu mẫu cho đúng hành động, đúng thứ tự xếp hạng;
    - `next_step` với id không có trong catalog hoặc slash không tồn tại → bị bỏ, ô vẫn hiện;
    - hành động `confirm`/`irreversible` không bao giờ chạy mà không qua modal, kể cả khi bật toggle tự động;
    - luật trong `.agentdeck/actions.json` sai schema → báo lỗi trong Settings, không làm hỏng ô;
    - gợi ý bị bỏ qua không hiện lại khi tín hiệu không đổi.
- Chạy app thật với Claude và Codex làm chat chính:
    1. Yêu cầu một việc lớn → agent lập plan nhiều phase, task list ghim hiện, ô bước tiếp theo có "Rà plan".
    2. Agent đề xuất phase 1 thành phiên riêng → bấm "Phiên mới" → phiên con xuất hiện dưới chat chính trong sidebar, chạy brief.
    3. Phiên con xong, `report_back` → chat chính nhận report có Steps/Changes/Verify, đánh dấu bước xong, đề xuất phase 2.
    4. Hai phase độc lập → "Chạy tất cả" → hai phiên chạy song song, không đụng chung file.
    5. Cuối việc có thay đổi git → nút "Commit" → commit đúng quy tắc repo, không push.
    6. Reload app giữa chừng → ghim, ô bước tiếp theo, đề xuất còn nguyên; phiên đang chạy báo đúng trạng thái.
- Provider không gọi tool harness (thử custom provider tắt tool) → harness vẫn hiện ô bước tiếp theo tự suy ra.
- Chạy app thật, mỗi tình huống thấy gợi ý phù hợp trong 2 nút chính hoặc menu "Thêm":
    - sửa file `.svelte` → "Mở Preview", "Audit UI";
    - kiểm tra fail 2 lần → "Sửa lỗi", "Model mạnh hơn", "Ý kiến thứ hai";
    - sửa file auth → "Rà bảo mật";
    - đang ở `main` có thay đổi → "Tạo branch" đứng trước "Commit";
    - thêm một slash command trong project → dùng được như hành động `slash:<tên>`.

---

## Phase 8 — Git worktree cho phiên làm việc (kiểu Claude Code desktop)

### 8.0 Mục tiêu

- Mỗi phiên (chat) có thể chạy trong một **git worktree riêng**, trên branch riêng. Nhờ vậy nhiều việc chạy song song trên cùng repo không giẫm lên nhau, và checkout chính của người dùng không bị đụng.
- AgentDeck **tự gợi ý** khi nào nên tách việc sang worktree. Agent gợi ý qua `propose_session` (Phase 7, H3), hoặc harness tự suy ra từ tín hiệu (H12).
- Vòng đời đầy đủ trong app: tạo → làm → cập nhật từ nhánh gốc → merge về → dọn dẹp. Mọi bước ghi lịch sử git đều do người dùng bấm.
- Quyết định đã chốt (mục 7.5): phiên song song dùng worktree riêng; chat chính merge (có hỏi người dùng); cap 3 phiên chạy cùng lúc; không tự push.

### 8.1 Hiện trạng (đã đọc code)

- **Chưa có hỗ trợ worktree.** `git grep -i worktree` chỉ thấy:
    - `crates/adapters/src/agent/codex.rs:~180-315` (`worktree_baselines`: lấy bản gốc của file để tính diff);
    - `crates/adapters/src/history/mod.rs:~190` (nhận ra `.git` là file trong worktree khi dò lịch sử).
- **Thư mục làm việc của chat:** `cwdOf` (`chat/session/state.svelte.ts:~325`) trả về `projectOf(session)?.path || session.workingDirectory`. Đường dẫn project đứng trước, nên hiện không có cách cho một chat chạy ở thư mục khác thư mục project.
- **Git có sẵn:** `src-tauri/src/changes.rs` có `changes_list`, `change_diff`, `change_revert`, stage, `git_branches`, `git_switch` (`:~373-382`). Có helper `toplevel()` và `checked_branch()` để kiểm tên branch. Changes panel đọc git cho mọi agent.
- **Dev server:** `browser_serve` giữ server theo `(project, command)` và tự chuyển sang cổng trống khi cổng bị chiếm. Mỗi worktree sẽ có server riêng nếu khóa theo `cwd`; cần kiểm lại khóa này.
- **Process:** `src-tauri/src/process_registry.rs`, `process_guard.rs` theo dõi tiến trình. Phải dừng hết tiến trình chạy trong worktree trước khi xóa worktree (Windows khóa file đang mở).

### 8.2 Các mục việc

**W1. Module Rust `worktree.rs`. — Cao**

- Lệnh Tauri (đăng ký ở `lib.rs` và `src-tauri/permissions`), chạy git CLI qua `blocking`, dùng lại `toplevel` và `checked_branch` của `changes.rs`:
    - `worktree_create { root, base, slug } -> { path, branch }`: tạo branch `<prefix><slug>-<4 ký tự ngẫu nhiên>` từ `base`; tạo worktree tại `<repo>/.agentdeck/worktrees/<slug>`; thêm `.agentdeck/worktrees/` vào `.git/info/exclude` (không sửa `.gitignore` của dự án).
    - `worktree_list { root }`: path, branch, base, HEAD, dirty, ahead/behind so với base, lần sửa cuối.
    - `worktree_status { path }`: như trên cho một worktree.
    - `worktree_sync { path, base }`: merge `base` vào branch của worktree. Trả về danh sách file xung đột nếu có; không tự giải quyết xung đột.
    - `worktree_merge { root, path }`: merge branch của worktree vào branch đang checkout ở checkout chính. Từ chối nếu checkout chính đang dirty. Xung đột thì dừng và trả danh sách file (không để repo ở trạng thái merge dở: `git merge --abort` nếu người dùng chọn hủy).
    - `worktree_remove { path, delete_branch, force }`: dừng tiến trình trong worktree trước. Từ chối nếu dirty, trừ khi `force`. Không xóa branch chưa merge, trừ khi `force`.
- Lỗi dùng `thiserror`. Không `unwrap()`. Log bằng `tracing`.
- Đường dẫn dài trên Windows: giữ slug ngắn (≤24 ký tự). Nếu `git worktree add` lỗi vì đường dẫn dài, báo rõ cho người dùng.

**W2. Phiên gắn với worktree. — Cao**

- `SessionItem.worktree?: { path, branch, base, createdAt, state: 'active' | 'merged' | 'removed' }` (`state.svelte.ts`). Lưu bền cùng session.
- `cwdOf` ưu tiên `session.worktree.path` khi `state === 'active'`, rồi mới tới project path. Mọi chỗ khởi động CLI, `browser_serve`, Changes panel, `run_checks`, `openProjectFile` đều đi qua `cwdOf`. Rà các chỗ đang lấy thẳng `project.path`.
- Phiên worktree vẫn thuộc project gốc: nằm dưới project trong sidebar (`tree.svelte.ts`), không thành project mới. Khi nhập lịch sử CLI (`crates/adapters/src/history`), map cwd của worktree về project gốc.
- Hội thoại CLI chạy với `cwd` là worktree. Rà từng adapter (Claude, Codex, Copilot, OpenCode, Antigravity, Command Code, custom) để chắc chúng dùng `cwd` được truyền vào, không tự dò lên repo gốc.

**W3. Tạo phiên worktree. — Cao**

- Menu "Chat mới": thêm "Chat mới trong worktree".
- Composer của chat mới: thêm toggle "Worktree riêng" và chọn branch gốc (mặc định là branch đang checkout).
- `propose_session` (Phase 7, H3) thêm trường `isolation: 'worktree' | 'shared'`. Các đề xuất cùng `parallel_group` mặc định là `worktree`.
- `delegate_task` (worker sửa file) có thể chạy trong worktree khi người gọi yêu cầu, hoặc khi hai worker có write scope chồng nhau.
- Cài đặt (`.agentdeck/worktree.json`, commit cùng repo, tùy chọn):
    - `prefix` của branch (mặc định `agentdeck/`);
    - `setup`: lệnh chạy sau khi tạo worktree, ví dụ `pnpm install --offline`. Chạy trong worktree, hiện tiến độ, cần người dùng bật;
    - `include`: danh sách file chưa track được chép sang worktree, ví dụ `.env.local`. Chỉ chép khi người dùng đồng ý lần đầu. Không bao giờ commit những file này.

**W4. UI. — Cao**

- Hàng phiên trong sidebar: badge tên branch, chấm trạng thái (dirty, ahead/behind).
- Header của phiên: base, số commit ahead/behind, số file thay đổi, và các nút: Cập nhật từ base, Merge về base, Mở thư mục, Mở terminal ở đây, Xóa worktree.
- Changes panel, Preview, terminal tự theo `cwdOf` của phiên.
- Màn quản lý worktree của project (Settings hoặc Tasks): danh sách, dung lượng đĩa, lần dùng cuối, nút dọn dẹp.
- Theo quy tắc UI trong `AGENTS.md`: popover dùng `ZPopover`/`PickerPopover`, menu dùng `Menu`/`MenuButton`, xác nhận nguy hiểm dùng `zModalService.danger`.

**W5. Gợi ý tách worktree (agent và harness). — Cao**

- Mô tả tool `propose_session` dạy agent đề xuất `isolation: 'worktree'` khi:
    - việc sẽ thành một branch hoặc PR riêng;
    - việc chạy song song với việc khác trong cùng repo;
    - thử nghiệm rủi ro (refactor lớn, nâng cấp dependency) mà người dùng có thể muốn bỏ;
    - checkout chính đang có thay đổi chưa commit thuộc việc khác.
- Không đề xuất khi: sửa nhỏ, vài lệnh, hoặc việc là một phần của việc đang làm.
- Thêm vào catalog H11 nhóm `worktree`:
    - `worktree.new_task`: tách việc sang phiên worktree mới (`via: 'session'`, isolation worktree);
    - `worktree.sync`: cập nhật từ base (`via: 'app'`, `confirm`);
    - `worktree.merge`: merge về base (`via: 'app'`, `irreversible`, qua `zModalService.danger`);
    - `worktree.resolve`: nhờ agent giải xung đột merge (`via: 'reply'` với danh sách file xung đột);
    - `worktree.cleanup`: xóa worktree đã merge và sạch (`confirm`);
    - `worktree.pr`: mở PR từ branch của worktree bằng `gh` nếu có (`confirm`, không tự push trước khi hỏi).
- Thêm luật vào H12:
    - người dùng yêu cầu việc mới trong khi checkout chính dirty → `worktree.new_task`;
    - plan có ≥2 phase độc lập → đề xuất các phase đó dạng worktree, cùng `parallel_group`;
    - phiên worktree xong việc (report `done`, kiểm tra pass) → `worktree.merge` ở chat chính;
    - base đã đi trước ≥N commit → `worktree.sync`;
    - worktree đã merge và sạch → `worktree.cleanup`;
    - worktree không dùng > 7 ngày → gợi ý dọn (điểm thấp, ở menu "Thêm").

**W6. Luồng merge về chat chính. — Cao**

- Phiên worktree gọi `report_back` (H3) khi xong. Report có `Changes` và `Verify` (Phase 6).
- Chat chính nhận report, hiện ô bước tiếp theo với nút "Merge <branch>".
- Bấm Merge thì kiểm tra trước: checkout chính sạch, branch worktree không có thay đổi chưa commit (nếu có thì gợi ý commit trong worktree trước, chỉ commit, không push).
- Merge bằng `worktree_merge`. Có xung đột thì hiện danh sách file và nút "Nhờ agent giải" (`worktree.resolve`, chạy trong chat chính); xong thì chạy kiểm tra.
- Sau khi merge xong: đánh dấu `worktree.state = 'merged'`, gợi ý `worktree.cleanup`.
- Không push. Push là hành động riêng, luôn xác nhận.

**W7. Giới hạn và dọn dẹp. — Cao**

- Cap 3 phiên worktree đang chạy cùng lúc. Phiên thứ 4 chờ trong hàng, hiện rõ là đang chờ.
- Khi app khởi động: đối chiếu `worktree_list` với các session. Worktree mồ côi (không còn session) hiện trong màn quản lý, không tự xóa.
- Xóa worktree:
    - dừng dev server và tiến trình CLI đang chạy trong đó trước (`process_registry`);
    - dirty thì hỏi bằng `zModalService.danger`, ghi rõ số file sẽ mất;
    - branch chưa merge thì không xóa branch, trừ khi người dùng chọn rõ.

**W8. An toàn. — Cao**

- Không bao giờ tự merge, tự xóa worktree hay tự xóa branch. Kể cả khi bật toggle "tự chạy phase kế tiếp" (H10).
- Không chép file bí mật sang worktree khi người dùng chưa đồng ý (W3 `include`). Không đưa chúng vào commit.
- Kiểm tên branch bằng `checked_branch`. Không truyền chuỗi người dùng nhập thẳng vào lệnh shell.

**W9. Kiểm thử. — Cao**

- Test Rust với repo git tạm (không gọi mạng):
    - create / list / status / sync (có và không có xung đột) / merge (sạch, xung đột, checkout chính dirty bị từ chối) / remove (dirty bị từ chối, force);
    - tên branch không hợp lệ bị từ chối;
    - `.git/info/exclude` được thêm đúng một lần.
- Test node: `cwdOf` ưu tiên worktree; luật H12 của nhóm `worktree`; cap 3 phiên.
- App thật:
    1. Plan 2 phase độc lập → hai đề xuất worktree → "Chạy tất cả" → hai phiên chạy trên hai branch, checkout chính không đổi.
    2. Một phiên xong → chat chính có "Merge <branch>" → merge sạch → gợi ý dọn → xóa worktree.
    3. Phiên còn lại xung đột khi merge → "Nhờ agent giải" → kiểm tra pass → merge.
    4. Hai worktree cùng chạy dev server → hai cổng khác nhau, Preview đúng worktree.
    5. Xóa worktree đang dirty → modal cảnh báo, hủy được.

### 8.3 Cần chủ dự án quyết định trước khi làm

1. Vị trí worktree: trong repo (`<repo>/.agentdeck/worktrees/`, giống cách Claude Code dùng `.claude/worktrees`) hay thư mục bên cạnh repo (`<repo>-worktrees/`). Trong repo thì dễ tìm hơn, nhưng một số công cụ quét thư mục có thể quét cả vào đó.
2. Có tự chạy lệnh `setup` (vd. `pnpm install`) sau khi tạo worktree không, hay chỉ gợi ý.
3. Merge kiểu `--no-ff` (giữ dấu vết branch) hay fast-forward khi được.

### 8.4 Thứ tự

- Làm sau Phase 7 H3 (phiên phase), vì W3/W5/W6 dùng `propose_session`, `report_back` và catalog H11.
- W1, W2, W4 (tạo worktree bằng tay, chạy chat trong worktree) làm được sớm hơn, ngay sau Phase 1, nếu người dùng muốn dùng worktree thủ công trước.

---

## Kịch bản kiểm thử tay trước mỗi release (chạy `pnpm dev`, app thật)

1. Stop trong lúc đang đổi credential (auto-switch bật).
2. Stop trong lúc chờ retry sau lỗi transient.
3. Đổi model/provider khi turn đang chạy → áp sau khi turn xong; lỗi của turn cũ xoay đúng scope.
4. Lỗi limit với auto-switch tắt → chuyển sang provider khác (không phải model khác cùng tài khoản).
5. Lỗi limit với auto-switch bật, hết tài khoản → resume card, không sang provider khác.
6. Hai worker delegate xếp hàng sau một lead; dừng lead → cả hai dừng, không có hand-back mồ côi.
7. Worker delegate gặp limit, recovery thất bại → chat cha nhận report failed.
8. Reload app khi đang delegate (wait=true và wait=false) → chat cha nhận "stopped: app restarted".
9. Codex/Copilot chạy 2+ sub-agent song song → không giật; Work tray đóng đúng mọi child.
10. agy chạy sub-agent → Work tray không còn dòng "running" sau khi xong.
11. Xóa/tắt một connector đang được chat dùng → chat báo provider không khả dụng, không tự nhảy sang provider khác.
12. Reload app, chat nền đặt quyền `ask` trong khi chat đang mở đặt `yolo` → turn nền chạy với `ask`.
13. Worker làm việc nhiều bước → card ở chat cha và Work tray hiện tiến độ `n/m · bước hiện tại`; khi xong, report hiện đủ STATUS, SUMMARY, Steps, Changes, Verify, Open.
14. Worker trả lời rất dài và không có `## Handoff` → cha vẫn nhận phần đầu, phần cuối và Run facts; `task_status` với `full=true` trả câu trả lời đầy đủ.
15. Worker báo "pass" nhưng lệnh kiểm tra thật sự fail → hand-back có cảnh báo và cha sửa thay vì chỉ tóm tắt.
16. Việc lớn nhiều phase → task list ghim, nút "Rà plan", đề xuất phiên cho phase 1.
17. Phiên phase báo về → chat chính đánh dấu bước xong và đề xuất phase kế; không tự chạy khi toggle tự động tắt.
18. Kết thúc lượt có thay đổi git → nút "Commit" (không push); không bao giờ tự commit.
19. Chat dài vượt ~70% context → một gợi ý tách phiên/nén, không lặp lại.
20. Provider không gọi `next_step` → vẫn có ô bước tiếp theo do AgentDeck suy ra, có nhãn phân biệt.

## Báo cáo khi xong mỗi PR

- Danh sách mục đã làm (theo ID, vd. A1, B3), mục đã kiểm chứng là không đúng và bỏ qua (kèm lý do).
- Kết quả thật của các lệnh DoD ở mục 0.3 (lỗi có sẵn ghi riêng).
- Kịch bản tay đã chạy và kết quả; kịch bản chưa chạy được thì ghi rõ.
