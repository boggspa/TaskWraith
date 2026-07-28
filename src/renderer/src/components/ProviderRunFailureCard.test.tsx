import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { ProviderRunFailureCard } from './ProviderRunFailureCard'

function failureMessage(model: string): ChatMessage {
  return {
    id: `failure-${model}`,
    role: 'error',
    content: 'Pi failed',
    timestamp: '2026-07-28T00:00:00.000Z',
    metadata: {
      kind: 'providerRunFailure',
      provider: 'pi',
      model,
      headline: 'Pi failed',
      lines: [{ text: 'upstream error' }]
    }
  } as ChatMessage
}

describe('ProviderRunFailureCard provider accent', () => {
  it('uses every Pi upstream hue from the frozen failed-run model', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const model = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(model, `missing representative Pi model for ${upstream}`).toBeTruthy()
      const html = renderToStaticMarkup(
        <ProviderRunFailureCard message={failureMessage(model!)} onCopy={() => undefined} />
      )

      expect(html).toContain(`provider-run-failure-card provider-${brand.hueClass}`)
      expect(html).not.toContain('provider-run-failure-card provider-pi')
    }
  })
})
