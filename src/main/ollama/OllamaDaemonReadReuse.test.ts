import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OLLAMA_RUN_CATALOG_REUSE_MS,
  OLLAMA_RUN_MODEL_SHOW_REUSE_MS,
  isOllamaRunRead,
  readOllamaModelShowForRun,
  recentOllamaCatalog,
  rememberOllamaCatalog,
  rememberOllamaModelShow,
  resetOllamaDaemonReadReuseForTests,
  withinOllamaRunReads
} from './OllamaDaemonReadReuse'

type Show = { id: string }

afterEach(() => {
  resetOllamaDaemonReadReuseForTests()
  vi.useRealTimers()
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

/** A read that settles like `fetch` on its own signal: aborting rejects it. */
function readOnSignal(answer: Promise<Show | null>, signal: AbortSignal) {
  return () =>
    new Promise<Show | null>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      answer.then(resolve, reject)
    })
}

describe('readOllamaModelShowForRun', () => {
  it('a run that stops ends only its own wait; the request it joined still answers the run that made it', async () => {
    const answer = deferred<Show | null>()
    const first = new AbortController()
    const second = new AbortController()
    const firstRead = vi.fn(readOnSignal(answer.promise, first.signal))
    const secondRead = vi.fn(readOnSignal(answer.promise, second.signal))

    const firstShow = readOllamaModelShowForRun('t001', firstRead, first.signal)
    const secondShow = readOllamaModelShowForRun('t001', secondRead, second.signal)
    second.abort()

    await expect(secondShow).rejects.toMatchObject({ name: 'AbortError' })
    answer.resolve({ id: 't001' })
    await expect(firstShow).resolves.toEqual({ id: 't001' })
    expect(firstRead).toHaveBeenCalledTimes(1)
    expect(secondRead).not.toHaveBeenCalled()
  })

  it('when the run whose request it joined stops, a run asks again on its own signal', async () => {
    const answer = deferred<Show | null>()
    const first = new AbortController()
    const second = new AbortController()
    const firstRead = vi.fn(readOnSignal(answer.promise, first.signal))
    const secondRead = vi.fn(async (): Promise<Show | null> => ({ id: 't001' }))

    const firstShow = readOllamaModelShowForRun('t001', firstRead, first.signal)
    const secondShow = readOllamaModelShowForRun('t001', secondRead, second.signal)
    first.abort()

    await expect(firstShow).rejects.toMatchObject({ name: 'AbortError' })
    await expect(secondShow).resolves.toEqual({ id: 't001' })
    expect(secondRead).toHaveBeenCalledTimes(1)
  })

  it('a failure is shared with the runs already waiting on it, but never remembered', async () => {
    const read = vi.fn(async (): Promise<Show | null> => null)

    await expect(
      Promise.all([
        readOllamaModelShowForRun('t001', read),
        readOllamaModelShowForRun('t001', read)
      ])
    ).resolves.toEqual([null, null])
    expect(read).toHaveBeenCalledTimes(1)

    await readOllamaModelShowForRun('t001', read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reuses an answer for the reuse window, then reads again', async () => {
    vi.useFakeTimers({ now: 0 })
    const read = vi.fn(async (): Promise<Show | null> => ({ id: 't001' }))

    await readOllamaModelShowForRun('t001', read)
    vi.setSystemTime(OLLAMA_RUN_MODEL_SHOW_REUSE_MS)
    await readOllamaModelShowForRun('t001', read)
    expect(read).toHaveBeenCalledTimes(1)

    vi.setSystemTime(OLLAMA_RUN_MODEL_SHOW_REUSE_MS + 1)
    await readOllamaModelShowForRun('t001', read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a refresh that found no metadata makes the next run ask again', async () => {
    const read = vi.fn(async (): Promise<Show | null> => ({ id: 't001' }))

    await readOllamaModelShowForRun('t001', read)
    rememberOllamaModelShow('t001', null)
    await readOllamaModelShowForRun('t001', read)

    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('recentOllamaCatalog', () => {
  it('answers within the run window only, and a failed read forgets it', () => {
    vi.useFakeTimers({ now: 0 })
    rememberOllamaCatalog('daemon', { models: ['t001'] })

    vi.setSystemTime(OLLAMA_RUN_CATALOG_REUSE_MS)
    expect(recentOllamaCatalog('daemon')).toEqual({ models: ['t001'] })
    vi.setSystemTime(OLLAMA_RUN_CATALOG_REUSE_MS + 1)
    expect(recentOllamaCatalog('daemon')).toBeUndefined()

    rememberOllamaCatalog('daemon', { models: ['t001'] })
    rememberOllamaCatalog('daemon', null)
    expect(recentOllamaCatalog('daemon')).toBeUndefined()
  })
})

describe('withinOllamaRunReads', () => {
  it('marks the reads made inside it, across awaits, and none outside it', async () => {
    expect(isOllamaRunRead()).toBe(false)

    const inside = await withinOllamaRunReads(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return isOllamaRunRead()
    })

    expect(inside).toBe(true)
    expect(isOllamaRunRead()).toBe(false)
  })
})
