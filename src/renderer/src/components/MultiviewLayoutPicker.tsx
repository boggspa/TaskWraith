import type { ReactElement } from 'react'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import {
  MULTIVIEW_LAYOUT_IDS,
  getMultiviewLayoutSpec,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'
import { ComposerPlusPicker, type ComposerPlusPickerSection } from './ComposerPlusPicker'
import { MultiviewSymbolIcon } from './AppChromeSymbols'

/**
 * A tiny preview of a layout: each pane drawn as a filled rounded rect,
 * derived straight from the layout catalogue's grid-template-areas so the
 * glyph and the real grid can never drift. Returned bare (no span) because
 * ComposerPlusPicker wraps row icons in its own `composer-plus-picker-row-icon`.
 */
export function MultiviewLayoutGlyph({ layout }: { layout: MultiviewLayout }): ReactElement {
  const spec = getMultiviewLayoutSpec(layout)
  const rows = (spec.gridTemplateAreas.match(/"([^"]*)"/g) ?? ['"a"']).map((row) =>
    row.replace(/"/g, '').trim().split(/\s+/)
  )
  const rowCount = rows.length
  const colCount = rows[0].length
  const boxes = new Map<string, { r0: number; c0: number; r1: number; c1: number }>()
  rows.forEach((cols, r) =>
    cols.forEach((name, c) => {
      const box = boxes.get(name)
      if (!box) {
        boxes.set(name, { r0: r, c0: c, r1: r, c1: c })
      } else {
        box.r0 = Math.min(box.r0, r)
        box.c0 = Math.min(box.c0, c)
        box.r1 = Math.max(box.r1, r)
        box.c1 = Math.max(box.c1, c)
      }
    })
  )
  const width = 16
  const height = 14
  const gap = 1.4
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="currentColor" stroke="none">
      {[...boxes.entries()].map(([name, box]) => {
        const x = (box.c0 / colCount) * width + gap / 2
        const y = (box.r0 / rowCount) * height + gap / 2
        const w = ((box.c1 - box.c0 + 1) / colCount) * width - gap
        const h = ((box.r1 - box.r0 + 1) / rowCount) * height - gap
        return <rect key={name} x={x} y={y} width={w} height={h} rx={1.3} opacity={0.85} />
      })}
    </svg>
  )
}

/**
 * Build the single picker section listing every layout. Extracted so the
 * item set (labels, active flag, disabled-when-too-narrow) can be unit-tested
 * without rendering the portal-based picker.
 */
export function buildMultiviewLayoutSections(
  current: MultiviewLayout,
  onSelectLayout: (layout: MultiviewLayout) => void,
  disabledLayouts?: ReadonlySet<MultiviewLayout>
): ComposerPlusPickerSection[] {
  return [
    {
      id: 'multiview-layouts',
      title: 'Multiview layout',
      items: MULTIVIEW_LAYOUT_IDS.map((id) => {
        const spec = getMultiviewLayoutSpec(id)
        return {
          id,
          label: spec.label,
          description: id === 'single' ? 'One chat (default)' : `${spec.paneCount} panes`,
          icon: <MultiviewLayoutGlyph layout={id} />,
          active: current === id,
          disabled: disabledLayouts?.has(id) ?? false,
          onSelect: () => onSelectLayout(id)
        }
      })
    }
  ]
}

export interface MultiviewLayoutPickerProps {
  layout: MultiviewLayout
  onSelectLayout: (layout: MultiviewLayout) => void
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
  /** Layouts that cannot fit the current window width (kept selectable=false). */
  disabledLayouts?: ReadonlySet<MultiviewLayout>
}

export function MultiviewLayoutPicker(props: MultiviewLayoutPickerProps): ReactElement {
  return (
    <ComposerPlusPicker
      provider={props.provider}
      composerStyle={props.composerStyle}
      sections={buildMultiviewLayoutSections(props.layout, props.onSelectLayout, props.disabledLayouts)}
      disabled={props.disabled}
      triggerIcon={<MultiviewSymbolIcon />}
    />
  )
}
