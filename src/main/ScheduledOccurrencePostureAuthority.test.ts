import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signRunPermissionPosture, type RunPermissionPostureContext } from './RunPermissionPosture'
import {
  createScheduledOccurrencePostureVerifier,
  type ScheduledOccurrencePostureCapability,
  type ScheduledOccurrencePostureIssueInput
} from './ScheduledOccurrencePostureAuthority'
import type { EffectiveRunPermissions, ExternalPathGrant } from './store/types'

const SECRET = Buffer.alloc(32, 41)
const ROOT_ID = `twso-root-v1:${'1'.repeat(64)}`
const NOW = '2026-07-15T05:00:00.000Z'
// resolve() keeps these fixtures lexically canonical on every platform; the
// posture validators require `resolve(p) === p`.
const REAL_WORKSPACE_PATH = resolve('/real/workspace')
const READABLE_GRANT_PATH = resolve('/external/readable')
const CHANGED_GRANT_PATH = resolve('/external/changed')

function permissions(
  overrides: Partial<EffectiveRunPermissions> = {}
): EffectiveRunPermissions {
  return {
    presetId: 'workspace_write',
    approvalMode: 'default',
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'workspace',
      externalPublish: 'deny',
      mcpTools: 'workspace',
      subThreadDelegation: 'deny',
      canvasInteraction: 'ask',
      canvasEval: 'deny',
      crossThreadRead: 'deny',
      threadMessage: 'deny',
      mediaEditing: 'ask',
      mediaRecording: 'deny'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: ['fileChanges', 'mcpTools'],
    readOnly: false,
    ...overrides
  }
}

function context(overrides: Partial<RunPermissionPostureContext> = {}): RunPermissionPostureContext {
  return {
    provider: 'codex',
    scope: 'workspace',
    appRunId: 'task-1',
    appChatId: 'chat-1',
    prompt: 'Inspect the exact workspace.',
    workflowMode: 'normal',
    runtimeProfileId: 'profile-1',
    ensembleParticipantId: null,
    ensembleLaneId: null,
    ...overrides
  }
}

function signedInput(
  overrides: Partial<ScheduledOccurrencePostureIssueInput> = {}
): ScheduledOccurrencePostureIssueInput {
  const effectivePermissions = overrides.effectivePermissions ?? permissions()
  const postureContext = overrides.context ?? context()
  const approvalMode = overrides.approvalMode ?? effectivePermissions.approvalMode
  return {
    rootId: ROOT_ID,
    workspaceId: 'workspace-1',
    workspaceRealPath: REAL_WORKSPACE_PATH,
    approvalMode,
    effectivePermissions,
    signature:
      overrides.signature ??
      signRunPermissionPosture(
        SECRET,
        approvalMode,
        effectivePermissions,
        postureContext
      ),
    context: postureContext,
    ...overrides
  }
}

describe('ScheduledOccurrencePostureAuthority', () => {
  it('issues an opaque immutable capability containing full signed permissions and grants', () => {
    const verifier = createScheduledOccurrencePostureVerifier(SECRET)
    const grant: ExternalPathGrant = {
      id: 'grant-1',
      provider: 'codex',
      bindingVersion: 2,
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      appRunId: 'task-1',
      path: READABLE_GRANT_PATH,
      kind: 'directory',
      access: 'read',
      duration: 'thisRun',
      issuedBy: 'main',
      signature: 'a'.repeat(64),
      createdAt: NOW
    }
    const effectivePermissions = permissions({ externalPathGrants: [grant] })
    const capability = verifier.issue(signedInput({ effectivePermissions }))
    const authority = verifier.resolver.consume(capability!)

    expect(capability).not.toBeNull()
    expect(Object.keys(capability!)).toEqual([])
    expect(Object.isFrozen(capability)).toBe(true)
    expect(authority).toMatchObject({
      schemaVersion: 1,
      rootId: ROOT_ID,
      workspaceId: 'workspace-1',
      workspaceRealPath: REAL_WORKSPACE_PATH,
      signedPosture: {
        approvalMode: 'default',
        effectivePermissions: {
          externalPathGrants: [grant],
          workspaceGrantServiceIds: ['fileChanges', 'mcpTools']
        },
        context: { provider: 'codex', prompt: 'Inspect the exact workspace.' }
      }
    })
    expect(authority?.promptSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(authority?.signedPosture.effectivePermissions)).toBe(true)
    expect(
      verifier.resolver.consume(
        Object.freeze({}) as ScheduledOccurrencePostureCapability
      )
    ).toBeNull()
    expect(verifier.resolver.consume(capability!)).toBeNull()
  })

  it('rejects forged secrets and every signed permission, grant, prompt, or context mutation', () => {
    const verifier = createScheduledOccurrencePostureVerifier(SECRET)
    const baseline = signedInput()
    expect(verifier.issue(baseline)).not.toBeNull()

    const forgedSignature = signRunPermissionPosture(
      Buffer.alloc(32, 42),
      baseline.approvalMode,
      baseline.effectivePermissions,
      baseline.context
    )
    expect(verifier.issue({ ...baseline, signature: forgedSignature })).toBeNull()

    const changedPermissions = permissions({ networkAccess: 'allow' })
    expect(
      verifier.issue({ ...baseline, effectivePermissions: changedPermissions })
    ).toBeNull()
    const changedGrantPermissions = permissions({
      externalPathGrants: [
        {
          id: 'grant-2',
          provider: 'codex',
          path: CHANGED_GRANT_PATH,
          kind: 'file',
          access: 'write',
          duration: 'thisRun',
          createdAt: NOW
        }
      ]
    })
    expect(
      verifier.issue({ ...baseline, effectivePermissions: changedGrantPermissions })
    ).toBeNull()
    for (const contextPatch of [
      { provider: 'claude' },
      { scope: 'global' },
      { appRunId: 'task-2' },
      { appChatId: 'chat-2' },
      { prompt: 'Changed prompt.' },
      { workflowMode: 'plan' },
      { runtimeProfileId: 'profile-2' },
      { ensembleParticipantId: 'participant-2' },
      { ensembleLaneId: 'lane-2' }
    ]) {
      expect(
        verifier.issue({ ...baseline, context: context(contextPatch) })
      ).toBeNull()
    }
  })

  it('binds root/workspace metadata immutably and zeroizes its issuing secret on disposal', () => {
    const mutableSecret = Buffer.alloc(32, 51)
    const verifier = createScheduledOccurrencePostureVerifier(mutableSecret)
    mutableSecret.fill(0)
    const effectivePermissions = permissions()
    const postureContext = context()
    const signature = signRunPermissionPosture(
      Buffer.alloc(32, 51),
      effectivePermissions.approvalMode,
      effectivePermissions,
      postureContext
    )
    const capability = verifier.issue(
      signedInput({ effectivePermissions, context: postureContext, signature })
    )
    const authority = verifier.resolver.consume(capability!)
    expect(authority).toMatchObject({ rootId: ROOT_ID, workspaceId: 'workspace-1' })
    const revokedCapability = verifier.issue(
      signedInput({ effectivePermissions, context: postureContext, signature })
    )

    verifier.dispose()
    expect(() => verifier.issue(signedInput())).toThrow(/disposed/i)
    expect(verifier.resolver.consume(revokedCapability!)).toBeNull()
  })

  it('keeps capabilities verifier-local, one-shot, and epoch-revocable', () => {
    const first = createScheduledOccurrencePostureVerifier(SECRET)
    const second = createScheduledOccurrencePostureVerifier(SECRET)
    const capability = first.issue(signedInput())

    expect(second.resolver.consume(capability!)).toBeNull()
    expect(first.resolver.consume(capability!)).not.toBeNull()
    expect(first.resolver.consume(capability!)).toBeNull()

    const revoked = first.issue(signedInput())
    first.dispose()
    expect(first.resolver.consume(revoked!)).toBeNull()
  })

  it('snapshots descriptor-safe data once and rejects hostile nested values before HMAC use', () => {
    const verifier = createScheduledOccurrencePostureVerifier(SECRET)
    const baseline = signedInput()
    let getterCalls = 0
    const stateful = { ...baseline.effectivePermissions }
    Object.defineProperty(stateful, 'networkAccess', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return getterCalls === 1 ? 'deny' : 'allow'
      }
    })
    expect(
      verifier.issue({
        ...baseline,
        effectivePermissions: stateful as EffectiveRunPermissions
      })
    ).toBeNull()
    expect(getterCalls).toBe(0)

    let proxyTrapCalls = 0
    const proxied = new Proxy(
      { ...baseline.effectivePermissions },
      {
        getPrototypeOf: (target) => {
          proxyTrapCalls += 1
          return Reflect.getPrototypeOf(target)
        },
        ownKeys: (target) => {
          proxyTrapCalls += 1
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor: (target, property) => {
          proxyTrapCalls += 1
          return Reflect.getOwnPropertyDescriptor(target, property)
        }
      }
    )
    expect(
      verifier.issue({
        ...baseline,
        effectivePermissions: proxied
      })
    ).toBeNull()
    expect(proxyTrapCalls).toBe(0)

    let arrayGetterCalls = 0
    const accessorArray = [baseline.effectivePermissions.externalPathGrants[0]]
    Object.defineProperty(accessorArray, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1
        return baseline.effectivePermissions.externalPathGrants[0]
      }
    })
    expect(
      verifier.issue({
        ...baseline,
        effectivePermissions: {
          ...baseline.effectivePermissions,
          externalPathGrants: accessorArray
        }
      })
    ).toBeNull()
    expect(arrayGetterCalls).toBe(0)

    const sparse = [baseline.effectivePermissions.externalPathGrants[0]]
    sparse.length = 2
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const hostileValues: unknown[] = [
      { ...baseline.effectivePermissions, networkAccess: undefined },
      { ...baseline.effectivePermissions, readOnly: Number.NaN },
      { ...baseline.effectivePermissions, readOnly: -0 },
      { ...baseline.effectivePermissions, readOnly: () => true },
      { ...baseline.effectivePermissions, readOnly: 1n },
      { ...baseline.effectivePermissions, externalPathGrants: sparse },
      { ...baseline.effectivePermissions, agenticServices: cyclic }
    ]
    for (const effectivePermissions of hostileValues) {
      expect(
        verifier.issue({
          ...baseline,
          effectivePermissions: effectivePermissions as EffectiveRunPermissions
        })
      ).toBeNull()
    }

    const nonEnumerable = { ...baseline.effectivePermissions }
    Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: true })
    expect(
      verifier.issue({
        ...baseline,
        effectivePermissions: nonEnumerable as EffectiveRunPermissions
      })
    ).toBeNull()
    const symbolValue = { ...baseline.effectivePermissions } as EffectiveRunPermissions & {
      [key: symbol]: boolean
    }
    symbolValue[Symbol('hidden')] = true
    expect(verifier.issue({ ...baseline, effectivePermissions: symbolValue })).toBeNull()
  })

  it('fails closed on weak secrets and noncanonical issue metadata', () => {
    expect(() => createScheduledOccurrencePostureVerifier(Buffer.alloc(31))).toThrow(/32 bytes/i)
    const verifier = createScheduledOccurrencePostureVerifier(SECRET)
    for (const patch of [
      { rootId: 'not-a-root' },
      { workspaceId: ' workspace-1' },
      { workspaceRealPath: '' },
      { approvalMode: ' plan' },
      { signature: 'A'.repeat(64) }
    ]) {
      expect(verifier.issue(signedInput(patch))).toBeNull()
    }
  })
})
