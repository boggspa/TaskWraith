import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatRun } from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { RunCard } from './RunCard'

function run(model: string): ChatRun {
  return {
    runId: `pi-${model}`,
    provider: 'pi',
    requestedModel: model,
    status: 'completed',
    startedAt: '2026-07-28T00:00:00.000Z',
    endedAt: '2026-07-28T00:00:01.000Z'
  } as ChatRun
}

describe('RunCard provider accent', () => {
  it('uses every Pi upstream hue for historical run cards', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const modelId = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(modelId, `missing representative Pi model for ${upstream}`).toBeTruthy()

      const html = renderToStaticMarkup(<RunCard run={run(modelId!)} />)
      expect(html).toContain(`run-card-provider provider-${brand.hueClass}`)
    }
  })
})
