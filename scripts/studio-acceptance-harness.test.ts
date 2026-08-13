import { spawn } from 'node:child_process'
import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The production harness is CommonJS because it is run directly by Node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  assertLaunchAuthorized,
  assertNoPriorStudioOrphans,
  buildStudioAcceptancePlan,
  buildStubSpec,
  descendantsOf,
  launchUnderWatchdog,
  materializeOwnedMedia,
  parseArgs,
  parseProcessTable,
  runStudioAcceptance
} = require('./studio-acceptance-harness.cjs') as {
  assertLaunchAuthorized: (
    args: Record<string, unknown>,
    plan: Record<string, any>
  ) => {
    launch: boolean
    reason?: string
  }
  assertNoPriorStudioOrphans: (
    plan: { artifactRoot: string },
    adapters?: Record<string, unknown>
  ) => Promise<{ scanned: number; trusted: number; orphans: unknown[] }>
  buildStudioAcceptancePlan: (options?: Record<string, unknown>) => Record<string, any>
  buildStubSpec: (options: {
    directory: string
    timeoutMs?: number
    forceAfterMs?: number
    stubbornGrandchild?: boolean
  }) => Record<string, any>
  descendantsOf: (
    rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>,
    rootPid: number
  ) => Array<{ pid: number; ppid: number; pgid: number; command: string }>
  launchUnderWatchdog: (
    spec: Record<string, unknown>,
    adapters?: Record<string, unknown>
  ) => Promise<{
    controllerPid: number
    pid: number
    pgid?: number
    receiptPath: string
    stop: () => Promise<Record<string, unknown>>
  }>
  materializeOwnedMedia: (options: {
    mediaPath: string
    mimeType: string
    userDataPath: string
  }) => Promise<{
    sha256: string
    mimeType: string
    sourcePath: string
    assetPath: string
    byteLength: number
  }>
  parseArgs: (argv: string[]) => Record<string, any>
  parseProcessTable: (
    stdout: string
  ) => Array<{ pid: number; ppid: number; pgid: number; command: string }>
  runStudioAcceptance: (
    args: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true }))
  )
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), label))
  roots.push(root)
  return root
}

async function waitFor<T>(
  probe: () => T | null | Promise<T | null>,
  label: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() <= deadline) {
    try {
      const value = await probe()
      if (value !== null) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function runNode(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`helper exited code=${code} signal=${signal}: ${stderr}`))
    })
  })
}

describe('Studio acceptance harness', () => {
  it('is plan-only by default and uses the sanctioned isolated profile posture', () => {
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioPlan01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    const args = parseArgs([])

    expect(assertLaunchAuthorized(args, plan)).toEqual({
      launch: false,
      reason: 'plan-only; --launch not supplied'
    })
    expect(plan.instanceId).toBe('studioPlan01')
    expect(plan.profile.appName).toBe('TaskWraith Dev studioPlan01')
    expect(plan.spawnPlan.env).toMatchObject({
      TASKWRAITH_INSTANCE_ID: 'studioPlan01',
      IOS_REMOTE_TRUE: '0',
      TASKWRAITH_STUDIO_COMPANION: '1',
      CFFIXED_USER_HOME: '/virtual/repo/.local-only/studio/home'
    })
    expect(plan.spawnPlan.argv).toContain('--use-mock-keychain')
    expect(plan.spawnPlan.argv).not.toContain(expect.stringContaining('--user-data-dir'))
    expect(plan.safety).toMatchObject({
      watchdogOwnsSpawn: true,
      parentDisconnectReapsExactGroup: true,
      neverTargetsLiveOrSharedProfile: true,
      launchRequiresOwnerOrphanClearance: true
    })
  })

  it('refuses a real launch without both explicit consent and orphan clearance', () => {
    const plan = buildStudioAcceptancePlan({
      instanceId: 'studioGuard01',
      repoRoot: '/virtual/repo',
      home: '/virtual/repo/.local-only/studio/home',
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
    const base = {
      ...parseArgs([]),
      launch: true,
      mediaPath: '/video.mov',
      mimeType: 'video/quicktime'
    }
    expect(() => assertLaunchAuthorized(base, plan)).toThrow(/i-accept-studio-isolated-launch/)
    expect(() => assertLaunchAuthorized({ ...base, acceptLaunch: true }, plan)).toThrow(
      /owner-confirms-existing-orphans-cleared/
    )
    // The third arm of the matrix: orphan clearance supplied but consent still
    // missing must fail on consent rather than fall through.
    expect(() =>
      assertLaunchAuthorized({ ...base, ownerConfirmsOrphansCleared: true }, plan)
    ).toThrow(/i-accept-studio-isolated-launch/)
  })

  it('materializes a content-addressed video only inside the isolated transcript-media store', async () => {
    const root = await temporaryRoot('studio-acceptance-media-')
    const source = path.join(root, 'source.mov')
    const userDataPath = path.join(root, 'home', 'Library', 'Application Support', 'isolated')
    await fsPromises.writeFile(source, Buffer.from('real media bytes'))

    const asset = await materializeOwnedMedia({
      mediaPath: source,
      mimeType: 'video/quicktime',
      userDataPath
    })

    expect(asset.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(asset.assetPath).toBe(
      await fsPromises.realpath(
        path.join(userDataPath, 'transcript-media', asset.sha256.slice(0, 2), `${asset.sha256}.mov`)
      )
    )
    expect(await fsPromises.readFile(asset.assetPath, 'utf8')).toBe('real media bytes')
    expect(asset.assetPath.startsWith((await fsPromises.realpath(userDataPath)) + path.sep)).toBe(
      true
    )
  })

  it('derives only exact descendants when locating the Studio child', () => {
    const rows = parseProcessTable(
      [
        '100 1 100 /Applications/Electron',
        '101 100 100 /helper',
        '102 101 100 /TaskWraithStudioCompanion --viewer',
        '200 1 200 /TaskWraithStudioCompanion --unrelated'
      ].join('\n')
    )
    expect(descendantsOf(rows, 100).map((row) => row.pid)).toEqual([101, 102])
  })

  it.runIf(process.platform !== 'win32')(
    'reaps the exact stub process group on a normal owner stop',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-stop-')
      const spec = buildStubSpec({ directory: root, forceAfterMs: 250 })
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      expect(processIsAlive(session.pid)).toBe(true)
      const grandchild = await waitFor(async () => {
        try {
          return JSON.parse(await fsPromises.readFile(path.join(root, 'grandchild.json'), 'utf8'))
        } catch {
          return null
        }
      }, 'stub grandchild launch')
      expect(processIsAlive(grandchild.pid)).toBe(true)

      const terminal = await session.stop()
      expect(terminal).toMatchObject({ status: 'reaped', reason: 'owner_requested' })
      await waitFor(() => (processIsAlive(session.pid) ? null : true), 'stub process exit')
      await waitFor(
        () => (processIsAlive(grandchild.pid) ? null : true),
        'stub grandchild process-group exit'
      )

      const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
      expect(receipt).toMatchObject({
        status: 'reaped',
        childPid: session.pid,
        childPgid: session.pgid,
        reason: 'owner_requested'
      })
    }
  )

  it.runIf(process.platform !== 'win32')(
    'reaps the exact stub group when the owner process dies without cleanup',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-abandon-')
      const harnessPath = path.resolve(__dirname, '..', 'scripts', 'studio-acceptance-harness.cjs')
      const owner = spawn(process.execPath, [harnessPath, '--self-test-abandon-owner', root], {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let ownerKilled = false
      try {
        const launched = await waitFor(async () => {
          try {
            return JSON.parse(await fsPromises.readFile(path.join(root, 'launched.json'), 'utf8'))
          } catch {
            return null
          }
        }, 'abandon-owner launch receipt')
        const grandchild = await waitFor(async () => {
          try {
            return JSON.parse(await fsPromises.readFile(path.join(root, 'grandchild.json'), 'utf8'))
          } catch {
            return null
          }
        }, 'abandon-owner grandchild launch')
        expect(processIsAlive(launched.childPid)).toBe(true)
        expect(processIsAlive(grandchild.pid)).toBe(true)

        ownerKilled = owner.kill('SIGKILL')
        expect(ownerKilled).toBe(true)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('owner did not exit after SIGKILL')),
            5_000
          )
          owner.once('exit', (_code, signal) => {
            clearTimeout(timer)
            expect(signal).toBe('SIGKILL')
            resolve()
          })
        })

        const terminal = await waitFor(async () => {
          try {
            const parsed = JSON.parse(
              await fsPromises.readFile(path.join(root, 'watchdog-receipt.json'), 'utf8')
            )
            return parsed.status === 'reaped' ? parsed : null
          } catch {
            return null
          }
        }, 'watchdog parent-death reaping')

        expect(terminal).toMatchObject({
          status: 'reaped',
          controllerPid: launched.controllerPid,
          childPid: launched.childPid,
          childPgid: launched.childPgid,
          reason: 'owner_disconnected'
        })
        await waitFor(
          () => (processIsAlive(launched.childPid) || processIsAlive(grandchild.pid) ? null : true),
          'entire abandoned stub process group exit'
        )
        expect(processIsAlive(launched.controllerPid)).toBe(false)
      } finally {
        if (!ownerKilled && processIsAlive(owner.pid!)) owner.kill('SIGKILL')
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'refuses to report a clean reap while a SIGTERM-ignoring descendant survives',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-stubborn-')
      const spec = buildStubSpec({ directory: root, forceAfterMs: 250, stubbornGrandchild: true })
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      // Wait for the grandchild's OWN announcement: it is only stubborn once it
      // has installed its SIGTERM handler, and the leader writes its pid before
      // that runtime exists.
      const grandchild = await waitFor(async () => {
        try {
          return JSON.parse(
            await fsPromises.readFile(path.join(root, 'grandchild-ready.json'), 'utf8')
          )
        } catch {
          return null
        }
      }, 'stubborn grandchild readiness')
      expect(processIsAlive(grandchild.pid)).toBe(true)

      try {
        // The group leader dies on SIGTERM; this grandchild ignores it. A
        // terminal `reaped` is only honest once the exact group is gone.
        const terminal = await session.stop()
        expect(terminal).toMatchObject({ status: 'reaped', groupExitVerified: true })
        await waitFor(
          () => (processIsAlive(grandchild.pid) ? null : true),
          'stubborn grandchild process-group exit'
        )

        const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
        expect(receipt).toMatchObject({
          schemaVersion: 2,
          status: 'reaped',
          groupExitVerified: true,
          groupRequiredForceKill: true
        })
      } finally {
        if (session.pgid) {
          try {
            process.kill(-session.pgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'refuses a launch while a prior receipt names a still-live group, and never kills it',
    async () => {
      const root = await temporaryRoot('studio-acceptance-orphan-live-')
      const acceptanceRoot = path.join(root, 'acceptance')
      await fsPromises.mkdir(path.join(acceptanceRoot, 'studioPrior01'), { recursive: true })
      const orphan = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore'
      })
      orphan.unref()
      try {
        // A detached child leads its own group, so pgid === pid. The receipt
        // claims `reaped` on purpose: that is exactly the false-green shape.
        await fsPromises.writeFile(
          path.join(acceptanceRoot, 'studioPrior01', 'watchdog-receipt.json'),
          JSON.stringify({
            schemaVersion: 1,
            status: 'reaped',
            childPid: orphan.pid,
            childPgid: orphan.pid
          })
        )

        await expect(
          assertNoPriorStudioOrphans({ artifactRoot: path.join(acceptanceRoot, 'studioNow01') })
        ).rejects.toThrow(/still alive/)
        expect(processIsAlive(orphan.pid!)).toBe(true)
      } finally {
        try {
          process.kill(orphan.pid!, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'trusts a v2 receipt that verified its own group exit, so a reused pgid cannot block forever',
    async () => {
      const root = await temporaryRoot('studio-acceptance-orphan-trusted-')
      const acceptanceRoot = path.join(root, 'acceptance')
      await fsPromises.mkdir(path.join(acceptanceRoot, 'studioPrior02'), { recursive: true })
      const reused = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore'
      })
      reused.unref()
      try {
        await fsPromises.writeFile(
          path.join(acceptanceRoot, 'studioPrior02', 'watchdog-receipt.json'),
          JSON.stringify({
            schemaVersion: 2,
            status: 'reaped',
            groupExitVerified: true,
            childPid: reused.pid,
            childPgid: reused.pid
          })
        )

        await expect(
          assertNoPriorStudioOrphans({ artifactRoot: path.join(acceptanceRoot, 'studioNow02') })
        ).resolves.toMatchObject({ trusted: 1, orphans: [] })
      } finally {
        try {
          process.kill(reused.pid!, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  )

  it('fails closed when a prior watchdog receipt cannot be read', async () => {
    const root = await temporaryRoot('studio-acceptance-orphan-malformed-')
    const acceptanceRoot = path.join(root, 'acceptance')
    await fsPromises.mkdir(path.join(acceptanceRoot, 'studioPrior03'), { recursive: true })
    await fsPromises.writeFile(
      path.join(acceptanceRoot, 'studioPrior03', 'watchdog-receipt.json'),
      'this is not a receipt'
    )

    await expect(
      assertNoPriorStudioOrphans({ artifactRoot: path.join(acceptanceRoot, 'studioNow03') })
    ).rejects.toThrow(/could not be read/)
  })

  it('drives the authorized renderer-to-durable-window joins in order without launching Electron', async () => {
    const root = await temporaryRoot('studio-acceptance-joins-')
    const source = path.join(root, 'accept.mov')
    await fsPromises.writeFile(source, 'fixture')
    const calls: string[] = []
    const renderer = { close: () => calls.push('renderer.close') }
    const session = {
      pid: 7001,
      pgid: 7001,
      remoteDebuggingPort: 9401,
      mainInspectorPort: 9801,
      stop: async () => {
        calls.push('watchdog.stop')
        return { status: 'reaped' }
      }
    }

    const result = await runStudioAcceptance(
      {
        ...parseArgs([]),
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        instanceId: 'studioJoin01',
        mediaPath: source,
        mimeType: 'video/quicktime'
      },
      {
        planOptions: {
          repoRoot: root,
          home: path.join(root, 'isolated-home'),
          platform: 'darwin',
          adapters: { resolveElectronPath: () => '/virtual/Electron' }
        },
        assertLaunchPortsFree: async () => {
          calls.push('ports.free')
        },
        runBuild: async () => {
          calls.push('build')
        },
        launchUnderWatchdog: async () => {
          calls.push('watchdog.launch')
          return session
        },
        assertExactChildOwnsDebugPorts: async () => {
          calls.push('ports.owned')
        },
        attachRenderer: async () => {
          calls.push('renderer.attach')
          return renderer
        },
        invokeStudioOpen: async (_renderer: unknown, asset: { sha256: string }) => {
          calls.push('preload.open')
          return { ok: true, assetId: asset.sha256 }
        },
        verifyDurableOpen: async () => {
          calls.push('journal.verify')
          return { revision: 1 }
        },
        findCompanion: async () => {
          calls.push('companion.find')
          return { pid: 7002, ppid: 7001, pgid: 7001, command: 'TaskWraithStudioCompanion' }
        },
        probeWindow: async () => {
          calls.push('window.probe')
          return { pid: 7002, visibleWindowCount: 1, windows: [{ title: 'TaskWraith Studio' }] }
        },
        writeEvidence: async () => {
          calls.push('evidence.write')
        }
      }
    )

    expect(result).toMatchObject({
      launched: true,
      evidence: {
        ok: true,
        electron: { pid: 7001, pgid: 7001 },
        companion: { pid: 7002 },
        window: { visibleWindowCount: 1 },
        durable: { revision: 1 }
      }
    })
    expect(calls).toEqual([
      'ports.free',
      'build',
      'watchdog.launch',
      'ports.owned',
      'renderer.attach',
      'preload.open',
      'journal.verify',
      'companion.find',
      'window.probe',
      'evidence.write',
      'renderer.close',
      'watchdog.stop'
    ])
  })
})
