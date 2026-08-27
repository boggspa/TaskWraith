import { describe, expect, it } from 'vitest'

import {
  runQueueDirectoryAttachmentReceiptMatchesBinding,
  signRunQueueDirectoryAttachmentReceipt,
  type RunQueueDirectoryAttachmentReceiptBinding,
  verifyRunQueueDirectoryAttachmentReceipt
} from './RunQueueDirectoryAttachmentReceipt'

const secret = Buffer.alloc(32, 0x42)

function binding(
  overrides: Partial<RunQueueDirectoryAttachmentReceiptBinding> = {}
): RunQueueDirectoryAttachmentReceiptBinding {
  return {
    canonicalPath: '/outside/reference',
    runId: 'run-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    provider: 'claude',
    ...overrides
  }
}

describe('RunQueueDirectoryAttachmentReceipt', () => {
  it('signs and verifies one exact workspace queue binding deterministically', () => {
    const expected = binding()
    const first = signRunQueueDirectoryAttachmentReceipt(secret, expected)
    const second = signRunQueueDirectoryAttachmentReceipt(secret, expected)

    expect(first).toEqual(second)
    expect(first.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(runQueueDirectoryAttachmentReceiptMatchesBinding(first, expected)).toBe(true)
    expect(verifyRunQueueDirectoryAttachmentReceipt(secret, first, expected)).toBe(true)
  })

  it('supports an explicitly global queue binding', () => {
    const expected = binding({ workspaceId: null, workspacePath: null })
    const receipt = signRunQueueDirectoryAttachmentReceipt(secret, expected)

    expect(verifyRunQueueDirectoryAttachmentReceipt(secret, receipt, expected)).toBe(true)
  })

  it.each([
    ['canonical path', { canonicalPath: '/outside/other' }],
    ['run', { runId: 'run-2' }],
    ['chat', { chatId: 'chat-2' }],
    ['workspace id', { workspaceId: 'workspace-2' }],
    ['workspace path', { workspacePath: '/workspace-2' }],
    ['original provider', { provider: 'codex' as const }]
  ])('rejects a receipt replayed against a different %s', (_label, overrides) => {
    const original = binding()
    const receipt = signRunQueueDirectoryAttachmentReceipt(secret, original)

    expect(verifyRunQueueDirectoryAttachmentReceipt(secret, receipt, binding(overrides))).toBe(
      false
    )
  })

  it('rejects tampered signatures and signatures from another persistent root', () => {
    const expected = binding()
    const receipt = signRunQueueDirectoryAttachmentReceipt(secret, expected)

    expect(
      verifyRunQueueDirectoryAttachmentReceipt(
        secret,
        { ...receipt, signature: '0'.repeat(64) },
        expected
      )
    ).toBe(false)
    expect(
      verifyRunQueueDirectoryAttachmentReceipt(Buffer.alloc(32, 0x24), receipt, expected)
    ).toBe(false)
  })

  it('refuses incomplete, relative, or mixed global/workspace signing bindings', () => {
    for (const candidate of [
      binding({ canonicalPath: 'relative/folder' }),
      binding({ canonicalPath: '/outside/\0folder' }),
      binding({ runId: '' }),
      binding({ chatId: ' chat-1' }),
      binding({ workspaceId: null }),
      binding({ workspacePath: null })
    ]) {
      expect(() => signRunQueueDirectoryAttachmentReceipt(secret, candidate)).toThrow(
        'binding is invalid'
      )
    }
    expect(() => signRunQueueDirectoryAttachmentReceipt(Buffer.alloc(8), binding())).toThrow(
      'secret is unavailable'
    )
  })
})
