# Bug — Card hỏi đáp (`agentdeck-ask`) không mở khi chat còn việc chạy nền

- Ngày: 2026-11-04
- Provider gặp lỗi: `command-code` (cùng nhóm nguyên nhân với `workbuddy`)
- Chat thử: `claude:cbf2d018-147e-46cb-a5fe-48a89d8c3213` (project msg-new-template)
- Liên quan: `docs/bugs/2026-11-04-command-code-run-project.md` (cùng họ nguyên nhân RC4/RC5)

---

## 1. Triệu chứng

1. Agent trả lời có một block `agentdeck-ask …` **hợp lệ** (2 câu hỏi, JSON đúng) rồi dừng lượt.
2. Chat **không mở card hỏi đáp**. Nội dung chỉ hiện dưới dạng bước (`Asked 1 question` + danh sách câu hỏi/option) trong transcript, user không bấm trả lời được.
3. Cùng lúc đó chat vẫn "bận": tin nhắn gửi thêm bị đẩy vào queue chứ không tới agent.

Kỳ vọng: câu hỏi hiện thành card ở trên ô nhập (ComposerDock) để user chọn và gửi trả lời.

---

## 2. Tái hiện

1. Mở chat với provider **command-code** cho một project có dev server (msg-new-template).
2. Nhắn `chạy project` — agent chạy server bằng shell nền của chính nó (vì thiếu MCP tools, xem file bug kia).
3. Đợi quá 20 s (`SHELL_WAIT_MS`) để lane được nhả.
4. Trong lúc đó gửi thêm một tin bất kỳ.
5. Agent kết thúc lượt bằng block `agentdeck-ask` → **không có card hỏi đáp**, cũng không có phản hồi nào thêm.

Đối chiếu: cùng kịch bản trên provider `claude` thì card mở bình thường (vì `canSendWhileWaiting` chỉ cho `claude` đi đường tắt, xem RC2).

---

## 3. Bằng chứng (flow log)

File: `%APPDATA%/dev.agentdeck.desktop/logs/debug.log` (dòng 5381, 5490, 5525-5526, 5704, 5751, 5753).

```
09:20:30 send        turn=local-mw1wp3y63235 agent=command-code resume=false
09:21:28 deliver     turn=local-mw1wp3y63235 reason=shell>20s call=call_00_shz7...
09:23:15 queue       sending one waiting message (0 remain)
09:23:15 send        turn=local-mw1wsnmcurvy agent=command-code resume=false  <-- tin của user thành LƯỢT PRIMARY MỚI
09:26:40 reply end   turn=local-mw1wp3y63235 error stopped                    <-- lượt mang câu hỏi bị thay/kết thúc
09:26:40 send        turn=local-mw1wx191f8yh agent=command-code resume=true
```

Đọc được từ log:

- Tin gửi trong lúc chờ background shell bị xếp `queue`, rồi được phát ra như một lượt **primary** mới (`worker=false`), không phải lane listener.
- Lượt đang chạy (đang/đã ghi block câu hỏi) kết thúc bằng `error … stopped` — đúng cơ chế "lượt mới thay lượt cũ".
- Sau đó tin nhắn user mới nhất nằm **sau** block câu hỏi ⇒ mọi hàm tìm câu hỏi đều trả rỗng ⇒ không bao giờ có card.

---

## 4. Nguyên nhân

### RC1 — Card chỉ hiện cho reply KHÔNG còn `live`, và chỉ tính các message SAU tin nhắn user cuối cùng

`apps/desktop/src/lib/components/chat/Chat.svelte:559-590` — `pendingQuestion`:

```
for (let index = chat.messages.length - 1; index >= 0; index--) {
    if (chat.messages[index].role === 'user') { lastUser = index; break; }
}
for (let index = chat.messages.length - 1; index > lastUser; index--) {
    const message = chat.messages[index];
    if (message.role !== 'assistant' || message.live || message.cancelled) continue;
    ... parseQuestions(block.text) ...
}
```

Cùng điều kiện ở `apps/desktop/src/lib/chat/session/run.svelte.ts`:

- `1487-1518` `pendingInput()`: gặp message `role === 'user'` là `return null`.
- `1531-1544` `openQuestions()`: gặp message user là `return []`.

Nghĩa là: reply đang `live`, reply bị `error/stopped`, hoặc có thêm một tin user sau nó ⇒ câu hỏi bị bỏ im lặng.

### RC2 — Tin gửi lúc chờ nền bị `queue` (không vào lane listener) vì `canSendWhileWaiting` khoá cứng vào `claude`

`apps/desktop/src/lib/chat/session/send-while-waiting.ts:20-29`:

```
export function canSendWhileWaiting(state: WaitState): boolean {
    return (
        state.agent === 'claude' &&      // <-- mọi provider khác luôn false
        state.whileRunning === 'queue' &&
        state.backgroundWorkOpen &&
        !state.foregroundTurn &&
        !state.streamingText &&
        !state.needsUserInput
    );
}
```

`command-code` (và codex, opencode, antigravity, workbuddy) vì vậy luôn rơi vào `queue`.

### RC3 — Queue được "xả" thành lượt primary mới, lượt cũ bị thay

`apps/desktop/src/lib/chat/session/events.svelte.ts:1640-1660` — shell quá `SHELL_WAIT_MS` thì `armShellWait` bắn, lane thành `waiting` + `backgroundWork: true` rồi gọi `sendNextQueued(sessionId)`.

`apps/desktop/src/lib/chat/session/run.svelte.ts:689-704` — lượt mới thay lượt cũ:

```
// A turn still marked live is replaced by this one: its events are ignored from now on (see `turns`) ...
if (previous?.live) { previous.live = false; ... }
...
turns[session.id] = turn;
```

`apps/desktop/src/lib/chat/runs/run-lanes.ts:41-56` — `deliveryFor()` chỉ trả `listener` khi lane primary đang `waiting` **và** `backgroundWork`, còn lại trả `queue`. Tin đã nằm sẵn trong queue từ trước thì không đi qua đường này, nên nó ra ngoài dưới dạng lượt primary và kết thúc lượt đang chạy.

### Hệ quả

Lượt mang block câu hỏi bị `stopped`; `lastUser` bị đẩy lên sau block đó ⇒ `pendingQuestion` và `openQuestions` đều rỗng ⇒ card không bao giờ mở, dù block JSON hợp lệ và đã được `parseQuestions` nhận (nó vẫn hiện thành bước qua `askAsStep`).

---

## 5. Hướng sửa (đề xuất)

1. **Không phát tin trong queue thành lượt primary khi lane primary còn `waiting` + background work.** Cho nó đi qua `deliveryFor()` để vào lane listener, nhờ vậy lượt đang chạy giữ nguyên reply và câu hỏi của nó.
2. **Cho card hỏi đáp hiện cả khi reply còn `live`:** khi lượt kết thúc bằng một block câu hỏi hợp lệ, đánh dấu reply ở trạng thái "chờ user trả lời" và bỏ điều kiện `message.live` cho trường hợp này trong `pendingQuestion` (Chat.svelte:559-590).
3. **Không để mất câu hỏi khi lượt bị thay/dừng:** nếu lượt bị replace/stop mà reply cuối có câu hỏi, giữ lại card (hoặc ghi rõ câu hỏi đã bị huỷ) thay vì biến mất im lặng.
4. **Bỏ ràng buộc `state.agent === 'claude'`** trong `canSendWhileWaiting` (send-while-waiting.ts:22) — chỉ cần `backgroundWorkOpen && !foregroundTurn && !streamingText && !needsUserInput`.

---

## 6. Phụ lục — vị trí code

| File                                                       | Dòng                          | Vai trò                                                                                    |
| ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/desktop/src/lib/components/chat/Chat.svelte`         | 559-590 `pendingQuestion`     | Nguồn duy nhất nuôi card trên ComposerDock; bỏ qua `message.live`, chỉ tính sau `lastUser` |
| `apps/desktop/src/lib/components/chat/ComposerDock.svelte` | 62-71                         | Nơi render `QuestionCard` phía trên ô nhập                                                 |
| `apps/desktop/src/lib/components/chat/ChatBlock.svelte`    | 147-151                       | Card trong transcript (cần `showQuestions`)                                                |
| `apps/desktop/src/lib/chat/recovery/questions.ts`          | 22, 33-67, 71-84              | `parseQuestions`, `FENCE`, `askAsStep`                                                     |
| `apps/desktop/src/lib/chat/session/run.svelte.ts`          | 689-704, 1487-1518, 1531-1544 | Lượt mới thay lượt cũ; `pendingInput`; `openQuestions`                                     |
| `apps/desktop/src/lib/chat/session/events.svelte.ts`       | 1631-1661                     | `armShellWait` (>20 s) -> lane `waiting` + `sendNextQueued`                                |
| `apps/desktop/src/lib/chat/session/send-while-waiting.ts`  | 20-29                         | `canSendWhileWaiting` khoá `agent === "claude"`                                            |
| `apps/desktop/src/lib/chat/runs/run-lanes.ts`              | 13-27, 41-56                  | `SHELL_WAIT_MS`, `isLongRunningWork`, `deliveryFor`                                        |
