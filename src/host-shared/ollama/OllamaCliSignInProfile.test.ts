import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readRememberedOllamaCliSignIn } from './OllamaCliSignInProfile'

const EARLIER = '2026-08-01T00:00:00.000Z'
const profiles: string[] = []

function profile(settings?: string): string {
  const path = mkdtempSync(join(tmpdir(), 'ollama-cli-signin-profile-'))
  profiles.push(path)
  if (settings !== undefined) writeFileSync(join(path, 'settings.json'), settings)
  return path
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('readRememberedOllamaCliSignIn', () => {
  it('reads the record main persisted and nothing else from it', () => {
    const path = profile(
      JSON.stringify({
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        ollamaCliSignIn: { signedIn: true, plan: 'pro', updatedAt: EARLIER, email: 'not-read' }
      })
    )
    expect(readRememberedOllamaCliSignIn(path)).toEqual({
      signedIn: true,
      plan: 'pro',
      updatedAt: EARLIER
    })
  })

  it('keeps a signed-out record signed out', () => {
    const path = profile(
      JSON.stringify({ ollamaCliSignIn: { signedIn: false, plan: 'pro', updatedAt: EARLIER } })
    )
    expect(readRememberedOllamaCliSignIn(path)).toEqual({ signedIn: false, updatedAt: EARLIER })
  })

  it('answers null for an absent profile, an absent record, or a malformed file', () => {
    expect(readRememberedOllamaCliSignIn(join(profile(), 'missing'))).toBeNull()
    expect(readRememberedOllamaCliSignIn(profile())).toBeNull()
    expect(readRememberedOllamaCliSignIn(profile('{}'))).toBeNull()
    expect(readRememberedOllamaCliSignIn(profile('{ not json'))).toBeNull()
    expect(readRememberedOllamaCliSignIn(profile('[]'))).toBeNull()
    expect(
      readRememberedOllamaCliSignIn(profile(JSON.stringify({ ollamaCliSignIn: 'pro' })))
    ).toBeNull()
  })

  it('refuses a symlinked settings file', () => {
    const path = profile()
    const elsewhere = profile(
      JSON.stringify({ ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER } })
    )
    symlinkSync(join(elsewhere, 'settings.json'), join(path, 'settings.json'))
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
  })

  it('refuses a settings file past the size bound', () => {
    const path = profile()
    const record = JSON.stringify({ ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER } })
    writeFileSync(join(path, 'settings.json'), record + ' '.repeat(4 * 1024 * 1024))
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
  })
})
