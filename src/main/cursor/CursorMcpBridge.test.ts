import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURSOR_LEGACY_WEB_MCP_SERVER_NAME,
  CURSOR_MCP_ALLOW_RULES,
  CURSOR_MCP_SERVER_NAME,
  CURSOR_WEB_FETCH_MCP_SERVER_SOURCE,
  buildCursorMcpServerEntry,
  isReservedCursorMcpServerName,
  mergeCursorAllowRules,
  mergeCursorMcpConfig
} from './CursorMcpBridge'

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
    expect(isReservedCursorMcpServerName(CURSOR_LEGACY_WEB_MCP_SERVER_NAME)).toBe(true)
    expect(isReservedCursorMcpServerName('taskwraith-evil')).toBe(true)
    expect(isReservedCursorMcpServerName('taskwraith_backup')).toBe(false)
    expect(isReservedCursorMcpServerName('user_taskwraith')).toBe(false)
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

  it('preserves other registered MCP servers + unknown top-level keys', () => {
    const existing = {
      mcpServers: { other: { command: 'foo', args: [] } },
      someUnknownTopLevel: { keep: true }
    }
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/s.cjs'] })
    const merged = mergeCursorMcpConfig(existing, entry)
    expect(merged).toEqual({
      mcpServers: {
        other: { command: 'foo', args: [] },
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

  it('drops reserved taskwraith servers before adding the real broker + legacy alias', () => {
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
    expect(merged.mcpServers.other).toEqual({ command: 'foo', args: [] })
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
