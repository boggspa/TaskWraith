# Agent Identicons

This folder contains the design-source identicon set for fallback sub-thread,
side-chat, guest, and agent nicknames.

- `base-agent-identicon.svg` is the shared monochrome suited-agent base.
- `generate-agent-identicons.mjs` reads `AGENT_NICKNAME_POOL` from `src/renderer/src/lib/agentIdentity.ts`.
- `named/*.svg` are generated, container-free SVG variants for each nickname.
- `agent-identicons.manifest.json` records the deterministic hue/accessory recipe.
- `agent-identicons.catalog.svg` is a quick review sheet.

Regenerate after editing the nickname pool:

```bash
node design-assets/agent-identicon/generate-agent-identicons.mjs
```
