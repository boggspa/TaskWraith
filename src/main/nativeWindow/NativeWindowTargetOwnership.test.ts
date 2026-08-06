import { describe, expect, it } from 'vitest'

import type { LaunchAttempt } from '../launch/types'
import type { NativeWindowLeaseOwnershipValidator } from './NativeWindowLeaseRegistry'
import {
  createNativeWindowTargetOwnershipLeaseRevalidator,
  NativeWindowTargetOwnershipRevalidationError,
  revalidateNativeWindowTargetOwnership,
  type NativeWindowTargetBinding,
  type NativeWindowTargetOwnershipInput,
  type NativeWindowTargetOwnershipLeaseProjection,
  validateNativeWindowTargetOwnership
} from './NativeWindowTargetOwnership'

const PROCESS_STARTED_AT = 'procBSDInfo:1774843200123456'
const REUSED_PROCESS_STARTED_AT = 'procBSDInfo:1774843200999999'

function attempt(overrides: Partial<LaunchAttempt> = {}): LaunchAttempt {
  const targetSnapshot: LaunchAttempt['targetSnapshot'] = {
    id: 'target-a',
    label: 'Target A',
    workspacePath: '/workspace',
    source: 'package-script',
    kind: 'run',
    platform: 'macos',
    confidence: 1,
    evidence: [],
    blockers: []
  }
  return {
    schemaVersion: 1,
    id: 'attempt-a',
    targetId: targetSnapshot.id,
    targetLabel: targetSnapshot.label,
    targetSource: targetSnapshot.source,
    targetKind: targetSnapshot.kind,
    targetSnapshot,
    targetSnapshotHash: 'target-hash',
    provider: 'codex',
    workspacePath: '/workspace',
    cwd: '/workspace',
    commandRaw: 'npm run dev',
    argv: ['npm', 'run', 'dev'],
    pid: 101,
    pgid: 101,
    processStartedAt: PROCESS_STARTED_AT,
    status: 'running',
    startedAt: '2026-07-28T02:40:00.000Z',
    updatedAt: '2026-07-28T02:40:00.000Z',
    outputTail: '',
    outputTailBytes: 0,
    outputTruncated: false,
    chatId: 'chat-a',
    runId: 'run-a',
    ...overrides
  }
}

function input(
  overrides: Partial<NativeWindowTargetOwnershipInput> = {}
): NativeWindowTargetOwnershipInput {
  return {
    instanceEpoch: 'instance-a',
    chatId: 'chat-a',
    runId: 'run-a',
    launchAttemptId: 'attempt-a',
    macosVersion: '15.2.1',
    hostProtectedPids: new Set([900]),
    attempt: attempt(),
    selectedWindow: {
      pid: 101,
      windowId: 42,
      processStartedAt: PROCESS_STARTED_AT
    },
    ...overrides
  }
}

function expectBinding(result: ReturnType<typeof validateNativeWindowTargetOwnership>) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.binding
}

function expectFailure(result: ReturnType<typeof validateNativeWindowTargetOwnership>) {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected native-window ownership failure.')
  return result.error
}

function lease(binding: NativeWindowTargetBinding): NativeWindowTargetOwnershipLeaseProjection {
  return {
    instanceEpoch: binding.instanceEpoch,
    chatId: binding.chatId,
    runId: binding.runId,
    launchAttemptId: binding.launchAttemptId,
    expectedPid: binding.expectedPid,
    selectedPid: binding.selectedPid,
    selectedProcessStartedAt: binding.processStartedAt,
    windowId: binding.windowId
  }
}

describe('NativeWindowTargetOwnership', () => {
  it('binds an active exact launch root with the same canonical birth receipt', () => {
    const result = validateNativeWindowTargetOwnership(input())
    const binding = expectBinding(result)

    expect(binding).toEqual({
      instanceEpoch: 'instance-a',
      chatId: 'chat-a',
      runId: 'run-a',
      launchAttemptId: 'attempt-a',
      expectedPid: 101,
      selectedPid: 101,
      windowId: 42,
      processStartedAt: PROCESS_STARTED_AT,
      ownership: 'exact',
      ancestryDepth: 0
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(binding)).toBe(true)
  })

  it('ignores missing, malformed, and different legacy process-group metadata', () => {
    for (const legacyPgid of [undefined, null, 0, 303, 'not-a-pgid']) {
      const candidate = {
        ...input({ attempt: { ...attempt(), pgid: legacyPgid } as unknown as LaunchAttempt }),
        selectedPgid: legacyPgid
      }
      const binding = expectBinding(validateNativeWindowTargetOwnership(candidate))
      expect(binding).toMatchObject({ expectedPid: 101, selectedPid: 101 })
      expect(binding).not.toHaveProperty('expectedPgid')
      expect(binding).not.toHaveProperty('selectedPgid')
    }
  })

  it('denies a same-process-group child without exact process identity', () => {
    const candidate = {
      ...input({
        selectedWindow: { pid: 102, windowId: 43, processStartedAt: PROCESS_STARTED_AT }
      }),
      selectedPgid: 101
    }
    expect(expectFailure(validateNativeWindowTargetOwnership(candidate)).code).toBe('pid-not-owned')
  })

  describe('descendant windows', () => {
    // `npm run dev`(101) -> node(150) -> electron(199): the attempt records the
    // npm PID, but the window the user attaches belongs to the Electron process.
    const CHILD_STARTED_AT = 'procBSDInfo:1774843200500000'
    const WINDOW_STARTED_AT = 'procBSDInfo:1774843200800000'

    function descendantChain() {
      return [
        { pid: 199, ppid: 150, processStartedAt: WINDOW_STARTED_AT },
        { pid: 150, ppid: 101, processStartedAt: CHILD_STARTED_AT },
        { pid: 101, ppid: 1, processStartedAt: PROCESS_STARTED_AT }
      ]
    }

    function descendantInput(overrides: Record<string, unknown> = {}) {
      return input({
        selectedWindow: { pid: 199, windowId: 43, processStartedAt: WINDOW_STARTED_AT },
        ancestry: {
          rootPid: 101,
          rootProcessStartedAt: PROCESS_STARTED_AT,
          leafPid: 199,
          leafProcessStartedAt: WINDOW_STARTED_AT,
          depth: 2,
          chain: descendantChain()
        },
        ...overrides
      } as Partial<NativeWindowTargetOwnershipInput>)
    }

    it('binds a window owned by a descendant of the launch process', () => {
      const binding = expectBinding(validateNativeWindowTargetOwnership(descendantInput()))
      expect(binding).toMatchObject({
        expectedPid: 101,
        selectedPid: 199,
        processStartedAt: WINDOW_STARTED_AT,
        ownership: 'descendant',
        ancestryDepth: 2
      })
    })

    it('still denies a descendant window when no ancestry proof is supplied', () => {
      const failure = expectFailure(
        validateNativeWindowTargetOwnership(
          input({
            selectedWindow: { pid: 199, windowId: 43, processStartedAt: WINDOW_STARTED_AT }
          })
        )
      )
      expect(failure.code).toBe('pid-not-owned')
      // The refusal has to name the real cause or the agent just retries.
      expect(failure.message).toMatch(/descend/i)
    })

    it('re-verifies the proof rather than trusting its summary fields', () => {
      const forged = descendantInput({
        ancestry: {
          rootPid: 101,
          rootProcessStartedAt: PROCESS_STARTED_AT,
          leafPid: 199,
          leafProcessStartedAt: WINDOW_STARTED_AT,
          depth: 2,
          // The chain never reaches 101; only the summary claims it does.
          chain: [
            { pid: 199, ppid: 150, processStartedAt: WINDOW_STARTED_AT },
            { pid: 150, ppid: 777, processStartedAt: CHILD_STARTED_AT }
          ]
        }
      })
      expect(expectFailure(validateNativeWindowTargetOwnership(forged)).code).toBe('pid-not-owned')
    })

    it('denies a proof whose leaf is not the window that was actually attached', () => {
      const mismatched = descendantInput({
        selectedWindow: { pid: 198, windowId: 43, processStartedAt: WINDOW_STARTED_AT }
      })
      expect(expectFailure(validateNativeWindowTargetOwnership(mismatched)).code).toBe(
        'pid-not-owned'
      )
    })

    it('denies a descendant of a protected host process at the leaf', () => {
      const hostWindow = descendantInput({ hostProtectedPids: new Set([900, 199]) })
      expect(expectFailure(validateNativeWindowTargetOwnership(hostWindow)).code).toBe(
        'protected-process'
      )
    })

    it('invalidates a saved binding when the ownership kind changes', () => {
      const binding = expectBinding(validateNativeWindowTargetOwnership(descendantInput()))
      const exactCurrent = input()
      const drifted = revalidateNativeWindowTargetOwnership({ binding, current: exactCurrent })
      expect(expectFailure(drifted).code).toBe('binding-mismatch')
    })

    it('revalidates a stable descendant binding', () => {
      const binding = expectBinding(validateNativeWindowTargetOwnership(descendantInput()))
      const stable = revalidateNativeWindowTargetOwnership({
        binding,
        current: descendantInput()
      })
      expect(stable.ok).toBe(true)
    })
  })

  it('fails closed for unsupported macOS, terminal attempts, and non-exact run owners', () => {
    expect(
      expectFailure(validateNativeWindowTargetOwnership(input({ macosVersion: '15.1.9' }))).code
    ).toBe('unsupported-macos-version')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(input({ attempt: attempt({ status: 'stopped' }) }))
      ).code
    ).toBe('inactive-launch-attempt')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(input({ attempt: attempt({ status: 'stopping' }) }))
      ).code
    ).toBe('inactive-launch-attempt')
    expect(
      expectFailure(validateNativeWindowTargetOwnership(input({ chatId: 'chat-b' }))).code
    ).toBe('attempt-identity-mismatch')
    expect(expectFailure(validateNativeWindowTargetOwnership(input({ runId: 'run-b' }))).code).toBe(
      'attempt-identity-mismatch'
    )
    expect(
      expectFailure(validateNativeWindowTargetOwnership(input({ launchAttemptId: 'attempt-b' })))
        .code
    ).toBe('attempt-identity-mismatch')
    expect(expectFailure(validateNativeWindowTargetOwnership(input({ runId: ' ' }))).code).toBe(
      'invalid-input'
    )
  })

  it('requires positive process/window identities and exact launch birth receipts', () => {
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(
          input({
            selectedWindow: { pid: 0, windowId: 42, processStartedAt: PROCESS_STARTED_AT }
          })
        )
      ).code
    ).toBe('invalid-input')
    expect(
      expectFailure(validateNativeWindowTargetOwnership(input({ attempt: attempt({ pid: 0 }) })))
        .code
    ).toBe('invalid-input')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(
          input({
            selectedWindow: { pid: 101, windowId: 0, processStartedAt: PROCESS_STARTED_AT }
          })
        )
      ).code
    ).toBe('invalid-input')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(
          input({ selectedWindow: { pid: 102, windowId: 42, processStartedAt: '' } })
        )
      ).code
    ).toBe('invalid-input')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(
          input({
            selectedWindow: { pid: 101, windowId: 42, processStartedAt: REUSED_PROCESS_STARTED_AT }
          })
        )
      ).code
    ).toBe('pid-not-owned')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(
          input({ attempt: attempt({ processStartedAt: undefined }) })
        )
      ).code
    ).toBe('invalid-input')
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(
          input({ attempt: attempt({ processStartedAt: 'not-a-canonical-receipt' }) })
        )
      ).code
    ).toBe('invalid-input')
  })

  it('denies only the current protected PID set, not windows based on titles or bundle identifiers', () => {
    expect(
      expectFailure(
        validateNativeWindowTargetOwnership(input({ hostProtectedPids: new Set([101, 900]) }))
      ).code
    ).toBe('protected-process')

    const selectedWindow = {
      pid: 101,
      windowId: 42,
      processStartedAt: PROCESS_STARTED_AT,
      title: 'TaskWraith child window',
      bundleId: 'app.taskwraith.child'
    }
    expect(
      expectBinding(
        validateNativeWindowTargetOwnership(
          input({ selectedWindow, hostProtectedPids: new Set([900]) })
        )
      ).selectedPid
    ).toBe(101)
  })

  it('provides a synchronous lease-registry-compatible revalidator that rejects either birth mismatch', () => {
    const binding = expectBinding(validateNativeWindowTargetOwnership(input()))
    let current = input()
    const revalidate = createNativeWindowTargetOwnershipLeaseRevalidator(binding, () => current)
    const registryCompatible: NativeWindowLeaseOwnershipValidator = revalidate

    expect(revalidate(lease(binding))).toBe(true)
    expect(registryCompatible).toBe(revalidate)

    current = input({
      selectedWindow: { pid: 101, windowId: 42, processStartedAt: REUSED_PROCESS_STARTED_AT }
    })
    const selectedBirthMismatch = revalidateNativeWindowTargetOwnership({ binding, current })
    expect(expectFailure(selectedBirthMismatch).code).toBe('pid-not-owned')
    expect(() => revalidate(lease(binding))).toThrow(NativeWindowTargetOwnershipRevalidationError)

    current = input({ attempt: attempt({ processStartedAt: REUSED_PROCESS_STARTED_AT }) })
    const launchBirthMismatch = revalidateNativeWindowTargetOwnership({ binding, current })
    expect(expectFailure(launchBirthMismatch).code).toBe('pid-not-owned')
    expect(() => revalidate(lease(binding))).toThrow(NativeWindowTargetOwnershipRevalidationError)

    current = input({
      attempt: attempt({ processStartedAt: REUSED_PROCESS_STARTED_AT }),
      selectedWindow: { pid: 101, windowId: 42, processStartedAt: REUSED_PROCESS_STARTED_AT }
    })
    const replacedProcess = revalidateNativeWindowTargetOwnership({ binding, current })
    expect(expectFailure(replacedProcess).code).toBe('binding-mismatch')
    expect(() => revalidate(lease(binding))).toThrow(NativeWindowTargetOwnershipRevalidationError)
  })
})
