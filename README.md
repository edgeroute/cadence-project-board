# Project Board

A [claudecodeui](https://github.com/siteboard/claudecodeui) plugin that adds a **GitHub Projects v2 kanban board** as a tab: every item as a card, drag-and-drop between Status columns, and Priority and Size editable from the card.

Ships a companion `/board` skill so the same board can be read and changed from a Claude Code session.

Modelled on [`szmidtpiotr/claude-github-issue`](https://github.com/szmidtpiotr/claude-github-issue) (MIT), which does the same job against repo issues and labels. The plugin shell, the drag mechanics and the build configuration follow it closely; the data layer is a rewrite, because Projects v2 has no REST API.

## Install

1. claudecodeui → **Settings → Plugins**
2. Paste this repository's URL
3. **Install**, then open the **Project Board** tab
4. Press ⚙ and paste your project's URL — `https://github.com/users/you/projects/1`

## The token

**It must be a classic personal access token with `repo` and `project` scopes.**

Fine-grained tokens cannot read user-owned projects at all. GitHub exposes a `Projects` permission only for *organizations*, so there is no combination of fine-grained settings that works for a project under a user account. If a call fails with `INSUFFICIENT_SCOPES`, that is almost always why.

The token is written to `.CadenceBoard/project-board.json` in the open project, and that directory is added to the project's `.gitignore` on first save. `$GH_TOKEN` (or `$GITHUB_TOKEN`) is used as a fallback when the file has no token, so a machine with a working credential needs no second copy.

## What it does

| | |
| :-- | :-- |
| **Columns** | The live options of the project's `Status` field, in the order GitHub returns them, plus a `No Status` column that appears only when something is in it |
| **Drag** | Moves an item's `Status`. Optimistic — the card moves on drop, and returns with an explanation if GitHub refuses |
| **Card** | Issue number, title, Priority, Size, up to three labels in their real colours, assignee avatars |
| **Detail** | Click a card to set `Status`, `Priority` or `Size`, read the issue body, or open it on GitHub |
| **Search** | Filters by issue number, title or repository |
| **Columns collapse** | Remembered per project in `localStorage` |

Nothing is hardcoded to one project: field and option ids are discovered from the project itself on every read, so a column added on github.com appears on the next refresh.

## Development

```bash
npm install
npm run build        # both bundles
npm run dev          # watch
npm run typecheck
```

**`dist/` is committed on purpose.** claudecodeui clones this repository and runs the committed bundles — there is no build step on install. A `.gitignore`d `dist/` ships a plugin that fails with RPC 503 the moment it is enabled.

Three build settings are load-bearing and documented where they live in `vite.config.ts`:

- `jsxRuntime: 'classic'` — the automatic runtime resolves `jsxDEV` from its own React, which is absent in the host's context. Every `.tsx` file therefore imports React explicitly.
- `define: { 'process.env': '{}' }` — the bundle runs in a browser.
- `cssCodeSplit: false` — the manifest names one entry file, so `styles.css` is imported `?inline` and injected into `<head>` at mount.

After any change: `npm run build`, then commit `src/` and `dist/` together.

## The `/board` skill

Installed to `~/.claude/skills/board/SKILL.md` when the backend starts, and refreshed whenever the content differs — so upgrading the plugin upgrades the skill.

```
/board                      show every column
/board 216                  show one item
/board move 216 ready       set Status
/board move 216 none        clear Status
/board priority 216 P1      set Priority
/board size 216 XS          set Size
```

It reads the same config file and issues the same GraphQL rather than calling this plugin's backend: the backend's port is assigned at startup and reported only to claudecodeui, so nothing outside that process can address it.

## Layout

```
manifest.json          slot/entry/server metadata
src/frontend/          React 18, classic JSX — the tab
src/backend/           Node HTTP server — config, GraphQL, cache
skill/SKILL.md         the /board skill, auto-installed
dist/                  committed build output
```

## Licence

MIT.
