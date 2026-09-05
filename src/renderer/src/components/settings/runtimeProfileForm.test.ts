import { describe, expect, it } from 'vitest'
import type { ProviderId, RuntimeProfile } from '../../../../main/store/types'
import {
  emptyRuntimeProfileForm,
  formFromRuntimeProfile,
  formatRuntimeProfileSecretRefs
} from './runtimeProfileForm'

function makeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'profile-1',
    name: 'Work profile',
    provider: 'codex' as ProviderId,
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  }
}

describe('emptyRuntimeProfileForm', () => {
  it('returns blank workspace-scoped defaults for codex', () => {
    expect(emptyRuntimeProfileForm()).toEqual({
      id: '',
      name: '',
      provider: 'codex',
      scope: 'workspace',
      workspaceMode: 'local',
      binaryPath: '',
      envText: '',
      envSecretText: '',
      approvalMode: 'default',
      networkPolicy: 'inherit',
      persistence: 'reusable'
    })
  })

  it('honours an explicit provider', () => {
    expect(emptyRuntimeProfileForm('claude' as ProviderId).provider).toBe('claude')
  })
})

describe('formatRuntimeProfileSecretRefs', () => {
  it('renders names as KEY= lines', () => {
    expect(formatRuntimeProfileSecretRefs(['AAA', 'BBB'])).toBe('AAA=\nBBB=')
  })

  it('returns empty text for missing or empty names', () => {
    expect(formatRuntimeProfileSecretRefs(undefined)).toBe('')
    expect(formatRuntimeProfileSecretRefs([])).toBe('')
  })
})

describe('formFromRuntimeProfile', () => {
  it('copies identity, provider, scope, mode, policy and persistence', () => {
    const form = formFromRuntimeProfile(
      makeProfile({
        id: 'p-9',
        name: 'Named',
        provider: 'kimi' as ProviderId,
        scope: 'global',
        workspaceMode: 'worktree',
        networkPolicy: 'deny',
        persistence: 'ephemeral'
      })
    )
    expect(form.id).toBe('p-9')
    expect(form.name).toBe('Named')
    expect(form.provider).toBe('kimi')
    expect(form.scope).toBe('global')
    expect(form.workspaceMode).toBe('worktree')
    expect(form.networkPolicy).toBe('deny')
    expect(form.persistence).toBe('ephemeral')
  })

  it('formats plaintext env while omitting secret-backed keys', () => {
    const form = formFromRuntimeProfile(
      makeProfile({
        env: { PLAIN: 'yes', TOKEN: 'hidden' },
        secretRefs: { env: ['TOKEN'] }
      })
    )
    expect(form.envText).toBe('PLAIN=yes')
    expect(form.envSecretText).toBe('TOKEN=')
  })

  it('falls back to empty binary path and default approval mode', () => {
    const form = formFromRuntimeProfile(makeProfile({ binaryPath: undefined }))
    expect(form.binaryPath).toBe('')
    expect(form.approvalMode).toBe('default')
  })

  it('keeps explicit binary path and approval mode', () => {
    const form = formFromRuntimeProfile(
      makeProfile({ binaryPath: '/usr/local/bin/codex', approvalMode: 'plan' })
    )
    expect(form.binaryPath).toBe('/usr/local/bin/codex')
    expect(form.approvalMode).toBe('plan')
  })

  it('leaves empty env and missing secret refs as empty text', () => {
    const form = formFromRuntimeProfile(makeProfile())
    expect(form.envText).toBe('')
    expect(form.envSecretText).toBe('')
  })
})
