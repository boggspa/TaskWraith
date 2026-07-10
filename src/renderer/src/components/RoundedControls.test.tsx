import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PillCard } from './PillCard'
import { PillButton } from './PillButton'
import { SegmentedControl } from './SegmentedControl'

describe('PillCard', () => {
  it('renders shared outer-rim and inset-capsule chrome on a native button', () => {
    const html = renderToStaticMarkup(
      <PillCard innerClassName="destination-layout" data-destination="files">
        File Editor
      </PillCard>
    )

    expect(html).toContain('type="button"')
    expect(html).toContain('class="pill-card"')
    expect(html).toContain('class="pill-card-inner destination-layout"')
    expect(html).toContain('data-destination="files"')
    expect(html).toContain('>File Editor</span></button>')
  })
})

describe('PillButton', () => {
  it('uses the shared pill chrome, defaults to a button, and preserves its name', () => {
    const html = renderToStaticMarkup(<PillButton>Refresh</PillButton>)

    expect(html).toContain('type="button"')
    expect(html).toContain('class="segmented-control-action"')
    expect(html).toContain('>Refresh</button>')
  })

  it('maps primary, danger, compact, disabled, and loading state to the shared contract', () => {
    const html = renderToStaticMarkup(
      <>
        <PillButton variant="primary" size="compact">Save</PillButton>
        <PillButton variant="danger" loading>Remove</PillButton>
      </>
    )

    expect(html).toContain('segmented-control-action--primary')
    expect(html).toContain('segmented-control-action--compact')
    expect(html).toContain('segmented-control-action--danger')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-loading="true"')
  })
})

describe('SegmentedControl', () => {
  it('renders an accessible controlled radiogroup with one selected segment', () => {
    const onValueChange = vi.fn()
    const html = renderToStaticMarkup(
      <SegmentedControl
        ariaLabel="Theme"
        value="dark"
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' }
        ]}
        onValueChange={onValueChange}
        size="compact"
      />
    )

    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="Theme"')
    expect(html).toContain('segmented-control--compact')
    expect(html).toContain('role="radio"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('is-active')
  })

  it('supports the pressed-button contract for immediate-action controls', () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        ariaLabel="Remote access"
        value="read"
        ariaMode="pressed"
        busy
        disableWhileBusy={false}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'read', label: 'Read' }
        ]}
        onValueChange={() => {}}
      />
    )

    expect(html).toContain('role="group"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('disabled=""')
  })
})
