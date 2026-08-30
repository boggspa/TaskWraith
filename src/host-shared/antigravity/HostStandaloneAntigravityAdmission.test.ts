import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isLiveSelectableProvider } from '../../shared/retiredProviders'
import {
  discoverHostStandaloneAntigravity,
  parseHostStandaloneAgyModels,
  readHostStandaloneAntigravityConsent,
  type DiscoverHostStandaloneAntigravityInput
} from './HostStandaloneAntigravityAdmission'

const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

function profile(settings?: unknown): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'host-antigravity-admission-')))
  paths.push(path)
  if (settings !== undefined) {
    writeFileSync(join(path, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
  }
  return path
}

function acceptedSettings() {
  return {
    antigravityEnabled: true,
    antigravityOptInAcceptedAt: 1_700_000_000_000,
    unrelatedSecret: 'must-not-project'
  }
}

describe('readHostStandaloneAntigravityConsent', () => {
  it('reads only the existing two-part profile consent', () => {
    expect(readHostStandaloneAntigravityConsent(profile(acceptedSettings()))).toEqual({
      accepted: true,
      acceptedAt: 1_700_000_000_000,
      status: 'accepted'
    })
    expect(
      readHostStandaloneAntigravityConsent(
        profile({ antigravityEnabled: true, antigravityOptInAcceptedAt: null })
      )
    ).toEqual({ accepted: false, acceptedAt: null, status: 'missing' })
    expect(
      readHostStandaloneAntigravityConsent(
        profile({ antigravityEnabled: true, antigravityOptInAcceptedAt: 'yes' })
      )
    ).toEqual({ accepted: false, acceptedAt: null, status: 'missing' })
  })

  it('fails closed for missing, malformed, oversized, and symlinked settings', () => {
    expect(readHostStandaloneAntigravityConsent(profile())).toEqual({
      accepted: false,
      acceptedAt: null,
      status: 'missing'
    })
    const malformed = profile()
    writeFileSync(join(malformed, 'settings.json'), '{broken', { mode: 0o600 })
    expect(readHostStandaloneAntigravityConsent(malformed).accepted).toBe(false)

    const oversized = profile()
    writeFileSync(join(oversized, 'settings.json'), 'x'.repeat(512 * 1024 + 1), { mode: 0o600 })
    expect(readHostStandaloneAntigravityConsent(oversized).status).toBe('invalid')

    const target = profile(acceptedSettings())
    const linked = profile()
    symlinkSync(join(target, 'settings.json'), join(linked, 'settings.json'))
    expect(readHostStandaloneAntigravityConsent(linked)).toEqual({
      accepted: false,
      acceptedAt: null,
      status: 'invalid'
    })
  })
})

describe('discoverHostStandaloneAntigravity', () => {
  it('does no binary or process work before consent', async () => {
    const resolveBinary = vi.fn(async () => ({ binaryPath: '/usr/local/bin/agy' }))
    const capture = vi.fn()

    await expect(
      discoverHostStandaloneAntigravity({
        profilePath: profile({ antigravityEnabled: true }),
        resolveBinary,
        capture
      })
    ).resolves.toMatchObject({ status: 'consent_required', admission: null })
    expect(resolveBinary).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('requires a resolved official binary and a current nonempty live model probe', async () => {
    const consentedProfile = profile(acceptedSettings())
    const capture = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }))
    await expect(
      discoverHostStandaloneAntigravity({
        profilePath: consentedProfile,
        resolveBinary: async () => ({ binaryPath: null }),
        capture
      })
    ).resolves.toMatchObject({ status: 'unavailable', admission: null })
    expect(capture).not.toHaveBeenCalled()

    await expect(
      discoverHostStandaloneAntigravity({
        profilePath: consentedProfile,
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy' }),
        capture
      })
    ).resolves.toMatchObject({ status: 'auth_required', admission: null })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('admits only live discovered rows, groups efforts, and keeps AntiGravity conditional', async () => {
    const capture = vi.fn<DiscoverHostStandaloneAntigravityInput['capture']>(async () => ({
      stdout: JSON.stringify({
        models: [
          { id: 'gemini-3.7-flash-high' },
          { id: 'gemini-3.7-flash-medium' },
          { id: 'gemini-3.7-flash-low' },
          { id: 'claude-opus-4-6' }
        ]
      }),
      stderr: '',
      code: 0
    }))
    const result = await discoverHostStandaloneAntigravity({
      profilePath: profile(acceptedSettings()),
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy' }),
      capture,
      env: {
        PATH: '/usr/local/bin',
        GEMINI_API_KEY: 'never-forward',
        google_api_key: 'never-forward-either',
        TASKWRAITH_LOCK_OWNER_ID: 'not-a-discovery-claim'
      }
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected admission')
    expect(isLiveSelectableProvider('antigravity')).toBe(false)
    expect(result.admission.offers.providerId).toBe('antigravity')
    expect(result.admission.offers.models).toEqual([
      expect.objectContaining({
        modelId: 'gemini-3.7-flash-high',
        label: 'Gemini 3.7 Flash',
        default: true,
        reasoning: [
          expect.objectContaining({ reasoningId: 'low' }),
          expect.objectContaining({ reasoningId: 'medium' }),
          expect.objectContaining({ reasoningId: 'high' })
        ]
      }),
      expect.objectContaining({ modelId: 'claude-opus-4-6', label: 'Opus 4.6' })
    ])
    expect(
      result.admission.offers.postures.map((posture) => [posture.label, posture.available])
    ).toEqual([
      ['Plan', true],
      ['Ask', false],
      ['Accept Edits', false],
      ['Full WS Access', false],
      ['Full Access (YOLO)', false]
    ])
    const captureOptions = capture.mock.calls[0]?.[2]
    expect(captureOptions).toMatchObject({ timeoutMs: 8_000 })
    expect(captureOptions?.env).toMatchObject({ PATH: '/usr/local/bin', FORCE_COLOR: '0' })
    expect(captureOptions?.env).not.toHaveProperty('GEMINI_API_KEY')
    expect(captureOptions?.env).not.toHaveProperty('google_api_key')
    expect(captureOptions?.env).not.toHaveProperty('TASKWRAITH_LOCK_OWNER_ID')
    expect(JSON.stringify(result)).not.toContain('must-not-project')
  })

  it('rechecks consent and never substitutes cached or static rows', async () => {
    const path = profile(acceptedSettings())
    const capture = vi.fn(async () => ({
      stdout: 'gemini-3.7-flash-high\n',
      stderr: '',
      code: 0
    }))
    const input = {
      profilePath: path,
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy' }),
      capture
    }
    await expect(discoverHostStandaloneAntigravity(input)).resolves.toMatchObject({
      status: 'ready'
    })
    writeFileSync(
      join(path, 'settings.json'),
      JSON.stringify({ antigravityEnabled: false, antigravityOptInAcceptedAt: null }),
      { mode: 0o600 }
    )
    await expect(discoverHostStandaloneAntigravity(input)).resolves.toMatchObject({
      status: 'consent_required',
      admission: null
    })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized live probe output instead of parsing a partial model floor', async () => {
    await expect(
      discoverHostStandaloneAntigravity({
        profilePath: profile(acceptedSettings()),
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy' }),
        capture: async () => ({
          stdout: `gemini-3.7-flash-high\n${'x'.repeat(256 * 1024)}`,
          stderr: '',
          code: 0
        })
      })
    ).resolves.toMatchObject({ status: 'auth_required', admission: null })
  })
})

describe('parseHostStandaloneAgyModels', () => {
  it('rejects unauthenticated prose while accepting current table output', () => {
    expect(parseHostStandaloneAgyModels('Not logged in. Please sign in.')).toEqual([])
    expect(parseHostStandaloneAgyModels('["Not logged in"]')).toEqual([])
    expect(
      parseHostStandaloneAgyModels(
        'gemini-3.7-flash-high\tGemini 3.7 Flash High\r\ngemini-3.7-flash-low  Gemini 3.7 Flash Low'
      )
    ).toEqual([
      { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash High' },
      { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash Low' }
    ])
  })
})
