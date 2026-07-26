import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ActivityReportingService,
  buildActivityReportingCheckin,
  normalizeActivityPresenceEndpoint,
  normalizeActivityReportingEndpoint
} from './ActivityReportingService'

const temporaryDirectories: string[] = []
type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

function temporaryStatePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-activity-reporting-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'state.json')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('ActivityReportingService', () => {
  it('sends the fixed no-identifier payload at most once per UTC day', async () => {
    const statePath = temporaryStatePath()
    const request = vi.fn(
      async (_input: FetchInput, _init?: FetchInit) => new Response(null, { status: 202 })
    )
    const service = new ActivityReportingService({
      endpoint: 'https://activity.taskwraith.invalid/v1/checkin',
      statePath,
      isEnabled: () => true,
      appVersion: '1.9.0',
      platform: 'darwin',
      architecture: 'arm64',
      request: request as typeof fetch,
      now: () => new Date('2026-07-26T18:42:10.123Z')
    })

    expect(await service.checkNow()).toBe('sent')
    expect(await service.checkNow()).toBe('already_reported')
    expect(request).toHaveBeenCalledTimes(1)

    const [, init] = request.mock.calls[0]!
    const payload = JSON.parse(String(init?.body))
    expect(payload).toEqual({
      schema: 1,
      event: 'app_active',
      day: '2026-07-26',
      appVersion: '1.9.0',
      platform: 'macos',
      architecture: 'arm64',
      channel: 'stable'
    })
    expect(Object.keys(payload)).toEqual([
      'schema',
      'event',
      'day',
      'appVersion',
      'platform',
      'architecture',
      'channel'
    ])
    expect(fs.readFileSync(statePath, 'utf8')).toBe(
      '{\n  "schema": 1,\n  "lastReportedDay": "2026-07-26"\n}\n'
    )
  })

  it('does nothing while disabled or when the build has no endpoint', async () => {
    const request = vi.fn(async () => new Response(null, { status: 202 }))
    const disabled = new ActivityReportingService({
      endpoint: 'https://activity.taskwraith.invalid',
      statePath: temporaryStatePath(),
      isEnabled: () => false,
      appVersion: '1.9.0',
      request: request as typeof fetch
    })
    const unconfigured = new ActivityReportingService({
      endpoint: '',
      statePath: temporaryStatePath(),
      isEnabled: () => true,
      appVersion: '1.9.0',
      request: request as typeof fetch
    })

    expect(await disabled.checkNow()).toBe('disabled')
    expect(await unconfigured.checkNow()).toBe('not_configured')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not record the day when delivery fails, so a later attempt can retry', async () => {
    const statePath = temporaryStatePath()
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
    const service = new ActivityReportingService({
      endpoint: 'https://activity.taskwraith.invalid/v1/checkin',
      statePath,
      isEnabled: () => true,
      appVersion: '1.9.0',
      request: request as typeof fetch,
      now: () => new Date('2026-07-26T18:42:10.123Z')
    })

    expect(await service.checkNow()).toBe('failed')
    expect(fs.existsSync(statePath)).toBe(false)
    expect(await service.checkNow()).toBe('sent')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('renews one process-only presence lease without writing it to disk', async () => {
    const statePath = temporaryStatePath()
    const request = vi.fn(
      async (_input: FetchInput, _init?: FetchInit) => new Response(null, { status: 202 })
    )
    const service = new ActivityReportingService({
      endpoint: 'https://activity.taskwraith.invalid/v1/checkin',
      statePath,
      isEnabled: () => true,
      appVersion: '1.9.0',
      request: request as typeof fetch,
      createPresenceLease: () => 'A'.repeat(22)
    })

    expect(await service.refreshPresence()).toBe('sent')
    expect(await service.refreshPresence()).toBe('sent')
    expect(request).toHaveBeenCalledTimes(2)
    for (const [input, init] of request.mock.calls) {
      expect(String(input)).toBe('https://activity.taskwraith.invalid/v1/presence')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        schema: 1,
        event: 'app_presence',
        lease: 'A'.repeat(22)
      })
    }
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('retracts the volatile lease when the preference is turned off', async () => {
    let enabled = true
    const request = vi.fn(
      async (_input: FetchInput, _init?: FetchInit) => new Response(null, { status: 202 })
    )
    const service = new ActivityReportingService({
      endpoint: 'https://activity.taskwraith.invalid',
      statePath: temporaryStatePath(),
      isEnabled: () => enabled,
      appVersion: '1.9.0',
      request: request as typeof fetch,
      createPresenceLease: () => 'B'.repeat(22)
    })

    expect(await service.refreshPresence()).toBe('sent')
    enabled = false
    expect(await service.refreshPresence()).toBe('disabled')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]?.[1]?.method).toBe('DELETE')
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      schema: 1,
      event: 'app_presence',
      lease: 'B'.repeat(22)
    })
  })
})

describe('activity reporting contract', () => {
  it('normalizes HTTPS and loopback receivers and rejects unsafe endpoints', () => {
    expect(normalizeActivityReportingEndpoint('https://activity.example')).toBe(
      'https://activity.example/v1/checkin'
    )
    expect(normalizeActivityReportingEndpoint('http://127.0.0.1:4319/')).toBe(
      'http://127.0.0.1:4319/v1/checkin'
    )
    expect(normalizeActivityReportingEndpoint('http://activity.example')).toBeNull()
    expect(
      normalizeActivityReportingEndpoint('https://activity.example/v1/checkin?user=1')
    ).toBeNull()
    expect(normalizeActivityPresenceEndpoint('https://activity.example/v1/checkin')).toBe(
      'https://activity.example/v1/presence'
    )
    expect(normalizeActivityPresenceEndpoint('https://activity.example/private')).toBeNull()
  })

  it('does not build reports for unsupported platforms or malformed versions', () => {
    expect(
      buildActivityReportingCheckin({
        now: new Date('2026-07-26T00:00:00.000Z'),
        appVersion: '1.9.0',
        platform: 'freebsd',
        architecture: 'x64'
      })
    ).toBeNull()
    expect(
      buildActivityReportingCheckin({
        now: new Date('2026-07-26T00:00:00.000Z'),
        appVersion: 'unknown',
        platform: 'darwin',
        architecture: 'arm64'
      })
    ).toBeNull()
  })
})
