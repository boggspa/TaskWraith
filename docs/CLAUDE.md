# CLAUDE.md has moved

This doctrine now lives at the repository root: [`CLAUDE.md`](../CLAUDE.md).

It was moved back out of `docs/` because Claude-family sessions only discover
`CLAUDE.md` at the repo root — see `scripts/agent-doctrine-reach.test.ts`,
which pins that delivery route. Do not relocate this doctrine into `docs/`
again; update the tooling instead if the discovery path ever changes.
