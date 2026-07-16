# Kimi Code (ACP) migration — design & containment

Developer reference for TaskWraith's Kimi provider after the **kimi-cli → Kimi
Code** migration (2026-07). Covers the transport change (Wire → ACP), the
per-run sandbox, the HTTP MCP bridge, auth/usage, and the rollout gate.

> **Status:** the ACP transport is **default-ON**, gated by `TASKWRAITH_KIMI_ACP`
> (`kimiGate.ts`; set `=0` to force it off, landing a kimi-code binary on the
> setup-required gate). The rollout gate is **cleared** — the live containment
> trace (see [Rollout gate](#rollout-gate)) passed every assertion against the
> real binary: fs client-authority routing, the FetchURL/WebSearch deny wall,
> sub-agent deny inheritance, and the B3 refusal + tripwire. A legacy Kimi CLI
> still routes to the retained Wire path.

## What changed

Moonshot replaced the Python `kimi-cli` with a TypeScript rewrite, **Kimi
Code**. The binary keeps the name `kimi` but:

- moved to `~/.kimi-code/bin/kimi` (exposed only via a `~/.zshrc` PATH export —
  invisible to a packaged launchd-PATH launch);
- **dropped Wire mode** — the stdio server is now `kimi acp`, an
  [Agent Client Protocol](https://agentclientprotocol.com) server;
- moved OAuth to `~/.kimi-code`, expiring the old token;
- renamed/removed most legacy flags (`--wire`, `--work-dir`, `--print`,
  `--agent-file`, `--resume`, `--thinking` are all gone or renamed).

TaskWraith drives the new generation over ACP, riding the same neutral ACP core
as Grok, inside a per-run sandbox.

## Generation detection (never semver)

The two generations are separate products with unrelated version sequences, so
we **positively identify** the CLI generation from `--help`, never by semver
(`providers/KimiFlavour.ts`):

- an advertised `--wire` option → `legacy-wire` (retained Wire path);
- otherwise an `acp` / `doctor` / `migrate` subcommand → `kimi-code` (ACP path);
- anything else → `unsupported` (fail closed).

`runKimiProvider` (`index.ts`) dispatches on this: `legacy-wire` → the Wire path;
`kimi-code` + `kimiAcpEnabled()` → `runKimiAcpProvider`; otherwise a setup-
required failure. It never silently falls back to a print-mode runner (Kimi
Code's `-p/--prompt` runs under auto-approve).

## Transport

The bidirectional JSON-RPC state machine (`initialize → session/new →
session/prompt`, `session/update` streaming, client-mediated
`session/request_permission`, default-deny, transport keep-alive, cancellation)
is provider-neutral and lives in `acp/AcpTurnClient.ts` — extracted from Grok's
client so both providers share it. Grok and Kimi differ only by hooks:

| hook | Grok | Kimi |
| --- | --- | --- |
| `initializeParams` | fs caps **off** | fs caps **on** (client fs authority) |
| `onInboundRequest` | — | answers `fs/read_text_file` / `fs/write_text_file` |
| `deniedToolRecovery` | one-shot recovery prompt | none |
| `endProcess` | `SIGINT` | **stdin EOF** (Kimi ignores SIGINT/SIGTERM) |

**Termination:** `kimi acp` ignores SIGINT *and* SIGTERM and exits only on stdin
EOF. The neutral core terminates via the provider `endProcess` hook with a
SIGKILL backstop, so no provider can hang a run — this applies on normal
completion, cancel, *and* lifecycle errors.

## Containment (the A3 sandbox)

Kimi Code's built-in tools can't be stripped, so the seat is sandboxed instead.
Every element is verified by the live trace (see below).

- **Isolated `KIMI_CODE_HOME`** (`kimi/KimiAcpHome.ts`, `KimiAcpContainment.ts`) —
  a per-run throwaway data root containing a curated config (telemetry off,
  migrated `[[permission.rules]] allow` stripped, empty `plugins/`+`skills/`),
  a **deny wall** (`[[permission.rules]] deny` for the egress tools `FetchURL`,
  `WebSearch`, `AgentSwarm` **and the server-side fs/exec escapers** `Bash`,
  `Glob`, `Grep`), and a **0600-seeded credential** copied from the real home
  (resolving the empty-home `-32000` auth paradox). Torn down on every exit path
  (completion, cancel, and a synchronous throw before the turn wires its close
  handler — the seed is a live token copy and must not leak).
- **Egress deny wall** — `FetchURL`/`WebSearch` auto-run server-side and hit
  `api.kimi.com/coding/v1/{search,fetch}`; the static deny rule blocks them
  before the network, survives auto/`-p` mode, and **inherits into sub-agents**.
  (Config-omission is insufficient — `FetchURL` survives removing the moonshot
  service; the deny rule is load-bearing.)
- **Client fs workspace authority** (`kimi/KimiAcpClient.ts`) — the client
  advertises fs capabilities, so built-in `Read`/`Write`/`Edit` route through
  `fs/read_text_file` / `fs/write_text_file`, served only within the workspace
  roots (workspace + signed external-path grants). The boundary **resolves
  symlinks** (`realpath` of the target, or its parent for a new write, and of
  the roots) so a workspace-internal symlink can't escape. Verified live: a
  `Read`/`Write` of an out-of-workspace path returns `failed`.
- **Server-side fs/exec deny wall** — the client fs authority only mediates
  `fs/read_text_file`/`fs/write_text_file` (i.e. `Read`/`Write`/`Edit`). Kimi's
  other file tools — `Bash`, `Glob`, `Grep` — execute INSIDE the `kimi acp`
  process and never reach the client, so they can read **and write** absolute
  paths outside the workspace roots (verified live: `Bash cat` leaked an outside
  file, `Bash echo >` **wrote** one, `Glob` enumerated an outside directory —
  each after `Read`/`Write` was correctly refused). They ride the same deny wall,
  forcing every fs/exec operation onto an enforced door: the client fs handler
  (`Read`/`Write`/`Edit`) or the workspace-confined TaskWraith gateway MCP
  (`run_shell_command` / `list_directory` / `find_files` / …). Post-fix the probe
  re-runs with every vector attempted and **denied** (`Bash`/`Glob` → `failed`).
- **Per-tool approval policy** (`kimi/KimiToolPolicy.ts`) — matches the stdio
  providers: read-only/safe tools auto-allow (read-only MCP + capability
  gateway, read-only shell, native read/search), mutating tools are ledger-gated
  on a write-capable seat and denied on a plan seat. Kimi namespaces MCP tools
  `mcp__taskwraith__<tool>`; `isKimiSafeMcpTool` strips that prefix before the
  membership check (a Grok-namespace classifier silently mis-classifies them).

### B3 — project config is un-sandboxable, so refuse

Kimi Code discovers project config from the **`session/new` cwd**, which must be
the real workspace for the seat to work. A workspace `.kimi-code/mcp.json`
executes arbitrary stdio servers **at session start, before any prompt or
permission check** — outside `KIMI_CODE_HOME`, the deny wall, and the HTTP-only
MCP surface (verified: it ran `/usr/bin/touch` at `session/new`). There is no
CLI flag to disable project discovery, and the cwd can't be relocated. So
`runKimiAcpProvider` **refuses the run** when the workspace carries
`.kimi-code/mcp.json` or `.kimi-code/plugins`
(`findUnsafeWorkspaceKimiConfig`), before building the home or spawning.

## TaskWraith MCP gateway over HTTP

Kimi ACP's `session/new` **rejects stdio MCP servers** (it validates entries
against an http/sse schema — `mcpCapabilities: {http, sse}`). Every other
provider reaches the gateway over the stdio bridge, so Kimi needs an HTTP
transport. `kimi/KimiHttpMcpBridge.ts` is a per-run localhost
(`127.0.0.1:0`) HTTP MCP server with a random Bearer token, advertised to
exactly one Kimi session via `session/new mcpServers`
(`{name, type:'http', url, headers:[{name,value}]}`). It hand-rolls JSON-RPC
responses (no MCP SDK — the app hand-rolls MCP anyway; Kimi accepts plain
`application/json`) and proxies every request into the existing
`handleMcpJsonRpcMessage` gateway dispatch, so all subset filtering, tool
guards, and broker routing are reused. The isolated home keeps this the **only**
MCP the seat sees, and MCP tool calls are gated by `session/request_permission`
(stronger than Grok, where MCP auto-ran).

## Auth & usage

- **Sign-in:** `kimi login` (device-code OAuth) or a Moonshot API key. Settings
  copy and `providerTerminalHandlers` use the Kimi Code subcommands (`login`,
  `upgrade`; no `logout` subcommand). `get-kimi-auth-status` and
  `detectConfiguredProviders` are OAuth-aware (an OAuth-only install with no API
  key still reads configured / `oauth`).
- **Usage:** the live `api.kimi.com/coding/v1/usages` endpoint is authoritative;
  the credential reader tries `~/.kimi-code/credentials/kimi-code.json` first
  (legacy `~/.kimi` fallback). Kimi Code writes **no** structured per-turn
  `token_usage` to disk, so the on-disk activity reader is not a live source.
- **Thinking:** rides the isolated config (`[thinking] enabled`), never the
  dropped `--thinking` flag.

## Session generation fence

Wire mints bare-uuid session ids; ACP mints `session_<uuid>`. Feeding one to the
other's resume is refused: `wireResumeSessionId` (`kimi/KimiSessionGeneration.ts`)
only resumes a Wire-generation id on the legacy path. ACP v1 opens a fresh
`session/new` per turn (Grok-parity), so cross-turn context relies on the
unconditional transcript injection, and host-seat compaction is flavour-gated
(kimi-code seats skip the legacy print-mode argv).

## Rollout gate

The flag is default-ON; these codified live suites cleared the gate and remain the
re-confirmation procedure (re-run after a Kimi Code upgrade or any containment
change — both drive real `kimi acp` turns and skip in ordinary CI):

```bash
KIMI_ACP_LIVE_TRACE=1 npx vitest run \
  src/main/kimi/KimiAcpContainment.live.test.ts \
  src/main/kimi/KimiAcpEscapeProbe.live.test.ts
```

- **`KimiAcpContainment.live.test.ts`** — asserts fs-routing, the out-of-workspace
  boundary, egress denial, sub-agent deny inheritance, and the B3 refusal +
  unguarded-execution tripwire.
- **`KimiAcpEscapeProbe.live.test.ts`** — the adversarial escape probe: plants
  unique canaries OUTSIDE the workspace and drives the most-permissive realistic
  seat to reach them via `Bash`/`Glob`/`find`/`cat` and a shell **write**;
  asserts every vector is denied (proves the fs/exec deny wall, not just the
  client-fs `Read`/`Write` boundary). **Liveness caveat:** an empty-completions
  Kimi (expired/unentitled token) makes every "denied" assertion pass vacuously —
  confirm the containment trace's assertion #1 (built-in `Read` returns the
  canary) is green in the same run before trusting a pass.

## Key files

| Concern | Module |
| --- | --- |
| Generation probe | `providers/KimiFlavour.ts` |
| Neutral ACP core | `acp/AcpTurnClient.ts`, `acp/AcpProtocol.ts` |
| Kimi ACP client (fs authority) | `kimi/KimiAcpClient.ts` |
| Isolated home + B3 refusal | `kimi/KimiAcpHome.ts`, `kimi/KimiAcpContainment.ts` |
| Deny wall (egress + fs/exec escapers) | `kimi/KimiAcpContainment.ts` (`KIMI_ACP_DENY_TOOLS`) |
| Live escape probe | `kimi/KimiAcpEscapeProbe.live.test.ts` |
| HTTP MCP bridge | `kimi/KimiHttpMcpBridge.ts` |
| Per-tool approval policy | `kimi/KimiToolPolicy.ts` |
| Generation fence | `kimi/KimiSessionGeneration.ts` |
| Credential paths | `providers/KimiCredential.ts` |
| Flag | `kimiGate.ts` |
| Provider dispatch + glue | `index.ts` (`runKimiProvider`, `runKimiAcpProvider`) |
| Live containment gate | `kimi/KimiAcpContainment.live.test.ts` |
