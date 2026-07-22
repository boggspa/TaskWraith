import { createHmac } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'scheduled-occurrence-seal-service-test'),
    getVersion: () => 'test'
  }
}))

import { createScheduledOccurrencePostureVerifier } from '../ScheduledOccurrencePostureAuthority'
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import { signRunPermissionPosture } from '../RunPermissionPosture'
import type {
  AppSettings,
  EffectiveRunPermissions,
  RuntimeProfile,
  ScheduledOccurrenceSealV2,
  ScheduledTask
} from '../store/types'
import { deriveScheduledSeatPostureMirror } from './SealEvidenceCommon'
import {
  ScheduledOccurrenceSealService,
  type ScheduledSealComposedFacts
} from './ScheduledOccurrenceSealService'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'scheduled-seal-service-'))
const WORKSPACE = realpathSync(TEMP_ROOT)
const BINARY = join(TEMP_ROOT, 'cursor-agent')
const SECRET = Buffer.alloc(32, 91)

writeFileSync(BINARY, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]))

afterAll(() => {
  // The OS temp reaper owns this directory; retaining it makes the fake binary
  // inspectable if a test fails before the app process exits.
})

function authorityRoot(): ScheduledOccurrenceAuthorityRoot {
  const mac = (domain: string, payload: Buffer) =>
    createHmac('sha256', SECRET).update(domain).update(payload).digest('hex')
  return Object.freeze({
    rootId: `twso-root-v1:${'a'.repeat(64)}`,
    sealPayloadMac: (payload: Buffer) => mac('seal', payload),
    verifySealPayloadMac: (payload: Buffer, value: string) => mac('seal', payload) === value,
    walPayloadMac: (payload: Buffer) => mac('wal', payload),
    verifyWalPayloadMac: (payload: Buffer, value: string) => mac('wal', payload) === value,
    runtimeProfileSetHmac: (payload: Buffer) => mac('runtime', payload),
    permissionPostureSetHmac: (payload: Buffer) => mac('posture', payload),
    providerLaunchHmac: (provider: string, payload: Buffer) => mac(`provider:${provider}`, payload),
    verifyProviderLaunchHmac: (provider: string, payload: Buffer, value: string) =>
      mac(`provider:${provider}`, payload) === value,
    dispose: () => {}
  }) as ScheduledOccurrenceAuthorityRoot
}

function scheduledTask(): ScheduledTask {
  const now = new Date('2026-07-21T12:00:00.000Z').toISOString()
  return {
    id: 'cursor-occurrence',
    provider: 'cursor',
    workspaceId: 'workspace-1',
    workspacePath: WORKSPACE,
    chatId: 'chat-1',
    prompt: 'Inspect the current working tree.',
    selectedModelType: 'composer-1',
    customModel: 'composer-1',
    runtimeProfileId: 'cursor-profile',
    approvalMode: 'plan',
    sessionTrust: false,
    imageAttachments: [],
    runAt: now,
    timezone: 'UTC',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    firedAt: now,
    runningSince: now,
    runId: 'cursor-scheduled-run'
  } as ScheduledTask
}

function profile(): RuntimeProfile {
  return {
    id: 'cursor-profile',
    name: 'Cursor test',
    provider: 'cursor',
    scope: 'workspace',
    workspaceMode: 'local',
    binaryPath: BINARY,
    env: {},
    networkPolicy: 'inherit',
    persistence: 'ephemeral',
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z'
  }
}

function composed(task: ScheduledTask, permissions: EffectiveRunPermissions): ScheduledSealComposedFacts {
  return {
    provider: 'cursor',
    model: 'composer-1',
    prompt: task.prompt,
    finalPrompt: task.prompt,
    runtimePreambleVersion: null,
    approvalMode: 'plan',
    workflowMode: 'normal',
    effectivePermissions: permissions,
    providerSessionId: null,
    reasoningEffort: null,
    serviceTier: null,
    claudeReasoningEffort: null,
    claudeFastMode: null,
    cursorReasoningEffort: null,
    cursorFastMode: false,
    taskWraithMcpAdvertised: false,
    taskWraithMcpProfileId: null,
    runtimeProfileId: 'cursor-profile',
    imageCount: 0
  }
}

function makeService(input: { tamperPersistedSeal?: boolean }) {
  let current = scheduledTask()
  const settings = {} as AppSettings
  const permissions = deriveScheduledSeatPostureMirror({
    provider: 'cursor',
    workspacePath: WORKSPACE,
    requestedModel: 'composer-1',
    taskApprovalMode: 'plan',
    workflowMode: 'normal',
    settings,
    unattendedElevationAck: null
  }).effectivePermissions
  const root = authorityRoot()
  const postureVerifier = createScheduledOccurrencePostureVerifier(SECRET)
  const service = new ScheduledOccurrenceSealService({
    authorityRoot: root,
    postureVerifier,
    appVersion: 'test',
    isSoloProviderSealWired: (provider) => provider === 'cursor',
    getSettings: () => settings,
    canonicalizePath: (value) => realpathSync(value),
    signRunPermissionPosture: (approvalMode, effectivePermissions, context) =>
      signRunPermissionPosture(SECRET, approvalMode, effectivePermissions, context),
    resolveUnattendedElevation: () => null,
    getChat: () => null,
    getRuntimeProfile: (id) => (id === 'cursor-profile' ? profile() : null),
    getScheduledTask: () => current,
    persistOccurrenceSeal: (_taskId, _runId, occurrenceSeal) => {
      const persisted = input.tamperPersistedSeal
        ? { ...occurrenceSeal, sealMac: '0'.repeat(64) }
        : occurrenceSeal
      current = { ...current, occurrenceSeal: persisted }
      return current
    },
    codexMcpConfig: () => null,
    codexApprovalPolicyForMode: () => 'never',
    codexSandboxPolicyForMode: () => ({}),
    claudeMcpFacts: () => ({ mcpServers: null, allowedTools: null }),
    claudeSdkPackageJsonPath: () => '',
    claudeSdkBundledCliPath: () => '',
    storedClaudeApiKeyConfigured: () => false,
    claudeSpawnEnv: () => ({}),
    grokAcpEnabled: () => false,
    grokMcpServerEntry: () => null,
    kimiAdmission: async () => {
      throw new Error('unwired')
    },
    probeCliVersion: async () => 'test',
    cliRuntimeDeps: { env: { PATH: process.env.PATH } }
  })
  return { service, current: () => current, composed: composed(current, permissions) }
}

describe('ScheduledOccurrenceSealService Cursor Stage 2', () => {
  it('mints, persists, and freshly verifies the claimed running post-image', async () => {
    const fixture = makeService({})
    const outcome = await fixture.service.sealSoloOccurrence({
      task: fixture.current(),
      ownerRunId: 'cursor-scheduled-run',
      workspaceRealPath: WORKSPACE,
      composed: fixture.composed
    })

    expect(outcome.ok).toBe(true)
    expect(fixture.current().occurrenceSeal).toMatchObject({
      schemaVersion: 2,
      ownerRunId: 'cursor-scheduled-run'
    })
  })

  it('fails closed when persistence tampers with the occurrence seal', async () => {
    const fixture = makeService({ tamperPersistedSeal: true })
    const outcome = await fixture.service.sealSoloOccurrence({
      task: fixture.current(),
      ownerRunId: 'cursor-scheduled-run',
      workspaceRealPath: WORKSPACE,
      composed: fixture.composed
    })

    expect(outcome).toEqual(
      expect.objectContaining({
        ok: false,
        reason: expect.stringMatching(/did not verify/i)
      })
    )
    expect((fixture.current().occurrenceSeal as ScheduledOccurrenceSealV2).sealMac).toBe(
      '0'.repeat(64)
    )
  })
})
