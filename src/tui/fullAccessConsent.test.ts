import { describe, expect, it } from 'vitest'

import {
  HostPermissionConsentAuthority,
  type HostPermissionConsentProofRequest
} from '../host-runtime/HostPermissionConsent'
import type { HostProviderOffersProjection } from '../shared/hostSetupProtocol'
import { buildThreadConfigureCommand } from './hostCommandFlow'
import {
  createTuiFullAccessPresence,
  projectTuiFullAccessPresence,
  type TuiFullAccessHostProcessBinding
} from './fullAccessConsent'

const BINDING: TuiFullAccessHostProcessBinding = {
  pid: 4242,
  startedAt: '2026-08-30T00:00:00.000Z',
  hostId: 'host-1',
  hostVersion: 'node-host-v1'
}

function fullAccessCommand() {
  return buildThreadConfigureCommand({
    actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' },
    selection: {
      threadId: 'thread-1',
      providerId: 'codex',
      modelId: 'gpt-5.6-terra',
      postureId: 'full_access',
      offerRevision: 'offer-1',
      postureConsent: true
    },
    commandId: 'a83cc79d-4365-47f2-9140-2bc6648912c1',
    idempotencyKey: 'tui-1:a83cc79d-4365-47f2-9140-2bc6648912c1'
  })
}

describe('TUI Full Access user presence', () => {
  it('binds an exact already-minted configure proof while hiding its copied secret', () => {
    const source = Buffer.alloc(32, 7)
    const verifierSecret = Buffer.from(source)
    const presence = createTuiFullAccessPresence(source, BINDING)
    source.fill(0)

    expect(
      presence.matches({
        pid: BINDING.pid,
        startedAt: BINDING.startedAt,
        hostId: BINDING.hostId,
        hostVersion: BINDING.hostVersion
      })
    ).toBe(true)
    const command = fullAccessCommand()
    const authorized = presence.authorizeConfigure(command)
    expect(authorized).not.toBe(command)
    expect(authorized.commandId).toBe(command.commandId)
    expect(authorized.idempotencyKey).toBe(command.idempotencyKey)
    expect(authorized.issuedAt).toBe(command.issuedAt)
    expect(command.arguments.postureConsentProof).toBeUndefined()

    const request: HostPermissionConsentProofRequest = {
      commandId: authorized.commandId,
      actor: authorized.actor,
      threadId: authorized.target.threadId,
      providerId: authorized.arguments.providerId as string,
      modelId: authorized.arguments.modelId as string,
      postureId: 'full_access',
      offerRevision: authorized.arguments.offerRevision as string,
      issuedAt: authorized.issuedAt
    }
    const verifier = new HostPermissionConsentAuthority(verifierSecret)
    expect(verifier.verifyRequestProof(request, authorized.arguments.postureConsentProof)).toBe(
      true
    )
    expect(verifier.verifyRequestProof(request, authorized.arguments.postureConsentProof)).toBe(
      false
    )
    verifier.dispose()
    verifierSecret.fill(0)
    presence.dispose()
  })

  it('rejects a mismatched Host process, lower postures, and use after disposal', () => {
    const presence = createTuiFullAccessPresence(Buffer.alloc(32, 3), BINDING)
    expect(presence.matches({ ...BINDING, pid: BINDING.pid + 1 })).toBe(false)
    const lower = buildThreadConfigureCommand({
      actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' },
      selection: {
        threadId: 'thread-1',
        providerId: 'codex',
        modelId: 'gpt-5.6-terra',
        postureId: 'workspace_write',
        offerRevision: 'offer-1',
        postureConsent: true
      }
    })
    expect(() => presence.authorizeConfigure(lower)).toThrow(/exact consented configure/)
    presence.dispose()
    expect(() => presence.authorizeConfigure(fullAccessCommand())).toThrow(/no longer active/)
  })

  it('preserves dynamic offers and narrows only an otherwise available Full Access row', () => {
    const offers: HostProviderOffersProjection = {
      providerId: 'ollama',
      offerRevision: 'dynamic-cloud-revision',
      models: [
        {
          modelId: 'minimax-m3:cloud',
          label: 'MiniMax M3 (Ollama Cloud)',
          available: true,
          reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
        }
      ],
      postures: [
        {
          postureId: 'default',
          label: 'Accept Edits',
          available: true,
          requiresExplicitConsent: false,
          ceiling: 'workspace_write'
        },
        {
          postureId: 'full_access',
          label: 'Full Access (YOLO)',
          available: true,
          requiresExplicitConsent: true,
          ceiling: 'full_access',
          detail: 'Host transport proof'
        }
      ]
    }

    const projected = projectTuiFullAccessPresence(offers, false)
    expect(projected.offerRevision).toBe(offers.offerRevision)
    expect(projected.models).toEqual(offers.models)
    expect(projected.postures).toEqual([
      offers.postures[0],
      expect.objectContaining({
        postureId: 'full_access',
        available: false,
        detail: expect.stringContaining('fresh standalone Host')
      })
    ])
    expect(projectTuiFullAccessPresence(offers, true)).toBe(offers)
  })
})
