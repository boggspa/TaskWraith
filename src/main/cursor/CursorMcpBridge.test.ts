import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURSOR_MCP_ALLOW_RULES,
  CURSOR_MCP_SERVER_NAME,
  CURSOR_WEB_FETCH_MCP_SERVER_SOURCE,
  buildCursorMcpServerEntry,
  mergeCursorAllowRules,
  mergeCursorMcpConfig
} from './CursorMcpBridge'

// 1.0.6-CRUX34 (OQ#2) — the Cursor web bridge. The live spike proved that an
// TaskWraith MCP server registered via workspace `.cursor/mcp.json` + `allow:
// ["Mcp(taskwraith:*)"]` + `--approve-mcps` IS invoked by Cursor in headless
// default/write mode (plan mode rejects all tools). These tests pin the pure
// config helpers + prove the embedded server source is valid JS (the template
// string escaping is easy to get wrong).

describe('CURSOR_MCP_ALLOW_RULES', () => {
  it('covers Cursor colon and hyphen MCP tool name spellings', () => {
    expect(CURSOR_MCP_ALLOW_RULES).toEqual([
      `Mcp(${CURSOR_MCP_SERVER_NAME}:*)`,
      `Mcp(${CURSOR_MCP_SERVER_NAME}-*)`
    ])
  })
})

describe('buildCursorMcpServerEntry', () => {
  it('builds the taskwraith entry keyed by the server name', () => {
    const entry = buildCursorMcpServerEntry({ command: '/x/electron', args: ['/tmp/s.cjs'] })
    expect(entry).toEqual({ taskwraith: { command: '/x/electron', args: ['/tmp/s.cjs'] } })
  })

  it('includes env when provided (electron-as-node)', () => {
    const entry = buildCursorMcpServerEntry({
      command: '/x/electron',
      args: ['/tmp/s.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(entry).toEqual({
      taskwraith: { command: '/x/electron', args: ['/tmp/s.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
    })
  })

  it('copies the args array (no aliasing the caller’s array)', () => {
    const args = ['/tmp/s.cjs']
    const entry = buildCursorMcpServerEntry({ command: 'node', args }) as {
      taskwraith: { args: string[] }
    }
    args.push('mutated')
    expect(entry.taskwraith.args).toEqual(['/tmp/s.cjs'])
  })
})

describe('mergeCursorMcpConfig', () => {
  it('adds the taskwraith server into an empty/absent config', () => {
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/s.cjs'] })
    expect(mergeCursorMcpConfig(null, entry)).toEqual({
      mcpServers: { taskwraith: { command: 'node', args: ['/tmp/s.cjs'] } }
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
        taskwraith: { command: 'node', args: ['/tmp/s.cjs'] }
      },
      someUnknownTopLevel: { keep: true }
    })
  })

  it('overwrites a pre-existing taskwraith server entry (latest wins)', () => {
    const existing = { mcpServers: { taskwraith: { command: 'stale', args: ['old'] } } }
    const entry = buildCursorMcpServerEntry({ command: 'node', args: ['/tmp/new.cjs'] })
    const merged = mergeCursorMcpConfig(existing, entry) as {
      mcpServers: { taskwraith: { command: string } }
    }
    expect(merged.mcpServers.taskwraith.command).toBe('node')
  })
})

describe('mergeCursorAllowRules', () => {
  it('adds the allow rule into an empty config (with an empty deny)', () => {
    expect(mergeCursorAllowRules(null, CURSOR_MCP_ALLOW_RULES)).toEqual({
      permissions: { allow: ['Mcp(taskwraith:*)', 'Mcp(taskwraith-*)'], deny: [] }
    })
  })

  it('preserves existing deny rules (e.g. the write-mode Shell deny) + dedups allow', () => {
    const existing = { permissions: { allow: ['Mcp(taskwraith:*)'], deny: ['Shell(**)'] } }
    const merged = mergeCursorAllowRules(existing, CURSOR_MCP_ALLOW_RULES)
    expect(merged.permissions.allow).toEqual(['Mcp(taskwraith:*)', 'Mcp(taskwraith-*)'])
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
