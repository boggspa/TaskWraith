import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  agyCliRootPath,
  agyConversationReceiptCandidateKeys,
  agyConversationReceiptPath,
  formatAgyProjectBoundSessionId,
  parseAgyConversationReceipt,
  parseAgyProjectBoundSessionId,
  readAgyConversationReceipt
} from './AntigravityConversationReceipt'

const HOME = '/Users/test'
const CONVERSATION = '0e81528b-aa70-4678-b9ce-d3005b829583'

describe('project-bound provider session ids', () => {
  it('round-trips a CLI UUID with explicit project provenance', () => {
    const tagged = formatAgyProjectBoundSessionId(CONVERSATION)
    expect(tagged).toBe(`agy-project-v1:${CONVERSATION}`)
    expect(parseAgyProjectBoundSessionId(tagged)).toBe(CONVERSATION)
  })

  it('does not treat a bare legacy UUID or malformed tag as project-bound', () => {
    expect(parseAgyProjectBoundSessionId(CONVERSATION)).toBeNull()
    expect(parseAgyProjectBoundSessionId('agy-project-v1:not-a-uuid')).toBeNull()
    expect(formatAgyProjectBoundSessionId('not-a-uuid')).toBeNull()
  })
})

describe('agyConversationReceiptPath', () => {
  it('reads the official CLI cache location by default', () => {
    expect(agyConversationReceiptPath({}, HOME)).toBe(
      join(HOME, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json')
    )
  })

  // createAgyCliEnv strips only credential keys, so a user's GEMINI_HOME reaches
  // the agy child. Ignoring it here would look for the receipt in the wrong
  // place, never learn an id, and silently degrade resumption to "always fresh".
  it('honours the same GEMINI_CLI_HOME / GEMINI_HOME overrides the CLI uses', () => {
    expect(agyCliRootPath({ GEMINI_CLI_HOME: '~/custom' }, HOME)).toBe(
      join(HOME, 'custom', '.gemini')
    )
    expect(agyCliRootPath({ GEMINI_HOME: '/opt/gemini-root' }, HOME)).toBe('/opt/gemini-root')
    expect(agyCliRootPath({ GEMINI_CLI_HOME: '   ' }, HOME)).toBe(join(HOME, '.gemini'))
  })
})

describe('agyConversationReceiptCandidateKeys', () => {
  it('tries the exact path first, then trailing-slash and resolved variants', () => {
    expect(agyConversationReceiptCandidateKeys('/tmp/work/', '/private/tmp/work')).toEqual([
      '/tmp/work/',
      '/tmp/work',
      '/private/tmp/work'
    ])
  })

  it('deduplicates when the resolved path matches the workspace', () => {
    expect(agyConversationReceiptCandidateKeys('/repo', '/repo')).toEqual(['/repo'])
  })
})

describe('parseAgyConversationReceipt', () => {
  const raw = JSON.stringify({
    '/repo': CONVERSATION,
    '/other': 'f674605d-98c6-4145-a8ae-8da6a491416e'
  })

  it('returns the id recorded for the workspace', () => {
    expect(parseAgyConversationReceipt(raw, ['/repo'])).toBe(CONVERSATION)
  })

  it('honours candidate order so the most exact key wins', () => {
    expect(parseAgyConversationReceipt(raw, ['/other', '/repo'])).toBe(
      'f674605d-98c6-4145-a8ae-8da6a491416e'
    )
  })

  it('returns null when no candidate key is present', () => {
    expect(parseAgyConversationReceipt(raw, ['/missing'])).toBeNull()
  })

  // A malformed cache must never become a --conversation argument, since agy
  // silently starts a new conversation for an id it does not recognise.
  it.each([
    ['not json', 'oops{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string body', '"just-a-string"'],
    ['a non-uuid value', JSON.stringify({ '/repo': 'conv-123' })],
    ['a non-string value', JSON.stringify({ '/repo': 42 })],
    ['an injected argument', JSON.stringify({ '/repo': `${CONVERSATION} --mode accept-edits` })]
  ])('rejects %s', (_label, body) => {
    expect(parseAgyConversationReceipt(body, ['/repo'])).toBeNull()
  })
})

describe('readAgyConversationReceipt', () => {
  it('resolves the id for the run workspace', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ '/repo': CONVERSATION }))
    await expect(
      readAgyConversationReceipt('/repo', {
        readFile,
        realpath: async (path) => path,
        homeDir: HOME,
        env: {}
      })
    ).resolves.toBe(CONVERSATION)
    expect(readFile).toHaveBeenCalledWith(agyConversationReceiptPath({}, HOME))
  })

  it('falls back to the resolved path when the CLI recorded that instead', async () => {
    await expect(
      readAgyConversationReceipt('/tmp/work', {
        readFile: async () => JSON.stringify({ '/private/tmp/work': CONVERSATION }),
        realpath: async () => '/private/tmp/work',
        homeDir: HOME,
        env: {}
      })
    ).resolves.toBe(CONVERSATION)
  })

  it('still reads the receipt when realpath fails', async () => {
    await expect(
      readAgyConversationReceipt('/repo', {
        readFile: async () => JSON.stringify({ '/repo': CONVERSATION }),
        realpath: async () => Promise.reject(new Error('ENOENT')),
        homeDir: HOME,
        env: {}
      })
    ).resolves.toBe(CONVERSATION)
  })

  // Best-effort by design: a missing receipt leaves the chat on its previous id
  // and the next turn simply starts fresh. It must never throw into the run's
  // terminal path.
  it.each([
    ['a missing workspace', null],
    ['an empty workspace', '   ']
  ])('returns null for %s without reading the file', async (_label, workspace) => {
    const readFile = vi.fn()
    await expect(
      readAgyConversationReceipt(workspace, { readFile, homeDir: HOME, env: {} })
    ).resolves.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('returns null when the receipt file cannot be read', async () => {
    await expect(
      readAgyConversationReceipt('/repo', {
        readFile: async () => Promise.reject(new Error('ENOENT')),
        realpath: async (path) => path,
        homeDir: HOME,
        env: {}
      })
    ).resolves.toBeNull()
  })
})
