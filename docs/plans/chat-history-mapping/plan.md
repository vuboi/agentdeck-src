# Plan: mapping lịch sử chat hai chiều (Claude, Codex, Antigravity, Copilot) và sửa lỗi nhảy chat

Ngày: 2026-11-02. Trạng thái: đề xuất, chưa code.

Phạm vi:

- Native → AgentDeck: đọc lịch sử của Claude Code, Codex, Antigravity (agy, trước đây gọi là "gemini"), GitHub Copilot CLI vào một chat AgentDeck.
- AgentDeck → native: một chat AgentDeck (có thể đã đổi qua lại nhiều provider/model) tiếp tục được trong CLI gốc (`claude --resume`, `codex resume`, ...).
- Đổi provider/model xen kẽ trong một chat mà không làm hỏng mapping, không lặp/mất lượt, không nhảy sang chat khác.
- Mapping ngược **không được đụng tới code của người dùng** và **không sửa file lịch sử native đã có**.

Tham khảo: `docs/development/probe-reports/history.md` (định dạng file của từng CLI), `docs/development/chat-flow-review-notes.md`.

---

## 1. Hiện trạng (đã đọc code)

### 1.1 Mô hình dữ liệu

- Toàn bộ mapping chat ↔ session native nằm ở frontend, trong IndexedDB (`prefs.ts`). `crates/store` (SQLite) và `crates/protocol::Session` không được app desktop dùng.
- `SessionItem` (`apps/desktop/src/lib/chat/session/state.svelte.ts:58-103`) giữ id native theo **hai kiểu khác nhau**:
    - agent đầu tiên: `agentSession`, `agentStarted`, `conversationModel`, `agentEpoch`;
    - agent thêm sau: `agentIds[agent] = {id, started, epoch}`, `agentModels[agent]`.
- "Agent đầu tiên" không được lưu, mà được **suy ra** bằng `source ?? agents[0] ?? agent` ở nhiều chỗ (`run.svelte.ts:466`, `events.svelte.ts:1403`, `history.svelte.ts:265`).
- Id chat mới luôn là `claude:<uuid>` dù agent là gì (`state.svelte.ts:908-917`). Chat import dùng `claude:<file stem>` / `codex:<session_meta.id>`. Id chat và id native trộn vào nhau.
- Dữ liệu mapping rải ở nhiều key: `chat.mixed` (alias, agentIds), `chat.otherTurns`, `local.messages.<id>`, `transcript.<id>`, `chat.placements`, `chat.parents`, `index.history`.

### 1.2 Đọc lịch sử native

| Provider         | Reader                                  | Ghi chú                                                  |
| ---------------- | --------------------------------------- | -------------------------------------------------------- |
| Claude           | `crates/adapters/src/history/claude.rs` | Fork/resume đoán bằng message uuid đầu tiên trùng nhau   |
| Codex            | `history/codex.rs`                      | **Không đọc `.jsonl.zst`**: khoảng 2/3 rollout bị bỏ qua |
| Antigravity      | không có                                | Lượt chỉ còn trong IndexedDB                             |
| Copilot          | không có                                | Lượt chỉ còn trong IndexedDB                             |
| OpenCode, custom | không có                                | Ngoài phạm vi plan này, nhưng kiến trúc phải nhận được   |

`Source` enum chỉ có `Claude | Codex` (`history/mod.rs:19-22`).

### 1.3 Định tuyến sự kiện

Sự kiện stream đi theo id chat AgentDeck (`agent.ts:85,512` → `handleAgentEvent`), lọc theo `turn` và `message_id` (`events.svelte.ts:1119-1157`). Phần này đúng. Lỗi nhảy chat **không** nằm ở backend routing.

---

## 2. Nguyên nhân lỗi nhảy chat (xếp theo mức độ)

| #   | Vị trí                                                                                | Lỗi                                                                                                                                                                                                                                                                                | Triệu chứng                                              |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| B1  | `run.svelte.ts:1350` `messagesOf` + `history.svelte.ts:951-995` `readTranscript`      | Sau khi đổi `activeId`, `chat.messages` vẫn là list của chat cũ cho tới khi `await` xong. Gửi tin / auto-turn / `startTurn` trong khoảng đó push vào list chat cũ; `sending.svelte.ts:710` còn gán `localMessages[B] = messages` (mảng của A) nên hai chat **dùng chung một mảng** | Tin nhắn hiện ở chat khác, hai chat "dính" nhau          |
| B2  | `history.svelte.ts:281-293, 389-390`                                                  | Khi một chat có nhiều file native (đổi provider, hoặc đổi model non-Claude), file **mới nhất** thắng và ghi đè `source`/`path`                                                                                                                                                     | Lượt của provider cũ biến mất, `otherTurns` hiện hai lần |
| B3  | `run.svelte.ts:466`                                                                   | `first = session.source ?? ...` đổi theo B2, nên `agentSession` (id Claude) bị resume dưới nhánh Codex, `agentIds.codex` bị bỏ qua                                                                                                                                                 | Resume nhầm session, mất ngữ cảnh, mở thread lạ          |
| B4  | `history.svelte.ts:366`                                                               | Agent sau import = `agents.at(-1)` (agent **thêm sau cùng**, không phải agent đang dùng). Claude→Codex→Claude cho ra Codex, rồi `modelFor` fallback và phát `agent-moved`                                                                                                          | Chat tự đổi provider sau reload                          |
| B5  | `history.svelte.ts:271-276`                                                           | Khóa alias của chat live dùng `source ?? agent`, khác `mixed` dùng `first`                                                                                                                                                                                                         | Một thread Codex hiện thành chat riêng (trùng)           |
| B6  | `history.svelte.ts:425, 460-466`; `content-tabs.svelte.ts:45-55`; `importHistory:216` | Mỗi lần refresh (chạy sau mỗi lượt của chat chưa có file) sắp lại list theo `updatedAt`, có thể đặt `activeId = sessions[0]` hoặc mở draft mới; id thiếu tạm thời làm đóng tab                                                                                                     | Chat đang mở nhảy sang chat khác, tab tự đóng            |
| B7  | `history.svelte.ts:651-664` `toMessages`                                              | Digest `MODEL_LEAD` / `EDIT_LEAD` gửi kèm lượt đầu của session mới không bị lọc khi import                                                                                                                                                                                         | Cả đoạn chat cũ hiện thành một bong bóng user            |
| B8  | `Composer.svelte:372-376, 403-430, 475-500`                                           | Picker không có giá trị lưu thì giữ agent/model/effort của chat trước và ghi vào chat mới; effect effort chạy trước `applyPickerFor`                                                                                                                                               | Chat mới "thừa hưởng" provider của chat cũ               |
| B9  | `events.svelte.ts:406-467` `moveChatTo`                                               | Recovery tự đổi provider của chat                                                                                                                                                                                                                                                  | Provider đổi mà người dùng không bấm                     |
| B10 | `history.svelte.ts:1130`; không có `delete mixed[...]`                                | Xóa chat chỉ đưa `session.path` vào trash; `chat.mixed` không được dọn, file native khác vẫn alias về id đã xóa                                                                                                                                                                    | Chat đã xóa "sống lại" hoặc hút session khác             |
| B11 | `messagesOf` cho chat nền có file native trả `[]`                                     | Digest khi đổi model/recovery của chat nền rỗng; reply nền ghi vào `localMessages` mà `readTranscript` bỏ qua khi đã có path                                                                                                                                                       | Mất ngữ cảnh khi đổi model ở chat không mở               |

Rủi ro backend cần kiểm tra thêm (chưa xác nhận):

- `warm.rs:38,162-196`: khóa warm pool bỏ `--resume/--session-id/--conversation` nhưng Claude truyền id trong config base64 (`agent/claude.rs:124-151`), nên khóa có thể đổi theo conversation, hoặc ngược lại tái dùng process sai.
- `manage.rs:105-110`: rename append vào file mà CLI đang ghi, không lock.
- `agent_warm_reset_session` không dọn Copilot pool (`agent_runs.rs:235-237`).

**Gốc chung:** không có một nguồn sự thật duy nhất cho "chat X gồm những session native nào, mỗi lượt thuộc session nào". Danh tính chat bị suy ra từ file native mới nhất, và danh sách tin nhắn của chat đang mở là một biến toàn cục.

---

## 3. Thiết kế đích

### 3.1 Ba khái niệm

1. **Chat** – id ổn định `ad:<uuid>`, không bao giờ suy ra từ provider. Chat cũ `claude:<uuid>`/`codex:<id>` giữ id cũ (không đổi id để khỏi gãy tab, placement, parent), nhưng id không còn mang nghĩa provider.
2. **Binding** (gắn kết) – một session native thuộc chat:

    ```ts
    interface Binding {
        id: string; // ad-local, ổn định
        provider: AgentId; // claude | codex | antigravity | copilot | ...
        nativeId: string | null; // null tới khi CLI báo id (Codex, agy)
        path?: string; // file native nếu biết
        model: string; // model lúc mở session
        epoch: number; // account epoch
        origin: 'created' | 'imported' | 'exported';
        state: 'pending' | 'live' | 'closed'; // closed = đã bị thay (đổi model/account/edit)
        syncedSeq: number; // seq cuối của ledger mà session này đã "thấy"
        nativeCursor?: { size: number; mtime: number; offset: number }; // để đọc tăng dần
    }
    ```

3. **Ledger** – danh sách lượt chuẩn của chat. Mỗi tin nhắn có `seq` tăng dần, `agent`, `model`, `bindingId`, và `nativeRef = {provider, nativeId, nativeMsgId}` để khử trùng.

Chat có `currentBinding` cho mỗi provider và một `activeAgent` được **lưu**, không suy ra.

Ràng buộc: `(provider, nativeId)` thuộc **tối đa một** chat. Đây là thứ chặn chat trùng và chat "hút" session của nhau.

### 3.2 Nơi lưu

Chuyển mapping xuống Rust, một SQLite `~/.agentdeck/chats.db` (dùng lại `crates/store` nếu hợp, nếu không thì module mới trong `ag-adapters`):

```sql
chats(id PK, title, project_id, cwd, active_agent, created_at, updated_at, deleted_at)
bindings(id PK, chat_id FK, provider, native_id, path, model, epoch, origin, state, synced_seq, cursor_json)
UNIQUE(provider, native_id) WHERE native_id IS NOT NULL
messages(chat_id, seq, role, agent, model, binding_id, native_provider, native_id, native_msg_id, time, blocks_json,
         PRIMARY KEY(chat_id, seq))
UNIQUE(chat_id, native_provider, native_msg_id) WHERE native_msg_id IS NOT NULL
```

Lý do: một transaction cho "ghi lượt + cập nhật binding", có unique constraint, không còn serialize toàn bộ chat mỗi lần lưu (`persistLocal()` hiện serialize mọi chat). Frontend giữ cache theo id, không giữ mảng toàn cục.

Tauri command mới (tên dự kiến): `chat_open(id, page)`, `chat_append(id, messages)`, `chat_bind(id, binding)`, `chat_resolve_native(provider, nativeId) -> chatId?`, `chat_sync_native(id)`, `chat_export(id, provider)`, `chat_delete(id)`.

### 3.3 Native → AgentDeck (import)

1. Reader chung cho mọi provider, cùng trả `HistorySession` / `HistoryMessage` hiện có, thêm `native_msg_id`:
    - Claude: `uuid` của record; nhóm assistant theo `message.id`.
    - Codex: `item.id` / `turn_id`; **đọc thêm `.jsonl.zst`** (crate `zstd`, chỉ đọc).
    - Copilot: `~/.copilot/session-state/<uuid>/events.jsonl`, khóa `messageId`, nhóm theo `turnId`.
    - Antigravity: `~/.gemini/<variant>/brain/<convId>/.system_generated/logs/transcript.jsonl`, khóa `convId:step_index`; turn = `USER_INPUT` tới `PLANNER_RESPONSE` cuối không có tool call. Không giải mã protobuf DB.
    - Mở rộng `Source` thành enum đủ provider; mỗi reader là một module như `claude.rs`/`codex.rs`.
2. Import **tăng dần**: binding giữ `nativeCursor`; chỉ parse phần append. Codex `.zst` đọc lại cả file nhưng chỉ khi `mtime/size` đổi.
3. Gắn vào chat:
    - `(provider, nativeId)` đã có binding → merge vào chat đó.
    - Chưa có → tạo chat mới (`origin: 'imported'`).
    - Không dùng heuristic thời gian/cwd để gắn. Heuristic fork của Claude (uuid đầu trùng) chỉ dùng để đặt `parentId`, không để gộp chat.
4. Merge vào ledger: khử trùng bằng `native_msg_id`. Lượt đã có trong ledger (do AgentDeck ghi lúc stream) được **gắn thêm** `nativeRef`, không thêm dòng mới. Lượt lạ (người dùng resume trong terminal) được chèn **sau `seq` cuối của binding đó**, theo thời gian.
5. Lọc phần AgentDeck tự chèn: mọi ngữ cảnh gửi kèm (digest đổi model, missed turns, edit) được bọc trong marker cố định:

    ```text
    <agentdeck-context v="1" kind="model-switch|missed-turns|edit">...</agentdeck-context>
    ```

    Reader cắt marker này khi import (sửa B7) và vẫn nhận được định dạng cũ (`MODEL_LEAD`, `EDIT_LEAD`, "Earlier in this chat") để tương thích.

6. File native mới nhất **không bao giờ** đổi `activeAgent`, `source`, hay thứ tự lượt (sửa B2, B3, B4).

### 3.4 Đổi provider/model xen kẽ trong một chat

Một hàm thuần duy nhất thay cho hai nhánh `agentSession` / `agentIds` trong `startTurn`:

```ts
resolveBinding(chat, { agent, model, epoch, listener, edited }) =>
    { binding, resume: boolean, catchUp: Message[] }
```

Quy tắc:

| Tình huống                                                             | Binding                                  | resume | catchUp                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------- | ------ | -------------------------------------------------------------- |
| Cùng provider, cùng model (hoặc model đổi live như Claude `set_model`) | binding live hiện tại                    | có     | lượt của provider khác từ `syncedSeq`                          |
| Cùng provider, model đổi, provider không đổi model live                | binding cũ → `closed`, tạo binding mới   | không  | digest cả ledger                                               |
| Đổi account (epoch khác)                                               | như trên                                 | không  | digest cả ledger                                               |
| Provider khác, lần đầu trong chat                                      | binding mới                              | không  | toàn bộ ledger tới nay                                         |
| Quay lại provider đã dùng (Claude→Codex→Claude)                        | binding live của provider đó             | có     | **chỉ** lượt từ `syncedSeq` của binding đó (lượt Codex ở giữa) |
| Edit tin nhắn                                                          | mọi binding → `closed`                   | không  | ledger tới tin đã sửa                                          |
| Listener lane / nền                                                    | binding tạm, không lưu như binding chính | không  | theo lane                                                      |

Sau mỗi lượt xong: `binding.syncedSeq = seq cuối`. Nhờ vậy mỗi provider nhận đúng phần nó bỏ lỡ, không gửi lặp, không gửi thiếu.

`activeAgent` chỉ đổi khi người dùng chọn trong picker. Recovery/fallback (`moveChatTo`) được phép đổi **provider** (đúng quy tắc không tự đổi account), nhưng phải: tạo binding như bảng trên, ghi lượt hệ thống "Đã chuyển sang X vì Y" vào ledger, và hiện thông báo (sửa B9).

Picker: giá trị của chat được đọc từ `chat.activeAgent` + binding; chat mới không có giá trị thì dùng mặc định toàn app, **không** dùng giá trị chat trước. Effect effort/permission chạy sau `applyPickerFor` (sửa B8).

### 3.5 AgentDeck → native (mapping ngược)

Mục tiêu: người dùng mở chat trong CLI gốc và tiếp tục được. Nguyên tắc an toàn (bắt buộc):

1. **Không ghi đè, không append vào file native đã có.** Chỉ tạo session mới (fork) với id mới.
2. **Không tái thực thi tool.** Lệnh và chỉnh sửa file trong quá khứ được ghi thành **văn bản tóm tắt** (lệnh, kết quả rút gọn, file đã đổi), không ghi thành `tool_use`/`function_call` có thể chạy lại. Vì thế export không bao giờ đụng code hay working tree.
3. Ghi file atomic: ghi `*.tmp` trong cùng thư mục rồi rename. Kiểm tra id chưa tồn tại.
4. Chỉ chạy khi người dùng bấm ("Tiếp tục trong CLI"). Không export tự động.
5. Binding tạo ra có `origin: 'exported'`, nên khi import lại thì file đó merge về đúng chat, không thành chat trùng; các lượt export khớp `native_msg_id` đã ghi nên không lặp.

Chiến lược theo provider:

| Provider                                                                              | Cách                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bất kỳ, nếu binding live của provider đó đã thấy hết ledger (`syncedSeq == seq cuối`) | Không ghi gì. Đưa lệnh resume: `claude --resume <id>`, `codex resume <id>`, `copilot --resume <id>`, `agy --conversation <id>`                                                                                         |
| Claude                                                                                | Tạo `~/.claude/projects/<cwd-slug>/<newUuid>.jsonl`: chuỗi `user`/`assistant` text với `parentUuid` nối tiếp, `cwd`, `sessionId`, `timestamp`; thêm `custom-title`                                                     |
| Codex                                                                                 | Tạo `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (không nén): `session_meta`, rồi `response_item/message` user/assistant; thêm dòng vào `session_index.jsonl` (append có lock)                             |
| Copilot                                                                               | Thử nghiệm: `session-state/<uuid>/events.jsonl` + `workspace.yaml`. Bật sau khi kiểm tra resume thật                                                                                                                   |
| Antigravity                                                                           | Không tổng hợp được (step DB là protobuf). Dùng **seed**: mở conversation mới, gửi một lượt `<agentdeck-context kind="missed-turns">` chứa digest, rồi đưa lệnh `agy --conversation <id>`. Lượt seed bị lọc khi import |

Định dạng ghi lấy từ fixture thật (`crates/adapters/tests/fixtures`), có round-trip test: export → reader của chính mình → so ledger.

### 3.6 Chống nhảy chat ở tầng UI

- Bỏ `chat.messages` toàn cục làm nơi ghi. Một store `messagesById: Map<chatId, Message[]>`; view của chat đang mở là `$derived(messagesById.get(activeId))`. Mọi đường ghi (`sending`, `startTurn`, `beginAutoTurn`, recovery) ghi theo **chat id của lượt**, không theo `activeId` (sửa B1, B11).
- `readTranscript` ghi kết quả vào `messagesById.get(id)` với token, không gán mảng của chat này cho chat khác.
- Refresh danh sách không được đổi `activeId` khi chat đang mở vẫn tồn tại trong DB (kể cả chat local chưa có file). Không tự mở draft mới khi chat chỉ thiếu tạm. Tab chỉ đóng khi `chat_delete` thật sự xảy ra (sửa B6).
- Sắp xếp danh sách giữ ổn định: chỉ dời chat khi nó có lượt mới, không dời vì file native được ghi lại.
- Bỏ `importHistory({refresh})` sau mỗi lượt. Thay bằng `chat_sync_native(id)` cho đúng chat đó, chạy debounce.
- Xóa chat: xóa mọi binding (đưa từng file vào trash như hiện nay), xóa ledger, xóa khóa unique (sửa B10).

---

## 4. Lộ trình

Mỗi phase là một nhánh/PR riêng, chạy được độc lập, có test.

### Phase 0 – Hotfix nhảy chat (không đổi lưu trữ)

Mục tiêu: hết triệu chứng nặng ngay, ít rủi ro.

1. B1: `messagesOf` chỉ trả `chat.messages` khi `chat.messagesFor === sessionId` (thêm trường này, gán cùng lúc với `chat.messages`); còn lại trả `localMessages[id]`. Bỏ phép gán `localMessages[B] = messages` dùng chung mảng ở `sending.svelte.ts:710`.
2. B3: lưu `firstAgent` cố định trong `SessionItem` và `chat.mixed`; mọi chỗ `source ?? agents[0] ?? agent` dùng `firstAgent`.
3. B2: alias không ghi đè `source`/`path` của chat đã có `firstAgent`; giữ `paths[]` theo agent và `readTranscript` đọc đúng file của từng binding.
4. B4: lưu `activeAgent` trong `chat.mixed`; import dùng giá trị này.
5. B5: khóa alias dùng `firstAgent`.
6. B6: `applyHistory` giữ `activeId` nếu chat còn trong `workspace.sessions` hoặc `local`; bỏ `newSession` khi thiếu tạm.
7. B7: `toMessages` lọc `MODEL_LEAD`, `EDIT_LEAD`.
8. B8: picker không mang giá trị chat trước; đổi thứ tự effect.
9. B10: `deleteSession` dọn `chat.mixed[id]` và `otherTurns`.

Kiểm thử: `node --experimental-strip-types --test` cho các test mới (đổi chat trong lúc `readTranscript` chưa xong rồi gửi; Claude→Codex→Claude rồi reload; xóa chat có hai binding). `pnpm --filter desktop check`.

### Phase 1 – Reader đủ provider (Rust, chỉ đọc)

1. Codex `.jsonl.zst`.
2. Reader Copilot `events.jsonl`.
3. Reader Antigravity `transcript.jsonl`.
4. `native_msg_id` cho mọi reader; `Source` đủ provider.
5. Cursor đọc tăng dần.

Kiểm thử: fixture cho từng provider trong `crates/adapters/tests/fixtures`, `cargo test -p ag-adapters`, `cargo clippy --workspace -- -D warnings`. Không gọi mạng.

### Phase 2 – Chat index trong Rust (ledger + binding)

1. `chats.db` với schema mục 3.2, migration tự động từ IndexedDB (`chat.mixed`, `local.messages.*`, `chat.otherTurns`, `transcript.*`). Giữ dữ liệu cũ tới khi migration xác nhận xong; có cờ rollback đọc lại IndexedDB.
2. Tauri command mục 3.2; bỏ `history_list` merge ở frontend, thay bằng danh sách từ index.
3. Marker `<agentdeck-context>` cho mọi ngữ cảnh gửi kèm.

Kiểm thử: unit test Rust cho unique `(provider, native_id)`, merge khử trùng, chèn lượt ngoài AgentDeck đúng vị trí; test migration với dump IndexedDB mẫu.

### Phase 3 – `resolveBinding` và store theo chat id

1. Thay hai nhánh trong `startTurn` (`run.svelte.ts:466-591`) bằng `resolveBinding`; `syncedSeq` sau mỗi lượt.
2. `messagesById` thay `chat.messages` (mục 3.6).
3. `moveChatTo` ghi lượt hệ thống + thông báo.

Kiểm thử: ma trận reducer thuần (không mạng) cho bảng mục 3.4, gồm Claude→Codex→Claude→Copilot, đổi model Codex giữa chừng, đổi account, edit, listener lane. Kiểm tra `catchUp` đúng từng trường hợp.

### Phase 4 – Export sang native

1. "Tiếp tục trong CLI" trong menu chat: hiện lệnh resume hoặc export.
2. Writer Claude, Codex (round-trip test). Copilot sau cờ thử nghiệm. Antigravity theo kiểu seed.
3. Kiểm tra thủ công một lần cho mỗi provider: export, chạy lệnh resume trong terminal, hỏi "tóm tắt chat", gửi một lượt, quay về AgentDeck và thấy lượt đó được import vào đúng chat.

### Phase 5 – Dọn dẹp

Xóa `agentSession`/`agentIds`/`chat.mixed`/`otherTurns` khỏi frontend sau một bản phát hành có migration. Cập nhật `docs/development/adding-agent-provider.md`: provider mới phải có reader (nếu CLI lưu lịch sử), khóa `native_msg_id`, cách resume, và chiến lược export.

**Legacy removal (ghi chú):** chỉ xóa code legacy khi đủ cả hai điều kiện:

Đã phát hành ít nhất một bản có chat index migration (`chat_index_migrate`). Không xóa trong cùng bản với migration.

Symbol và key cần xóa:

- Frontend: `agentSession`, `agentIds` (kể cả nhánh đọc/ghi của chúng trong `state.svelte.ts`, `run.svelte.ts`, `events.svelte.ts`, `history.svelte.ts`).
- Alias và cache: `chat.mixed`, `chat.otherTurns`.
- IndexedDB keys: `chat.mixed`, `chat.otherTurns`, và các key mapping khác còn sót sau migration (`local.messages.<id>`, `transcript.<id>`, `chat.placements`, `chat.parents`). Xác nhận từng key trước khi xóa.
- Fallback: `chat.owner` và nhánh `firstAgent` (suy ra bằng `source ?? agents[0] ?? agent`).

Khi code legacy được xóa, chạy lại `cargo test -p ag-adapters` và `pnpm --filter desktop check`.

---

## 5. Tối ưu

- Đọc tăng dần theo cursor thay vì quét lại mọi file mỗi lần refresh; quét thư mục chỉ khi `mtime` thư mục đổi.
- Không parse record nặng: Claude `api-request-blob`, `attachment` (trừ `queued_command`, `task_status`); Codex `world_state`.
- Danh sách sidebar đọc từ bảng `chats`, không đọc transcript.
- Ghi theo chat (một transaction), không serialize toàn bộ chat như `persistLocal()`.
- `chat_sync_native(id)` debounce khoảng 500 ms sau `done`, chỉ cho chat đó.
- Phân trang ledger theo `seq` (thay `history_load_page` theo file).

## 6. Rủi ro

| Rủi ro                                                  | Giảm thiểu                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Định dạng file native đổi theo phiên bản CLI            | Reader chịu lỗi (bỏ qua dòng lạ), fixture theo phiên bản, export chỉ dùng tập record tối thiểu     |
| Export làm CLI từ chối resume                           | Round-trip test + kiểm thử tay mỗi bản CLI; tắt export cho provider đó nếu hỏng, vẫn còn kiểu seed |
| Migration mất dữ liệu                                   | Không xóa IndexedDB tới Phase 5; cờ rollback; test với dump thật (đã ẩn nội dung)                  |
| CLI đang ghi file lúc AgentDeck đọc                     | Chỉ đọc tới dòng hoàn chỉnh cuối cùng; cursor lùi về đầu dòng dở                                   |
| Antigravity không có id tool, không có marker interrupt | Khử trùng bằng `convId:step_index`; chấp nhận độ chính xác thấp hơn                                |

## 7. Tiêu chí hoàn tất

- Đổi chat liên tục khi một chat khác đang stream: không có tin nhắn nào hiện sai chat.
- Claude → Codex → Claude → Copilot trong một chat, reload app: thứ tự lượt giữ nguyên, agent đang chọn giữ nguyên, không có chat trùng trong sidebar.
- Mỗi lần quay lại một provider, prompt gửi đi chỉ chứa phần nó bỏ lỡ (kiểm tra bằng log request).
- Resume trong terminal rồi quay lại: lượt mới hiện đúng chat, không lặp.
- Export: không file native nào có sẵn bị đổi (so hash trước/sau), working tree của project không đổi (`git status` sạch như trước).
- `cargo clippy --workspace -- -D warnings`, `cargo test -p ag-adapters`, `pnpm --filter desktop check` sạch.
