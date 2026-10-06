import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogue } from './ThreadCatalogue'

const seen = vi.hoisted(() => ({ lstat: [] as string[], deniedOpen: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
      seen.lstat.push(String(args[0]))
      return actual.lstatSync(...args)
    }) as typeof actual.lstatSync,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (String(args[0]) === seen.deniedOpen) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
      return actual.openSync(...args)
    }
  }
})

const roots: string[] = []

function make(): { catalogue: ThreadCatalogue; root: string } {
  const root = fs.mkdtempSync(join(tmpdir(), 'catalogue-epoch-read-'))
  roots.push(root)
  const catalogue = new ThreadCatalogue({
    profilePath: root,
    writer: 'desktop',
    writerId: 'desktop',
    canWrite: () => true,
    writerLifecycle: () => 'active',
    canPublishResolution: () => false,
    canErase: () => true,
    isSourceWitnessCurrent: () => true,
    isIndexedGenerationCommitted: () => false
  })
  return { catalogue, root }
}

/** The chat fence file, found by its hashed name wherever the catalogue keeps it. */
function fenceFile(root: string, chatId: string): string {
  const name = `${createHash('sha256').update(chatId).digest('hex')}.json`
  const walk = (directory: string): string | null => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = walk(full)
        if (found) return found
      } else if (entry.name === name && full.includes(join('epochs', 'chats'))) return full
    }
    return null
  }
  const found = walk(root)
  if (!found) throw new Error('fence file not found')
  return found
}

afterEach(() => {
  seen.lstat.length = 0
  seen.deniedOpen = null
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('ThreadCatalogue epoch fence reads', () => {
  it('reads an absent fence as initial without asking again whether it exists', () => {
    const { catalogue } = make()
    seen.lstat.length = 0

    expect(catalogue.readErasureState('chat-1')).toEqual({
      generation: 'initial',
      erasing: false
    })
    expect(seen.lstat.filter((file) => file.includes('epochs'))).toEqual([])
  })

  it('still reads a corrupt fence as erasing', () => {
    const { catalogue, root } = make()
    catalogue.reestablishErasure('chat-1', 'recorded-but-lost')
    fs.writeFileSync(fenceFile(root, 'chat-1'), '{not json')

    expect(catalogue.readErasureState('chat-1')).toEqual({
      generation: 'unreadable',
      erasing: true
    })
  })

  it('still reads a fence that cannot be opened as erasing', () => {
    const { catalogue, root } = make()
    catalogue.reestablishErasure('chat-1', 'recorded-but-lost')
    seen.deniedOpen = fenceFile(root, 'chat-1')

    expect(catalogue.readErasureState('chat-1')).toEqual({
      generation: 'unreadable',
      erasing: true
    })
  })
})
