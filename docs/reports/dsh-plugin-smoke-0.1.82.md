# DSH plugin smoke report

## Scope

- Catalog: [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/)
- Target plugin: `github:drscrewdriver/dsh-browser-cdp`
- Target AgentDeck integration: MCP Store → DSH Plugin catalog → `dsh --profile sdk`

## Result

The AgentDeck integration path is implemented and delegates installation to the official DSH command. The current Windows environment did not have `dsh` on `PATH`. A disposable npm attempt used `@deepseek-ai/dsh@0.2.2-rc.1`, but npm installation did not complete within the smoke window, so no plugin was installed into a user profile and no website automation screenshot is claimed.

## Compatibility notes

- Store emits npm specs such as `dsh-browser-cdp@<version>` and GitHub specs such as `github:drscrewdriver/dsh-browser-cdp`.
- DSH owns plugin lifecycle and profile composition; AgentDeck only manages the `sdk` profile through `dsh plugin`.
- `dsh-browser-cdp` requires a compatible DSH/Node runtime and a separately running Chromium-family browser with CDP available.

## Next live test

1. Install a supported DSH CLI and confirm `dsh --version`.
2. Open AgentDeck MCP Store and refresh the DSH catalog.
3. Filter category `Browser & Web`, install `dsh-browser-cdp` into the disposable `sdk` profile.
4. Start Chromium with CDP enabled, connect the plugin, then test navigation, page text extraction and screenshot capture on a public test page.
5. Save screenshots and record the plugin version, DSH version and browser CDP port.
