/**
 * `run-queue-changed` had one recipient while `get-run-queue-jobs` served two
 * kinds of caller. These pin the projection that closes that gap without
 * leaking one chat's queued prompts into another chat's pop-out.
 */
import { describe, expect, it } from 'vitest'

import { runQueueChangedDeliveries } from './runQueueChangedDeliveries'
import type { RunQueueJob } from '../store/types'

function job(id: string, chatId: string): RunQueueJob {
  return { id, chatId, status: 'queued', createdAt: 1 } as unknown as RunQueueJob
}

const JOBS = [job('j1', 'chat-1'), job('j2', 'chat-2'), job('j3', 'chat-1')]

describe('runQueueChangedDeliveries', () => {
  it('gives every main window the whole queue', () => {
    const deliveries = runQueueChangedDeliveries({
      jobs: JOBS,
      mainWindows: ['main-a', 'main-b'],
      popouts: []
    })

    expect(deliveries.map((delivery) => delivery.window)).toEqual(['main-a', 'main-b'])
    expect(deliveries[0].jobs.map((entry) => entry.id)).toEqual(['j1', 'j2', 'j3'])
    expect(deliveries[1].jobs.map((entry) => entry.id)).toEqual(['j1', 'j2', 'j3'])
  })

  it('gives a chat pop-out only its own chat, never a peer chat', () => {
    const deliveries = runQueueChangedDeliveries({
      jobs: JOBS,
      mainWindows: [],
      popouts: [{ window: 'popout-1', kind: 'chat', chatId: 'chat-1' }]
    })

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].window).toBe('popout-1')
    expect(deliveries[0].jobs.map((entry) => entry.id)).toEqual(['j1', 'j3'])
    expect(deliveries[0].jobs.some((entry) => entry.chatId === 'chat-2')).toBe(false)
  })

  it('reaches the main window and each chat pop-out from one emit', () => {
    const deliveries = runQueueChangedDeliveries({
      jobs: JOBS,
      mainWindows: ['main'],
      popouts: [
        { window: 'popout-1', kind: 'chat', chatId: 'chat-1' },
        { window: 'popout-2', kind: 'chat', chatId: 'chat-2' }
      ]
    })

    expect(
      deliveries.map((delivery) => [delivery.window, delivery.jobs.map((entry) => entry.id)])
    ).toEqual([
      ['main', ['j1', 'j2', 'j3']],
      ['popout-1', ['j1', 'j3']],
      ['popout-2', ['j2']]
    ])
  })

  it('is not a recipient at all when the pop-out has no run-queue authority', () => {
    const deliveries = runQueueChangedDeliveries({
      jobs: JOBS,
      mainWindows: [],
      popouts: [
        { window: 'workspace-popout', kind: 'workspace', chatId: 'chat-1' },
        { window: 'chat-popout-without-chat', kind: 'chat', chatId: undefined },
        { window: 'unknown-popout', kind: undefined, chatId: undefined }
      ]
    })

    expect(deliveries).toEqual([])
  })

  it('delivers an empty queue to a chat pop-out whose last job was cancelled', () => {
    const deliveries = runQueueChangedDeliveries({
      jobs: [job('j2', 'chat-2')],
      mainWindows: [],
      popouts: [{ window: 'popout-1', kind: 'chat', chatId: 'chat-1' }]
    })

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].jobs).toEqual([])
  })
})
