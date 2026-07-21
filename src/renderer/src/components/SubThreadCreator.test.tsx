import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { getProviderLabel } from '../lib/providerLabels'
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

  it('defaults the picked provider to the first non-parent option', () => {
    expect(renderCreator('claude')).toContain('Spawn Codex sub-thread')
    expect(renderCreator('codex')).toContain('Spawn Claude sub-thread')
  })
})
