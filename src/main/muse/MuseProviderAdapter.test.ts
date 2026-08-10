import { describe, expect, it, vi } from 'vitest'
import { createMuseOrchestrationStubs } from './MuseOrchestrationContracts'
import {
  createMuseProviderAdapter,
  createStubWiredMuseProviderAdapter,
  museProviderAdapterDescriptor,
  prepareMuseLaunchPlan,
  runMuseOpaqueExec,
  validateMuseLaunchArgv
} from './MuseProviderAdapter'
import type { MuseSpawnHandle } from './MuseOrchestrationContracts'

function fakeSpawn(stdoutLines: string[], code = 0): MuseSpawnHandle {
  let stdoutListener: ((chunk: string) => void) | null = null
  return {
    pid: 4242,
    kill() {},
    onStdout(listener) {
      stdoutListener = listener
    },
    onStderr() {},
    async wait() {
      stdoutListener?.(stdoutLines.map((line) => `${line}\n`).join(''))
      return { code, signal: null }
    }
  }
}

describe('MuseProviderAdapter', () => {
  describe('museProviderAdapterDescriptor', () => {
    it('declares opaque exec transport without claiming ProviderId', () => {
      const descriptor = museProviderAdapterDescriptor()
      expect(descriptor.provider).toBe('muse')
      expect(descriptor.transport).toBe('muse-exec-json')
      expect(descriptor.features.agentBenchMcpBridge).toBe(false)
      expect(descriptor.features.providerManagedMcp).toBe(false)
      expect(descriptor.features.appManagedApprovals).toBe(false)
      expect(descriptor.capabilities.reasoningEffort).toBe(true)
    })
  })

  describe('validateMuseLaunchArgv', () => {
    it('rejects forbidden containment escapes', () => {
      expect(validateMuseLaunchArgv(['exec', '--json', '--yolo']).ok).toBe(false)
      expect(validateMuseLaunchArgv(['exec', '--disable-sandbox']).forbidden).toContain(
        '--disable-sandbox'
      )
      // Headless seats intentionally emit --disable-approval (MuseCliArgs).
      expect(validateMuseLaunchArgv(['exec', '--disable-approval']).ok).toBe(true)
      expect(
        validateMuseLaunchArgv(['exec', '--reasoning-effort', 'none']).forbidden
      ).toContain('--reasoning-effort none')
    })

    it('rejects --no-session-log for metering seats', () => {
      const result = validateMuseLaunchArgv(['exec', '--json', '--no-session-log'])
      expect(result.meteringConflicts).toContain('--no-session-log')
    })

    it('accepts the stub production argv shape', () => {
      const modules = createMuseOrchestrationStubs()
      const argv = modules.cliArgs.buildExecArgv({
        workspacePath: '/ws',
        prompt: 'hi',
        model: 'muse-spark-1.2',
        effort: 'high',
        writeCapable: false,
        sessionId: 'sess-1',
        apiKeyStdin: false
      })
      expect(validateMuseLaunchArgv(argv).ok).toBe(true)
      expect(argv).toContain('--disable-write')
      expect(argv).toContain('--disable-shell')
      expect(argv).toContain('--sandbox-network')
      expect(argv).not.toContain('--yolo')
    })
  })

  describe('prepareMuseLaunchPlan', () => {
    it('pins skills then builds argv/env under the isolated home', async () => {
      const skillPin = vi.fn(async () => ({
        ok: true as const,
        pinHash: 'pin-abc',
        enabledSkillIds: [] as string[]
      }))
      const modules = createMuseOrchestrationStubs({
        skillPin: { applyAndAssert: skillPin }
      })
      const plan = await prepareMuseLaunchPlan(
        {
          runId: 'run-1',
          workspacePath: '/workspace',
          prompt: 'hello',
          writeCapable: false,
          temporaryRoot: '/tmp',
          reasoningEffort: 'none',
          model: 'muse-spark-1.2'
        },
        modules
      )
      expect(skillPin).toHaveBeenCalledOnce()
      expect(plan.skillPinHash).toBe('pin-abc')
      expect(plan.effort).toBe('minimal')
      expect(plan.env.MUSE_NO_AUTO_UPDATE).toBe('1')
      expect(plan.env.XDG_CONFIG_HOME).toContain('xdg-config')
      expect(plan.argv).not.toContain('none')
      expect(plan.env.META_API_KEY).toBeUndefined()
    })

    it('fails closed when skill pin fails', async () => {
      const modules = createMuseOrchestrationStubs({
        skillPin: {
          async applyAndAssert() {
            return {
              ok: false,
              pinHash: '',
              enabledSkillIds: [],
              warning: 'pin drift'
            }
          }
        }
      })
      await expect(
        prepareMuseLaunchPlan(
          {
            runId: 'run-2',
            workspacePath: '/workspace',
            prompt: 'hello',
            writeCapable: true,
            temporaryRoot: '/tmp'
          },
          modules
        )
      ).rejects.toThrow(/pin drift/)
    })
  })

  describe('runMuseOpaqueExec', () => {
    it('pumps stdout through ExecJson, projects usage, asserts cron, cleans home', async () => {
      const cleanup = vi.fn(() => ({ ok: true as const, alreadyAbsent: false }))
      const cronAssert = vi.fn(async () => ({ ok: true, jobCount: 0 }))
      const usage = vi.fn(async () => ({
        usage: { inputTokens: 10, outputTokens: 4 },
        recordsSeen: 1
      }))
      const modules = createMuseOrchestrationStubs({
        usage: { projectFromSession: usage },
        cronAssert: { assertEmptyAtTeardown: cronAssert },
        isolatedHome: {
          create(input) {
            const base = createMuseOrchestrationStubs().isolatedHome.create(input)
            return { ...base, cleanup }
          }
        },
        process: {
          spawn: () =>
            fakeSpawn([
              JSON.stringify({
                payload_type: 'runtime.session.metadata',
                metadata: {
                  tool_surface_version: '2',
                  build: { sha: '427a430436' }
                },
                session_id: 'sess-live'
              }),
              JSON.stringify({
                payload_type: 'run.output.delta',
                text: 'hello from muse'
              }),
              JSON.stringify({
                payload_type: 'run.terminal.completed',
                text: 'hello from muse'
              })
            ])
        }
      })

      const result = await runMuseOpaqueExec({
        binaryPath: '/bin/muse',
        modules,
        request: {
          runId: 'run-exec',
          workspacePath: '/workspace',
          prompt: 'hi',
          writeCapable: false,
          temporaryRoot: '/tmp',
          sessionId: 'sess-live'
        }
      })

      expect(result.status).toBe('success')
      expect(result.assistantText).toContain('hello from muse')
      expect(result.toolSurfaceVersion).toBe('2')
      expect(result.buildSha).toBe('427a430436')
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 })
      expect(usage).toHaveBeenCalledOnce()
      expect(cronAssert).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
    })

    it('surfaces cron non-empty as a teardown warning', async () => {
      const modules = createMuseOrchestrationStubs({
        cronAssert: {
          async assertEmptyAtTeardown() {
            return { ok: false, jobCount: 2, warning: 'cron jobs present' }
          }
        },
        process: {
          spawn: () =>
            fakeSpawn([
              JSON.stringify({ payload_type: 'run.terminal.completed', text: 'done' })
            ])
        }
      })
      const result = await runMuseOpaqueExec({
        binaryPath: '/bin/muse',
        modules,
        request: {
          runId: 'run-cron',
          workspacePath: '/workspace',
          prompt: 'hi',
          writeCapable: true,
          temporaryRoot: '/tmp'
        }
      })
      expect(result.warnings.some((w) => w.includes('cron'))).toBe(true)
    })
  })

  describe('createMuseProviderAdapter', () => {
    it('exposes status/mcp helpers without registration', async () => {
      const adapter = createStubWiredMuseProviderAdapter({
        temporaryRoot: '/tmp',
        probe: {
          resolveBinary: async () => ({ binaryPath: '/bin/muse', source: 'path' }),
          hasInjectedCredential: async () => true
        }
      })
      const status = (await adapter.getStatus()) as {
        available: boolean
        transport: string
        inAppApprovals: boolean
      }
      expect(status.available).toBe(true)
      expect(status.transport).toBe('muse-exec-json')
      expect(status.inAppApprovals).toBe(false)

      const mcp = (await adapter.getMcpStatus()) as { available: boolean; message: string }
      expect(mcp.available).toBe(false)
      expect(mcp.message).toMatch(/no TaskWraith MCP broker/i)

      const contract = await adapter.getCapabilityContract({ workspacePath: '/ws' })
      expect(contract.provider).toBe('muse')
      expect(contract.mcp.available).toBe(false)
      expect(contract.approvals.inAppApprovals).toBe(false)
    })

    it('run() refuses when binary or credential is missing', async () => {
      const adapter = createMuseProviderAdapter({
        temporaryRoot: '/tmp',
        modules: createMuseOrchestrationStubs(),
        probe: {
          resolveBinary: async () => ({ binaryPath: null, error: 'missing' }),
          hasInjectedCredential: async () => true
        }
      })
      await expect(
        adapter.run({
          event: {},
          payload: { prompt: 'x', workspace: '/ws' }
        })
      ).rejects.toThrow(/not resolvable/)

      const noCred = createStubWiredMuseProviderAdapter({
        temporaryRoot: '/tmp',
        probe: {
          resolveBinary: async () => ({ binaryPath: '/bin/muse' }),
          readAuthJsonText: async () => null,
          readMetaApiKeyEnv: () => null
        }
      })
      await expect(
        noCred.run({
          event: {},
          payload: { prompt: 'x', workspace: '/ws' }
        })
      ).rejects.toThrow(/credential/)
    })
  })
})
