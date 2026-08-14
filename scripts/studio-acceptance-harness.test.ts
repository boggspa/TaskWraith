import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The production harness is CommonJS because it is run directly by Node.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  assertCleanWatchdogTerminal,
  assertLaunchAuthorized,
  assertNoPriorStudioOrphans,
  buildStudioAcceptanceJourney,
  buildStudioAcceptancePlan,
  buildStudioUiDriverRequest,
  buildStubSpec,
  descendantsOf,
  driveStudioUiJourney,
  launchUnderWatchdog,
  materializeOwnedMedia,
  parseArgs,
  parseProcessTable,
  runStudioUiDriver,
  waitForStudioJournalOperation,
  runStudioAcceptance
} = require('./studio-acceptance-harness.cjs') as {
  assertCleanWatchdogTerminal: (terminal: Record<string, unknown>) => Record<string, unknown>
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
  ) => Promise<{
    scanned: number
    trusted: number
    protectedInstalledGroups: Array<{
      receiptPath: string
      pgid: number
      memberPids: number[]
    }>
    orphans: unknown[]
  }>
  buildStudioAcceptanceJourney: () => Array<Record<string, any>>
  buildStudioAcceptancePlan: (options?: Record<string, unknown>) => Record<string, any>
  buildStudioUiDriverRequest: (options: Record<string, any>) => Record<string, any>
  buildStubSpec: (options: {
    directory: string
    timeoutMs?: number
    forceAfterMs?: number
    stubbornGrandchild?: boolean
    grandchildGracefulExitMs?: number
  }) => Record<string, any>
  descendantsOf: (
    rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>,
    rootPid: number
  ) => Array<{ pid: number; ppid: number; pgid: number; command: string }>
  driveStudioUiJourney: (
    plan: Record<string, any>,
    target: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
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
  runStudioUiDriver: (
    plan: Record<string, any>,
    target: Record<string, any>,
    actions: Array<Record<string, unknown>>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  waitForStudioJournalOperation: (
    plan: Record<string, any>,
    expectation: Record<string, any>,
    options?: Record<string, any>
  ) => Promise<Record<string, any>>
  runStudioAcceptance: (
    args: Record<string, any>,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
}
/* eslint-enable @typescript-eslint/no-require-imports */

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
      launchRequiresOwnerOrphanClearance: true,
      exactCompanionWindowTargeting: true,
      uiDriverNeverSignalsProcesses: true,
      realTranscriptRequired: true,
      evidenceAfterVerifiedGroupExit: true
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

  it('disconnects a watchdog controller whose launch handshake times out', async () => {
    const root = await temporaryRoot('studio-acceptance-watchdog-timeout-')
    const controller = new EventEmitter() as EventEmitter & {
      pid: number
      connected: boolean
      send: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }
    controller.pid = 6101
    controller.connected = true
    controller.send = vi.fn()
    controller.disconnect = vi.fn(() => {
      controller.connected = false
    })

    await expect(
      launchUnderWatchdog(buildStubSpec({ directory: root }), {
        fork: () => controller,
        launchTimeoutMs: 20
      })
    ).rejects.toThrow(/launch timed out/)
    expect(controller.disconnect).toHaveBeenCalledOnce()
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
      let launched: {
        controllerPid: number
        childPid: number
        childPgid?: number
      } | null = null
      try {
        launched = await waitFor(async () => {
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
        await waitFor(
          () => (processIsAlive(launched.controllerPid) ? null : true),
          'watchdog controller exit'
        )
      } finally {
        if (!ownerKilled && processIsAlive(owner.pid!)) owner.kill('SIGKILL')
        if (launched?.childPgid) {
          try {
            process.kill(-launched.childPgid, 'SIGKILL')
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
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
        const terminalPromise = session.stop()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(processIsAlive(grandchild.pid)).toBe(true)
        const terminal = await terminalPromise
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
    'allows the exact group its configured grace interval before forcing it down',
    async () => {
      const root = await temporaryRoot('studio-acceptance-watchdog-grace-')
      const spec = buildStubSpec({
        directory: root,
        forceAfterMs: 500,
        grandchildGracefulExitMs: 150
      })
      const session = await launchUnderWatchdog(spec, {
        controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
      })
      const grandchild = await waitFor(async () => {
        try {
          return JSON.parse(
            await fsPromises.readFile(path.join(root, 'grandchild-ready.json'), 'utf8')
          )
        } catch {
          return null
        }
      }, 'graceful grandchild readiness')

      try {
        const terminal = await session.stop()
        expect(terminal).toMatchObject({
          status: 'reaped',
          reason: 'owner_requested',
          groupExitVerified: true
        })
        await waitFor(
          () => (processIsAlive(grandchild.pid) ? null : true),
          'graceful grandchild process-group exit'
        )
        const receipt = JSON.parse(await fsPromises.readFile(session.receiptPath, 'utf8'))
        expect(receipt).toMatchObject({
          schemaVersion: 2,
          status: 'reaped',
          groupExitVerified: true
        })
        expect(receipt.groupRequiredForceKill).not.toBe(true)
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
            kind: 'taskwraith-studio-acceptance-watchdog',
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
        await waitFor(() => (processIsAlive(orphan.pid!) ? null : true), 'orphan fixture exit')
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
            kind: 'taskwraith-studio-acceptance-watchdog',
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
        await waitFor(
          () => (processIsAlive(reused.pid!) ? null : true),
          'reused process-group fixture exit'
        )
      }
    }
  )

  it('excludes the owner installed TaskWraith Studio group from a legacy pgid collision without signaling it', async () => {
    const installedPgid = 93870
    const execFile = vi.fn(async () => ({
      stdout: [
        `${installedPgid} 1 ${installedPgid} /Applications/TaskWraith.app/Contents/MacOS/TaskWraith`,
        `95216 ${installedPgid} ${installedPgid} /Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion`
      ].join('\n'),
      stderr: ''
    }))

    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNowInstalled' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 1,
                status: 'reaped',
                childPid: installedPgid,
                childPgid: installedPgid
              }
            }
          ],
          execFile
        }
      )
    ).resolves.toMatchObject({
      orphans: [],
      protectedInstalledGroups: [
        {
          receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
          pgid: installedPgid,
          memberPids: [installedPgid, 95216]
        }
      ]
    })
    expect(execFile).toHaveBeenCalledOnce()
    expect(execFile).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='])
  })

  it('does not exempt a Studio-looking descendant unless the exact installed app owns the group', async () => {
    const acceptancePgid = 93871

    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNowUntrusted' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 1,
                status: 'reaped',
                childPid: acceptancePgid,
                childPgid: acceptancePgid
              }
            }
          ],
          execFile: async () => ({
            stdout: [
              `${acceptancePgid} 1 ${acceptancePgid} /virtual/acceptance/Electron`,
              `95217 ${acceptancePgid} ${acceptancePgid} /Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion`
            ].join('\n'),
            stderr: ''
          })
        }
      )
    ).rejects.toThrow(/still alive/)
  })

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

  it.each([
    [
      'wrong kind',
      {
        kind: 'unrelated-receipt',
        schemaVersion: 2,
        status: 'reaped',
        groupExitVerified: true,
        childPid: 8101,
        childPgid: 8101
      }
    ],
    [
      'future schema',
      {
        kind: 'taskwraith-studio-acceptance-watchdog',
        schemaVersion: 3,
        status: 'reaped',
        groupExitVerified: true,
        childPid: 8102,
        childPgid: 8102
      }
    ],
    [
      'missing process group identity',
      {
        kind: 'taskwraith-studio-acceptance-watchdog',
        schemaVersion: 2,
        status: 'reaped',
        groupExitVerified: true,
        childPid: 8103,
        childPgid: null
      }
    ]
  ])('fails closed for a prior watchdog receipt with %s', async (_label, receipt) => {
    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNow04' },
        {
          readPriorReceipts: async () => [
            { receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json', receipt }
          ]
        }
      )
    ).rejects.toThrow(/could not be read/)
  })

  it('does not trust a non-terminal v2 receipt merely because it claims group verification', async () => {
    await expect(
      assertNoPriorStudioOrphans(
        { artifactRoot: '/virtual/acceptance/studioNow05' },
        {
          readPriorReceipts: async () => [
            {
              receiptPath: '/virtual/acceptance/prior/watchdog-receipt.json',
              receipt: {
                kind: 'taskwraith-studio-acceptance-watchdog',
                schemaVersion: 2,
                status: 'running',
                groupExitVerified: true,
                childPid: 8104,
                childPgid: 8104
              }
            }
          ],
          execFile: async () => ({ stdout: '8104 1 8104 /usr/bin/node\n', stderr: '' })
        }
      )
    ).rejects.toThrow(/still alive/)
  })

  it('builds a bounded exact-window driver request and refuses unsafe targets', () => {
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [
          {
            windowId: 42,
            title: 'TaskWraith Studio',
            bounds: { x: 100, y: 120, width: 1280, height: 720 }
          }
        ]
      },
      artifactRoot: '/virtual/acceptance/studioDriver01'
    }
    expect(
      buildStudioUiDriverRequest({
        ...target,
        actions: [
          { type: 'key', key: 'tab' },
          { type: 'key', key: 'return' }
        ]
      })
    ).toMatchObject({
      schemaVersion: 1,
      expectedPid: 7002,
      expectedPgid: 7001,
      windowId: 42,
      actions: [
        { type: 'key', key: 'tab' },
        { type: 'key', key: 'return' }
      ]
    })
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        companion: { ...target.companion, pgid: 9999 },
        actions: [{ type: 'key', key: 'tab' }]
      })
    ).toThrow(/process group/)
    expect(() =>
      buildStudioUiDriverRequest({
        ...target,
        companion: {
          ...target.companion,
          command:
            '/Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion --viewer'
        },
        actions: [{ type: 'key', key: 'tab' }]
      })
    ).toThrow(/installed TaskWraith/)
    expect(() =>
      buildStudioUiDriverRequest({ ...target, actions: [{ type: 'key', key: 'delete-all' }] })
    ).toThrow(/unsupported UI action/)
  })

  it('waits for a real nonempty transcript journal operation', async () => {
    const root = await temporaryRoot('studio-acceptance-transcript-journal-')
    const studioStateDirectory = path.join(root, 'studio-companion')
    await fsPromises.mkdir(studioStateDirectory, { recursive: true })
    await fsPromises.writeFile(
      path.join(studioStateDirectory, 'studio-project.journal.jsonl'),
      [
        JSON.stringify({
          format: 'taskwraith-studio-journal',
          v: 1,
          revision: 1,
          op: { type: 'set_transcript', transcript: { assetId: 'asset-a', segments: [] } }
        }),
        JSON.stringify({
          format: 'taskwraith-studio-journal',
          v: 1,
          revision: 2,
          op: {
            type: 'set_transcript',
            transcript: {
              assetId: 'asset-a',
              segments: [{ segmentId: 'seg-a', text: 'spoken words' }]
            }
          }
        })
      ].join('\n') + '\n'
    )

    await expect(
      waitForStudioJournalOperation(
        { studioStateDirectory },
        { type: 'set_transcript', assetId: 'asset-a', requireNonEmptyTranscript: true },
        { timeoutMs: 100 }
      )
    ).resolves.toMatchObject({ revision: 2, op: { type: 'set_transcript' } })
  })

  it('runs the Swift driver from a bounded request file and validates its receipt', async () => {
    const root = await temporaryRoot('studio-acceptance-driver-request-')
    const target = {
      companion: {
        pid: 7002,
        ppid: 7001,
        pgid: 7001,
        command: '/virtual/TaskWraithStudioCompanion --viewer'
      },
      electronPgid: 7001,
      window: {
        pid: 7002,
        visibleWindowCount: 1,
        windows: [{ windowId: 42, bounds: { x: 1, y: 2, width: 640, height: 360 } }]
      }
    }
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const request = JSON.parse(await fsPromises.readFile(args[1], 'utf8'))
      return {
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          kind: 'taskwraith-studio-ui-driver-receipt',
          pid: request.expectedPid,
          pgid: request.expectedPgid,
          windowId: request.windowId,
          actions: request.actions.map((action: Record<string, unknown>, index: number) => ({
            index,
            type: action.type,
            key: action.key ?? null,
            screenshotPath: action.path ?? null,
            byteLength: action.path ? 4096 : null
          }))
        })}\n`,
        stderr: ''
      }
    })

    const receipt = await runStudioUiDriver(
      { artifactRoot: root },
      target,
      [
        { type: 'key', key: 'tab' },
        { type: 'screenshot', name: 'transcript-band' }
      ],
      { execFile }
    )
    expect(receipt).toMatchObject({
      kind: 'taskwraith-studio-ui-driver-receipt',
      pid: 7002,
      pgid: 7001,
      windowId: 42,
      actions: [
        { index: 0, type: 'key', key: 'tab' },
        { index: 1, type: 'screenshot' }
      ]
    })
    expect(execFile).toHaveBeenCalledOnce()
    expect(execFile.mock.calls[0][0]).toBe('/usr/bin/swift')
    expect(execFile.mock.calls[0][1][0]).toMatch(/studio-acceptance-ui-driver\.swift$/)
  })

  it('defines and drives the host-authorized accept/reject journey in exact order', async () => {
    expect(buildStudioAcceptanceJourney().map((stage) => stage.id)).toEqual([
      'transcript-ready',
      'propose-accept',
      'review-current-proposed',
      'accept',
      'propose-reject',
      'reject',
      'transport-review'
    ])

    const calls: string[] = []
    let proposalNumber = 0
    const receipt = await driveStudioUiJourney(
      { artifactRoot: '/virtual/acceptance/studioJourney01' },
      {
        companion: { pid: 7002, pgid: 7001, command: '/virtual/TaskWraithStudioCompanion' },
        electronPgid: 7001,
        window: {}
      },
      {
        waitForJournalOperation: async (_plan: unknown, expectation: Record<string, unknown>) => {
          calls.push(
            `journal:${String(expectation.type)}:${String(
              expectation.decision ?? expectation.assetId ?? ''
            )}`
          )
          if (expectation.type === 'set_transcript') {
            return { revision: 2, op: { type: 'set_transcript' } }
          }
          if (expectation.type === 'propose_edit') {
            proposalNumber += 1
            return {
              revision: 2 + proposalNumber * 2 - 1,
              op: {
                type: 'propose_edit',
                proposal: { proposalId: `proposal-${proposalNumber}` }
              }
            }
          }
          return {
            revision: 2 + proposalNumber * 2,
            op: {
              type: 'resolve_proposal',
              proposalId: `proposal-${proposalNumber}`,
              decision: expectation.decision
            }
          }
        },
        runUiDriver: async (
          _plan: unknown,
          _target: unknown,
          actions: Array<Record<string, unknown>>
        ) => {
          calls.push(`driver:${actions.map((action) => action.key ?? action.name).join(',')}`)
          return {
            schemaVersion: 1,
            kind: 'taskwraith-studio-ui-driver-receipt',
            pid: 7002,
            pgid: 7001,
            windowId: 42,
            actions: actions.map((action, index) => ({
              index,
              type: action.type,
              key: action.key ?? null,
              screenshotPath:
                action.type === 'screenshot' ? `/virtual/${String(action.name)}.png` : null
            }))
          }
        }
      }
    )

    expect(receipt).toMatchObject({
      ok: true,
      transcript: { revision: 2 },
      accepted: { proposalId: 'proposal-1', resolutionRevision: 4 },
      rejected: { proposalId: 'proposal-2', resolutionRevision: 6 }
    })
    expect(calls).toEqual([
      'journal:set_transcript:',
      'driver:tab,bracket-left,return',
      'journal:propose_edit:',
      'driver:ghost',
      'driver:w,current,v,proposed',
      'driver:a',
      'journal:resolve_proposal:accept',
      'driver:w,tab,bracket-right,return',
      'journal:propose_edit:',
      'driver:ghost-reject',
      'driver:r',
      'journal:resolve_proposal:reject',
      'driver:space,right,left,i,o,l,p,c,g,s,final'
    ])
    expect(receipt.screenshots).toEqual([
      '/virtual/ghost.png',
      '/virtual/current.png',
      '/virtual/proposed.png',
      '/virtual/ghost-reject.png',
      '/virtual/final.png'
    ])
  })

  it('fails a partial UI journey without manufacturing a success receipt', async () => {
    let driverCalls = 0
    await expect(
      driveStudioUiJourney(
        { artifactRoot: '/virtual/acceptance/studioJourneyFail' },
        {
          companion: { pid: 7002, pgid: 7001, command: '/virtual/TaskWraithStudioCompanion' },
          electronPgid: 7001,
          window: {}
        },
        {
          waitForJournalOperation: async (_plan: unknown, expectation: Record<string, unknown>) => {
            if (expectation.type === 'set_transcript') {
              return { revision: 2, op: { type: 'set_transcript' } }
            }
            return {
              revision: 3,
              op: { type: 'propose_edit', proposal: { proposalId: 'proposal-fail' } }
            }
          },
          runUiDriver: async () => {
            driverCalls += 1
            if (driverCalls === 2) throw new Error('screenshot failed')
            return { actions: [] }
          }
        }
      )
    ).rejects.toThrow(/screenshot failed/)
  })

  it.each([
    [{ status: 'reap_incomplete', reason: 'owner_requested', groupExitVerified: false }],
    [{ status: 'exited', reason: 'child_exit', groupExitVerified: true }],
    [{ status: 'reaped', reason: 'deadline_exceeded', groupExitVerified: true }]
  ])('rejects an unclean acceptance watchdog terminal %#', (terminal) => {
    expect(() => assertCleanWatchdogTerminal(terminal)).toThrow(/did not confirm clean/)
  })

  it('drives the authorized renderer-to-durable-window joins in order without launching Electron', async () => {
    const root = await temporaryRoot('studio-acceptance-joins-')
    const source = path.join(root, 'accept.mov')
    await fsPromises.writeFile(source, 'fixture')
    const calls: string[] = []
    const renderer = { close: () => calls.push('renderer.close') }
    const watchdogTerminal = {
      status: 'reaped',
      reason: 'owner_requested',
      groupExitVerified: true
    }
    let journeyError: Error | null = null
    const session = {
      pid: 7001,
      pgid: 7001,
      remoteDebuggingPort: 9401,
      mainInspectorPort: 9801,
      stop: async () => {
        calls.push('watchdog.stop')
        return watchdogTerminal
      }
    }

    const args = {
      ...parseArgs([]),
      launch: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      instanceId: 'studioJoin01',
      mediaPath: source,
      mimeType: 'video/quicktime'
    }
    const adapters = {
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
        return {
          pid: 7002,
          visibleWindowCount: 1,
          windows: [
            {
              windowId: 42,
              title: 'TaskWraith Studio',
              bounds: { x: 100, y: 100, width: 1280, height: 720 }
            }
          ]
        }
      },
      driveUiJourney: async () => {
        calls.push('journey.drive')
        if (journeyError) throw journeyError
        return { ok: true, screenshots: ['/virtual/final.png'] }
      },
      writeEvidence: async () => {
        calls.push('evidence.write')
      }
    }

    const result = await runStudioAcceptance(args, adapters)

    expect(result).toMatchObject({
      launched: true,
      evidence: {
        ok: true,
        electron: { pid: 7001, pgid: 7001 },
        companion: { pid: 7002 },
        window: { visibleWindowCount: 1 },
        durable: { revision: 1 },
        journey: { ok: true, screenshots: ['/virtual/final.png'] },
        watchdogTerminal
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
      'journey.drive',
      'renderer.close',
      'watchdog.stop',
      'evidence.write'
    ])

    calls.length = 0
    journeyError = new Error('mid-action failure')
    await expect(runStudioAcceptance(args, adapters)).rejects.toThrow(/mid-action failure/)
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
      'journey.drive',
      'renderer.close',
      'watchdog.stop'
    ])
  })
})
