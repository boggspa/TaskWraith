import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CombinedModelPicker } from '../components/CombinedModelPicker'
import { mergeOllamaModelCatalog } from '../lib/ollamaModelCatalog'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
  'utf8'
).replace(/\r\n/g, '\n')

const HIDE_RULE =
  '.composer-combined-picker-trigger[data-composer-control="model"]\n' +
  '  .composer-combined-picker-trigger-provider-label {\n' +
  '  display: none;\n' +
  '}'
const CLOUD_EXCEPTION =
  '.composer-combined-picker-trigger[data-composer-control="model"]\n' +
  '  .composer-combined-picker-trigger-provider:has(.composer-combined-picker-trigger-cloud-indicator)\n' +
  '  .composer-combined-picker-trigger-provider-label {\n' +
  '  display: inline;\n' +
  '}'

const renderChip = (provider: 'codex' | 'ollama', model: { id: string; label: string }): string =>
  renderToStaticMarkup(
    <CombinedModelPicker
      provider={provider}
      composerStyle="default"
      modelOptions={[model]}
      selectedModelId={model.id}
      onSelectModel={() => undefined}
      reasoningOptions={[]}
      selectedReasoning=""
      onSelectReasoning={() => undefined}
    />
  )

const providerSpanOf = (html: string): string => {
  const start = html.indexOf('class="composer-combined-picker-trigger-provider"')
  const end = html.indexOf('composer-combined-picker-trigger-primary', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe('composer model chip — provider name hidden, Ollama Cloud excepted', () => {
  it('hides the provider name only inside the composer model trigger and only in CSS', () => {
    expect(css).toContain(HIDE_RULE)
    // Every rule that hides the label is the scoped one: nothing hides it for
    // seat-change rows or transcript attribution chips.
    const hideCount =
      css.split('composer-combined-picker-trigger-provider-label {\n  display: none;').length - 1
    expect(hideCount).toBe(1)
    expect(css.indexOf(HIDE_RULE)).toBeGreaterThan(-1)
  })

  it('restores the name when the Ollama Cloud indicator sits beside the logo', () => {
    expect(css).toContain(CLOUD_EXCEPTION)
    expect(css.indexOf(CLOUD_EXCEPTION)).toBeGreaterThan(css.indexOf(HIDE_RULE))
  })

  it('anchors the exception to real markup: only Cloud rows render the indicator inside the provider span', () => {
    const cloud = mergeOllamaModelCatalog([{ id: 'minimax-m3:cloud', label: 'minimax-m3' }]).find(
      (option) => option.id === 'minimax-m3:cloud'
    )!
    const cloudSpan = providerSpanOf(renderChip('ollama', { id: cloud.id, label: cloud.label! }))
    expect(cloudSpan).toContain('composer-combined-picker-trigger-cloud-indicator')
    expect(cloudSpan).toContain('composer-combined-picker-trigger-provider-label">MiniMax<')

    const localSpan = providerSpanOf(
      renderChip('ollama', { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)' })
    )
    expect(localSpan).not.toContain('composer-combined-picker-trigger-cloud-indicator')
    expect(localSpan).toContain('composer-combined-picker-trigger-provider-label">')

    const codexSpan = providerSpanOf(renderChip('codex', { id: 'gpt-5.5', label: 'GPT 5.5' }))
    expect(codexSpan).not.toContain('composer-combined-picker-trigger-cloud-indicator')
    // The label stays in the DOM (hidden by CSS), so assistive tech and the
    // popover keep the provider name.
    expect(codexSpan).toContain('composer-combined-picker-trigger-provider-label">Codex<')
  })
})
