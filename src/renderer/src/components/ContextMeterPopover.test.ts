import { describe, expect, it } from 'vitest'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { contextMeterRowHueClass } from './ContextMeterPopover'

describe('contextMeterRowHueClass', () => {
  it('uses every Pi upstream hue for a model-aware context row', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const modelId = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(modelId, `missing representative Pi model for ${upstream}`).toBeTruthy()
      expect(contextMeterRowHueClass({ provider: 'pi', modelId: modelId! })).toBe(brand.hueClass)
    }
  })

  it('keeps Ollama display-brand and ordinary-provider behavior', () => {
    expect(contextMeterRowHueClass({ provider: 'ollama', modelId: 'qwen3.5:9b' })).toBe('alibaba')
    expect(contextMeterRowHueClass({ provider: 'claude', modelId: 'claude-opus-4-8' })).toBe(
      'claude'
    )
  })
})

describe('ContextMeterPopover Pi surface accents', () => {
  it('keeps the row and solo popover chrome on the upstream hue', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./ContextMeterPopover.tsx', import.meta.url), 'utf8')
    )
    expect(source).toContain('className={`context-meter-row provider-${row.providerClass}')
    expect(source).toContain("'--context-meter-row-accent': accent")
    expect(source).toContain('provider-${popoverProviderClass}')
    expect(source).toContain('data-provider-hue={popoverProviderClass}')
  })
})
