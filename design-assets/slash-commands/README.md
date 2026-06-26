# Slash Command Icons

Original monoline SVG icons for TaskWraith slash command rows.

Design constraints:

- `24x24` SVG viewBox.
- No baked container.
- Theme-aware linework via `currentColor`.
- `fill="none"` only; no filled shapes.
- Rounded monoline joins for compact menu/list rendering.
- Accessible `<title>` and `<desc>` in every SVG.

## Command Map

| Command concept | SVG filename |
| --- | --- |
| Review diff | `icons/review-diff.svg` |
| Compact context | `icons/compact-context.svg` |
| Help | `icons/help.svg` |
| Feedback | `icons/feedback.svg` |
| Move to side chat | `icons/side-chat.svg` |
| Return to main chat | `icons/main-chat.svg` |
| Explain | `icons/explain.svg` |
| Test | `icons/test.svg` |
| Select model | `icons/model.svg` |
| Fork thread | `icons/fork.svg` |
| Set goal | `icons/goal.svg` |
| MCP tools | `icons/mcp.svg` |
| Memory | `icons/memory.svg` |

`manifest.json` carries the same mapping in machine-readable form.
