# Harness verification matrix

Updated: 2026-11-07

## Passing checks

| Layer                                                             | Command                                                 | Result               |
| ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------- |
| Harness state, replay, approval, child tree, supervisor contracts | `cargo test -p ag-orchestrator`                         | 14 passed            |
| dsh JSONL, JSON-RPC correlation, shutdown, typed notifications    | `cargo test -p ag-adapters dsh_protocol -- --nocapture` | 6 passed             |
| Desktop Svelte UI, including DSH Store diagnostics                | `pnpm --dir apps/desktop run check`                     | 0 errors, 0 warnings |
| Rust formatting                                                   | `cargo fmt --all -- --check`                            | passed               |
| Patch whitespace                                                  | `git diff --check`                                      | passed               |

## Runtime boundaries

| Layer                  | Status                          | Evidence or blocker                                                                              |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| DSH plugin store       | Contract and UI ready           | Official `dsh plugin --profile sdk add/remove` path retained; CLI availability is shown in Store |
| DSH SDK process stream | Protocol contract ready         | CLI was not installed during smoke attempt; no fake live result is reported                      |
| Preview UI             | Static Svelte validation passed | Native Preview interaction still requires a running Tauri dev host                               |
| Native desktop Rust    | Blocked in current toolchain    | `whisper-rs-sys` cannot find `stdbool.h`; bundled bindings then fail Windows ABI size assertions |
| Windows installer      | Previously passed for 0.1.82    | Rebuild after this slice waits for the whisper toolchain fix                                     |

## Safety boundary

The event log and protocol modules are provider-neutral contracts. They do not silently claim a live dsh session, OAuth, MCP sandbox, or Google Sheets connection. Those rows require the corresponding runtime, credentials, and Windows native environment before being marked verified.
