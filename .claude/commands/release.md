---
description: Cut an AgentDeck release: bump version, write release notes, verify, commit, tag and push
argument-hint: <version, e.g. 0.1.66>
---

Cut the AgentDeck release for version `$ARGUMENTS` (accept a leading `v` and strip it). Follow the steps in order. Stop at the first failed step and report it with the exact output. Do not skip a step.

Environment (Windows, Git Bash): run `export PATH="$HOME/.cargo/bin:/c/Program Files/Git/usr/bin:$PATH"` before any Cargo or pnpm command. Use pnpm, never npm or yarn, to install packages.

1. **Validate the version.** If `$ARGUMENTS` is empty or not `X.Y.Z`, stop and ask for it. Read the current version from `[workspace.package]` in `Cargo.toml`. The new version must be higher than it. If the tag `vX.Y.Z` already exists (`git tag -l vX.Y.Z`), stop.

2. **Check the tree.** Run `git update-index --refresh` (clears stat-only dirt), then `git status --short`. Release files may be modified: `Cargo.toml`, `Cargo.lock`, `apps/desktop/src-tauri/tauri.conf.json`, `docs/release-notes/vX.Y.Z.md`. Any other uncommitted change is not part of this release. Do not commit it. List those files and stop so the user can decide, unless the user already said which to include.

3. **Bump the version** in exactly these places, then nothing else:
    - `Cargo.toml`: `version` under `[workspace.package]`.
    - `apps/desktop/src-tauri/tauri.conf.json`: top-level `"version"`.
    - `Cargo.lock`: refreshed by running `node scripts/cargo.mjs check --workspace`. It must show the new version on the workspace crates (`ag-*`, `agentdeck-desktop`).
      Check with `grep -rn "<old version>" --include=*.toml --include=*.json . | grep -v node_modules`. Only Cargo.lock dependency entries may still hold old numbers.

4. **Write the release notes** at `docs/release-notes/vX.Y.Z.md`. Base them on `git log <previous tag>..HEAD` and the diff, not on memory. Use this structure, the same as earlier releases:
    - `### What's new`: user-facing features, one bullet each, bold title, plain language.
    - `### Fixes`: user-facing bug fixes. Write `- None in this release.` if there are none. Never leave this section out.
    - `### Developer notes`: version, release tag, and any pinned CLI, adapter, or connector paths a developer needs.

5. **Run the verification:** `pnpm release:check`. It runs cargo check, clippy with `-D warnings`, `cargo test --workspace`, svelte-check, and the desktop node tests. This can take several minutes. If any step fails, stop, show the failing lines, and do not commit. Fix only if the user asks.

6. **Commit the release files only.** Stage them by name: `git add Cargo.toml Cargo.lock apps/desktop/src-tauri/tauri.conf.json docs/release-notes/vX.Y.Z.md`. Never use `git add -A` or `git add .`: the pre-commit hook (Husky) reformats every staged file, so unrelated files would change. Commit with message `chore: release vX.Y.Z`. End the message with the attribution line the session specifies. Do not amend or rewrite existing commits.

7. **Tag and push:**
    - `git tag -a vX.Y.Z -m "AgentDeck vX.Y.Z"`
    - `git push origin main`
    - `git push origin vX.Y.Z`
      Pushing the tag starts the `release` workflow, which builds every platform and updates `latest.json`, so installed apps are offered the update when it finishes. Do not push a tag for a version that failed step 5.

8. **Report.** Run `gh run list --workflow release.yml --limit 1` and give the run ID and status. Report the version, the release notes path, the commit hash, and the tag. Say plainly that the workflow runs on GitHub and has not finished yet.
