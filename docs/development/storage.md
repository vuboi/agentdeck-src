# Where AgentDeck keeps data

Pick the store by what the data is. Do not put a large or queried set of rows in IndexedDB.

| Store                                                       | Use for                                                                   | Examples                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQLite** (`sqlite::open`, one shared app DB via `app_db`) | Growing data that is filtered, paged or summed, read by Rust or by agents | `app.db`: usage log, Audit log. `chats.db`: chat ledger (dual-write, off by default). `<project>/.agentdeck/ui-memory/memory.db`: page memory |
| **IndexedDB** (`prefs-db.ts`)                               | Small UI state read by the webview                                        | layout, tabs, composer, permissions, accounts, providers, chat meta, folder listings (capped at 2,000 keys)                                   |
| **localStorage**                                            | Tiny per-window preferences                                               | row heights, theme, active session, browser history                                                                                           |
| **Plain files**                                             | Things people read, edit or diff                                          | project `memory.md`, `docs/plans/*.md`, `docs/artifacts/*`, attachments, audit and generated images                                           |

## Choosing

- Stored in IndexedDB and the app only shows it: keep it there while each key stays under about 1 MB and nothing filters it.
- Grows with use, needs a range or a count, or Rust needs it: SQLite.
- A person should read or edit it, or it belongs in git: a file in the project.

## Keep and clean

- Project data (memory, plans, artifacts, UI memory): kept while the project exists.
- Code index (`<home>/index`): a cache. Deleted when the project folder is gone or stops being a project, or after 7 days without index use. Rebuilt on the next use.
- Trash (`<home>/trash`): items older than 14 days go; over 2 GB the oldest go until 1.5 GB.
- Audit log: keeps the last two days (`audit_prune`).
- Usage log: keeps the newest 20,000 replies.
- Folder listings: the newest 2,000 are kept.
- Deleting a chat deletes its command images.

Cleanup runs at start (about a minute after launch) for the trash and index files, and hourly for the Audit log while the app is open.
