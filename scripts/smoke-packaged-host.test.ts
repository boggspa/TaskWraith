import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

// @portability-ok The source-launcher smoke executes the bundled tui-runtime
// Node binary, a locally-prepared gitignored artifact (`prepare:tui-runtime`)
// that CI runners never prepare. Gate on its presence at collect time so an
// absent runtime produces a SKIP, never a silent pass.
const hasLocalTuiRuntime = fs.existsSync(path.join(repoRoot, 'build', 'tui-runtime'))

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
    expect(smoke).toContain('DevinCredentialLane.js')
    expect(smoke).toContain('conditionalOnlyStatuses')
    expect(smoke).toContain('discovery.payloadVersion')
    expect(smoke).toContain('must identify the exact static payload')
    expect(smoke).toContain('seedReleaseScaleProfile')
    expect(smoke).toContain('release-scale fixture must exceed two thousand rows per family')
    expect(smoke).toContain('genuinely truncated participant family')
    expect(smoke).toContain("status.providerId !== 'antigravity'")
    expect(smoke).not.toContain('exact production main/muse closure')
    expect(smoke).toContain('main provider closure mismatch')
    for (const provider of [
      'Claude',
      'Codex',
      'Cursor',
      'Devin',
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

  it.skipIf(!hasLocalTuiRuntime)(
    'executes the source launcher through bundled tui-runtime Node on this platform',
    () => {
      // @portability-ok Windows resolves the npm launcher as npm.cmd.
      const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      execFileSync(npmBinary, ['run', 'host:build', '--silent'], { cwd: repoRoot, stdio: 'pipe' })
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
    },
    30_000
  )
})
