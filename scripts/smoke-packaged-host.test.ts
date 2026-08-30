import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

describe('packaged production Host smoke', () => {
  it('keeps launcher, resource, and sidecar mode contracts explicit', () => {
    const smoke = fs.readFileSync(path.join(repoRoot, 'scripts', 'smoke-packaged-host.cjs'), 'utf8')
    const posix = fs.readFileSync(
      path.join(repoRoot, 'build', 'host-launcher', 'taskwraith-host'),
      'utf8'
    )
    const cmd = fs.readFileSync(
      path.join(repoRoot, 'build', 'host-launcher', 'taskwraith-host.cmd'),
      'utf8'
    )
    const powershell = fs.readFileSync(
      path.join(repoRoot, 'build', 'host-launcher', 'taskwraith-host.ps1'),
      'utf8'
    )

    expect(smoke).toContain('function validateHostPayload')
    expect(smoke).toContain('function runProductionRoundTrip')
    expect(smoke).toContain("['stop', '--profile', canonicalProfile]")
    expect(smoke).toContain('Emergency-only cleanup')
    expect(smoke).toContain('TASKWRAITH_HOST_REQUIRE_PACKAGE')
    expect(smoke).toContain('host-bin')
    expect(smoke).toContain('legacyChatsPath')
    expect(smoke).toContain('must tighten a legacy chats directory to owner-only')
    expect(smoke).toContain('MistralCredentialLane.js')
    expect(smoke).toContain('conditionalOnlyStatuses')
    expect(smoke).toContain("status.providerId !== 'antigravity'")
    expect(smoke).not.toContain('exact production main/muse closure')
    expect(smoke).toContain('main provider closure mismatch')
    for (const provider of [
      'Claude',
      'Codex',
      'Cursor',
      'Grok',
      'Kimi',
      'Mistral',
      'Muse',
      'Ollama',
      'Pi'
    ]) {
      expect(smoke).toContain(`HostNode${provider}Provider.js`)
    }
    for (const launcher of [posix, cmd, powershell]) {
      expect(launcher).toContain('tui-runtime')
      expect(launcher).toMatch(/serve\s+--mode\s+production/)
      expect(launcher).not.toMatch(/ELECTRON_RUN_AS_NODE=1/)
    }
    expect(posix).not.toContain('*/node')
    expect(cmd).not.toContain('if not defined NODE_BIN if exist "%RUNTIME_ROOT%\\win32-x64')
    expect(cmd).not.toContain('if not defined NODE_BIN if exist "%RUNTIME_ROOT%\\win32-arm64')
  })

  it('executes the source launcher through bundled tui-runtime Node on this platform', () => {
    execFileSync('npm', ['run', 'host:build', '--silent'], { cwd: repoRoot, stdio: 'pipe' })
    const result = spawnSync(
      process.execPath,
      ['scripts/smoke-packaged-host.cjs', '--source-launcher'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 20_000
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(`${result.stdout || ''}${result.stderr || ''}`).toContain(
      'packaged production Host source launcher smoke ok'
    )
  }, 30_000)
})
