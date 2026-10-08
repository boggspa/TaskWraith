import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createProfileOllamaBaseUrlReader,
  readRememberedOllamaCliSignIn
} from './OllamaCliSignInProfile'

// Each safety check in the reader is a pair: the lstat before the open, then
// O_NOFOLLOW and fstat on the opened descriptor, so a file swapped between the
// two still cannot slip through. These hooks record which paths the reader
// opens and let a test swap the file right after the pre-open check, which
// pins every layer of each pair on its own.
const fsHooks = vi.hoisted(() => ({
  opened: [] as string[],
  withoutNoFollow: false,
  afterCheck: null as ((path: string) => void) | null
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const thenSwap =
    (check: (...input: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const stats = check(...args)
      const swap = fsHooks.afterCheck
      fsHooks.afterCheck = null
      swap?.(String(args[0]))
      return stats
    }
  return {
    ...fs,
    constants: {
      ...fs.constants,
      get O_NOFOLLOW() {
        return fsHooks.withoutNoFollow ? 0 : fs.constants.O_NOFOLLOW
      }
    },
    lstatSync: thenSwap(fs.lstatSync as (...input: unknown[]) => unknown),
    statSync: thenSwap(fs.statSync as (...input: unknown[]) => unknown),
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      fsHooks.opened.push(String(args[0]))
      return fs.openSync(...args)
    }
  }
})

const EARLIER = '2026-08-01T00:00:00.000Z'
const OVER_BOUND_PADDING = ' '.repeat(4 * 1024 * 1024)
const profiles: string[] = []

function profile(settings?: string): string {
  const path = mkdtempSync(join(tmpdir(), 'ollama-cli-signin-profile-'))
  profiles.push(path)
  if (settings !== undefined) writeFileSync(join(path, 'settings.json'), settings)
  return path
}

afterEach(() => {
  fsHooks.withoutNoFollow = false
  fsHooks.opened.length = 0
  fsHooks.afterCheck = null
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
    writeFileSync(join(path, 'settings.json'), record + OVER_BOUND_PADDING)
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
  })

  // The "never opened" assertions below mean something only because the
  // recorder sees an ordinary read.
  it('opens only the settings file it checked', () => {
    const path = profile(
      JSON.stringify({ ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER } })
    )
    expect(readRememberedOllamaCliSignIn(path)).toEqual({ signedIn: true, updatedAt: EARLIER })
    expect(fsHooks.opened).toEqual([join(path, 'settings.json')])
  })

  it('refuses a symlinked settings file before opening anything', () => {
    const path = profile()
    const elsewhere = profile(
      JSON.stringify({ ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER } })
    )
    symlinkSync(join(elsewhere, 'settings.json'), join(path, 'settings.json'))
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
    expect(fsHooks.opened).toEqual([])
  })

  it.each([false, true])('refuses swapped symlinks (%s)', (withoutNoFollow) => {
    fsHooks.withoutNoFollow = withoutNoFollow
    const path = profile(
      JSON.stringify({ ollamaCliSignIn: { signedIn: false, updatedAt: EARLIER } })
    )
    const elsewhere = profile(
      JSON.stringify({ ollamaCliSignIn: { signedIn: true, plan: 'pro', updatedAt: EARLIER } })
    )
    const settings = join(path, 'settings.json')
    fsHooks.afterCheck = (checked) => {
      if (checked !== settings) return
      unlinkSync(settings)
      symlinkSync(join(elsewhere, 'settings.json'), settings)
    }
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
  })

  it('refuses a settings file past the size bound before opening anything', () => {
    const path = profile()
    const record = JSON.stringify({ ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER } })
    writeFileSync(join(path, 'settings.json'), record + OVER_BOUND_PADDING)
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
    expect(fsHooks.opened).toEqual([])
  })

  it('refuses a settings file that grew past the size bound after it was checked', () => {
    const record = JSON.stringify({ ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER } })
    const path = profile(record)
    const settings = join(path, 'settings.json')
    fsHooks.afterCheck = (checked) => {
      if (checked === settings) writeFileSync(settings, record + OVER_BOUND_PADDING)
    }
    expect(readRememberedOllamaCliSignIn(path)).toBeNull()
  })
})

describe('createProfileOllamaBaseUrlReader', () => {
  const readOnce = (path: string) => createProfileOllamaBaseUrlReader(path)()

  it('reads only the daemon URL, normalised, from the one file it checked', () => {
    const path = profile(
      JSON.stringify({
        ollamaBaseUrl: 'http://127.0.0.1:43123/v1?x=1',
        ollamaCliSignIn: { signedIn: true, updatedAt: EARLIER }
      })
    )
    expect(readOnce(path)).toBe('http://127.0.0.1:43123')
    expect(fsHooks.opened).toEqual([join(path, 'settings.json')])
    // Main strips a path of any length, so the Host does too.
    expect(
      readOnce(profile(JSON.stringify({ ollamaBaseUrl: `http://127.0.0.1:1/${'a'.repeat(4096)}` })))
    ).toBe('http://127.0.0.1:1')
  })

  it('answers null for an absent URL or settings file, or a symlinked settings file', () => {
    expect(readOnce(join(profile(), 'missing'))).toBeNull()
    expect(readOnce(profile('{}'))).toBeNull()
    const linked = profile()
    const elsewhere = profile(JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:43123' }))
    symlinkSync(join(elsewhere, 'settings.json'), join(linked, 'settings.json'))
    fsHooks.opened.length = 0
    expect(readOnce(linked)).toBeNull()
    expect(fsHooks.opened).toEqual([])
  })

  it('keeps the URL it last read while the settings file cannot be read', () => {
    const path = profile(JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:43123' }))
    const read = createProfileOllamaBaseUrlReader(path)
    expect(read()).toBe('http://127.0.0.1:43123')
    writeFileSync(join(path, 'settings.json'), '{"ollamaBaseUrl": "http://127.0.0.1:5')
    expect(read()).toBe('http://127.0.0.1:43123')
    unlinkSync(join(path, 'settings.json'))
    expect(read()).toBe('http://127.0.0.1:43123')
    // A settings record that names no URL is the user's choice of the default.
    writeFileSync(join(path, 'settings.json'), JSON.stringify({ ollamaDefaultModel: 'x' }))
    expect(read()).toBeNull()
    writeFileSync(join(path, 'settings.json'), '{')
    expect(read()).toBeNull()
  })
})
