import { describe, expect, it } from 'vitest'

import type { ProviderId, RunQueueRequestSnapshot } from '../store/types'
import {
  classifyPreparedSoloSteerPayload,
  hasQualifiedExactFullToolBatchAccelerator,
  type PreparedSoloSteerPayload
} from './SteeringPayloadPolicy'

function request(overrides: Partial<PreparedSoloSteerPayload> = {}): PreparedSoloSteerPayload {
  return {
    imageAttachments: [],
    ...overrides
  }
}

function imageAttachment(path: string): RunQueueRequestSnapshot['imageAttachments'][number] {
  return { path }
}

describe('classifyPreparedSoloSteerPayload', () => {
  it('admits a text-only payload to the provider live-steering router', () => {
    expect(classifyPreparedSoloSteerPayload({ provider: 'pi', request: request() })).toEqual({
      delivery: 'live',
      reason: 'The prepared steer payload contains only live-deliverable text.',
      boundaryAcceleration: 'natural-boundary',
      liveImagePaths: []
    })
  })

  it('allows Codex native turn/steer to carry exact main-verified image paths', () => {
    const verifiedImagePaths = ['/owned/one.png', ' /owned/two.jpg ']
    const decision = classifyPreparedSoloSteerPayload({
      provider: 'codex',
      request: request({
        imageAttachments: [imageAttachment('/durable/one.png'), imageAttachment('/durable/two.jpg')]
      }),
      verifiedImagePaths
    })

    expect(decision).toEqual({
      delivery: 'live',
      reason:
        'codex can deliver the prepared text and verified image paths through its negotiated live steering transport.',
      boundaryAcceleration: 'natural-boundary',
      liveImagePaths: ['/owned/one.png', '/owned/two.jpg']
    })
    expect(decision.liveImagePaths).not.toBe(verifiedImagePaths)
  })

  it.each([
    { label: 'no verified paths', verifiedImagePaths: undefined },
    { label: 'a partial verified set', verifiedImagePaths: ['/owned/one.png'] },
    {
      label: 'an oversized verified set',
      verifiedImagePaths: ['/owned/one.png', '/owned/two.png', '/owned/extra.png']
    },
    { label: 'a blank verified path', verifiedImagePaths: ['/owned/one.png', ' '] }
  ])('keeps Codex images durable when authority supplies $label', ({ verifiedImagePaths }) => {
    const decision = classifyPreparedSoloSteerPayload({
      provider: 'codex',
      request: request({
        imageAttachments: [imageAttachment('/durable/one.png'), imageAttachment('/durable/two.png')]
      }),
      verifiedImagePaths
    })

    expect(decision).toMatchObject({
      delivery: 'durable-boundary',
      boundaryAcceleration: 'natural-boundary',
      liveImagePaths: []
    })
    expect(decision.reason).toMatch(/one verified main-owned path/i)
  })

  it.each(['kimi', 'mistral', 'grok'] as const)(
    'allows %s ACP to negotiate live delivery of the complete verified image set',
    (provider) => {
      const decision = classifyPreparedSoloSteerPayload({
        provider,
        request: request({
          imageAttachments: [
            imageAttachment('/durable/one.png'),
            imageAttachment('/durable/two.jpg')
          ]
        }),
        verifiedImagePaths: ['/owned/one.png', '/owned/two.jpg']
      })

      expect(decision).toMatchObject({
        delivery: 'live',
        boundaryAcceleration: 'exact-full-tool-batch',
        liveImagePaths: ['/owned/one.png', '/owned/two.jpg']
      })
    }
  )

  it.each<{
    provider: ProviderId
    boundaryAcceleration: 'exact-full-tool-batch' | 'natural-boundary'
  }>([
    { provider: 'claude', boundaryAcceleration: 'exact-full-tool-batch' },
    { provider: 'ollama', boundaryAcceleration: 'exact-full-tool-batch' },
    { provider: 'gemini', boundaryAcceleration: 'natural-boundary' },
    { provider: 'pi', boundaryAcceleration: 'natural-boundary' },
    { provider: 'cursor', boundaryAcceleration: 'natural-boundary' },
    { provider: 'muse', boundaryAcceleration: 'natural-boundary' },
    { provider: 'antigravity', boundaryAcceleration: 'natural-boundary' }
  ])(
    'keeps $provider images durable with $boundaryAcceleration fallback',
    ({ provider, boundaryAcceleration }) => {
      const decision = classifyPreparedSoloSteerPayload({
        provider,
        request: request({ imageAttachments: [imageAttachment('/durable/one.png')] }),
        verifiedImagePaths: ['/owned/one.png']
      })

      expect(decision).toMatchObject({
        delivery: 'durable-boundary',
        boundaryAcceleration,
        liveImagePaths: []
      })
      expect(decision.reason).toMatch(/image attachments require durable boundary/i)
    }
  )

  it.each([
    {
      label: 'Discord context',
      override: {
        discordContextSelection: { channelId: 'channel-1', limit: 25 as const }
      }
    },
    {
      label: 'project references',
      override: {
        projectReferenceContextSelection: {
          schemaVersion: 1 as const,
          projectId: 'project-1',
          referenceIds: ['reference-1']
        }
      }
    },
    { label: 'directed participant routing', override: { dmTargetParticipantId: 'seat-1' } },
    { label: 'directed participant routing', override: { exactPickerParticipantId: 'seat-1' } },
    {
      label: 'external path grants',
      override: {
        externalPathGrants: [
          {
            id: 'grant-1',
            provider: 'codex' as const,
            path: '/outside',
            kind: 'directory' as const,
            access: 'read' as const,
            duration: 'thisRun' as const,
            createdAt: '2026-08-26T00:00:00.000Z'
          }
        ]
      }
    }
  ])('keeps Codex $label on the durable boundary', ({ label, override }) => {
    const decision = classifyPreparedSoloSteerPayload({
      provider: 'codex',
      request: request(override)
    })

    expect(decision).toMatchObject({
      delivery: 'durable-boundary',
      boundaryAcceleration: 'natural-boundary',
      liveImagePaths: []
    })
    expect(decision.reason).toContain(label)
  })

  it('never forwards verified Codex images when another structured shape requires a boundary', () => {
    const decision = classifyPreparedSoloSteerPayload({
      provider: 'codex',
      request: request({
        imageAttachments: [imageAttachment('/durable/one.png')],
        discordContextSelection: { channelId: 'channel-1', limit: 10 }
      }),
      verifiedImagePaths: ['/owned/one.png']
    })

    expect(decision.delivery).toBe('durable-boundary')
    expect(decision.liveImagePaths).toEqual([])
    expect(decision.reason).toContain('Discord context')
  })

  it('does not treat empty optional selections as shape-changing content', () => {
    const decision = classifyPreparedSoloSteerPayload({
      provider: 'codex',
      request: request({
        dmTargetParticipantId: ' ',
        exactPickerParticipantId: '',
        projectReferenceContextSelection: {
          schemaVersion: 1,
          projectId: 'project-1',
          referenceIds: []
        },
        externalPathGrants: []
      })
    })

    expect(decision.delivery).toBe('live')
  })

  it('fails closed when prepared request metadata is missing or verified paths are extra', () => {
    expect(
      classifyPreparedSoloSteerPayload({ provider: 'kimi', request: undefined })
    ).toMatchObject({
      delivery: 'durable-boundary',
      boundaryAcceleration: 'exact-full-tool-batch'
    })
    expect(
      classifyPreparedSoloSteerPayload({
        provider: 'codex',
        request: request(),
        verifiedImagePaths: ['/not-in-the-request.png']
      })
    ).toMatchObject({
      delivery: 'durable-boundary',
      liveImagePaths: []
    })
  })
})

describe('hasQualifiedExactFullToolBatchAccelerator', () => {
  it('pins the complete provider matrix', () => {
    const qualified: ProviderId[] = ['claude', 'kimi', 'mistral', 'grok', 'ollama']
    const natural: ProviderId[] = ['gemini', 'codex', 'cursor', 'antigravity', 'pi', 'muse']

    for (const provider of qualified) {
      expect(hasQualifiedExactFullToolBatchAccelerator(provider), provider).toBe(true)
    }
    for (const provider of natural) {
      expect(hasQualifiedExactFullToolBatchAccelerator(provider), provider).toBe(false)
    }
  })
})
