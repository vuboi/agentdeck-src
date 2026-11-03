# plan-connectors-cli: CLI "Not installed" sau update, card account thiếu, Antigravity mất account

Ngày: 2026-11-03. Base: `fix/plan-phase0-batch1` (HEAD `31fa4b7`, v0.1.72).
Phạm vi: Settings → Connectors (`ConnectorsSection.svelte`, `connectors.svelte.ts`) và backend `apps/desktop/src-tauri/src/connectors*`.

Thứ tự làm: A → B → C → D → E. Mỗi mục một commit riêng.

---

## Triệu chứng (người dùng báo)

1. Update app xong, card CLI báo **Not installed** và hiện nút **Install**, dù CLI vẫn còn trên máy (ảnh: Antigravity "Not installed").
2. Login xong OpenCode, Muse Code, WorkBuddy, Command Code thì không có card account. Command Code vẫn hiện nút **Sign in** sau khi đã login.
3. Antigravity đã lưu nhiều account. Sau mỗi lần update chỉ còn 1 card dùng được; các account khác bắt login lại.
4. Có lúc login CLI bị mất (chưa có bằng chứng, xem mục E).

---

## Kết quả debug (bằng chứng)

### Máy người dùng (đọc lúc 2026-11-03)

| Kiểm tra                                 | Kết quả                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `where agy`                              | `C:\Users\boi.vn\AppData\Local\agy\bin\agy.exe` (có cài)                                  |
| User PATH (registry)                     | có `C:\Users\boi.vn\AppData\Local\agy\bin`                                                |
| Tiến trình app                           | `C:\Users\boi.vn\AppData\Local\AgentDeck\agentdeck-desktop.exe`, khởi động lại lúc update |
| `where codex/opencode/codebuddy`         | `%LOCALAPPDATA%\pnpm\*.CMD`                                                               |
| `npm root -g`                            | `%LOCALAPPDATA%\mise\installs\node\24.19.0\node_modules`                                  |
| Bản trùng                                | `codex` pnpm 0.163.0, npm(mise) 0.166.0; `opencode` pnpm 2.2.2, npm(mise) 2.2.5           |
| `command-code`                           | chỉ có trong thư mục Node của mise, không có trên PATH của shell                          |
| mise                                     | `node 24` (theo major), thư mục theo bản `24.19.0`                                        |
| `~/.agentdeck/antigravity-accounts.json` | đủ 4 account                                                                              |
| Credential Manager                       | đủ 4 target `AgentDeck Antigravity <hex email>` và `gemini:antigravity`                   |
| `command-code status --json`             | `{"authenticated":true,"version":"1.88.2","user":"vuboi","model":"…"}`                    |
| `opencode auth list --format json`       | danh sách provider (`opencode-go`, `msg_agent`), mỗi provider có `connections`            |

### A. CLI "Not installed" sau update (nguyên nhân chính)

- Chat dò binary bằng `resolve_binary` (`crates/adapters/src/agent/resolve.rs:386`). Thứ tự dò: đường dẫn ghim, `provider.candidates()`, PATH, `common_dirs`, login shell. Với agy, `candidates_for` có `%LOCALAPPDATA%\agy\bin\agy.exe` (`crates/adapters/src/agent/antigravity.rs:50`).
- Settings dò bằng `which()` (`apps/desktop/src-tauri/src/connectors/runtime.rs:21`), gọi từ `connectors_detect` (`connectors.rs:671`). `which()` chỉ tìm trong `augmented_path()`: PATH của tiến trình app cộng `common_dirs`. Nó không dùng `candidates()`, và `common_dirs` không có `%LOCALAPPDATA%\agy\bin`.
- PATH của tiến trình app là PATH lúc app được mở. Sau update, installer mở lại app và app thừa hưởng môi trường cũ. Nếu CLI được cài trong lúc app đang chạy (vd. AgentDeck chạy `install.ps1` của agy), PATH đó không có thư mục mới, dù registry đã có.
- Kết quả: chat vẫn chạy agy được, nhưng card báo **Not installed**. Mọi CLI nằm ngoài `common_dirs` đều bị lỗi này.

### B. Card Command Code không đổi sau khi login

- `loginOf` (`ConnectorsSection.svelte:182-188`) chỉ ánh xạ `agy → antigravity` và `muse-code → muse_code`. Các id còn lại đọc `detected[id]`. Với `command-code`, nó đọc `detected['command-code']`, trong khi backend trả key `command_code` (`connectors.rs` struct `Detected`). Vì vậy `info` luôn là `undefined`: không có "Signed in", nút vẫn là "Sign in".
- `login_from_status` (`connectors/commandcode.rs:78`) bỏ qua `user` và `model`, dù CLI có trả.

### C. Không có card account cho OpenCode, WorkBuddy, Muse Code, Command Code

- Chỉ card có `accounts` (claude, codex, copilot: `ConnectorsSection.svelte:97,112,146`) và `agy` mới có khối account. Bốn connector này chỉ có dòng header.
- Backend không trả thông tin danh tính:
    - OpenCode `login_status` (`connectors/opencode.rs:18`): `logged_in = out.ok`, nên báo đã login cả khi danh sách rỗng. Bỏ qua danh sách provider.
    - WorkBuddy (`connectors/workbuddy.rs:68`), Muse Code (`connectors/muse_code.rs:18`): chỉ kiểm tra token có trong Credential Manager, không có email.
    - Command Code: xem B.

### D. Antigravity: chỉ 1 account dùng được sau update

- Dữ liệu **không mất**: file index và 4 credential vẫn còn (xem bảng trên).
- `read_agy_quotas` (`connectors/antigravity.rs:710`) đọc quota account không active bằng token đã lưu của account đó. Access token sống khoảng 1 giờ. Chỉ account active được agy tự gia hạn (`agy_saved_active_email` chép token mới vào bản lưu, dòng 274-284).
- `fetch_agy_summary` (dòng 540-546) trả `"the Antigravity sign-in has expired: run agy once to renew it"` khi token hết hạn.
- UI `needsAgyLogin` / `authFailure` (`ConnectorsSection.svelte:299-308`) bắt chữ `expired` trong lỗi, nên hiện nút đỏ "Sign in again" và không có quota.
- App đóng hơn 1 giờ (hoặc update, vốn đóng rồi mở lại app) thì mọi account không active đều trông như phải login lại. Thật ra token gia hạn được (`refresh_token` vẫn còn, `agy_credential_status` không báo expired).
- Quota từng account (`agyAccountQuotas`) không được lưu vào `SavedAccountCache` (`connectors.svelte.ts:406-418`), nên sau khi mở lại app không có số cũ để hiện.

### E. CLI bị cài trùng chỗ, có thể mất CLI khi Node của mise đổi bản

- `connector_install` → `node_tool` (`connectors.rs:841-849`) luôn ưu tiên `npm` hơn `pnpm`, không xét CLI đang nằm ở đâu.
- Tự cập nhật (`AUTO_UPDATE` + `updateOutdated`, `connectors.svelte.ts:717-745`) chạy ở lần dò đầu tiên của mỗi lần mở app (`latestCheckedAt = 0`). Mỗi lần update hoặc mở lại app, CLI cũ hơn npm sẽ bị `npm install -g` vào `mise\installs\node\24.19.0`. CLI gốc cài bằng pnpm vẫn ở `%LOCALAPPDATA%\pnpm`, nên mới có 2 bản lệch version.
- `assemble_path` (`resolve.rs:281`) xếp thư mục có `node.exe` (thư mục mise) trước PATH cha. App dùng bản npm/mise, terminal dùng bản pnpm.
- Rủi ro (chưa tái hiện): mise chuyển sang Node 24.x mới và dọn bản cũ thì mọi CLI cài bằng npm trong `24.19.0` biến mất cùng, và card báo Not installed.
- Rủi ro (chưa tái hiện): `connector_update_idle` (`connectors.rs:826`) chỉ bỏ qua khi có chat turn (`agent_busy`). Nó không bỏ qua `opencode serve` (`opencode_serve.rs`) hay tiến trình codex chạy nền. Trên Windows, npm/pnpm cập nhật binary đang chạy có thể lỗi `EBUSY`/`EPERM` giữa chừng, để lại CLI hỏng.

### Login CLI bị mất (chưa có bằng chứng)

- App không ghi `~/.claude`, `~/.codex`, `~/.gemini`. Login được đọc trực tiếp (`claude auth status`, registry của codex-auth).
- Nghi vấn còn lại: hai bản CLI lệch version (E) đọc/ghi login khác nhau. Kiểm tra lại sau khi xong E.

---

## Kế hoạch sửa

### A. Settings dò CLI giống chat (ưu tiên 1)

1. `connectors/runtime.rs`: thêm `fresh_path()` cho Windows. Hàm đọc PATH User (`HKCU\Environment\Path`) và Machine (`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path`) từ registry, mở rộng `%VAR%`, rồi nối vào sau PATH của tiến trình. Cache theo TTL sẵn có (`CACHE_TTL` 60s).
2. `resolve.rs` `build_augmented_path`: dùng PATH tiến trình + PATH registry làm `current`. Child process nhận PATH mới luôn, kể cả khi app được mở lại từ installer.
3. `connectors_detect` (`connectors.rs:671`): với connector có `Provider` (claude, codex, agy, opencode, copilot, command-code), dò bằng `ag_adapters::agent::runner::resolve_binary` hoặc `provider.candidates()` trước rồi mới tới `which`. Cách nhỏ nhất: thêm `candidates` cho `which` theo id (agy: `%LOCALAPPDATA%\agy\bin\agy.exe`).
4. Thêm `%LOCALAPPDATA%\agy\bin` vào `common_dirs` Windows (`resolve.rs:69`).
5. Test: `which_finds_agy_in_local_appdata_without_path` (thư mục tạm, không gọi mạng), và test `fresh_path` nối không trùng.

### B. Command Code hiện đúng trạng thái login

1. `ConnectorsSection.svelte` `loginOf`: thêm `if (id === 'command-code') return detected.command_code;`. Kiểm tra lại các chỗ khác đọc `detected[id]` theo id có gạch ngang (`connectors.svelte.ts` `refreshConnector`, badge).
2. `commandcode.rs` `login_from_status`: lấy `user` vào `email` (hoặc `detail`: `user · model`). Sửa test sẵn có, thêm trường hợp có `user`.

### C. Card account cho OpenCode, WorkBuddy, Muse Code, Command Code

1. Backend `Login` thêm field tùy chọn `accounts: Vec<LoginAccount { id, label, kind }>`, hoặc dùng `email` / `detail` nếu chỉ có 1 account.
    - OpenCode: parse `auth list --format json`; `logged_in = !list.is_empty()`; mỗi `connection` là một dòng (`name` + `label`).
    - Command Code: 1 dòng `user` + `model`.
    - WorkBuddy / Muse Code: **cần kiểm tra trước khi code**: token lưu có phải JWT có claim `email`/`sub` không. Có thì giải mã cục bộ (không gọi mạng). Không có thì card ghi "Device sign-in", không có email.
2. UI: một khối "Signed-in account" cho 4 connector này, chép style card của khối Antigravity (cùng `rounded-lg border p-3`, grid `sm:grid-cols-2`). Nút Sign out giữ chỗ cũ. Không thêm màu hay badge mới.
3. Chụp màn hình, so với tab Codex và Antigravity.

### D. Antigravity giữ đủ account sau update

1. Backend: gia hạn token cho account không active. Khi `expiry <= now + 30` và có `refresh_token`, gọi endpoint token OAuth của Google (`grant_type=refresh_token`), rồi ghi lại vào target `AgentDeck Antigravity <hex>` của account đó. **Không đụng** `gemini:antigravity`.
    - **Cần kiểm tra trước**: `client_id` (và secret nếu là desktop client) mà agy dùng. Tìm trong token JSON, file cấu hình agy, hoặc binary agy. Đưa URL và client vào `endpoints.json` như các endpoint khác.
    - Không lấy được client: bỏ D1, làm D2 + D3 (account vẫn chuyển được vì agy tự gia hạn khi chạy).
2. Backend: trả lỗi có mã `error_kind: "renewable" | "auth" | "network"` trong `AgyAccountQuota`, thay vì UI phải dò chữ.
3. UI `needsAgyLogin`: chỉ hiện "Sign in again" khi `error_kind === "auth"` hoặc `account.expired`. `renewable` thì hiện chữ xám "Token renews when this account is used" và giữ quota cũ.
4. `saveAccountCache` lưu thêm `agyAccountQuotas`, nạp lại trong `accountCacheReady`.
5. Test Rust: token hết hạn có `refresh_token` → `renewable`; không có `refresh_token` → `auth`.

### E. Cài/cập nhật CLI đúng chỗ, không cài trùng

1. `connectors.rs`: thêm `install_owner(path) -> Owner { Pnpm, Npm { node_dir }, Vendor, Unknown }`.
    - Path trong `PNPM_HOME` hoặc `%LOCALAPPDATA%\pnpm` → `pnpm add -g`.
    - Path trong `npm prefix -g` → npm của đúng Node đó.
    - `.local\bin\claude.exe`, `agy\bin` → installer của vendor.
2. `connector_install`: khi CLI đã có (update), dùng `install_owner` của path đang dò được. Cài mới: có pnpm global (`PNPM_HOME`) thì ưu tiên pnpm, nếu không mới dùng npm. Khi npm prefix nằm trong thư mục Node theo version (`mise\installs\node\<ver>`, `nvm\<ver>`), ghi một dòng cảnh báo vào log connector.
3. `connector_update_idle`: bỏ qua khi binary đang được dùng: `opencode serve` đang chạy, tiến trình codex nền, hoặc `agent_busy`. Thêm hàm kiểm tra theo id.
4. `updateOutdated` (`connectors.svelte.ts:732`): không tự cập nhật khi `install_owner` là `Unknown`, hoặc khi dò thấy 2 bản. Lúc đó card hiện dòng chữ "2 copies found: <path1>, <path2>".
5. `connectors_detect`: trả thêm `copies: Vec<String>` cho mỗi tool (tìm tên đó trong mọi thư mục của PATH tăng cường).
6. Test: `install_owner` cho các path mẫu pnpm / mise / vendor.

### Dọn máy hiện tại (người dùng tự chạy, sau khi xong E)

Giữ một bản cho mỗi CLI. Ví dụ giữ bản pnpm, gỡ bản npm trong mise:

```bash
npm uninstall -g @openai/codex @opencode/cli
```

`command-code` và `copilot` hiện chỉ có bản npm/mise. Giữ nguyên, hoặc cài lại bằng pnpm rồi gỡ bản npm.

---

## DoD (chạy và báo kết quả thật)

```bash
pnpm check
```

```bash
pnpm test
```

```bash
pnpm lint
```

Kiểm tra tay trong app thật (bản build, không dùng mock):

1. Mở app từ installer (giả lập update) → tab Antigravity báo đã cài, có version.
2. Login Command Code → card hiện "Signed in" và user.
3. Tab OpenCode, WorkBuddy, Muse Code có card account.
4. Đóng app hơn 1 giờ, mở lại → đủ 4 card Antigravity, không có nút đỏ "Sign in again" cho account còn `refresh_token`.
5. Có bản CLI cũ hơn npm → tự cập nhật đúng chỗ đang cài, `where <cli>` không sinh bản thứ hai.

Xóa ảnh chụp và file thử trước khi xong (`pnpm clean:junk`).
