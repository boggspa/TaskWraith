import { describe, expect, it, vi } from 'vitest'
import { persistAuthorizedProviderSessionMetadata } from './ProviderSessionMetadataPersistenceGate'

describe('persistAuthorizedProviderSessionMetadata', () => {
  it('does not read, save, or publish a delayed CLI session frame without live authority', () => {
    const readCurrent = vi.fn(() => ({ id: 'chat-1' }))
    const buildUpdate = vi.fn((chat: { id: string }) => ({ ...chat, sessionId: 'session-1' }))
    const save = vi.fn()
    const publish = vi.fn()

    expect(
      persistAuthorizedProviderSessionMetadata({
        isAuthorized: () => false,
        readCurrent,
        buildUpdate,
        saveAndPublish: (update) => {
          save(update)
          publish(update)
        }
      })
    ).toBe(false)
    expect(readCurrent).not.toHaveBeenCalled()
    expect(buildUpdate).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('rechecks after building a Kimi session update and commits nothing when authority was lost', () => {
    let checks = 0
    const readCurrent = vi.fn(() => ({ id: 'chat-1' }))
    const buildUpdate = vi.fn((chat: { id: string }) => ({ ...chat, sessionId: 'kimi-session' }))
    const save = vi.fn()
    const publish = vi.fn()

    expect(
      persistAuthorizedProviderSessionMetadata({
        isAuthorized: () => ++checks === 1,
        readCurrent,
        buildUpdate,
        saveAndPublish: (update) => {
          save(update)
          publish(update)
        }
      })
    ).toBe(false)
    expect(readCurrent).toHaveBeenCalledOnce()
    expect(buildUpdate).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(checks).toBe(2)
  })

  it('saves and publishes an update while the exact run remains authorized', () => {
    const isAuthorized = vi.fn(() => true)
    const saveAndPublish = vi.fn()

    expect(
      persistAuthorizedProviderSessionMetadata({
        isAuthorized,
        readCurrent: () => ({ id: 'chat-1' }),
        buildUpdate: (chat) => ({ ...chat, sessionId: 'session-1' }),
        saveAndPublish
      })
    ).toBe(true)
    expect(isAuthorized).toHaveBeenCalledTimes(2)
    expect(saveAndPublish).toHaveBeenCalledOnce()
    expect(saveAndPublish).toHaveBeenCalledWith({ id: 'chat-1', sessionId: 'session-1' })
  })

  it('does not commit when the current record or proposed update no longer exists', () => {
    const saveAndPublish = vi.fn()

    expect(
      persistAuthorizedProviderSessionMetadata({
        isAuthorized: () => true,
        readCurrent: () => null,
        buildUpdate: vi.fn(),
        saveAndPublish
      })
    ).toBe(false)
    expect(
      persistAuthorizedProviderSessionMetadata({
        isAuthorized: () => true,
        readCurrent: () => ({ id: 'chat-1' }),
        buildUpdate: () => null,
        saveAndPublish
      })
    ).toBe(false)
    expect(saveAndPublish).not.toHaveBeenCalled()
  })
})
