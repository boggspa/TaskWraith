import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadCatalogue } from './ThreadCatalogue'

const roots: string[] = []

function make(canErase = true): { catalogue: ThreadCatalogue; root: string } {
  const root = fs.mkdtempSync(join(tmpdir(), 'catalogue-reestablish-'))
  roots.push(root)
  const catalogue = new ThreadCatalogue({
    profilePath: root,
    writer: 'desktop',
    writerId: 'desktop',
    canWrite: () => true,
    writerLifecycle: () => 'active',
    canPublishResolution: () => false,
    canErase: () => canErase,
    isSourceWitnessCurrent: () => true,
    isIndexedGenerationCommitted: () => false
  })
  return { catalogue, root }
}

/** Every epoch file under the catalogue, by name, so a rewrite shows as a changed mtime or body. */
function epochFiles(root: string): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (full.includes(`${join('epochs', '')}`))
        found.set(full, fs.readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return found
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('ThreadCatalogue.reestablishErasure', () => {
  it('writes a fresh fence when none exists and reports it was not reused', () => {
    const { catalogue } = make()

    const result = catalogue.reestablishErasure('chat-1', 'recorded-but-lost')

    expect(result.reused).toBe(false)
    expect(result.generation).not.toBe('recorded-but-lost')
    expect(catalogue.readErasureState('chat-1')).toEqual({
      generation: result.generation,
      erasing: true
    })
    expect(catalogue.currentErasureGeneration('chat-1')).toBe(result.generation)
  })

  it('keeps a live fence under its generation without rewriting it', () => {
    const { catalogue, root } = make()
    const generation = catalogue.beginErasure('chat-1')
    const before = epochFiles(root)

    const result = catalogue.reestablishErasure('chat-1', generation)

    expect(result).toEqual({ generation, reused: true })
    expect(epochFiles(root)).toEqual(before)
    // The resumed fence still lifts under the generation the first run minted.
    expect(catalogue.finishErasure(generation, 'chat-1')).toBe(true)
    expect(catalogue.readErasureState('chat-1').erasing).toBe(false)
  })

  it('refuses a live fence minted under another generation', () => {
    const { catalogue } = make()
    const live = catalogue.beginErasure('chat-1')

    expect(() => catalogue.reestablishErasure('chat-1', 'someone-elses')).toThrow(
      /generation mismatch/
    )

    expect(catalogue.readErasureState('chat-1')).toEqual({ generation: live, erasing: true })
  })

  it('re-fences a scope whose fence a finished erasure already lifted', () => {
    const { catalogue } = make()
    const first = catalogue.beginErasure('chat-1')
    expect(catalogue.finishErasure(first, 'chat-1')).toBe(true)

    const result = catalogue.reestablishErasure('chat-1', first)

    expect(result.reused).toBe(false)
    expect(result.generation).not.toBe(first)
    expect(catalogue.readErasureState('chat-1').erasing).toBe(true)
  })

  it('replaces an unreadable fence rather than wedging the deletion behind it', () => {
    const { catalogue, root } = make()
    const generation = catalogue.beginErasure('chat-1')
    for (const file of epochFiles(root).keys()) fs.writeFileSync(file, '{not json')
    expect(catalogue.readErasureState('chat-1')).toEqual({
      generation: 'unreadable',
      erasing: true
    })

    const result = catalogue.reestablishErasure('chat-1', generation)

    expect(result.reused).toBe(false)
    expect(catalogue.readErasureState('chat-1')).toEqual({
      generation: result.generation,
      erasing: true
    })
  })

  it('covers the global scope', () => {
    const { catalogue } = make()
    const generation = catalogue.beginErasure()

    expect(catalogue.reestablishErasure(undefined, generation)).toEqual({
      generation,
      reused: true
    })
    expect(catalogue.currentErasureGeneration('any-chat')).toBe(generation)
  })

  it('needs erasure authority', () => {
    const { catalogue } = make(false)

    expect(() => catalogue.reestablishErasure('chat-1', 'g')).toThrow(/authority is unavailable/)
  })

  it('reports no live generation when nothing is fenced', () => {
    const { catalogue } = make()

    expect(catalogue.currentErasureGeneration('chat-1')).toBeNull()
    expect(catalogue.readErasureState('chat-1')).toEqual({ generation: 'initial', erasing: false })
  })
})
