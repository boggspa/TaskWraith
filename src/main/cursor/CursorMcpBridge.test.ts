import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURSOR_LEGACY_WEB_MCP_SERVER_NAME,
  CURSOR_BROKER_MCP_ALLOW_RULES,
  CURSOR_BROKER_PLAN_MCP_ALLOW_RULES,
  CURSOR_BROKER_READONLY_MCP_ALLOW_RULES,
  CURSOR_GATEWAY_MCP_TOOL_NAMES,
  CURSOR_GATEWAY_PLAN_MCP_TOOL_NAMES,
  CURSOR_GATEWAY_READONLY_MCP_TOOL_NAMES,
  CURSOR_MCP_ALLOW_RULES,
  CURSOR_MCP_SERVER_NAME,
  CURSOR_READONLY_MCP_ALLOW_RULES,
  CURSOR_SCOPED_MCP_SERVER_NAME,
  CURSOR_WEB_FETCH_MCP_SERVER_SOURCE,
  buildCursorBrokerMcpServerEntry,
  buildCursorMcpServerEntry,
  buildCursorReadOnlyMcpServerEntry,
  globalCursorMcpNeedsUpdate,
  isReservedCursorMcpServerName,
  mergeCursorAllowRules,
  mergeCursorMcpConfig,
  mergeGlobalCursorMcpServers
} from './CursorMcpBridge'
import {
  isPlanAdvertisedTool,
  isReadOnlyAdvertisedTool
} from '../mcp/McpAutoAllowedTools'
import { isCapabilityGatewayToolName } from '../mcp/McpToolGateway'

// 1.0.6-CRUX34 (OQ#2) — the Cursor MCP bridge. The live spike proved that a
// TaskWraith MCP server registered via workspace `.cursor/mcp.json` + Cursor
// permission allow rules is invoked by Cursor in headless default/write mode
// (plan mode rejects all tools). These tests pin the pure config helpers + prove
// the embedded legacy web server source is valid JS (the template string
// escaping is easy to get wrong).

describe('CURSOR_MCP_ALLOW_RULES', () => {
  it('covers Cursor documented MCP tokens and observed hyphen display names', () => {
    expect(CURSOR_MCP_ALLOW_RULES).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:*)`)
    expect(CURSOR_MCP_ALLOW_RULES).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:run_shell_command)`)
    expect(CURSOR_MCP_ALLOW_RULES).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:apply_patch)`)
    expect(CURSOR_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:capability_search)`
    )
    expect(CURSOR_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:capability_invoke)`
    )
    expect(CURSOR_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:video_encode_clip)`
    )
    expect(CURSOR_MCP_ALLOW_RULES).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-run_shell_command)`)
    expect(CURSOR_MCP_ALLOW_RULES).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-apply_patch)`)
    expect(CURSOR_MCP_ALLOW_RULES).not.toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-*)`)
    expect(CURSOR_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(CURSOR_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}-run_shell_command)`
    )
    expect(CURSOR_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:*)`
    )
  })

  it('reserves the TaskWraith server prefix for brokered tools only', () => {
    expect(isReservedCursorMcpServerName(CURSOR_MCP_SERVER_NAME)).toBe(true)
    expect(isReservedCursorMcpServerName(`${CURSOR_MCP_SERVER_NAME}-evil`)).toBe(true)
    expect(isReservedCursorMcpServerName(CURSOR_SCOPED_MCP_SERVER_NAME)).toBe(true)
    expect(isReservedCursorMcpServerName(`${CURSOR_SCOPED_MCP_SERVER_NAME}-evil`)).toBe(true)
    expect(isReservedCursorMcpServerName(CURSOR_LEGACY_WEB_MCP_SERVER_NAME)).toBe(true)
    expect(isReservedCursorMcpServerName('taskwraith-evil')).toBe(true)
    expect(isReservedCursorMcpServerName('taskwraith_backup')).toBe(false)
    expect(isReservedCursorMcpServerName('user_taskwraith')).toBe(false)
  })
})

describe('canonical global broker allow rules', () => {
  it('never grants permissions to the preserved user-owned taskwraith server', () => {
    expect(CURSOR_BROKER_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(CURSOR_BROKER_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:read_file)`
    )
    expect(CURSOR_BROKER_PLAN_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:canvas_click)`
    )
  })

  it('uses exact safe/plan rules without a canonical wildcard', () => {
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:read_file)`
    )
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:git_status)`
    )
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:write_file)`
    )
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:*)`
    )
    for (const tool of CURSOR_GATEWAY_PLAN_MCP_TOOL_NAMES) {
      expect(CURSOR_BROKER_PLAN_MCP_ALLOW_RULES).toContain(
        `Mcp(${CURSOR_MCP_SERVER_NAME}:${tool})`
      )
    }
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:capability_search)`
    )
    expect(CURSOR_BROKER_READONLY_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:capability_invoke)`
    )
    // Hidden plan instruments are reached through capability_invoke, not
    // directly advertised or pre-approved as individual Cursor MCP tools.
    expect(CURSOR_BROKER_PLAN_MCP_ALLOW_RULES).not.toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:canvas_click)`
    )
  })

  it('derives scoped lists from the gateway ceiling plus permission overlays', () => {
    // 41 → 40 on 2026-07-24: ensemble_continue left the gateway ceiling with
    // the Work Session removal.
    expect(CURSOR_GATEWAY_MCP_TOOL_NAMES).toHaveLength(40)
    expect(CURSOR_GATEWAY_MCP_TOOL_NAMES).toContain('ensemble_propose_goal_complete')
    for (const tool of CURSOR_GATEWAY_READONLY_MCP_TOOL_NAMES) {
      expect(isCapabilityGatewayToolName(tool) || isReadOnlyAdvertisedTool(tool)).toBe(true)
    }
    for (const tool of CURSOR_GATEWAY_PLAN_MCP_TOOL_NAMES) {
      expect(isCapabilityGatewayToolName(tool) || isPlanAdvertisedTool(tool)).toBe(true)
    }
  })
})

describe('CURSOR_READONLY_MCP_ALLOW_RULES (read-only safe-subset broker)', () => {
  it('scopes to the read-only server name and covers the wildcard + hyphen spellings', () => {
    expect(CURSOR_READONLY_MCP_ALLOW_RULES).toContain(`Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}:*)`)
    expect(CURSOR_READONLY_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}:read_file)`
    )
    expect(CURSOR_READONLY_MCP_ALLOW_RULES).toContain(
      `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}-read_file)`
    )
    // Never a broad prefix wildcard (a same-prefixed workspace server must not ride it).
    expect(CURSOR_READONLY_MCP_ALLOW_RULES).not.toContain(`Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}-*)`)
  })

  it('SAFETY: never allows a mutating tool (only the read-only advertise subset)', () => {
    for (const mutating of ['write_file', 'replace', 'apply_patch', 'run_shell_command']) {
      expect(CURSOR_READONLY_MCP_ALLOW_RULES).not.toContain(
        `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}:${mutating})`
      )
      expect(CURSOR_READONLY_MCP_ALLOW_RULES).not.toContain(
        `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}-${mutating})`
      )
    }
    // Exactly one exact-rule per gateway/read-only tool (plus the wildcard +
    // hyphen forms). Safe capabilities outside the compact direct set are
    // available through capability_invoke instead of individual rules.
    for (const tool of CURSOR_GATEWAY_READONLY_MCP_TOOL_NAMES) {
      expect(CURSOR_READONLY_MCP_ALLOW_RULES).toContain(
        `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}:${tool})`
      )
    }
  })
})

describe('buildCursorReadOnlyMcpServerEntry', () => {
  it('registers ONLY the scoped read-only server (no full broker, no legacy alias)', () => {
    const entry = buildCursorReadOnlyMcpServerEntry({
      command: '/x/electron',
      args: ['/tmp/s.cjs', '--safe-subset']
    })
    expect(Object.keys(entry)).toEqual([CURSOR_SCOPED_MCP_SERVER_NAME])
    expect(entry[CURSOR_MCP_SERVER_NAME]).toBeUndefined()
    expect(entry[CURSOR_LEGACY_WEB_MCP_SERVER_NAME]).toBeUndefined()
    const scoped = entry[CURSOR_SCOPED_MCP_SERVER_NAME] as { command: string; args: string[] }
    expect(scoped.command).toBe('/x/electron')
    expect(scoped.args).toContain('--safe-subset')
  })
})

describe('B-mode global broker helpers', () => {
  const invocation = { command: '/x/electron', args: ['/tmp/s.cjs', '--socket', '/sock', '--token', 'T1'] }

  it('buildCursorBrokerMcpServerEntry registers the full broker WITHOUT the legacy alias', () => {
    const entry = buildCursorBrokerMcpServerEntry(invocation)
    expect(Object.keys(entry)).toEqual([CURSOR_MCP_SERVER_NAME])
    expect(entry[CURSOR_LEGACY_WEB_MCP_SERVER_NAME]).toBeUndefined()
  })

  it('does not persist per-run route fields in the shared global broker entry', () => {
    const entry = buildCursorBrokerMcpServerEntry({
      ...invocation,
      env: {
        TASKWRAITH_GEMINI_MCP_BRIDGE: '1',
        TASKWRAITH_PARENT_PROVIDER: 'cursor',
        TASKWRAITH_RUN_ID: 'cursor-run-a',
        TASKWRAITH_CHAT_ID: 'chat-a',
        TASKWRAITH_WORKSPACE_PATH: '/workspace-a',
        TASKWRAITH_RUNTIME_PROFILE_ID: 'profile-a',
        TASKWRAITH_INSTANCE_ID: 'ambient-instance-must-not-persist',
        TASKWRAITH_MCP_SOCKET_PATH: '/live/socket',
        TASKWRAITH_MCP_BROKER_TOKEN: 'live-token',
        TASKWRAITH_MCP_INSTANCE_EPOCH: '0123456789abcdef0123456789abcdef',
        TASKWRAITH_MCP_BRIDGE_LOG_EPOCH: '9',
        TASKWRAITH_MCP_ISOLATED_INSTANCE_ID: 'isolated-profile',
        TASKWRAITH_MCP_SAFE_SUBSET: '1',
        TASKWRAITH_MCP_PLAN_SUBSET: '0',
        TASKWRAITH_MCP_CORE_SUBSET: '0',
        TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
        TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL: '0',
        TASKWRAITH_MCP_MESH_DIRECT: '1',
        TASKWRAITH_MCP_AUDIT: '1'
      }
    })
    const server = entry[CURSOR_MCP_SERVER_NAME] as { env?: Record<string, string> }

    // These values are inherited from each cursor-agent process when it
    // launches its own stdio broker child. Storing them globally would make a
    // concurrent seat's route replace this one before its tool call.
    expect(server.env).toEqual({
      TASKWRAITH_GEMINI_MCP_BRIDGE: '1'
    })
  })

  it('mergeGlobalCursorMcpServers PRESERVES the user\'s own servers and only adds broker keys', () => {
    const existing = {
      mcpServers: {
        taskwraith: { command: 'node', args: ['/web.cjs'] }, // user's global web server
        agbench: { command: 'node', args: ['/agb.cjs'] }
      }
    }
    const merged = mergeGlobalCursorMcpServers(existing, buildCursorBrokerMcpServerEntry(invocation))
    const servers = (merged.mcpServers ?? {}) as Record<string, unknown>
    // user servers untouched
    expect(servers.taskwraith).toEqual({ command: 'node', args: ['/web.cjs'] })
    expect(servers.agbench).toEqual({ command: 'node', args: ['/agb.cjs'] })
    // broker added
    expect(servers[CURSOR_MCP_SERVER_NAME]).toBeDefined()
  })

  it('prunes only an explicitly named obsolete TaskWraith registration', () => {
    const existing = {
      mcpServers: {
        taskwraith: { command: 'node', args: ['/user-web.cjs'] },
        agbench: { command: 'node', args: ['/user-tools.cjs'] },
        [CURSOR_SCOPED_MCP_SERVER_NAME]: { command: 'node', args: ['/old-readonly.cjs'] }
      }
    }
    const entry = buildCursorBrokerMcpServerEntry(invocation)
    const merged = mergeGlobalCursorMcpServers(existing, entry, [CURSOR_SCOPED_MCP_SERVER_NAME])
    const servers = (merged.mcpServers ?? {}) as Record<string, unknown>

    expect(servers[CURSOR_SCOPED_MCP_SERVER_NAME]).toBeUndefined()
    expect(servers.taskwraith).toEqual({ command: 'node', args: ['/user-web.cjs'] })
    expect(servers.agbench).toEqual({ command: 'node', args: ['/user-tools.cjs'] })
    expect(servers[CURSOR_MCP_SERVER_NAME]).toBeDefined()
  })

  it('globalCursorMcpNeedsUpdate detects a token refresh (repair-on-stale) but skips a no-op', () => {
    const entry = buildCursorBrokerMcpServerEntry(invocation)
    const registered = mergeGlobalCursorMcpServers({ mcpServers: {} }, entry)
    // identical → no update needed
    expect(globalCursorMcpNeedsUpdate(registered, entry)).toBe(false)
    // token rotated (new launch) → needs update
    const rotated = buildCursorBrokerMcpServerEntry({
      ...invocation,
      args: ['/tmp/s.cjs', '--socket', '/sock', '--token', 'T2']
    })
    expect(globalCursorMcpNeedsUpdate(registered, rotated)).toBe(true)
  })

  it('globalCursorMcpNeedsUpdate detects an obsolete registration that must be pruned', () => {
    const entry = buildCursorBrokerMcpServerEntry(invocation)
    const registered = mergeGlobalCursorMcpServers(
      {
        mcpServers: {
          [CURSOR_SCOPED_MCP_SERVER_NAME]: { command: 'node', args: ['/old-readonly.cjs'] }
        }
      },
      entry
    )

    expect(
      globalCursorMcpNeedsUpdate(registered, entry, [CURSOR_SCOPED_MCP_SERVER_NAME])
    ).toBe(true)
  })
})

describe('buildCursorMcpServerEntry', () => {
  it('builds the broker entry keyed by the server name', () => {
    const entry = buildCursorMcpServerEntry({ command: '/x/electron', args: ['/tmp/s.cjs'] })
    expect(entry).toEqual({
      [CURSOR_MCP_SERVER_NAME]: { command: '/x/electron', args: ['/tmp/s.cjs'] },
      [CURSOR_LEGACY_WEB_MCP_SERVER_NAME]: { command: '/x/electron', args: ['/tmp/s.cjs'] }
    })
  })

  it('includes env when provided (electron-as-node)', () => {
    const entry = buildCursorMcpServerEntry({
      command: '/x/electron',
      args: ['/tmp/s.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(entry).toEqual({
      [CURSOR_MCP_SERVER_NAME]: {
        command: '/x/electron',
        args: ['/tmp/s.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      [CURSOR_LEGACY_WEB_MCP_SERVER_NAME]: {
        command: '/x/electron',
        args: ['/tmp/s.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    })
  })

  it('copies the args array (no aliasing the caller’s array)', () => {
    const args = ['/tmp/s.cjs']
    const entry = buildCursorMcpServerEntry({ command: 'node', args }) as {
      [CURSOR_MCP_SERVER_NAME]: { args: string[] }
      [CURSOR_LEGACY_WEB_MCP_SERVER_NAME]: { args: string[] }
    }
    args.push('mutated')
    expect(entry[CURSOR_MCP_SERVER_NAME].args).toEqual(['/tmp/s.cjs'])
    expect(entry[CURSOR_LEGACY_WEB_MCP_SERVER_NAME].args).toEqual(['/tmp/s.cjs'])
  })
})

describe('mergeCursorMcpConfig', () => {
  it('adds the broker server into an empty/absent config', () => {
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/s.cjs'] })
    expect(mergeCursorMcpConfig(null, entry)).toEqual({
      mcpServers: {
        [CURSOR_MCP_SERVER_NAME]: { command: 'node', args: ['/tmp/s.cjs'] },
        [CURSOR_LEGACY_WEB_MCP_SERVER_NAME]: { command: 'node', args: ['/tmp/s.cjs'] }
      }
    })
  })

  it('isolates supplied servers while preserving non-server top-level keys', () => {
    const existing = {
      mcpServers: { other: { command: 'foo', args: [] } },
      someUnknownTopLevel: { keep: true }
    }
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/s.cjs'] })
    const merged = mergeCursorMcpConfig(existing, entry)
    expect(merged).toEqual({
      mcpServers: {
        [CURSOR_MCP_SERVER_NAME]: { command: 'node', args: ['/tmp/s.cjs'] },
        [CURSOR_LEGACY_WEB_MCP_SERVER_NAME]: { command: 'node', args: ['/tmp/s.cjs'] }
      },
      someUnknownTopLevel: { keep: true }
    })
  })

  it('overwrites a pre-existing broker server entry (latest wins)', () => {
    const existing = {
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: 'stale', args: ['old'] } }
    }
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/new.cjs'] })
    const merged = mergeCursorMcpConfig(existing, entry) as {
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: string } }
    }
    expect(merged.mcpServers[CURSOR_MCP_SERVER_NAME].command).toBe('node')
  })

  it('drops all pre-existing servers before adding the real broker + legacy alias', () => {
    const existing = {
      mcpServers: {
        other: { command: 'foo', args: [] },
        taskwraith: { command: 'stale', args: ['old'] },
        'taskwraith-evil': { command: 'malware', args: [] },
        [CURSOR_MCP_SERVER_NAME]: { command: 'stale-broker', args: ['old'] },
        [`${CURSOR_MCP_SERVER_NAME}-evil`]: { command: 'malware2', args: [] }
      }
    }
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/new.cjs'] })
    const merged = mergeCursorMcpConfig(existing, entry) as {
      mcpServers: Record<string, unknown>
    }
    expect(merged.mcpServers.other).toBeUndefined()
    expect(merged.mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual({
      command: 'node',
      args: ['/tmp/new.cjs']
    })
    expect(merged.mcpServers.taskwraith).toEqual({
      command: 'node',
      args: ['/tmp/new.cjs']
    })
    expect(merged.mcpServers['taskwraith-evil']).toBeUndefined()
    expect(merged.mcpServers[`${CURSOR_MCP_SERVER_NAME}-evil`]).toBeUndefined()
  })

  it('retains only the active canonical TaskWraith broker for the Home/global alias case', () => {
    const existing = {
      mcpServers: {
        [CURSOR_MCP_SERVER_NAME]: { command: 'node', args: ['/broker.cjs'] },
        [CURSOR_SCOPED_MCP_SERVER_NAME]: { command: 'node', args: ['/scoped.cjs'] },
        taskwraith: { command: 'node', args: ['/user-web.cjs'] },
        'taskwraith-broker-evil': { command: 'node', args: ['/evil.cjs'] },
        agbench: { command: 'node', args: ['/agbench.cjs'] }
      }
    }
    const merged = mergeCursorMcpConfig(
      existing,
      { user_docs: { url: 'https://example.test/mcp' } },
      { preserveExistingTaskWraithBrokers: true }
    ) as { mcpServers: Record<string, unknown> }

    expect(merged.mcpServers).toEqual({
      [CURSOR_MCP_SERVER_NAME]: { command: 'node', args: ['/broker.cjs'] },
      user_docs: { url: 'https://example.test/mcp' }
    })
  })
})

describe('mergeCursorAllowRules', () => {
  it('adds the allow rule into an empty config (with an empty deny)', () => {
    const merged = mergeCursorAllowRules(null, CURSOR_MCP_ALLOW_RULES)
    expect(merged.permissions.allow).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:*)`)
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}-run_shell_command)`
    )
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}-run_shell_command)`
    )
    expect(merged.permissions.allow).not.toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-*)`)
    expect(merged.permissions.allow).not.toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:*)`
    )
    expect(merged.permissions.deny).toEqual([])
  })

  it('preserves existing deny rules (e.g. the write-mode Shell deny) + dedups allow', () => {
    const existing = {
      permissions: { allow: [`Mcp(${CURSOR_MCP_SERVER_NAME}:*)`], deny: ['Shell(**)'] }
    }
    const merged = mergeCursorAllowRules(existing, CURSOR_MCP_ALLOW_RULES)
    expect(merged.permissions.allow).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:*)`)
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_MCP_SERVER_NAME}-run_shell_command)`
    )
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:run_shell_command)`
    )
    expect(merged.permissions.allow).toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}-run_shell_command)`
    )
    expect(merged.permissions.allow).not.toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-*)`)
    expect(merged.permissions.allow).not.toContain(
      `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:*)`
    )
    expect(merged.permissions.deny).toEqual(['Shell(**)'])
  })

  it('preserves unknown top-level keys', () => {
    const merged = mergeCursorAllowRules({ extra: 1 }, CURSOR_MCP_ALLOW_RULES) as Record<
      string,
      unknown
    >
    expect(merged.extra).toBe(1)
  })
})

describe('CURSOR_WEB_FETCH_MCP_SERVER_SOURCE', () => {
  it('declares the web_fetch + web_search tools and runs in strict mode', () => {
    expect(CURSOR_WEB_FETCH_MCP_SERVER_SOURCE).toContain("name: 'web_fetch'")
    expect(CURSOR_WEB_FETCH_MCP_SERVER_SOURCE).toContain("name: 'web_search'")
    expect(CURSOR_WEB_FETCH_MCP_SERVER_SOURCE).toContain("'use strict'")
    // The embed must NOT contain a live template literal (would break escaping).
    expect(CURSOR_WEB_FETCH_MCP_SERVER_SOURCE).not.toContain('${')
  })

  it('is syntactically valid JS (node --check) — proves the template escaping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskwraith-mcp-src-'))
    const file = join(dir, 'taskwraith-mcp-server.cjs')
    try {
      writeFileSync(file, CURSOR_WEB_FETCH_MCP_SERVER_SOURCE)
      // Throws (non-zero exit) if the source has a syntax error.
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
