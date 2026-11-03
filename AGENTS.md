# AGENTS.md — conventions for all coding agents

When adding an agent/provider, read the checklist in `docs/development/adding-agent-provider.md` and connect every relevant surface.

When changing Store skill installation/sync/update, read `docs/development/store-skill-locations.md`; connect the provider's global and project folders instead of updating only AgentDeck's cache.

## Environment (Windows)

- Rust uses `~/.cargo/bin` (the mise cargo shim is broken). In bash: `export PATH="$HOME/.cargo/bin:$PATH"`.
- Node 24, pnpm 10. Do not use npm/yarn to install packages.

## Rust

- Edition 2021; workspace dependencies are declared in the root `Cargo.toml` (`[workspace.dependencies]`).
- Errors: use `thiserror` in libraries and `anyhow` in binaries. Do not use `unwrap()` outside tests.
- Async: `tokio`. Logging: `tracing`.
- `cargo clippy --workspace -- -D warnings` must pass cleanly.

## Frontend

- Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`). Do not use the legacy store API in new code.
- TypeScript strict mode. `svelte-check` must report no errors.
- Do not add a large UI library; `packages/ui` will be replaced with the user's UI kit.

## General

- Do not commit secrets. Do not call the network from tests.
- Keep changes minimal and within the assigned module.
- At the end, run all DoD commands for the module and report the actual results.

## Before editing code

- Vague request (unclear file, expected behavior, or scope): ask up to 3 questions first; do not edit yet.
- Change touches 3+ files or affects logic/state: state a short plan (which files, what, why) and wait for "ok".
- Change only what was asked. No refactors, renames, new abstractions, extra options, or drive-by cleanup unless asked.
- Do not guess bug causes: read the code and find evidence before fixing.
- When done: list changed files with a one-line reason each.

### Prompt keywords

- `?` at the start: analyze and propose only; do not edit files.
- `plan:` state a plan and wait for approval.
- `go:` do it now without asking.
- `min:` smallest possible change, one spot.

## UI style (no AI slop)

- Use existing tokens only (z-ui-svelte / Tailwind theme colors, spacing, radius, font sizes). No new hex colors, odd px values, or new shadows.
- Banned: gradients, glassmorphism, glow, heavy shadows, colored borders, emoji as icons, needless badges/pills, decorative animation, all-caps text, gradient text.
- Default flat: plain backgrounds, 1px `border`, one accent color (`primary`). Build hierarchy with font size and weight, not color.
- Spacing on the 4/8 scale (`gap-1 gap-2 gap-3 gap-4`); same element type, same spacing.
- Before building a new component, find a similar one in the repo and copy its style. Do not invent when a pattern exists.
- Keep UI edits inside the requested scope; do not "polish" surrounding parts.
- After a UI change, screenshot it and compare with neighboring screens for consistency.

## Popovers and pick lists (UI)

- Every popover/select menu uses `ZPopover` (or an existing `PickerPopover` / `ProjectSelect`); do not position a separate menu with `position: absolute`.
  Anchor the popover to the element that opens it (`anchor`), choose `zPosition` based on available space, and size it to its content (a short list should stay narrow rather than filling the panel).
- The trigger must remain highlighted while its popover is open: use `TRIGGER_ON` / `TRIGGER_ON_PLAIN` from `src/lib/app/ui/popover.ts`, as with the chat cell's model picker.
- Popover lists use `zHoverGlide`: attach `glide()` to the list and add `data-glide-item` to each row (`glide` is in `src/lib/app/ui/popover.ts`).
  The selected/active row has its own `ROW_ON` background (`bg-primary/15 text-primary`) and `aria-selected="true"` so it does not receive the hover box.
- A popover search field auto-focuses when it opens. Long lists use virtual scrolling and fade at both ends (see `PickerPopover`).
- Every row has an icon: agents use their brand logo (`AgentLogo`, passing `agent`), not a generic icon.
- `ZCommand` is reserved for the chat search palette (`SearchPalette`); use popovers elsewhere.
- Hover must not override active state: an open tab, enabled button, or selected tool keeps `bg-primary/15 text-primary` on hover (use `ACTIVE_ON` / `TRIGGER_ON` from `src/lib/app/ui/popover.ts`, with `!` to win against the button's own hover style).

## Shared components (do not rebuild them per location)

- Pick lists, search fields, and tab lists: `PickerPopover` (`sm`/`md`, `search`, `local`, `headings`).
- Context menus and button menus: `Menu` (open at a point with `at`, or on an `anchor`) and `MenuButton` (icon button with a menu). Pass items as `ZDropdownMenuItem`; do not use `ZDropdownMenu` anymore.
- Project filter select: `ProjectSelect`. Searchable tab list: `TabListButton`.
- Open a file from any path with `openProjectFile` (`src/lib/files/file-viewer.svelte.ts`) and the helpers in `src/lib/files/paths.ts`; do not slice or join paths manually.

## Two model popovers (chat input and AI image generation): always update both

- `ModelPicker.svelte` (chat) and `ImageGenerator.svelte` (image generation) use the same popover structure: nested list, Fast mode, effort, divider, and Free / Hide / Paid sections. If you change the UI or ordering in one, change the other in the same turn (including `zSize="sm"`, divider, scrollbar, and model order). The model order and divider use the shared `freeFirst` in `src/lib/agents/models.svelte.ts`; do not reorder models independently in each component.

## Junk files (test and temporary files)

- Delete files created only for testing (Word, Excel, screenshots, logs) before finishing; do not leave them at the repository root or elsewhere in the repo.
- `pnpm clean:junk` lists uncommitted junk (read-only); `pnpm clean:junk:delete` removes it. Only files unknown to Git are affected; tracked files are never deleted. Other uncommitted files are listed separately for manual review.
- `pnpm hooks:install` enables Husky at `.husky/pre-commit`; it blocks staged junk files, then formats and lints staged source files.
- Detection rules are at the top of `scripts/clean-junk.mjs` (extensions `.docx .xlsx .pptx .pdf .zip .log .tmp .part`, temporary directories, and `demo-media` outputs); add new junk types there when needed.
