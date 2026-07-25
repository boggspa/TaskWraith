import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AGY_MODEL_CACHE_FILENAME,
  agyModelCachePath,
  readCachedAgyModels,
  sanitizeCachedAgyModels,
  writeCachedAgyModels
} from './AntigravityAgyModelCache'

const USER_DATA = '/Users/test/Library/Application Support/TaskWraith'
const MODELS = [
  { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
  { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' }
]

function record(models: unknown, version: unknown = 1): string {
  return JSON.stringify({ version, updatedAt: '2026-07-25T00:00:00.000Z', models })
}

describe('agyModelCachePath', () => {
  it('lives beside the other userData caches', () => {
    expect(agyModelCachePath(USER_DATA)).toBe(join(USER_DATA, AGY_MODEL_CACHE_FILENAME))
  })
})

describe('sanitizeCachedAgyModels', () => {
  it('accepts a well-formed record', () => {
    expect(sanitizeCachedAgyModels(JSON.parse(record(MODELS)))).toEqual(MODELS)
  })

  it('defaults a missing label to the id, matching live bare-id output', () => {
    expect(sanitizeCachedAgyModels(JSON.parse(record([{ id: 'gemini-3.1-pro-low' }])))).toEqual([
      { id: 'gemini-3.1-pro-low', label: 'gemini-3.1-pro-low' }
    ])
  })

  // A cached row carrying the gemini-api prefix would be routed by
  // dispatchAntigravityCombinedMode onto the separately billed SDK key lane. An
  // agy-lane cache must never be able to redirect a run onto the paid lane.
  it('refuses ids in the gemini-api dispatch namespace', () => {
    const models = sanitizeCachedAgyModels(
      JSON.parse(record([{ id: 'gemini-api:gemini-2.5-flash' }, ...MODELS]))
    )
    expect(models).toEqual(MODELS)
  })

  it.each([
    ['an argv-ish leading dash', '--dangerously-skip-permissions'],
    ['whitespace', 'gemini 3.6 flash'],
    ['a control character', 'gemini-3.6' + String.fromCharCode(0) + 'flash'],
    ['an empty id', '   ']
  ])('rejects %s', (_label, id) => {
    expect(sanitizeCachedAgyModels(JSON.parse(record([{ id }])))).toEqual([])
  })

  it('rejects an unknown schema version so a future format is not misread', () => {
    expect(sanitizeCachedAgyModels(JSON.parse(record(MODELS, 2)))).toEqual([])
  })

  it.each([
    ['a non-object', 'nope'],
    ['an array', []],
    ['null', null],
    ['a missing models array', { version: 1 }]
  ])('returns nothing for %s', (_label, parsed) => {
    expect(sanitizeCachedAgyModels(parsed)).toEqual([])
  })

  it('deduplicates case-insensitively and caps the list', () => {
    const dupes = [{ id: 'gemini-3.6-flash-high' }, { id: 'GEMINI-3.6-FLASH-HIGH' }]
    expect(sanitizeCachedAgyModels(JSON.parse(record(dupes))).length).toBe(1)
    const many = Array.from({ length: 300 }, (_unused, index) => ({ id: `gemini-x${index}` }))
    expect(sanitizeCachedAgyModels(JSON.parse(record(many))).length).toBe(128)
  })
})

describe('readCachedAgyModels', () => {
  it('reads the persisted catalogue', async () => {
    const readFile = vi.fn(async () => record(MODELS))
    await expect(readCachedAgyModels({ userDataPath: USER_DATA, readFile })).resolves.toEqual(
      MODELS
    )
    expect(readFile).toHaveBeenCalledWith(agyModelCachePath(USER_DATA))
  })

  // Callers with no app context (and most tests) must fall straight through to
  // the hardcoded floor rather than touching the filesystem.
  it('is inert without a userDataPath', async () => {
    const readFile = vi.fn()
    await expect(readCachedAgyModels({ readFile })).resolves.toEqual([])
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing file', async () => Promise.reject(new Error('ENOENT'))],
    ['malformed JSON', async () => 'oops{']
  ])('returns nothing for %s', async (_label, readFile) => {
    await expect(readCachedAgyModels({ userDataPath: USER_DATA, readFile })).resolves.toEqual([])
  })
})

describe('writeCachedAgyModels', () => {
  it('persists a versioned, stamped record', async () => {
    const writeFile = vi.fn(async (_path: string, _contents: string) => undefined)
    await writeCachedAgyModels(MODELS, {
      userDataPath: USER_DATA,
      writeFile,
      now: () => '2026-07-25T12:00:00.000Z'
    })
    const [path, contents] = writeFile.mock.calls[0]
    expect(path).toBe(agyModelCachePath(USER_DATA))
    expect(JSON.parse(contents)).toEqual({
      version: 1,
      updatedAt: '2026-07-25T12:00:00.000Z',
      models: MODELS
    })
  })

  // One odd successful-but-empty probe must not erase a good cache and drop the
  // user back to the hardcoded floor.
  it('refuses to persist an empty list', async () => {
    const writeFile = vi.fn()
    await writeCachedAgyModels([], { userDataPath: USER_DATA, writeFile })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('drops unsafe rows rather than persisting them', async () => {
    const writeFile = vi.fn(async (_path: string, _contents: string) => undefined)
    await writeCachedAgyModels([{ id: 'gemini-api:x', label: 'x' }, ...MODELS], {
      userDataPath: USER_DATA,
      writeFile,
      now: () => 'stamp'
    })
    expect(JSON.parse(writeFile.mock.calls[0][1]).models).toEqual(MODELS)
  })

  it('never throws when the write fails', async () => {
    await expect(
      writeCachedAgyModels(MODELS, {
        userDataPath: USER_DATA,
        writeFile: async () => Promise.reject(new Error('EACCES'))
      })
    ).resolves.toBeUndefined()
  })
})
