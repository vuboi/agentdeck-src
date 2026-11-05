# Plan: composer predictions (gợi ý prompt tiếp theo)

Ngày: 2026-11-05. Trạng thái: đề xuất, chưa code.

## 0. Mục tiêu

Sau khi agent trả lời xong một lượt, chat hiện **1–3 gợi ý prompt tiếp theo** dạng nút nhỏ, inline ngay dưới câu trả lời cuối.

1. Bấm một gợi ý → điền vào Composer (sửa được), focus Composer. Enter để gửi.
2. Chỉ là gợi ý: không chặn gì, không phải câu hỏi. Khác hẳn `QuestionCard` (AskUserQuestion: agent hỏi và chờ trả lời, có options/multi-select/free text).
3. Gợi ý biến mất khi gửi tin mới, khi lượt mới bắt đầu, hoặc khi Composer đang có chữ.

Ngoài phạm vi bản đầu: lưu gợi ý vào `chats.db`, gợi ý cho lượt cũ (chỉ lượt cuối), ghost-text trong Composer kiểu Tab-to-accept.

## 1. Hiện trạng (đã kiểm tra)

### Provider có sẵn

- **Claude**: Agent SDK `0.3.316` có option `promptSuggestions: boolean` (`sdk.d.ts:2133`), CLI `2.1.318` có `--prompt-suggestions`.
    - Phát `{ type: 'prompt_suggestion', suggestion, uuid, session_id }`, **tối đa 1 gợi ý/lượt**, đến **sau** message `result`.
    - Bị tắt ở lượt đầu tiên, sau lỗi API, ở plan mode, khi gần chạm limit, hoặc khi `promptSuggestionEnabled: false` / `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`.
    - Dùng chung prompt cache của lượt chính nên gần như free.
- **Codex** (`0.163.0`): app-server schema có `thread/prediction/request { threadId, sourceTurnId }` và notification `thread/prediction/updated { result: { type: 'completed', text } | { type: 'failed' } }`. Nhưng binary trả `thread/prediction/request is not implemented yet`. Chưa dùng được, 1 text/lượt.
- OpenCode, Antigravity, CommandCode, WorkBuddy, custom: không có.

=> Native chỉ cho tối đa 1 gợi ý, và lượt đầu không có. Muốn 2–3 gợi ý và phủ mọi provider thì cần một bộ sinh gợi ý phía app.

### Code liên quan

- Claude chạy qua `apps/desktop/src/agent/claude-sdk-runner.mjs` (`options()` dựng option SDK), config từ `sdk_args` ở `crates/adapters/src/agent/claude.rs:106`, parse dòng ở `claude.rs:267`.
- `AgentEvent` ở `crates/adapters/src/agent/mod.rs:30`; bản TS ở `apps/desktop/src/lib/chat/agent.ts:10`.
- Chạy một lần: `runner.rs:352` dừng đọc ngay khi có `Done` (không chờ pipe đóng). Gợi ý đến sau `result` nên **hiện tại sẽ bị mất**.
- Chạy warm: `warm.rs:509` kết thúc lượt ở `Done`, rồi `park` hoặc `tail::start` (`warm.rs:715`). Dòng `prompt_suggestion` đến sau sẽ nằm lại trong pipe, lượt sau đọc phải.
- Sinh gợi ý one-shot đã có tiền lệ: `apps/desktop/src-tauri/src/image_gen.rs:318` (`suggest_with_claude`, `suggest_with_cli`, `suggest_with_custom`) trả JSON gợi ý.
- Frontend: event vào `recordAgentEvent` (`chat/session/events.svelte.ts:1380`); draft Composer ở `drafts[sessionId]` (`chat/session/state.svelte.ts:355`); tin cuối render ở `Chat.svelte:1038` (`AssistantMessage`, list ảo có `measureRow`).

## 2. Thiết kế

### 2.1 Event mới

- Rust: `AgentEvent::Suggestion { text: String }`. TS: `{ kind: 'suggestion'; text: string }`.
- Không tính là nội dung trả lời: không đổi run state, không làm `tail` mở AutoTurn (`tail.rs::is_content` phải trả `false`), watchdog bỏ qua.

### 2.2 Nguồn gợi ý (đề xuất: native + bộ sinh bù)

1. **Native trước**: Claude bật `promptSuggestions`. Codex để sau (Phase 3) khi app-server làm xong.
2. **Bộ sinh bù**: khi lượt xong và native chưa đủ 3 (hoặc provider không có native), gọi one-shot một model rẻ:
    - Input: prompt cuối của user + câu trả lời cuối (cắt ~4k ký tự) + gợi ý native nếu có.
    - Output JSON `{ "suggestions": ["..."] }`, 1–3 câu, cùng ngôn ngữ user, mệnh lệnh ngắn (≤ 80 ký tự), không trùng native.
    - Model: model rẻ của cùng provider (Claude → Haiku), hoặc model chọn trong Settings (giống "prompt suggestion model" của Image).
    - Tái dùng cách gọi CLI one-shot của `image_gen.rs`, không refactor `image_gen.rs`.
    - Tốn thêm token + một tiến trình CLI mỗi lượt => có công tắc riêng, mặc định tắt (xem mục 5).
3. Gộp: native đứng đầu, bỏ trùng (so chuẩn hóa chữ thường, bỏ dấu câu), tối đa 3.

### 2.3 Lấy gợi ý native sau `Done`

- **Chạy một lần** (`runner.rs`): sau `finished`, đọc thêm tối đa `SUGGESTION_GRACE` (~4 s) chỉ để bắt `Suggestion`; dừng ngay khi có gợi ý, EOF hoặc hết giờ. `Done` đã phát trước nên UI không chờ.
- **Warm** (`warm.rs`): sau `Done`, nếu provider hỗ trợ gợi ý thì drain có giới hạn (~4 s) trước khi `park`. Tin mới của chat trong lúc drain thì ngắt drain ngay. Nếu đi `tail`, tail chuyển `Suggestion` ra sink như event thường.
- Event đến sau `done` phải được frontend nhận theo turn id: cần kiểm tra `bridge.rs`/`events.svelte.ts` không bỏ event của lượt đã xong (rủi ro chính, xem mục 4).

### 2.4 State frontend

- `suggestions = $state<Record<string, { turnId: string; items: string[] }>>({})` trong `chat/session/state.svelte.ts`.
- Nhận `suggestion` → thêm vào lượt cuối (dedupe, max 3).
- Xóa khi: gửi tin, lượt mới bắt đầu, chat bị xóa/đổi.
- Hàm thuần `mergeSuggestions(native, generated)` để unit test.

### 2.5 UI

- Component mới `PromptSuggestions.svelte`, render trong `Chat.svelte` ngay dưới `AssistantMessage` của **tin cuối**, cùng cột `max-w-[52rem]`.
- Nút nhỏ hàng ngang, wrap khi hẹp: `ZButton` `zType="outline"` `zSize="sm"`, icon lucide (ví dụ `CornerDownRight`), chữ 1 dòng, truncate, tooltip full text. Copy style chip có sẵn (`ComposerChips` / `ProposalCard`), không màu mới, không badge, không animation trang trí.
- Hiện khi: lượt cuối xong không lỗi/không bị dừng, chat không bận, không có `QuestionCard`/permission/plan đang chờ, Composer rỗng.
- Bấm: `drafts[sessionId] = text`, focus Composer, caret cuối. Không tự gửi.
- Chiều cao: row đo bằng `measureRow` nên list ảo tự cập nhật. Gợi ý đến 1–3 s sau `done` sẽ làm row cao thêm một dòng: chỉ đẩy khi đang dính đáy (theo cơ chế autoscroll hiện có), không thêm hiệu ứng (theo quy tắc "no extra motion").

### 2.6 Cài đặt

- Settings > Chat: "Prompt suggestions" (bật native, mặc định bật) và "Generate extra suggestions" (bộ sinh bù, mặc định tắt) + chọn model.
- Truyền xuống `TurnRequest.prompt_suggestions: bool` → `sdk_args` set `"promptSuggestions"`.

## 3. Các bước

### Phase 1: Claude native (1 gợi ý, nhỏ, gần như free)

| File                                                                                 | Việc                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `crates/adapters/src/agent/mod.rs`                                                   | `AgentEvent::Suggestion`; `TurnRequest.prompt_suggestions`        |
| `crates/adapters/src/agent/claude.rs`                                                | config `promptSuggestions`; parse `prompt_suggestion`; test parse |
| `apps/desktop/src/agent/claude-sdk-runner.mjs`                                       | `promptSuggestions: config.promptSuggestions` trong `options()`   |
| `crates/adapters/src/agent/runner.rs`                                                | grace read sau `Done`; test với provider giả                      |
| `crates/adapters/src/agent/warm.rs`, `tail.rs`                                       | drain có giới hạn trước `park`; tail không coi là nội dung        |
| `apps/desktop/src/lib/chat/agent.ts`                                                 | kiểu event `suggestion`                                           |
| `apps/desktop/src/lib/chat/session/state.svelte.ts`, `events.svelte.ts`              | state + nhận/xóa gợi ý                                            |
| `apps/desktop/src/lib/components/chat/PromptSuggestions.svelte` (mới), `Chat.svelte` | UI inline                                                         |
| Settings (file sẽ xác định khi làm)                                                  | công tắc                                                          |

### Phase 2: bộ sinh bù (2–3 gợi ý, mọi provider)

- `apps/desktop/src-tauri/src/chat_suggest.rs` (mới): command `chat_suggest { provider, model, prompt, reply, existing }` → `{ suggestions }`, timeout 30 s, hủy khi chat gửi tin mới.
- Frontend gọi sau `done` khi bật; bỏ kết quả nếu lượt đã cũ.

### Phase 3: Codex native

- `codex_server.rs`: sau `turn/completed` gọi `thread/prediction/request`; map `thread/prediction/updated` → `Suggestion`. Lỗi "not implemented" thì tắt cho tiến trình đó, không log lỗi người dùng.

## 4. Rủi ro

- Event sau `Done` có thể bị frontend/bridge bỏ vì lượt đã đóng: kiểm tra đầu Phase 1, nếu đúng thì route theo chat id thay vì turn id.
- Drain sau `Done` giữ tiến trình warm thêm tối đa ~4 s: tin mới phải ngắt được ngay.
- Lượt đầu Claude không có gợi ý native (SDK cố ý): chỉ bộ sinh bù lấp được.
- Bộ sinh bù gửi lại nội dung chat cho model: cùng provider của chat nên không lộ thêm bên thứ ba; vẫn không ghi nội dung vào log.

## 5. Cần chốt

1. Nguồn gợi ý: (a) chỉ native (Claude 1 gợi ý, free) — (b) native + bộ sinh bù (1–3, tốn thêm token) — (c) chỉ bộ sinh bù.
2. Bấm gợi ý: điền vào Composer (đề xuất) hay gửi luôn.

## 6. Kiểm tra (DoD)

- `cargo test -p ag-adapters` (parse `prompt_suggestion`, grace read, drain warm), `cargo clippy --workspace -- -D warnings`.
- `pnpm --filter desktop test` (merge/dedupe/xóa khi gửi), `svelte-check` không lỗi.
- Chạy app thật: lượt thứ 2 với Claude hiện nút; bấm điền Composer; gửi thì nút mất; screenshot so với `QuestionCard`/`ProposalCard`.
