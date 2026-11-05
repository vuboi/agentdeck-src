# Plans and Canvas

Plans keeps project plans in `docs/plans/`. Canvas keeps agent-created previews and documents in `docs/artifacts/`; both stay with the project.

## Plans

Open **Plans** in the right panel and choose a project. The list shows each plan's status, completed steps and path. Use the status menu to mark a plan approved, doing, done or dropped. Refresh after editing a plan outside AgentDeck.

In chat, use `/plan <goal>` to ask an agent to write and save a plan, or `/plans` to list project plans. Agents can also use `plan_list`, `plan_read`, `plan_write` and `plan_step`. Plans saved from Claude or Codex plan mode appear in the project list.

## Canvas

Open **Canvas** in the right panel to browse artifacts for a project and choose a saved version. HTML and SVG render in a restricted sandbox; Markdown is rendered as a document and code is read-only. Use the source toggle to inspect the original content, Copy to copy it, or Save as file to write a copy under `docs/`.

Artifacts created in the current chat open in Canvas and appear as a card in the conversation. Each update creates a version. Delete asks for confirmation and removes the artifact and its saved versions from `docs/artifacts/`.

The existing Preview panel is not used for agent HTML because it does not provide the Canvas sandbox. The Canvas **Open in Preview** action explains this restriction.
