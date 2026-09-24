import { describe, expect, it, vi } from 'vitest'
import type { ChatComposerSelectionPatchRequest } from '../../../shared/chatComposerSelectionPatch'
import { ChatComposerSelectionPatchQueue } from './ChatComposerSelectionPatchQueue'

function request(
  patch: ChatComposerSelectionPatchRequest['patch'],
  overrides: Partial<ChatComposerSelectionPatchRequest> = {}
): ChatComposerSelectionPatchRequest {
  return {
    chatId: 'chat-1',
    patch,
    provider: 'claude',
    deferProviderScoped: false,
    ...overrides
  }
}

describe('ChatComposerSelectionPatchQueue', () => {
  it('coalesces rapid picker changes into one small latest-value request', async () => {
    const callbacks: Array<() => void> = []
    const persist = vi.fn(async (input: ChatComposerSelectionPatchRequest) => ({
      ok: true as const,
      changed: true,
      chatId: input.chatId,
      revision: 2,
      updatedAt: 2
    }))
    const queue = new ChatComposerSelectionPatchQueue({
      persist,
      schedule: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      cancel: vi.fn()
    })

    queue.enqueue(request({ selectedModelType: 'claude-sonnet-5' }))
    queue.enqueue(request({ selectedModelType: 'claude-opus-5' }))
    queue.enqueue(request({ claudeReasoningEffort: 'high' }))
    callbacks.at(-1)?.()
    await queue.flushAll()

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith(
      request({
        selectedModelType: 'claude-opus-5',
        claudeReasoningEffort: 'high'
      })
    )
  })

  it('retains busy-chat deferral and the first queue timestamp across a batch', async () => {
    const persist = vi.fn(async (input: ChatComposerSelectionPatchRequest) => ({
      ok: true as const,
      changed: true,
      chatId: input.chatId,
      revision: 2,
      updatedAt: 2
    }))
    const queue = new ChatComposerSelectionPatchQueue({ persist, delayMs: 60_000 })
    queue.enqueue(
      request(
        { selectedModelType: 'claude-opus-5' },
        { deferProviderScoped: true, queuedAt: 'first' }
      )
    )
    queue.enqueue(
      request({ claudeReasoningEffort: 'high' }, { deferProviderScoped: true, queuedAt: 'second' })
    )

    await queue.flush('chat-1')

    expect(persist).toHaveBeenCalledWith(
      request(
        {
          selectedModelType: 'claude-opus-5',
          claudeReasoningEffort: 'high'
        },
        { deferProviderScoped: true, queuedAt: 'first' }
      )
    )
    queue.dispose()
  })

  it('keeps immediate and busy-deferred picker patches in separate ordered requests', async () => {
    const persist = vi.fn(async (input: ChatComposerSelectionPatchRequest) => ({
      ok: true as const,
      changed: true,
      chatId: input.chatId,
      revision: 2,
      updatedAt: 2
    }))
    const queue = new ChatComposerSelectionPatchQueue({ persist, delayMs: 60_000 })
    queue.enqueue(request({ permissionPresetId: 'read_only' }))
    queue.enqueue(
      request(
        { selectedModelType: 'claude-opus-5' },
        { deferProviderScoped: true, queuedAt: 'queued' }
      )
    )

    await queue.flushAll()

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[0][0]).toEqual(request({ permissionPresetId: 'read_only' }))
    expect(persist.mock.calls[1][0]).toEqual(
      request(
        { selectedModelType: 'claude-opus-5' },
        { deferProviderScoped: true, queuedAt: 'queued' }
      )
    )
    queue.dispose()
  })

  it('serializes a second batch behind an in-flight request', async () => {
    let releaseFirst: (() => void) | undefined
    const order: string[] = []
    const persist = vi.fn(
      (input: ChatComposerSelectionPatchRequest) =>
        new Promise<{
          ok: true
          changed: true
          chatId: string
          revision: number
          updatedAt: number
        }>((resolve) => {
          const model = String(input.patch.selectedModelType)
          order.push(`start:${model}`)
          const finish = () => {
            order.push(`finish:${model}`)
            resolve({
              ok: true,
              changed: true,
              chatId: input.chatId,
              revision: 2,
              updatedAt: 2
            })
          }
          if (!releaseFirst) releaseFirst = finish
          else finish()
        })
    )
    const queue = new ChatComposerSelectionPatchQueue({ persist, delayMs: 60_000 })
    queue.enqueue(request({ selectedModelType: 'first' }))
    const first = queue.flush('chat-1')
    queue.enqueue(request({ selectedModelType: 'second' }))
    const second = queue.flush('chat-1')

    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start:first'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second'])
    queue.dispose()
  })

  it('reports persistence failures without rejecting the UI queue', async () => {
    const onError = vi.fn()
    const queue = new ChatComposerSelectionPatchQueue({
      persist: vi.fn(async () => {
        throw new Error('offline')
      }),
      onError,
      delayMs: 60_000
    })
    queue.enqueue(request({ selectedModelType: 'claude-opus-5' }))

    await expect(queue.flush('chat-1')).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('chat-1', expect.any(Error))
    queue.dispose()
  })
})
