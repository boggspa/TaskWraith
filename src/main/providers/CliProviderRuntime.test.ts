import { describe, it, expect, vi } from 'vitest'
import {
  applyRuntimeProfileToPayload,
  runtimeSettings,
  type CliProviderRuntimeDependencies,
  type RuntimeProfilePayload
} from './CliProviderRuntime'
import type { AppSettings, RuntimeProfile } from '../store/types'

// CliProviderRuntime imports AppStore from '../store', which touches Electron/fs
// at module load. We exercise applyRuntimeProfileToPayload with INJECTED deps, so
// AppStore is never called — mock the module purely to avoid the side-effectful
// import during the test run. (vitest hoists vi.mock above the imports.)
vi.mock('../store', () => ({
  AppStore: { getSettings: () => ({}), getRuntimeProfiles: () => [] }
}))

function makeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'builtin:grok:global',
    name: 'Grok global',
    provider: 'grok',
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    approvalMode: 'default',
    networkPolicy: 'inherit',
    persistence: 'reusable',
    builtin: true,
    createdAt: '0',
    updatedAt: '0',
    ...overrides
  }
}

const depsWith = (profile: RuntimeProfile): CliProviderRuntimeDependencies => ({
  getRuntimeProfiles: () => [profile]
})

const payload = (overrides: Partial<RuntimeProfilePayload>): RuntimeProfilePayload => ({
  provider: 'grok',
  scope: 'workspace',
  runtimeProfileId: 'builtin:grok:global',
  ...overrides
})

describe('applyRuntimeProfileToPayload — read-only is a safety floor', () => {
  it('does NOT loosen an explicit read-only (plan) seat to a write-capable profile default', () => {
    // The live regression: builtin:grok:global (approvalMode 'default') clobbered
    // a user's explicit "Plan / Read-only" choice, turning the seat write-capable.
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'plan' }),
      depsWith(makeProfile({ approvalMode: 'default' }))
    )
    expect(out.approvalMode).toBe('plan')
  })

  it('still applies the profile mode for a non-read-only seat', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'acceptEdits' }),
      depsWith(makeProfile({ approvalMode: 'default' }))
    )
    expect(out.approvalMode).toBe('default')
  })

  it('lets a profile TIGHTEN a non-read-only seat to read-only', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'default' }),
      depsWith(makeProfile({ approvalMode: 'plan' }))
    )
    expect(out.approvalMode).toBe('plan')
  })

  it('does NOT raise a verified default seat to auto_edit via runtime profile', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'default' }),
      depsWith(makeProfile({ approvalMode: 'auto_edit' }))
    )
    expect(out.approvalMode).toBe('default')
  })

  it('preserves an explicit auto_edit seat when the matching profile is also auto_edit', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'auto_edit' }),
      depsWith(makeProfile({ approvalMode: 'auto_edit' }))
    )
    expect(out.approvalMode).toBe('auto_edit')
  })

  it('leaves approvalMode untouched when no runtime profile id is set', () => {
    const out = applyRuntimeProfileToPayload(
      { provider: 'grok', scope: 'workspace', approvalMode: 'plan' },
      depsWith(makeProfile())
    )
    expect(out.approvalMode).toBe('plan')
  })
})

describe('runtimeSettings', () => {
  const baseSettings = {
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'workspace',
      networkAccess: 'deny'
    }
  } as AppSettings

  it('allows runtime profiles to tighten but not loosen agentic services', () => {
    const settings = runtimeSettings(
      baseSettings,
      makeProfile({
        agenticServices: {
          shellCommands: 'allow',
          fileChanges: 'allow',
          mcpTools: 'deny',
          subThreadDelegation: 'allow',
          canvasInteraction: 'ask',
          canvasEval: 'ask',
          networkAccess: 'allow'
        }
      })
    )

    expect(settings.agenticServices.shellCommands).toBe('ask')
    expect(settings.agenticServices.fileChanges).toBe('deny')
    expect(settings.agenticServices.mcpTools).toBe('deny')
    expect(settings.agenticServices.subThreadDelegation).toBe('workspace')
    expect(settings.agenticServices.networkAccess).toBe('deny')
  })
})
