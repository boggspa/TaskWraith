import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

// @portability-ok The source-launcher smoke executes the bundled tui-runtime
// Node binary, a locally-prepared gitignored artifact (`prepare:tui-runtime`)
// that CI runners never prepare. The directory itself always exists — its
// README is tracked — so gate on this platform's prepared binary, resolved the
// way the smoke resolves it, at collect time: an absent runtime produces a
// SKIP, never a silent pass and never a guaranteed failure.
const localTuiRuntimeNode = path.join(
  repoRoot,
  'build',
  'tui-runtime',
  `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
  process.platform === 'win32' ? 'node.exe' : 'node'
)
const hasLocalTuiRuntime = fs.existsSync(localTuiRuntimeNode)

describe('packaged production Host smoke', () => {
  it('waits out a late-released profile tree before removing it', () => {
    // Windows releases a just-closed SQLite file late: the Host's thread-
    // catalogue worker closes thread-catalogue-v1/query.sqlite on shutdown,
    // the launcher exit is observed first, and the hosted runner's scanner can
    // hold the file for seconds after that. Three 100 ms retries were not
    // enough (runs 35034254499 and 35040796137: EBUSY on unlink).
    const smoke = fs.readFileSync(path.join(repoRoot, 'scripts', 'smoke-packaged-host.cjs'), 'utf8')
    const retries = Number(/const PROFILE_REMOVE_RETRIES = (\d+)/.exec(smoke)?.[1])
    const delayMs = Number(/const PROFILE_REMOVE_DELAY_MS = (\d+)/.exec(smoke)?.[1])
    expect(retries * delayMs).toBeGreaterThanOrEqual(15_000)
    expect(smoke).not.toMatch(/maxRetries: 3, retryDelay: 100/)
    expect(smoke.match(/removeTreeWhenReleased\(/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('kills the launcher tree and keeps the smoke failure visible on emergency cleanup', () => {
    // On Windows the launcher is cmd.exe running the packaged node.exe: a
    // signal reaches only cmd.exe, the Host survives holding query.sqlite, and
    // the profile removal in `finally` then throws EBUSY in place of the smoke
    // failure it followed (recovery run 35044758726: orphan node, only EBUSY
    // reported). Emergency cleanup must kill the whole tree, and a cleanup
    // error must never replace the failure that triggered it.
    const smoke = fs.readFileSync(path.join(repoRoot, 'scripts', 'smoke-packaged-host.cjs'), 'utf8')
    expect(smoke).toMatch(/function terminateHostTree\(child\)[\s\S]*?'taskkill'[\s\S]*?'\/T'/)
    expect(smoke).toMatch(/child\.exitCode === null\) \{\s*terminateHostTree\(child\)/)
    expect(smoke).not.toMatch(/child\.exitCode === null\) \{\s*child\.kill\('SIGTERM'\)/)
    expect(smoke).toMatch(/catch \(error\) \{\s*failure = error\s*\}/)
    expect(smoke).toMatch(/if \(failure\) throw failure/)
    // Nothing may throw from a `finally` (no-unsafe-finally): the cleanup runs
    // after the try/catch and re-throws the recorded failure last.
    expect(smoke).not.toMatch(/\} finally \{[\s\S]{0,400}removeTreeWhenReleased\(profile\)/)
  })

  it('gives hosted runners a real history-coverage budget and names a coverage timeout', () => {
    // Since e2187b89f the Host indexes launch history itself: the release-scale
    // fixture (41 threads, >2000 runs and participants) takes 8-12 s to reach
    // coverage=complete on an Apple Silicon Mac, and the hosted Windows runner
    // is the slow I/O class (recovery run 35050063151 lapsed the fixed 30 s
    // budget and then failed a later assertion against the initial snapshot).
    const smoke = fs.readFileSync(path.join(repoRoot, 'scripts', 'smoke-packaged-host.cjs'), 'utf8')
    const budget =
      /TASKWRAITH_HOST_SMOKE_COVERAGE_MS',\s*process\.env\.CI \? (\d[\d_]*) : (\d[\d_]*)/.exec(
        smoke
      )
    expect(budget).not.toBeNull()
    expect(Number(budget![1].replace(/_/g, ''))).toBeGreaterThanOrEqual(120_000)
    expect(Number(budget![2].replace(/_/g, ''))).toBeGreaterThanOrEqual(30_000)
    expect(smoke).not.toMatch(/Math\.max\(timeoutMs, 30_000\)/)
    expect(smoke).toMatch(/history coverage did not complete within/)
  })

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
      execFileSync(npmBinary, ['run', 'host:build', '--silent'], {
        cwd: repoRoot,
        stdio: 'pipe',
        // Node refuses to spawn .cmd/.bat without a shell (EINVAL); the args carry no spaces.
        shell: process.platform === 'win32'
      })
      const result = spawnSync(
        process.execPath,
        ['scripts/smoke-packaged-host.cjs', '--source-launcher'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          // Cold history coverage is asynchronous; each protocol response
          // still has the smoke script's original 12-second deadline.
          timeout: 60_000
        }
      )
      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout || ''}${result.stderr || ''}`).toBe(0)
      expect(`${result.stdout || ''}${result.stderr || ''}`).toContain(
        'packaged production Host source launcher smoke ok'
      )
    },
    90_000
  )
})
