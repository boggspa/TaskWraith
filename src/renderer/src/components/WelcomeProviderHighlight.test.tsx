import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OLLAMA_DISPLAY_BRANDS } from '../../../shared/ollamaBrandTable'
import { PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { WelcomeProviderHighlight } from './WelcomeProviderHighlight'

const expectExclusiveHue = (html: string, hueClass: string, seatClass: string): void => {
  const color = `var(--provider-${hueClass}-color, var(--accent))`

  expect(html).toContain(`class="workspace-name-glow provider-${hueClass}"`)
  expect(html).toContain(`data-welcome-provider-hue="${hueClass}"`)
  expect(html).toContain(`--welcome-provider-color:${color}`)
  expect(html).toContain(`--workspace-name-glow-color:${color}`)
  expect(html).not.toContain(`var(--provider-${seatClass}-color`)
}

describe('WelcomeProviderHighlight', () => {
  it.each(
    OLLAMA_DISPLAY_BRANDS.map((brand) => [
      brand.providerLabel,
      brand.providerClass,
      brand.needles[0]
    ])
  )('gives the Ollama %s spoof its exclusive %s hue', (_label, hueClass, modelId) => {
    const html = renderToStaticMarkup(
      <WelcomeProviderHighlight provider="ollama" modelId={modelId}>
        Welcome
      </WelcomeProviderHighlight>
    )

    expectExclusiveHue(html, hueClass, 'ollama')
  })

  it.each(
    Object.entries(PI_UPSTREAM_BRANDS).map(([upstream, brand]) => [
      brand.label,
      brand.hueClass,
      `${upstream}/test-model`
    ])
  )('gives the Pi %s spoof its exclusive %s hue', (_label, hueClass, modelId) => {
    const html = renderToStaticMarkup(
      <WelcomeProviderHighlight provider="pi" modelId={modelId}>
        Welcome
      </WelcomeProviderHighlight>
    )

    expectExclusiveHue(html, hueClass, 'pi')
  })

  it.each([
    ['ollama', 'unknown-local-model'],
    ['pi', 'unknown-upstream/model']
  ])('falls an unknown %s model back to its seat hue', (provider, modelId) => {
    const html = renderToStaticMarkup(
      <WelcomeProviderHighlight provider={provider} modelId={modelId}>
        Welcome
      </WelcomeProviderHighlight>
    )

    expect(html).toContain(`class="workspace-name-glow provider-${provider}"`)
    expect(html).toContain(
      `--welcome-provider-color:var(--provider-${provider}-color, var(--accent))`
    )
  })
})
