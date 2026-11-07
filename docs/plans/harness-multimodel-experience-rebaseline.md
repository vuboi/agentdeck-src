---
title: Rebaseline Harness flow/UI cho đa provider và connector
status: in_progress
agent: Codex
chat:
source: manual
created: 2026-11-07T06:54:43.000Z
updated: 2026-11-07T08:10:18.000Z
---

# Rebaseline Harness flow/UI cho đa provider và connector

## Mục tiêu

Hoàn thiện trải nghiệm Harness trong AgentDeck: session/turn lifecycle, stream, tools/connectors, approvals, child agents, recovery và UI; dùng được xuyên nhiều model provider và connector. DeepSeek là một provider trong danh sách, không phải runtime bắt buộc.

## Trạng thái đã đối chiếu

- Có nền Harness provider-neutral ở orchestrator, event/replay contracts, event projection, approval expiry, child-session identity và stream coalescing.
- Có nhiều đường provider (CLI, custom OpenAI-compatible, Copilot, OpenCode, local) và connector/MCP hiện có; coverage này chưa chứng minh parity runtime/UI.
- DSH SDK/ACP process adapter và live turn chưa được chứng minh đầy đủ. Giữ nó là adapter tùy chọn, không chặn Harness core.
- Checklist còn thiếu provider health/quota/latency và routing; MCP session/sandbox/environment policy; runtime UI projection; native/runtime proof.
- Google Sheets/OAuth ngoài phạm vi.
- Workspace đang có thay đổi chưa commit; trước implementation phải phân biệt thay đổi thuộc task này với thay đổi có sẵn, không revert hay gom commit ngoài scope.

## Bảng parity ban đầu

| Khả năng                       | Mã/contract hiện có                                                                                                                                                                            | Bằng chứng runtime hiện có                                                                                                                             | Trạng thái                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Harness lifecycle và event log | `crates/orchestrator` transition/replay; `agent_runs` phát envelope                                                                                                                            | Native desktop smoke chưa hoàn tất                                                                                                                     | Implemented; runtime một phần                             |
| Multi-turn event sequence      | Runtime tạo theo turn, log đòi seq liên tục theo session; các turn chạy đồng thời có thể seed cùng sequence                                                                                    | Log writer/counter giờ dùng chung theo session và cấp sequence trong critical section; orchestrator replay tests pass; desktop runtime proof pending   |
| Tool/approval/child projection | Rust observer chuyển AgentEvent sang Harness; frontend hiển thị live state                                                                                                                     | Replay khôi phục active tool, approval và child session; resume không tự gửi prompt                                                                    | Contract/UI code verified; Preview/native pending         |
| Provider coverage              | CLI, custom API, Copilot và OpenCode dùng một shared Harness runtime/event log; custom stop ghi cancellation                                                                                   | Adapter-specific live turns chưa chạy trong native desktop                                                                                             | Source parity implemented; native proof pending           |
| MCP policy/lifecycle           | Config theo project/provider, allowed server list, startup retry tối đa một lần, fail rõ tên connector, cleanup attachment dở dang; HTTP session DELETE khi server cấp session ID              | Helper contract tests pass; native MCP run chưa được kiểm chứng                                                                                        | Source implemented; native proof pending                  |
| Health/routing                 | Quota/cache, account room, failure recovery, offline/local policy, allow-list/capability, account-plan allow-list và bounded latency/error metrics; `fast` chỉ xếp route hợp lệ có sample khỏe | Metrics process-local; native provider health chưa kiểm chứng. `maxCost` chưa được dùng làm policy vì chưa có giá thực tế nhất quán để enforce an toàn | Routing source/test implemented; native proof pending     |
| DSH SDK/ACP                    | SDK supervisor đã nối `agent_runs`, stream, approval, cancel, restore → resume → wait → prompt và terminal shutdown; ACP profile vẫn không được chọn runtime                                   | DSH protocol/supervisor stand-in tests pass; desktop compile/live provider turn pending                                                                | Adapter source/contract implemented; native proof pending |
| Harness UI recovery            | Interrupted replay hiển thị active tool/approval/child IDs; Resume không tự gửi prompt; settings có allowed plans                                                                              | Svelte check và focused UI logic tests pass; Preview server mở port nhưng không trả response nên chưa có UI flow proof                                 | UI source verified; Preview/native pending                |

Kết luận tạm: không yêu cầu API key để build/test core. Credential chỉ cần cho inference smoke với provider thật. DeepSeek/DSH không phải dependency của Harness chung. MCP stdio child giờ nhận environment allow-list cùng env cấu hình tường minh; OS sandbox enforcement và Preview/native live runtime vẫn pending.

Audit step 1 hoàn tất. Step 2 sửa sequence liên tục, append failure, shared runner state/logging và custom-provider cancellation. Các turn đồng thời giờ dùng chung sequence allocator theo session; DSH approval resolution dùng cùng composite ID với UI. HTTP MCP teardown, bounded provider telemetry/ranking, MCP startup retry/cleanup, plan eligibility và UI replay đã được nối. DSH SDK source flow đã sửa resume → wait → prompt, xử lý approval resolution và đóng process. Không dùng giá ước tính để giả lập `maxCost`; enforcement cần nguồn billing thực và nhất quán. OS sandbox enforcement và Preview UI proof vẫn pending. Windows native `cargo check` và focused desktop test hiện pass; live Tauri/provider turn chưa xác nhận.

## Nguyên tắc

- Ưu tiên capability contract chung; provider-specific code chỉ chuyển protocol sang canonical events/actions.
- UI chỉ phản ánh runtime event/snapshot, không suy đoán trạng thái từ text.
- Connector là session-scoped, policy/approval thống nhất; credentials tiếp tục qua cơ chế hiện có.
- Tích hợp DSH là tùy chọn và opt-in; provider lỗi hoặc thiếu credential không được làm hỏng provider khác.
- Không đánh dấu xong theo contract tests nếu chưa có runtime evidence phù hợp.

## Các bước

- [x] 1. Audit parity: lập bảng tính năng Harness và trạng thái code thực tế qua `agent_runs`, provider adapters, MCP lifecycle, session restore, frontend stores/components. Phân loại implemented / contract-only / runtime-proven / missing. Giữ nguyên diff hiện có.
- [x] 2. Đóng canonical runtime gaps đã xác nhận: tool progress/result/retry, approval response, cancellation, resume, child lifecycle và terminal state. Thêm focused test cho từng khe hở.
- [ ] 3. Đóng provider-neutral connector lifecycle: session attach/detach, health/failure/retry, allowed tools, environment/workspace policy và cleanup; capability-gate sandbox theo OS. Không tuyên bố hỗ trợ sandbox khi chưa có proof trên OS đó. MCP startup retry, fail rõ connector, cleanup attachment dở dang và environment allow-list đã có; sandbox isolation theo OS còn thiếu implementation/proof.
- [x] 4. Hoàn thiện multi-provider health/routing: latency, quota/rate-limit, errors, fallback và offline/local preference; tôn trọng provider allow-list, account-plan allow-list, capability và connector eligibility. Latency/error samples giới hạn trong bộ nhớ; failed-heavy provider không được xếp như route khỏe. `maxCost` chưa enforce vì không có nguồn billing thực, thống nhất cho provider.
- [x] 5. Hoàn thiện DSH adapter tùy chọn sau khi core ổn định: process stream, approval, cancel, shutdown, resume. DSH SDK là adapter tùy chọn; core build/test không phụ thuộc API key. Protocol/supervisor stand-in tests pass; native app/live turn được ghi riêng ở bước 7.
- [x] 6. Hoàn thiện UI theo capability/event: tool progress/output/retry, approval states/expiry/transport error, child sessions, interrupted recovery, provider/connector settings, typed readiness/error. Giữ UI dùng chung cho mọi provider. Replay khôi phục active tool/approval/child IDs; allowed-plan control được nối; Svelte check và focused logic tests pass.
- [ ] 7. Kiểm chứng và cập nhật checklist theo bằng chứng: focused Rust/frontend tests; Preview cho chat/tool/approval/child/recovery/settings/error; native build/runtime khi toolchain cho phép. Ghi riêng contract, Preview, live provider và native evidence. Windows native `cargo check` và MCP environment unit test pass; Preview còn boot splash/ACL errors, live desktop provider flow chưa xác nhận.

## Tiêu chí hoàn tất

- Cùng một Harness UI/event model hoạt động với ít nhất một provider CLI, một custom API provider và một local provider; provider/connector còn lại có fake contract tests.
- Tool, approval, child, cancellation, interrupted recovery và retry có transition quan sát được, không có DSH-specific branch trong UI.
- Đóng session dọn process, child runtime, MCP attachments và pending approvals; policy ngăn connector/tool ngoài scope.
- Routing không chọn provider bị cấm, thiếu capability hoặc trái offline/local policy; lỗi, quota và latency hiển thị đúng nguồn.
- Có Preview evidence cho mỗi UI state; native/runtime proof được tách riêng và checklist không ghi hoàn tất nếu chưa kiểm chứng.

## Kiểm chứng

Dùng focused project scripts/tests đã khai báo: `pnpm --dir apps/desktop run check`, test focused của `ag-orchestrator`/adapter, `git diff --check`, và Preview UI checks. Chạy native Cargo/Tauri gate khi toolchain cho phép; ghi nguyên lỗi môi trường nếu không. Không chạy full suite hoặc sửa unrelated files nếu không cần cho acceptance.

### Bằng chứng lần kiểm tra 2026-11-07

- `pnpm run check` trong `apps/desktop`: pass, 0 errors, 0 warnings.
- `node --experimental-strip-types --test src/lib/chat/recovery/plan-eligibility.test.ts src/lib/agents/provider-telemetry.test.ts`: 7/7 pass.
- `cargo test -p ag-orchestrator`: 21/21 pass.
- `cargo test -p ag-adapters dsh_`: 16/16 pass, gồm protocol, supervisor và lifecycle/resume.
- `cargo test -p ag-adapters -p ag-orchestrator` tổng hợp: adapter có 9 test thất bại do Windows không có executable `sh`; 265 pass, 1 ignored. Các lỗi là trong worker/tail tests phụ thuộc shell, không phải test DSH/Harness đã chạy riêng ở trên.
- `git diff --check`: pass, chỉ có cảnh báo line endings CRLF.
- Preview rerun: `browser_open` thành công tại `http://localhost:1431/`; screenshot chỉ thấy boot spinner, DOM còn `#boot-splash`, title rỗng. Console errors và failed requests đều rỗng; HTML cùng entry modules trả HTTP 200, nhưng `browser_eval` không phản hồi. App chưa đạt UI runtime proof; nguyên nhân chưa xác định.
- Native desktop build: trước đó bị chặn ở `whisper-rs-sys v0.15.0` do thiếu `stdbool.h`/binding assertions và cấu hình CMake generator; desktop integration chưa được compile/runtime-proven.
- DSH live inference: CLI headless đã chạy contract trước đó nhưng thiếu auth riêng của CLI (`DEEPSEEK_API_KEY`). Đây không phải dependency của Harness core hay provider DeepSeek đã cấu hình trong AgentDeck; live DSH inference vẫn pending.
- Sandbox: process cleanup không đồng nghĩa filesystem/network sandbox. Không có bằng chứng enforcement native cho Windows/macOS/Linux trong lần kiểm tra này.

### Recheck — 2026-11-07

- Windows native check: `pnpm exec node scripts/cargo.mjs check -p agentdeck-desktop --lib --target x86_64-pc-windows-msvc` pass using VS 2022 wrapper and isolated target directory.
- Focused Windows desktop test: `pnpm exec node scripts/cargo.mjs test -p agentdeck-desktop --lib environment_tests --target x86_64-pc-windows-msvc` pass, 1/1. This tests MCP child environment allow-listing and explicit configured values.
- Focused DSH tests: 16/16 pass; orchestrator tests: 21/21 pass; focused frontend tests: 7/7 pass; Svelte check: 0 errors/warnings; `git diff --check` and Rust fmt pass.
- Preview server returns HTML and entry modules, but app stays at `#boot-splash`; browser console reports Tauri commands blocked by web Preview ACL (`plugin:window|is_maximized`, `plugin:event|listen`, `usage_since`). No Preview UI state is counted as verified.
- OS sandbox enforcement is still absent/unproven across Windows/macOS/Linux. Steps 3 and 7 remain unchecked.
