import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { getProviderLabel } from '../lib/providerLabels'

const configuredSnapshot = vi.hoisted(() => ({ providerIds: [] as string[] }))

vi.mock('../hooks/useConfiguredProviderSnapshot', () => ({
  useConfiguredProviderSnapshot: () => ({
    ready: true,
    providerIds: configuredSnapshot.providerIds
  })
}))

import { SubThreadCreator } from './SubThreadCreator'

function makeParentChat(provider: ProviderId): ChatRecord {
  return {
    appChatId: 'parent-1',
    scope: 'workspace',
    provider,
    title: 'Parent chat',
    workspaceId: 'ws',
    workspacePath: '/repo',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: []
  }
}

function renderCreator(parentProvider: ProviderId = 'claude'): string {
  return renderToStaticMarkup(
    createElement(SubThreadCreator, {
      parentChat: makeParentChat(parentProvider),
      onCreated: () => {},
      onCancel: () => {}
    })
  )
}

describe('SubThreadCreator provider picker', () => {
  beforeEach(() => {
    configuredSnapshot.providerIds = []
  })

  it('offers every live selectable provider as a delegation target', () => {
    const html = renderCreator()
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      expect(html).toContain(`value="${provider}"`)
      expect(html).toContain(getProviderLabel(provider))
    }
  })

  it('does not offer retired providers', () => {
    const html = renderCreator()
    expect(html).not.toContain('value="gemini"')
    expect(html).not.toContain('Gemini')
  })

  it('keeps conditional AntiGravity behind the configured-provider snapshot', () => {
    const html = renderCreator()
    expect(html).not.toContain('value="antigravity"')
    expect(html).not.toContain('AntiGravity')
  })

  it('offers AntiGravity only when the configured-provider snapshot admits it', () => {
    configuredSnapshot.providerIds = ['gemini', 'antigravity']
    const html = renderCreator()
    expect(html).toContain('value="antigravity"')
    expect(html).toContain('AntiGravity')
    expect(html).not.toContain('value="gemini"')
  })

  it('renders an existing AntiGravity parent without treating it as retired', () => {
    const html = renderCreator('antigravity')
    expect(html).toContain('Parent chat')
    expect(html).not.toContain('retired')
  })

  it('defaults the picked provider to the first non-parent option', () => {
    expect(renderCreator('claude')).toContain('Spawn Codex sub-thread')
    expect(renderCreator('codex')).toContain('Spawn Claude sub-thread')
  })
})
