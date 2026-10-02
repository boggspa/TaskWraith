import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PROGRAMME_ROLLOUT_FLAGS,
  resolveRolloutFlags,
  pinRolloutFlagsOnSpawnPlan,
  validateRolloutFlagRecord
} = require('./rolloutFlags.cjs')
const { buildElectronSpawnPlan, spawnExactElectronChild } = require('./electronChildSession.cjs')
const { validatePerfEnvironment } = require('./schema.cjs')
const { runT2BaselineCli } = require('./runT2Baseline.cjs')

const QUEUED = 'TASKWRAITH_HOST_QUEUED_START'
const CHECKPOINT = 'TASKWRAITH_CHECKPOINT_WORKER'
const FAIRNESS = 'TASKWRAITH_CODEX_COHORT_FAIRNESS'
const TRANSACTION = 'TASKWRAITH_HOST_TXN_PERSIST'
const JOURNAL = 'TASKWRAITH_JOURNAL_FLUSHER'
const RUN_EVENT = 'TASKWRAITH_RUN_EVENT_FLUSHER'

type Spawned = { cmd: string; args: string[]; opts: { env: Record<string, string> } }

const planBase = {
  instanceId: 'perfFlags01',
  repoRoot: '/virtual/repo',
  remoteDebuggingPort: 9421,
  mainInspectorPort: 9821,
  adapters: { resolveElectronPath: () => '/virtual/Electron' }
}

function fakeSpawn(spawned: Spawned[]) {
  return (cmd: string, args: string[], opts: Spawned['opts']) => {
    spawned.push({ cmd, args, opts })
    return Object.assign(new EventEmitter(), {
      pid: 5151,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true
    })
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('programme rollout flags', () => {
  it.each([JOURNAL, RUN_EVENT])(
    'pins inherited %s off and enables only its explicit declaration',
    (flag) => {
      vi.stubEnv(JOURNAL, '1')
      vi.stubEnv(RUN_EVENT, '1')
      for (const declared of [[], [flag]]) {
        const resolved = resolveRolloutFlags({ declared, inheritedEnv: process.env })
        const plan = pinRolloutFlagsOnSpawnPlan(buildElectronSpawnPlan(planBase), resolved)
        const spawned: Spawned[] = []
        spawnExactElectronChild({ spawnPlan: plan, adapters: { spawn: fakeSpawn(spawned) } })
        for (const name of [JOURNAL, RUN_EVENT]) {
          const token = declared.includes(name) ? '1' : '0'
          expect(spawned[0].opts.env[name]).toBe(token)
          expect(plan.shellCommand).toContain(`${name}=${token}`)
          expect(resolved.record.effective[name]).toBe(token === '1' ? 'on' : 'off')
          if (token === '0') expect(resolved.record.inheritedOverridden).toContain(name)
        }
        expect(validateRolloutFlagRecord(resolved.record)).toEqual([])
      }
    }
  )

  it('pins an inherited transaction ON off unless explicitly declared, including child merge', () => {
    vi.stubEnv(TRANSACTION, '1')
    const off = resolveRolloutFlags({ inheritedEnv: process.env })
    expect(off.values[TRANSACTION]).toBe('0')
    expect(off.record.effective[TRANSACTION]).toBe('off')
    expect(off.record.inheritedOverridden).toContain(TRANSACTION)
    const plan = pinRolloutFlagsOnSpawnPlan(buildElectronSpawnPlan(planBase), off)
    const spawned: Spawned[] = []
    spawnExactElectronChild({ spawnPlan: plan, adapters: { spawn: fakeSpawn(spawned) } })
    expect(spawned[0].opts.env[TRANSACTION]).toBe('0')
  })

  it('records declared transaction ON and pins exact token 1 in the child and command', () => {
    const on = resolveRolloutFlags({ declared: [TRANSACTION] })
    expect(on.values[TRANSACTION]).toBe('1')
    expect(on.record.effective[TRANSACTION]).toBe('on')
    expect(validateRolloutFlagRecord(on.record)).toEqual([])
    const plan = pinRolloutFlagsOnSpawnPlan(buildElectronSpawnPlan(planBase), on)
    expect(plan.shellCommand).toContain(`${TRANSACTION}=1`)
    const spawned: Spawned[] = []
    spawnExactElectronChild({ spawnPlan: plan, adapters: { spawn: fakeSpawn(spawned) } })
    expect(spawned[0].opts.env[TRANSACTION]).toBe('1')
  })

  it('lists exactly the flags the source reads as the exact token 1', () => {
    expect(PROGRAMME_ROLLOUT_FLAGS).toEqual([
      CHECKPOINT,
      FAIRNESS,
      QUEUED,
      TRANSACTION,
      JOURNAL,
      RUN_EVENT
    ])
  })

  it('pins every flag off by default and records each as off', () => {
    const resolved = resolveRolloutFlags()
    expect(resolved.values).toEqual({
      [CHECKPOINT]: '0',
      [FAIRNESS]: '0',
      [QUEUED]: '0',
      [TRANSACTION]: '0',
      [JOURNAL]: '0',
      [RUN_EVENT]: '0'
    })
    expect(resolved.record).toEqual({
      schemaVersion: 1,
      declared: [],
      effective: {
        [CHECKPOINT]: 'off',
        [FAIRNESS]: 'off',
        [QUEUED]: 'off',
        [TRANSACTION]: 'off',
        [JOURNAL]: 'off',
        [RUN_EVENT]: 'off'
      },
      inheritedOverridden: []
    })
  })

  it('turns on only the declared flags and pins the rest off', () => {
    const resolved = resolveRolloutFlags({ declared: [QUEUED] })
    expect(resolved.values).toEqual({
      [CHECKPOINT]: '0',
      [FAIRNESS]: '0',
      [QUEUED]: '1',
      [TRANSACTION]: '0',
      [JOURNAL]: '0',
      [RUN_EVENT]: '0'
    })
    expect(resolved.record.declared).toEqual([QUEUED])
    expect(resolved.record.effective).toEqual({
      [CHECKPOINT]: 'off',
      [FAIRNESS]: 'off',
      [QUEUED]: 'on',
      [TRANSACTION]: 'off',
      [JOURNAL]: 'off',
      [RUN_EVENT]: 'off'
    })
  })

  it('names every inherited value the pin replaces', () => {
    const resolved = resolveRolloutFlags({
      declared: [QUEUED, FAIRNESS],
      inheritedEnv: { [CHECKPOINT]: '1', [QUEUED]: '0', [FAIRNESS]: '1', HOME: '/h' }
    })
    // An inherited ON checkpoint worker is pinned off, an inherited '0' queued
    // start is pinned on, and an inherited value equal to its pin stays silent.
    expect(resolved.record.inheritedOverridden).toEqual([CHECKPOINT, QUEUED])
    expect(
      resolveRolloutFlags({ inheritedEnv: { [CHECKPOINT]: '0' } }).record.inheritedOverridden
    ).toEqual([])
  })

  it('refuses unknown, duplicate and malformed declarations', () => {
    expect(() => resolveRolloutFlags({ declared: ['TASKWRAITH_UTILITY_WRITE'] })).toThrow(
      /programme rollout flag/
    )
    expect(() => resolveRolloutFlags({ declared: ['HOME'] })).toThrow(/programme rollout flag/)
    expect(() => resolveRolloutFlags({ declared: [QUEUED, QUEUED] })).toThrow(/more than once/)
    expect(() => resolveRolloutFlags({ declared: QUEUED })).toThrow(/array/)
  })
})

describe('spawn plan pinning', () => {
  it('pins every flag in the plan env and in the recorded command', () => {
    const plan = buildElectronSpawnPlan(planBase)
    const pinned = pinRolloutFlagsOnSpawnPlan(plan, resolveRolloutFlags({ declared: [QUEUED] }))
    expect(pinned.env).toEqual({
      ...plan.env,
      [CHECKPOINT]: '0',
      [FAIRNESS]: '0',
      [QUEUED]: '1',
      [TRANSACTION]: '0',
      [JOURNAL]: '0',
      [RUN_EVENT]: '0'
    })
    expect(pinned.shellCommand).toBe(
      `env ${CHECKPOINT}=0 ${FAIRNESS}=0 ${QUEUED}=1 ${TRANSACTION}=0 ${JOURNAL}=0 ${RUN_EVENT}=0 ${plan.shellCommand}`
    )
    expect(pinned.argv).toEqual(plan.argv)
    // The unpinned plan is left untouched.
    for (const name of PROGRAMME_ROLLOUT_FLAGS) expect(plan.env[name]).toBeUndefined()
  })

  it('refuses a partial pin, an unknown token or a plan that already sets a flag', () => {
    const plan = buildElectronSpawnPlan(planBase)
    const good = resolveRolloutFlags({ declared: [QUEUED] })
    const { [QUEUED]: _dropped, ...partial } = good.values
    expect(() => pinRolloutFlagsOnSpawnPlan(plan, { values: partial })).toThrow(
      /every programme flag exactly once/
    )
    expect(() =>
      pinRolloutFlagsOnSpawnPlan(plan, { values: { ...good.values, [QUEUED]: 'true' } })
    ).toThrow(/no recognised token/)
    expect(() =>
      pinRolloutFlagsOnSpawnPlan({ ...plan, env: { ...plan.env, [FAIRNESS]: '1' } }, good)
    ).toThrow(/only writer/)
    expect(() => pinRolloutFlagsOnSpawnPlan({ ...plan, shellCommand: '' }, good)).toThrow(
      /shellCommand/
    )
  })

  it('spawns the child with the pinned state even when the runner exports flags', () => {
    vi.stubEnv(CHECKPOINT, '1')
    vi.stubEnv(QUEUED, '1')
    const plan = pinRolloutFlagsOnSpawnPlan(
      buildElectronSpawnPlan(planBase),
      resolveRolloutFlags({ declared: [FAIRNESS], inheritedEnv: process.env })
    )
    const spawned: Spawned[] = []
    spawnExactElectronChild({ spawnPlan: plan, adapters: { spawn: fakeSpawn(spawned) } })
    const env = spawned[0].opts.env
    expect(env[CHECKPOINT]).toBe('0')
    expect(env[QUEUED]).toBe('0')
    expect(env[FAIRNESS]).toBe('1')
    expect(env.TASKWRAITH_INSTANCE_ID).toBe('perfFlags01')
  })
})

describe('environment record', () => {
  const baseEnvironment = {
    schemaVersion: 1,
    runId: 'run',
    gitSha: 'a'.repeat(40),
    appVersion: '1.9.8',
    instanceId: 'perfFlags01',
    userDataDir: '/u',
    remoteDebuggingPort: 9421,
    iosRemote: false,
    fxPosture: 'cinematic_default',
    workload: 'dual_run',
    seed: 42,
    startedAt: '2026-09-24T00:00:00.000Z',
    authoritativeBaseline: false,
    repoProvenance: {
      gitSha: 'a'.repeat(40),
      dirty: false,
      dirtyTreeFingerprint: 'b'.repeat(64),
      dirtyPaths: [],
      isolatedWorktree: true
    }
  }

  it('keeps a record without rollout flags valid and rejects a contradictory one', () => {
    expect(validatePerfEnvironment(baseEnvironment).ok).toBe(true)
    const record = resolveRolloutFlags({ declared: [QUEUED] }).record
    expect(validatePerfEnvironment({ ...baseEnvironment, rolloutFlags: record }).ok).toBe(true)
    const contradicted = { ...record, effective: { ...record.effective, [QUEUED]: 'off' } }
    expect(validatePerfEnvironment({ ...baseEnvironment, rolloutFlags: contradicted })).toEqual({
      ok: false,
      errors: ['rolloutFlags.effective must match rolloutFlags.declared']
    })
  })

  it('rejects records that omit a flag, invent a state or name a stranger', () => {
    const record = resolveRolloutFlags().record
    const { [QUEUED]: _dropped, ...partial } = record.effective
    expect(validateRolloutFlagRecord({ ...record, effective: partial })).toContain(
      'rolloutFlags.effective must state every programme flag as on or off'
    )
    expect(
      validateRolloutFlagRecord({
        ...record,
        effective: { ...record.effective, [QUEUED]: 'maybe' }
      })
    ).toContain('rolloutFlags.effective must state every programme flag as on or off')
    expect(validateRolloutFlagRecord({ ...record, declared: ['HOME'] })).toContain(
      'rolloutFlags.declared must list programme flags only'
    )
    expect(validateRolloutFlagRecord({ ...record, inheritedOverridden: ['HOME'] })).toContain(
      'rolloutFlags.inheritedOverridden must list programme flags only'
    )
    expect(validateRolloutFlagRecord({ ...record, schemaVersion: 2 })).toContain(
      'rolloutFlags.schemaVersion must be 1'
    )
  })
})

describe('T2 runner', () => {
  it('records declared flags in the environment and the reproducible command', async () => {
    vi.stubEnv(CHECKPOINT, '1')
    const outDir = mkdtempSync(path.join(tmpdir(), 'tw-t2-flags-'))
    try {
      const dry = await runT2BaselineCli(
        [
          '--workload=dual_run',
          '--dry-run',
          '--lean',
          '--scale-down=40',
          '--instance-id=perfFlagsDry01',
          `--home=${path.join(outDir, 'home')}`,
          `--out-dir=${outDir}`,
          `--flag=${QUEUED}`
        ],
        { repoRoot: path.resolve(__dirname, '..', '..'), forceIsolated: true, platform: 'darwin' }
      )
      expect(dry.ok).toBe(true)
      expect(dry.report.environment.rolloutFlags).toEqual({
        schemaVersion: 1,
        declared: [QUEUED],
        effective: {
          [CHECKPOINT]: 'off',
          [FAIRNESS]: 'off',
          [QUEUED]: 'on',
          [TRANSACTION]: 'off',
          [JOURNAL]: 'off',
          [RUN_EVENT]: 'off'
        },
        inheritedOverridden: [CHECKPOINT]
      })
      expect(dry.spawnPlan.env[QUEUED]).toBe('1')
      expect(dry.spawnPlan.env[CHECKPOINT]).toBe('0')
      expect(
        dry.report.launchPlan.shellCommand.startsWith(
          `env ${CHECKPOINT}=0 ${FAIRNESS}=0 ${QUEUED}=1 ${TRANSACTION}=0 ${JOURNAL}=0 ${RUN_EVENT}=0 `
        )
      ).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('refuses an undeclarable flag before doing any work', async () => {
    await expect(
      runT2BaselineCli(['--workload=dual_run', '--dry-run', '--flag=TASKWRAITH_UTILITY_WRITE'])
    ).rejects.toThrow(/programme rollout flag/)
  })

  it('describes the paired interference environment with the child merge rule', () => {
    // The paired path runs only under a real launch; this pins its wiring to
    // the spawn's own merge (comment lines are stripped first).
    const src = readFileSync(path.join(__dirname, 'runT2Baseline.cjs'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(src).toContain('env: { ...(options.env || process.env), ...spawnPlan.env },')
  })
})
