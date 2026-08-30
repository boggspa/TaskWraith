import { describe, expect, it } from 'vitest'

import {
  formatHostAgySessionId,
  hostAgyConversationReceiptPath,
  parseHostAgyConversationReceipt,
  parseHostAgySessionId,
  readHostAgyConversationReceipt
} from './HostAgyConversationReceipt'

const ID = '0e81528b-aa70-4678-b9ce-d3005b829583'

describe('HostAgyConversationReceipt', () => {
  it('tags only canonical agy conversation ids', () => {
    expect(formatHostAgySessionId(ID)).toBe(`agy-project-v1:${ID}`)
    expect(parseHostAgySessionId(`agy-project-v1:${ID}`)).toBe(ID)
    expect(formatHostAgySessionId('not-a-uuid')).toBeNull()
    expect(parseHostAgySessionId(ID)).toBeNull()
  })

  it('uses the same Gemini home overrides as the agy process', () => {
    expect(hostAgyConversationReceiptPath({ GEMINI_HOME: '/private/gemini' }, '/home')).toBe(
      '/private/gemini/antigravity-cli/cache/last_conversations.json'
    )
    expect(hostAgyConversationReceiptPath({ GEMINI_CLI_HOME: '~/custom' }, '/home')).toBe(
      '/home/custom/.gemini/antigravity-cli/cache/last_conversations.json'
    )
  })

  it('reads only the exact workspace receipt and returns a tagged session id', async () => {
    const read = async () => JSON.stringify({ '/resolved/work': ID, '/other': 'private' })
    await expect(
      readHostAgyConversationReceipt('/linked/work', {
        read,
        resolve: async () => '/resolved/work',
        home: '/home',
        env: {}
      })
    ).resolves.toBe(`agy-project-v1:${ID}`)
  })

  it('fails closed for malformed, oversized, or foreign receipts', async () => {
    expect(parseHostAgyConversationReceipt('{broken', ['/work'])).toBeNull()
    expect(parseHostAgyConversationReceipt('x'.repeat(1024 * 1024 + 1), ['/work'])).toBeNull()
    expect(parseHostAgyConversationReceipt(JSON.stringify({ '/other': ID }), ['/work'])).toBeNull()
    await expect(
      readHostAgyConversationReceipt('/work', {
        read: async () => {
          throw new Error('missing')
        },
        resolve: async () => '/work'
      })
    ).resolves.toBeNull()
  })
})
