import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

type AsyncThreeArg = (first: unknown, second: unknown, third: unknown) => Promise<unknown>

/* eslint-disable @typescript-eslint/no-require-imports */
const runner = require('./studio-transcript-failure-live-runner.cjs') as {
  FIXTURE_DURATION_SECONDS: number
  FIXTURE_FRAME_RATE: number
  FIXTURE_SIZE: string
  MAX_FIXTURE_BYTES: number
  boundedArtifactRoot: (value: string) => string
  buildNoAudioFixtureCommand: (options: Record<string, unknown>) => string[]
  buildNoAudioProbeCommand: (options: Record<string, unknown>) => string[]
  parseNoAudioProbe: (stdout: string) => Record<string, unknown>
  assertSafeFixtureFile: (filePath: string, label?: string) => Promise<Record<string, unknown>>
  assertStableFixtureIdentity: (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    label?: string
  ) => Record<string, unknown>
  validateNoAudioManifest: (
    manifest: Record<string, unknown>,
    expected: Record<string, unknown>
  ) => Record<string, unknown>
  generateNoAudioFixture: (
    options: Record<string, unknown>,
    adapters?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  assertUnavailableTranscriptStatus: (
    status: Record<string, unknown>,
    assetId: string,
    options?: Record<string, unknown>
  ) => Record<string, unknown>
  assertTranscriptStatusHistory: (
    history: Array<Record<string, unknown>>,
    assetId: string,
    options?: Record<string, unknown>
  ) => Record<string, unknown>
  waitForUnavailableTranscriptStatus: (
    options: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  proveNoTranscriptJournal: (
    entries: Array<Record<string, unknown>>,
    assetId: string,
    assetPath: string
  ) => Record<string, unknown>
  provePostReapJournal: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
  assertTargetMatchesFixture: (
    target: Record<string, unknown>,
    fixture: Record<string, unknown>,
    plan: Record<string, unknown>
  ) => Record<string, unknown>
  sealTranscriptFailureEvidence: (
    options: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  assertVerifiedWatchdogReceipt: (
    receipt: Record<string, unknown>,
    terminal: Record<string, unknown>,
    electron: Record<string, unknown>
  ) => Record<string, unknown>
  driveNegativeTranscriptJourney: (
    plan: Record<string, unknown>,
    target: Record<string, unknown>,
    adapters: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  parseTranscriptFailureArgs: (argv: string[]) => Record<string, unknown>
  runTranscriptFailureAcceptance: (
    options: Record<string, unknown>,
    adapters?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
}

const temporaryRoots: string[] = []

async function temporaryRoot(prefix = 'studio-transcript-failure-') {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(directory)
  return directory
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await fsPromises.rm(temporaryRoots.pop() as string, { recursive: true, force: true })
  }
})

function unavailable(assetId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    assetId,
    state: 'unavailable',
    code: 'transcribe_failed',
    message: 'No audio stream is available for on-device transcription.',
    updatedAt: Date.now(),
    ...overrides
  }
}

function launchServicesReceiptFixture() {
  const terminal = {
    type: 'terminal',
    status: 'reaped',
    reason: 'owner_requested',
    childPid: 1357,
    childPgid: 1357,
    groupExitVerified: true,
    detachedGroupExitVerified: true,
    detachedProcessGroups: [{ pgid: 2468, evidencePids: [2468], memberPids: [2468, 2470] }],
    launchServicesExecutable: '/exact/Studio.app/Contents/MacOS/Studio',
    launchServicesAdoption: {
      requestId: 'transcript-adoption',
      pid: 2468,
      pgid: 2468,
      executable: '/exact/Studio.app/Contents/MacOS/Studio',
      startedAt: 'Thu Sep 24 02:00:00 2026',
      acknowledged: true,
      groupExitVerified: true
    }
  }
  const receipt = {
    schemaVersion: 2,
    kind: 'taskwraith-studio-acceptance-watchdog',
    ...structuredClone(terminal)
  }
  const electron = {
    pid: 2468,
    pgid: 2468,
    launchMode: 'launch-services',
    launcherPid: 1357,
    launcherPgid: 1357
  }
  return { receipt, terminal, electron }
}

async function finalReceiptFixture(launchMode = 'launch-services') {
  const root = await temporaryRoot('studio-transcript-disk-join-')
  const fixture = await runner.generateNoAudioFixture(
    { artifactRoot: root, durationSeconds: 2 },
    {
      resolveMediaTool: (name: string) => `/virtual/${name}`,
      realpathTool: async (filePath: string) => filePath,
      readToolReceipt: async (filePath: string) => ({
        path: filePath,
        sha256: 'c'.repeat(64),
        byteLength: 10
      }),
      execFile: async (command: string, args: string[]) => {
        if (args[0] === '-version') return { stdout: `${command} version test` }
        if (command === '/virtual/ffmpeg') {
          await fsPromises.writeFile(args.at(-1) as string, 'deterministic-video')
        }
        return {
          stdout:
            command === '/virtual/ffprobe'
              ? '{"programs":[],"stream_groups":[],"streams":[{"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","nb_read_frames":"60","duration":"2.000000"}],"format":{"duration":"2.000000"}}'
              : ''
        }
      }
    }
  )
  const launchServices = launchServicesReceiptFixture()
  const terminal =
    launchMode === 'launch-services'
      ? launchServices.terminal
      : {
          type: 'terminal',
          status: 'reaped',
          reason: 'owner_requested',
          childPid: 1234,
          childPgid: 1234,
          groupExitVerified: true,
          detachedGroupExitVerified: true,
          detachedProcessGroups: []
        }
  const electron =
    launchMode === 'launch-services'
      ? launchServices.electron
      : { launchMode: 'direct', pid: 1234, pgid: 1234, launcherPid: null, launcherPgid: null }
  const evidence = {
    ok: true,
    instanceId: 'transcript-disk',
    journey: { statusHistory: { events: [] }, journal: {} },
    electron,
    watchdogTerminal: terminal
  }
  const plan = {
    artifactRoot: root,
    evidencePath: path.join(root, 'harness.json'),
    receiptPath: path.join(root, 'watchdog.json'),
    studioStateDirectory: path.join(root, 'state'),
    profile: { userDataPath: path.join(root, 'home') },
    repoRoot: path.resolve(__dirname, '..')
  }
  const assetId = Buffer.from(fixture.outputSha256 as string, 'hex').toString('base64url')
  const assetPath = path.join(
    plan.profile.userDataPath,
    'transcript-media',
    assetId.slice(0, 2),
    `${assetId}.mp4`
  )
  return {
    terminal,
    async seal(mutateDisk?: (disk: Record<string, any>) => void) {
      const disk = {
        schemaVersion: 1,
        kind: 'taskwraith-studio-in-product-acceptance',
        ...structuredClone(evidence)
      }
      mutateDisk?.(disk)
      await fsPromises.writeFile(plan.evidencePath, JSON.stringify(disk))
      await fsPromises.writeFile(
        plan.receiptPath,
        JSON.stringify({
          schemaVersion: 2,
          kind: 'taskwraith-studio-acceptance-watchdog',
          ...terminal
        })
      )
      return runner.sealTranscriptFailureEvidence({
        plan,
        fixture,
        result: { evidence },
        sleep: async () => {},
        readJournalOperations: async () => [
          {
            revision: 1,
            op: { type: 'open_media', asset: { assetId, path: assetPath, mediaKind: 'video' } }
          }
        ]
      })
    }
  }
}

describe('Transcript failure adoption receipt joins', () => {
  it.each(['direct', 'launch-services'])(
    'seals the complete %s disk harness joins',
    async (mode) => {
      const fixture = await finalReceiptFixture(mode)
      const sealed = await fixture.seal()
      expect(fs.existsSync(sealed.path as string)).toBe(true)
      if (mode === 'direct') expect(fixture.terminal).not.toHaveProperty('launchServicesAdoption')
    }
  )

  it.each([
    'missing terminal',
    'stripped adoption',
    'stripped executable',
    'requestId',
    'startedAt',
    'executable',
    'missing electron',
    'electron pid',
    'electron metadata'
  ])(
    'rejects disk-harness-only %s while returned and watchdog proofs remain complete',
    async (damage) => {
      const fixture = await finalReceiptFixture()
      await expect(
        fixture.seal((disk) => {
          if (damage === 'missing terminal') delete disk.watchdogTerminal
          else if (damage === 'stripped adoption')
            delete disk.watchdogTerminal.launchServicesAdoption
          else if (damage === 'stripped executable')
            delete disk.watchdogTerminal.launchServicesExecutable
          else if (damage === 'missing electron') delete disk.electron
          else if (damage === 'electron pid') disk.electron.pid += 1
          else if (damage === 'electron metadata') disk.electron.remoteDebuggingPort = 9555
          else disk.watchdogTerminal.launchServicesAdoption[damage] = 'contradictory-disk-proof'
        })
      ).rejects.toThrow(/disk harness (Electron|watchdog)/)
    }
  )

  it('rejects a disk-harness-only direct terminal contradiction', async () => {
    const fixture = await finalReceiptFixture('direct')
    await expect(
      fixture.seal((disk) => {
        disk.watchdogTerminal.childPid += 1
      })
    ).rejects.toThrow(/disk harness watchdog/)
  })

  it('accepts an acknowledged exact Electron adoption and reap', () => {
    const { receipt, terminal, electron } = launchServicesReceiptFixture()
    expect(runner.assertVerifiedWatchdogReceipt(receipt, terminal, electron)).toBe(receipt)
  })

  it.each(['both', 'disk', 'terminal'])(
    'rejects stripped LaunchServices proof from %s receipts',
    (side) => {
      const { receipt, terminal, electron } = launchServicesReceiptFixture()
      for (const value of [
        ...(side !== 'terminal' ? [receipt] : []),
        ...(side !== 'disk' ? [terminal] : [])
      ]) {
        delete (value as Record<string, unknown>).launchServicesExecutable
        delete (value as Record<string, unknown>).launchServicesAdoption
      }
      expect(() => runner.assertVerifiedWatchdogReceipt(receipt, terminal, electron)).toThrow(
        /adoption/
      )
    }
  )

  it.each(['requestId', 'startedAt', 'executable', 'pid', 'pgid'] as const)(
    'rejects a mismatched adoption %s despite otherwise reaped receipts',
    (field) => {
      const { receipt, terminal, electron } = launchServicesReceiptFixture()
      const adoption = terminal.launchServicesAdoption
      if (field === 'requestId') adoption.requestId = 'another-request'
      else if (field === 'startedAt') adoption.startedAt = 'Thu Sep 24 02:00:01 2026'
      else if (field === 'executable')
        adoption.executable = terminal.launchServicesExecutable = '/other/Studio'
      else if (field === 'pid') electron.pid = 2470
      else {
        for (const value of [receipt, terminal]) {
          value.launchServicesAdoption.pgid = 3000
          value.detachedProcessGroups.push({ pgid: 3000, evidencePids: [2468], memberPids: [2468] })
        }
      }
      expect(() => runner.assertVerifiedWatchdogReceipt(receipt, terminal, electron)).toThrow(
        /adoption/
      )
    }
  )
})

describe('negative transcript status is exact and fail-closed', () => {
  it('accepts only a typed unavailable status for the exact asset', () => {
    const status = runner.assertUnavailableTranscriptStatus(unavailable('asset-a'), 'asset-a')
    expect(status).toMatchObject({
      assetId: 'asset-a',
      state: 'unavailable',
      code: 'transcribe_failed'
    })
  })

  it.each([
    ['wrong asset', unavailable('asset-b'), /asset is wrong/],
    ['stale state', unavailable('asset-a', { state: 'pending', code: null }), /not unavailable/],
    ['empty code', unavailable('asset-a', { code: '' }), /code must be nonempty/],
    ['empty message', unavailable('asset-a', { message: ' ' }), /message must be nonempty/],
    ['invalid timestamp', unavailable('asset-a', { updatedAt: 0 }), /updatedAt is invalid/]
  ])('rejects %s', (_label, status, expected) => {
    expect(() => runner.assertUnavailableTranscriptStatus(status, 'asset-a')).toThrow(expected)
  })

  it('rejects a stale terminal status when the caller supplies an observation floor', () => {
    expect(() =>
      runner.assertUnavailableTranscriptStatus(
        unavailable('asset-a', { updatedAt: 10 }),
        'asset-a',
        {
          minimumUpdatedAt: 11
        }
      )
    ).toThrow(/stale/)
  })

  it('waits through wrong-asset and pending notices, then returns the exact terminal notice', async () => {
    const statuses = [
      [{ status: unavailable('other'), receivedAt: Date.now() }],
      [
        { status: unavailable('asset-a', { state: 'pending', code: null }), receivedAt: Date.now() }
      ],
      [
        {
          status: unavailable('asset-a', { state: 'pending', code: null }),
          receivedAt: Date.now()
        },
        { status: unavailable('asset-a'), receivedAt: Date.now() + 1 }
      ]
    ]
    const result = await runner.waitForUnavailableTranscriptStatus({
      assetId: 'asset-a',
      timeoutMs: 1_000,
      readHistory: async () => statuses.shift(),
      waitFor: async (options: { probe: () => Promise<unknown> }) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const observed = await options.probe()
          if (observed) return observed as Record<string, unknown>
        }
        throw new Error('timeout')
      }
    })
    expect(result).toMatchObject({
      unavailable: { status: { assetId: 'asset-a', state: 'unavailable' } }
    })
  })

  it('fails on malformed terminal errors instead of treating them as a timeout', async () => {
    await expect(
      runner.waitForUnavailableTranscriptStatus({
        assetId: 'asset-a',
        timeoutMs: 1_000,
        readHistory: async () => [
          {
            status: unavailable('asset-a', { state: 'pending', code: null }),
            receivedAt: Date.now()
          },
          { status: unavailable('asset-a', { code: '' }), receivedAt: Date.now() + 1 }
        ],
        waitFor: async (options: { probe: () => Promise<unknown> }) => options.probe()
      })
    ).rejects.toThrow(/code must be nonempty/)
  })

  it('rejects pre-install, wrong-asset, and out-of-order histories', () => {
    const pending = unavailable('asset-a', { state: 'pending', code: null })
    const terminal = unavailable('asset-a')
    expect(() =>
      runner.assertTranscriptStatusHistory(
        [
          { status: pending, receivedAt: 10 },
          { status: terminal, receivedAt: 11 }
        ],
        'asset-a',
        { installedAt: 12 }
      )
    ).toThrow(/lacks pending/)
    expect(() =>
      runner.assertTranscriptStatusHistory(
        [
          { status: unavailable('other', { state: 'pending', code: null }), receivedAt: 20 },
          { status: unavailable('other'), receivedAt: 21 }
        ],
        'asset-a'
      )
    ).toThrow(/lacks pending/)
    expect(() =>
      runner.assertTranscriptStatusHistory(
        [
          { status: terminal, receivedAt: 30 },
          { status: pending, receivedAt: 31 }
        ],
        'asset-a'
      )
    ).toThrow(/ordered pending/)
    expect(() =>
      runner.assertTranscriptStatusHistory(
        [
          { status: pending, receivedAt: 40 },
          { status: terminal, receivedAt: 41 },
          { status: pending, receivedAt: 42 }
        ],
        'asset-a'
      )
    ).toThrow(/post-terminal/)
  })

  it('passes the bounded timeout to the wait adapter and fails closed when it expires', async () => {
    let observedTimeout = null
    await expect(
      runner.waitForUnavailableTranscriptStatus({
        assetId: 'asset-a',
        timeoutMs: 1234,
        readHistory: async () => [],
        waitFor: async (options: { timeoutMs: number }) => {
          observedTimeout = options.timeoutMs
          throw new Error('bounded wait expired')
        }
      })
    ).rejects.toThrow(/bounded wait expired/)
    expect(observedTimeout).toBe(1234)
  })
})

describe('negative transcript journal proof', () => {
  it('proves no set_transcript operation committed for the opened asset', () => {
    const assetPath = '/tmp/studio/asset.mp4'
    const proof = runner.proveNoTranscriptJournal(
      [
        {
          revision: 1,
          op: {
            type: 'open_media',
            asset: { assetId: 'asset-a', path: assetPath, mediaKind: 'video' }
          }
        }
      ],
      'asset-a',
      assetPath
    )
    expect(proof).toMatchObject({ entryCount: 1, setTranscriptForAsset: 0 })
    expect(proof.journalSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reds if either operation identity form commits the negative asset', () => {
    expect(() =>
      runner.proveNoTranscriptJournal(
        [
          {
            revision: 1,
            op: {
              type: 'open_media',
              asset: { assetId: 'asset-a', path: '/tmp/a.mp4', mediaKind: 'video' }
            }
          },
          { revision: 2, op: { type: 'set_transcript', assetId: 'asset-a' } }
        ],
        'asset-a',
        '/tmp/a.mp4'
      )
    ).toThrow(/set_transcript/)
    expect(() =>
      runner.proveNoTranscriptJournal(
        [
          {
            revision: 1,
            op: {
              type: 'open_media',
              asset: { assetId: 'asset-a', path: '/tmp/a.mp4', mediaKind: 'video' }
            }
          },
          { revision: 2, op: { type: 'set_transcript', transcript: { assetId: 'asset-a' } } }
        ],
        'asset-a',
        '/tmp/a.mp4'
      )
    ).toThrow(/set_transcript/)
  })

  it('reds on a missing or wrong open_media identity', () => {
    expect(() => runner.proveNoTranscriptJournal([], 'asset-a', '/tmp/a.mp4')).toThrow(
      /exactly one/
    )
    expect(() =>
      runner.proveNoTranscriptJournal(
        [
          {
            revision: 1,
            op: {
              type: 'open_media',
              asset: { assetId: 'other', path: '/tmp/a.mp4', mediaKind: 'video' }
            }
          }
        ],
        'asset-a',
        '/tmp/a.mp4'
      )
    ).toThrow(/exactly one/)
    expect(() =>
      runner.proveNoTranscriptJournal(
        [
          {
            revision: 1,
            op: {
              type: 'open_media',
              asset: { assetId: 'asset-a', path: '/tmp/a.mp4', mediaKind: 'audio' }
            }
          }
        ],
        'asset-a',
        '/tmp/a.mp4'
      )
    ).toThrow(/exactly one/)
  })

  it('reds when the journal mutates during the bounded quiescence snapshot', async () => {
    const fixtureHash = 'ab'.repeat(32)
    const assetId = Buffer.from(fixtureHash, 'hex').toString('base64url')
    const assetPath = `/tmp/transcript-media/${assetId.slice(0, 2)}/${assetId}.mp4`
    const fixture = { outputPath: '/tmp/a.mp4', outputSha256: fixtureHash }
    const open = {
      revision: 1,
      op: { type: 'open_media', asset: { assetId, path: assetPath, mediaKind: 'video' } }
    }
    let reads = 0
    await expect(
      runner.driveNegativeTranscriptJourney(
        { transcriptTimeoutMs: 1_000, profile: { userDataPath: '/tmp' } },
        { fixture, asset: { sha256: assetId, sourcePath: fixture.outputPath, assetPath } },
        {
          readTranscriptHistory: async () => [
            {
              status: unavailable(assetId, { state: 'pending', code: null }),
              receivedAt: Date.now()
            },
            { status: unavailable(assetId), receivedAt: Date.now() + 1 }
          ],
          waitFor: async (options: { probe: () => Promise<unknown> }) => options.probe(),
          readJournalOperations: async () => {
            reads += 1
            return reads === 1
              ? [open]
              : [
                  open,
                  {
                    revision: 2,
                    op: {
                      type: 'open_media',
                      asset: { assetId: 'other', path: '/tmp/other.mp4', mediaKind: 'video' }
                    }
                  }
                ]
          },
          sleep: async () => undefined
        }
      )
    ).rejects.toThrow(/journal changed/)
  })

  it('reds when the terminal post-reap journal mutates', async () => {
    const assetId = 'asset-a'
    const assetPath = '/tmp/a.mp4'
    const open = {
      revision: 1,
      format: 'taskwraith-studio-journal',
      v: 1,
      op: { type: 'open_media', asset: { assetId, path: assetPath, mediaKind: 'video' } }
    }
    let reads = 0
    await expect(
      runner.provePostReapJournal({
        plan: {},
        assetId,
        assetPath,
        sleep: async () => undefined,
        readJournalOperations: async () => {
          reads += 1
          return reads === 1
            ? [open]
            : [
                open,
                {
                  ...open,
                  revision: 2,
                  op: { ...open.op, asset: { ...open.op.asset, assetId: 'other' } }
                }
              ]
        }
      })
    ).rejects.toThrow(/journal changed/)
  })
})

describe('bounded deterministic no-audio fixture apparatus', () => {
  it('uses a lavfi video source, explicit no-audio mapping, and bit-exact video flags', () => {
    const command = runner.buildNoAudioFixtureCommand({
      outputPath: '/tmp/fixture/acceptance-no-audio.mp4',
      durationSeconds: 5
    })
    expect(command).toContain('lavfi')
    expect(command).toContain('-an')
    expect(command).toContain('-fflags')
    expect(command).toContain('-n')
    expect(command).not.toContain('-y')
    expect(command).toContain('+bitexact')
    expect(command[command.indexOf('-t') + 1]).toBe('5')
    expect(command.at(-1)).toBe('/tmp/fixture/acceptance-no-audio.mp4')
  })

  it('rejects same-identity in-place mutation when the digest changes', () => {
    const identity = { dev: 1, ino: 2, size: 10, mtimeNs: '3', ctimeNs: '4' }
    expect(() =>
      runner.assertStableFixtureIdentity(
        { identity, sha256: 'a'.repeat(64) },
        { identity, sha256: 'b'.repeat(64) },
        'fixture'
      )
    ).toThrow(/identity or hash changed/)
  })

  it('rejects a probe that contains any audio stream', () => {
    expect(() =>
      runner.parseNoAudioProbe('{"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}')
    ).toThrow(/no audio stream/)
  })

  it('generates, probes, hashes, and seals a fixture through adapters without ffmpeg', async () => {
    const root = await temporaryRoot()
    const calls: string[][] = []
    const fixture = await runner.generateNoAudioFixture(
      { artifactRoot: root, durationSeconds: 2 },
      {
        resolveMediaTool: (name: string) => `/virtual/${name}`,
        realpathTool: async (filePath: string) => filePath,
        readToolReceipt: async (filePath: string) => ({
          path: filePath,
          sha256: 'c'.repeat(64),
          byteLength: 10
        }),
        execFile: async (command: string, args: string[]) => {
          calls.push([command, ...args])
          if (args[0] === '-version') return { stdout: `${command} version test` }
          if (command === '/virtual/ffmpeg') {
            await fsPromises.writeFile(args.at(-1) as string, 'deterministic-video')
          }
          return {
            stdout:
              command === '/virtual/ffprobe'
                ? '{"programs":[],"stream_groups":[],"streams":[{"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","nb_read_frames":"60","duration":"2.000000"}],"format":{"duration":"2.000000"}}'
                : ''
          }
        }
      }
    )
    expect(fixture).toMatchObject({ durationSeconds: 2, frameRate: runner.FIXTURE_FRAME_RATE })
    expect(calls.map((call) => call[0])).toEqual([
      '/virtual/ffmpeg',
      '/virtual/ffprobe',
      '/virtual/ffmpeg',
      '/virtual/ffprobe'
    ])
    expect(JSON.parse(await fsPromises.readFile(fixture.manifestPath, 'utf8'))).toEqual(fixture)
  })

  const realFfmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((file) =>
    fs.existsSync(file)
  )
  const realFfprobe = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find((file) =>
    fs.existsSync(file)
  )
  it.skipIf(!realFfmpeg || !realFfprobe)(
    'produces byte-identical fixtures twice with real ffmpeg',
    async () => {
      const firstRoot = await temporaryRoot('studio-transcript-real-a-')
      const secondRoot = await temporaryRoot('studio-transcript-real-b-')
      const adapters = {
        resolveMediaTool: (name: string) => (name === 'ffmpeg' ? realFfmpeg : realFfprobe),
        execFile: async (command: string, args: string[], options: Record<string, unknown>) => {
          const { execFile: run } = await import('node:child_process')
          return await new Promise<{ stdout: string }>((resolve, reject) => {
            run(command, args, options, (error, stdout, stderr) => {
              if (error) {
                error.message += `: ${stderr}`
                reject(error)
              } else resolve({ stdout })
            })
          })
        }
      }
      const first = await runner.generateNoAudioFixture(
        { artifactRoot: firstRoot, durationSeconds: 2 },
        adapters
      )
      const second = await runner.generateNoAudioFixture(
        { artifactRoot: secondRoot, durationSeconds: 2 },
        adapters
      )
      expect(second.outputSha256).toBe(first.outputSha256)
      expect(second.outputByteLength).toBe(first.outputByteLength)
    }
  )

  it('seals runner-owned final evidence after a terminal journal read', async () => {
    const root = await temporaryRoot('studio-transcript-seal-')
    const fixture = await runner.generateNoAudioFixture(
      { artifactRoot: root, durationSeconds: 2 },
      {
        resolveMediaTool: (name: string) => `/virtual/${name}`,
        realpathTool: async (filePath: string) => filePath,
        readToolReceipt: async (filePath: string) => ({
          path: filePath,
          sha256: 'c'.repeat(64),
          byteLength: 10
        }),
        execFile: async (command: string, args: string[]) => {
          if (args[0] === '-version') return { stdout: `${command} version test` }
          if (command === '/virtual/ffmpeg') {
            await fsPromises.writeFile(args.at(-1) as string, 'deterministic-video')
          }
          return {
            stdout:
              command === '/virtual/ffprobe'
                ? '{"programs":[],"stream_groups":[],"streams":[{"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","nb_read_frames":"60","duration":"2.000000"}],"format":{"duration":"2.000000"}}'
                : ''
          }
        }
      }
    )
    const assetId = Buffer.from(fixture.outputSha256, 'hex').toString('base64url')
    const assetPath = path.join(
      root,
      'home',
      'transcript-media',
      assetId.slice(0, 2),
      `${assetId}.mp4`
    )
    const state = path.join(root, 'state')
    await fsPromises.mkdir(state, { recursive: true })
    const plan = {
      artifactRoot: root,
      evidencePath: path.join(root, 'harness.json'),
      receiptPath: path.join(root, 'watchdog.json'),
      studioStateDirectory: state,
      profile: { userDataPath: path.join(root, 'home') },
      repoRoot: fileURLToPath(new URL('..', import.meta.url))
    }
    const terminal = {
      status: 'reaped',
      reason: 'owner_requested',
      groupExitVerified: true,
      detachedGroupExitVerified: true,
      childPid: 1234,
      childPgid: 1234
    }
    await fsPromises.writeFile(
      plan.evidencePath,
      `${JSON.stringify({ watchdogTerminal: terminal, electron: { pid: 1234, pgid: 1234 } })}\n`
    )
    await fsPromises.writeFile(
      plan.receiptPath,
      `${JSON.stringify({ schemaVersion: 2, kind: 'taskwraith-studio-acceptance-watchdog', ...terminal })}\n`
    )
    await fsPromises.writeFile(
      path.join(state, 'studio-project.journal.jsonl'),
      `${JSON.stringify({ format: 'taskwraith-studio-journal', v: 1, revision: 1, op: { type: 'open_media', asset: { assetId, path: assetPath, mediaKind: 'video' } } })}\n`
    )
    const sealed = await runner.sealTranscriptFailureEvidence({
      plan,
      fixture,
      result: {
        evidence: {
          journey: {
            statusHistory: { events: [] },
            journal: {
              before: { journalSha256: 'a'.repeat(64) },
              after: { journalSha256: 'a'.repeat(64) }
            }
          },
          watchdogTerminal: terminal,
          electron: { pid: 1234, pgid: 1234 }
        }
      }
    })
    expect(sealed.path).toBe(
      path.join(await fsPromises.realpath(root), 'transcript-failure-evidence.json')
    )
    const final = JSON.parse(await fsPromises.readFile(sealed.path, 'utf8'))
    expect(final).toMatchObject({
      kind: 'taskwraith-studio-transcript-failure-final-evidence',
      runner: { workspaceRelativePath: 'scripts/studio-transcript-failure-live-runner.cjs' },
      fixture: { outputSha256: fixture.outputSha256 },
      postReapJournal: {
        before: { setTranscriptForAsset: 0 },
        after: { setTranscriptForAsset: 0 }
      }
    })
    expect(() =>
      runner.assertVerifiedWatchdogReceipt(
        { schemaVersion: 2, kind: 'taskwraith-studio-acceptance-watchdog', status: 'running' },
        terminal,
        { pid: 1234, pgid: 1234 }
      )
    ).toThrow(/clean owner-requested teardown/)
    expect(() =>
      runner.assertVerifiedWatchdogReceipt(
        {
          schemaVersion: 2,
          kind: 'taskwraith-studio-acceptance-watchdog',
          ...terminal,
          childPid: 9
        },
        terminal,
        { pid: 1234, pgid: 1234 }
      )
    ).toThrow(/child pid\/pgid/)
    expect(() =>
      runner.assertVerifiedWatchdogReceipt(
        { schemaVersion: 2, kind: 'taskwraith-studio-acceptance-watchdog', ...terminal },
        { ...terminal, childPgid: 5678 },
        { pid: 1234, pgid: 1234 }
      )
    ).toThrow(/terminal child pid\/pgid/)
    const acknowledgedTerminal = launchServicesReceiptFixture().terminal
    const detachedProcessGroups = [
      {
        pgid: 2468,
        evidencePids: [2468, 2470],
        memberPids: [2468, 2470],
        requiredForceKill: true
      }
    ]
    expect(
      runner.assertVerifiedWatchdogReceipt(
        {
          schemaVersion: 2,
          kind: 'taskwraith-studio-acceptance-watchdog',
          ...terminal,
          childPid: 1357,
          childPgid: 1357,
          launchServicesExecutable: acknowledgedTerminal.launchServicesExecutable,
          launchServicesAdoption: acknowledgedTerminal.launchServicesAdoption,
          detachedProcessGroups
        },
        {
          ...terminal,
          childPid: 1357,
          childPgid: 1357,
          launchServicesExecutable: acknowledgedTerminal.launchServicesExecutable,
          launchServicesAdoption: acknowledgedTerminal.launchServicesAdoption,
          detachedProcessGroups
        },
        {
          pid: 2468,
          pgid: 2468,
          launchMode: 'launch-services',
          launcherPid: 1357,
          launcherPgid: 1357
        }
      )
    ).toMatchObject({ childPid: 1357, childPgid: 1357 })
    expect(() =>
      runner.assertVerifiedWatchdogReceipt(
        {
          schemaVersion: 2,
          kind: 'taskwraith-studio-acceptance-watchdog',
          ...terminal,
          childPid: 1357,
          childPgid: 1357,
          detachedProcessGroups: []
        },
        { ...terminal, childPid: 1357, childPgid: 1357, detachedProcessGroups: [] },
        {
          pid: 2468,
          pgid: 2468,
          launchMode: 'launch-services',
          launcherPid: 1357,
          launcherPgid: 1357
        }
      )
    ).toThrow(/exact detached Electron group/)
  })

  it('refuses root targets and symlinked fixture files', async () => {
    expect(() => runner.boundedArtifactRoot('/')).toThrow(/bounded absolute/)
    expect(() => runner.boundedArtifactRoot('relative-artifacts')).toThrow(/originally absolute/)
    expect(() => runner.buildNoAudioFixtureCommand({ outputPath: 'relative.mp4' })).toThrow(
      /originally absolute/
    )
    const root = await temporaryRoot()
    const target = path.join(root, 'target.mp4')
    const link = path.join(root, 'link.mp4')
    await fsPromises.writeFile(target, 'x')
    await fsPromises.symlink(target, link)
    await expect(runner.assertSafeFixtureFile(link)).rejects.toThrow(/regular file/)
  })

  it('validates the manifest contract and product byte bound', () => {
    const outputPath = '/tmp/f/acceptance-no-audio.mp4'
    const manifestPath = '/tmp/f/no-audio-fixture-manifest.json'
    const good = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-transcript-failure-no-audio-fixture',
      durationSeconds: 3,
      expectedFrameCount: 90,
      frameRate: runner.FIXTURE_FRAME_RATE,
      size: runner.FIXTURE_SIZE,
      mimeType: 'video/mp4',
      outputPath,
      manifestPath,
      outputSha256: 'a'.repeat(64),
      outputByteLength: 10,
      ffmpegCommand: runner.buildNoAudioFixtureCommand({
        outputPath,
        durationSeconds: 3,
        ffmpegPath: '/virtual/ffmpeg'
      }),
      ffprobeCommand: runner.buildNoAudioProbeCommand({
        outputPath,
        ffprobePath: '/virtual/ffprobe'
      }),
      ffmpegExitCode: 0,
      ffprobeExitCode: 0,
      tools: { ffmpeg: '/virtual/ffmpeg', ffprobe: '/virtual/ffprobe' },
      toolReceipts: {
        ffmpeg: {
          path: '/virtual/ffmpeg',
          sha256: 'c'.repeat(64),
          byteLength: 10,
          version: 'test'
        },
        ffprobe: {
          path: '/virtual/ffprobe',
          sha256: 'c'.repeat(64),
          byteLength: 10,
          version: 'test'
        }
      },
      probe: {
        streamCount: 1,
        videoStreamCount: 1,
        audioStreamCount: 0,
        width: 640,
        height: 360,
        frameRate: '30/1',
        durationSeconds: 3,
        frameCount: 90
      },
      provenanceNote:
        'Video is synthesised from lavfi testsrc2 with no audio stream. The unavailable status and absence of a set_transcript journal operation are measured by the live journey.'
    }
    expect(
      runner.validateNoAudioManifest(good, { durationSeconds: 3, outputPath, manifestPath })
    ).toBe(good)
    expect(() =>
      runner.validateNoAudioManifest(
        { ...good, outputByteLength: runner.MAX_FIXTURE_BYTES + 1 },
        { durationSeconds: 3, outputPath, manifestPath }
      )
    ).toThrow(/contract/)
    expect(() =>
      runner.validateNoAudioManifest(
        { ...good, extra: true },
        { durationSeconds: 3, outputPath, manifestPath }
      )
    ).toThrow(/keys are not exact/)
    expect(() =>
      runner.validateNoAudioManifest(
        { ...good, ffmpegCommand: [...good.ffmpegCommand.slice(0, -1), '/tmp/mutated.mp4'] },
        { durationSeconds: 3, outputPath, manifestPath }
      )
    ).toThrow(/contract/)
    expect(() =>
      runner.validateNoAudioManifest(
        { ...good, probe: { ...good.probe, frameCount: 89 } },
        { durationSeconds: 3, outputPath, manifestPath }
      )
    ).toThrow(/contract/)
  })

  it('refuses to overwrite an existing output and leaves it untouched', async () => {
    const root = await temporaryRoot()
    const output = path.join(root, 'fixtures', 'acceptance-no-audio.mp4')
    await fsPromises.mkdir(path.dirname(output), { recursive: true })
    await fsPromises.writeFile(output, 'owner-data')
    await expect(
      runner.generateNoAudioFixture(
        { artifactRoot: root, durationSeconds: 2 },
        { execFile: async () => ({ stdout: '' }) }
      )
    ).rejects.toThrow(/already exists/)
    expect(await fsPromises.readFile(output, 'utf8')).toBe('owner-data')
  })

  it('cleans only a regular partial and preserves a raced symlink', async () => {
    const regularRoot = await temporaryRoot('studio-transcript-partial-')
    const regularOutput = path.join(regularRoot, 'fixtures', 'acceptance-no-audio.mp4')
    await expect(
      runner.generateNoAudioFixture(
        { artifactRoot: regularRoot, durationSeconds: 2 },
        {
          resolveMediaTool: (name: string) => `/virtual/${name}`,
          realpathTool: async (filePath: string) => filePath,
          readToolReceipt: async (filePath: string) => ({
            path: filePath,
            sha256: 'c'.repeat(64),
            byteLength: 10
          }),
          execFile: async (command: string, args: string[]) => {
            if (args[0] === '-version') return { stdout: `${command} version test` }
            if (command === '/virtual/ffmpeg') {
              await fsPromises.writeFile(args.at(-1) as string, 'partial')
              throw new Error('controlled ffmpeg failure')
            }
            return { stdout: '' }
          }
        }
      )
    ).rejects.toThrow(/controlled ffmpeg failure/)
    expect((await fsPromises.lstat(regularOutput)).isFile()).toBe(true)

    const symlinkRoot = await temporaryRoot('studio-transcript-race-')
    const symlinkOutput = path.join(symlinkRoot, 'fixtures', 'acceptance-no-audio.mp4')
    const owner = path.join(symlinkRoot, 'owner.bin')
    await fsPromises.writeFile(owner, 'owner')
    await expect(
      runner.generateNoAudioFixture(
        { artifactRoot: symlinkRoot, durationSeconds: 2 },
        {
          resolveMediaTool: (name: string) => `/virtual/${name}`,
          realpathTool: async (filePath: string) => filePath,
          readToolReceipt: async (filePath: string) => ({
            path: filePath,
            sha256: 'c'.repeat(64),
            byteLength: 10
          }),
          execFile: async (command: string, args: string[]) => {
            if (args[0] === '-version') return { stdout: `${command} version test` }
            if (command === '/virtual/ffmpeg') {
              await fsPromises.symlink(owner, args.at(-1) as string)
              throw new Error('controlled raced symlink')
            }
            return { stdout: '' }
          }
        }
      )
    ).rejects.toThrow(/controlled raced symlink/)
    expect((await fsPromises.lstat(symlinkOutput)).isSymbolicLink()).toBe(true)
  })
})

describe('plan-only and launch parsing interlocks', () => {
  it('integrates install-before-open typed capture, journal proof, and post-reap sealing seams', async () => {
    const root = await temporaryRoot('studio-transcript-integration-')
    const fixtureHash = 'cd'.repeat(32)
    const fixture = {
      outputPath: path.join(root, 'fixtures', 'acceptance-no-audio.mp4'),
      manifestPath: path.join(root, 'fixtures', 'no-audio-fixture-manifest.json'),
      outputSha256: fixtureHash,
      outputByteLength: 10,
      durationSeconds: 2,
      frameRate: 30,
      mimeType: 'video/mp4'
    }
    const assetId = Buffer.from(fixtureHash, 'hex').toString('base64url')
    const assetPath = `/tmp/transcript-media/${assetId.slice(0, 2)}/${assetId}.mp4`
    const open = {
      revision: 1,
      op: { type: 'open_media', asset: { assetId, path: assetPath, mediaKind: 'video' } }
    }
    const history: Array<Record<string, unknown>> = []
    let captureInstalled = false
    let openCalled = false
    const result = await runner.runTranscriptFailureAcceptance(
      {
        repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
        instanceId: 'negInt01',
        artifactRoot: path.join(root, 'artifacts'),
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        packagedExecutablePath: '/tmp/fake.app/Contents/MacOS/fake',
        durationSeconds: 2,
        timeoutMs: 60_000,
        transcriptTimeoutMs: 30_000
      },
      {
        generateFixture: async () => fixture,
        evaluateByValue: async (_renderer: unknown, expression: string) => {
          if (expression.includes('onStudioTranscriptStatus')) {
            captureInstalled = true
            return true
          }
          if (expression.includes('.events')) return history
          return true
        },
        invokeStudioOpen: async () => {
          openCalled = captureInstalled
          const now = Date.now()
          history.push(
            {
              status: {
                schemaVersion: 1,
                assetId,
                state: 'pending',
                code: null,
                message: 'pending',
                updatedAt: now
              },
              receivedAt: now
            },
            {
              status: {
                schemaVersion: 1,
                assetId,
                state: 'unavailable',
                code: 'transcribe_failed',
                message: 'no audio',
                updatedAt: now + 1
              },
              receivedAt: now + 1
            }
          )
          return { ok: true }
        },
        readJournalOperations: async () => [open],
        sleep: async () => undefined,
        sealFinalEvidence: async () => ({ path: '/tmp/final.json', sha256: 'e'.repeat(64) }),
        runStudioAcceptance: async (
          _args: Record<string, unknown>,
          adapters: Record<string, unknown>
        ) => {
          const asset = { sourcePath: fixture.outputPath, sha256: assetId, assetPath }
          await (adapters.invokeStudioOpen as AsyncThreeArg)({}, asset, {})
          return {
            launched: true,
            evidence: {
              journey: await (adapters.driveUiJourney as AsyncThreeArg)(
                { transcriptTimeoutMs: 1_000, profile: { userDataPath: '/tmp' } },
                { asset },
                {}
              )
            }
          }
        }
      }
    )
    expect(openCalled).toBe(true)
    expect(result.evidence.journey).toMatchObject({
      kind: 'taskwraith-studio-negative-transcript-journey',
      journal: { before: { maxRevision: 1 }, after: { journalSha256: expect.any(String) } }
    })
    expect(result.finalEvidence).toMatchObject({ sha256: 'e'.repeat(64) })
  })

  it('defaults to a non-launching plan and does not create fixture files', async () => {
    const root = await temporaryRoot()
    const result = await runner.runTranscriptFailureAcceptance({
      repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
      instanceId: 'negPlan01',
      artifactRoot: path.join(root, 'artifacts'),
      launch: false,
      durationSeconds: 2,
      transcriptTimeoutMs: 1_000
    })
    expect(result).toMatchObject({
      launched: false,
      safety: { planOnlyByDefault: true, noGuiProcessStarted: true }
    })
    await expect(fsPromises.lstat(path.join(root, 'artifacts', 'fixtures'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('parses explicit launch flags but still requires the packaged executable at execution time', () => {
    const parsed = runner.parseTranscriptFailureArgs([
      '--launch',
      '--i-accept-studio-isolated-launch',
      '--owner-confirms-existing-orphans-cleared',
      '--instance-id=negLive01',
      '--artifact-root=/tmp/negative-live',
      '--packaged-executable=/tmp/TaskWraith.app/Contents/MacOS/TaskWraith',
      '--duration-seconds=5',
      '--timeout-ms=60000',
      '--transcript-timeout-ms=30000'
    ])
    expect(parsed).toMatchObject({
      launch: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      durationSeconds: 5
    })
  })

  it('rejects an invalid timeout before invoking fixture generation', async () => {
    let generated = false
    const root = await temporaryRoot()
    await expect(
      runner.runTranscriptFailureAcceptance(
        {
          repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
          instanceId: 'negTime01',
          artifactRoot: path.join(root, 'artifacts'),
          launch: true,
          acceptLaunch: true,
          ownerConfirmsOrphansCleared: true,
          packagedExecutablePath: '/tmp/fake.app/Contents/MacOS/fake',
          durationSeconds: 2,
          timeoutMs: 29_999,
          transcriptTimeoutMs: 1_000
        },
        {
          generateFixture: async () => {
            generated = true
            return {}
          }
        }
      )
    ).rejects.toThrow(/timeoutMs/)
    expect(generated).toBe(false)
  })

  it('wires the generated fixture and custom negative journey through an injected harness adapter', async () => {
    const root = await temporaryRoot()
    const fixture = {
      outputPath: path.join(root, 'fixtures', 'acceptance-no-audio.mp4'),
      manifestPath: path.join(root, 'fixtures', 'no-audio-fixture-manifest.json'),
      outputSha256: 'b'.repeat(64),
      outputByteLength: 10,
      durationSeconds: 2,
      frameRate: 30,
      mimeType: 'video/mp4'
    }
    let capturedArgs: Record<string, unknown> | null = null
    const result = await runner.runTranscriptFailureAcceptance(
      {
        repoRoot: '/Users/chrisizatt/Documents/AGBench-studio-continuation',
        instanceId: 'negWire01',
        artifactRoot: path.join(root, 'artifacts'),
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        packagedExecutablePath: '/tmp/fake.app/Contents/MacOS/fake',
        durationSeconds: 2,
        timeoutMs: 60_000,
        transcriptTimeoutMs: 30_000
      },
      {
        generateFixture: async () => fixture,
        driveJourney: async (_plan: Record<string, unknown>, target: Record<string, unknown>) => ({
          kind: 'injected-negative-journey',
          fixture: target.fixture,
          statusHistory: [],
          journal: {}
        }),
        sealFinalEvidence: async () => ({
          path: '/tmp/final-evidence.json',
          sha256: 'd'.repeat(64)
        }),
        runStudioAcceptance: async (
          args: Record<string, unknown>,
          adapters: Record<string, unknown>
        ) => {
          capturedArgs = args
          const plan = { transcriptTimeoutMs: 1_000 }
          const journey = adapters.driveUiJourney as AsyncThreeArg
          return {
            launched: true,
            evidence: {
              journey: await journey(
                plan,
                { asset: { sha256: 'a'.repeat(43), assetPath: fixture.outputPath } },
                {}
              )
            }
          }
        }
      }
    )
    expect(capturedArgs).toMatchObject({
      launch: true,
      mediaPath: fixture.outputPath,
      mimeType: 'video/mp4'
    })
    expect(result).toMatchObject({ launched: true, negativeTranscript: true })
    expect(result.evidence.journey).toMatchObject({
      kind: 'injected-negative-journey',
      fixture
    })
  })
})
