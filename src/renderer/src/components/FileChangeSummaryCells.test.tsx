import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DiffFileSummaryOwner } from '../../../main/store/types'
import {
  FileChangeOwnerCell,
  FileChangePathCell,
  fileChangeOwnerLabel,
  fileChangeOwnerTitle,
  filePathTailSegments,
  normalizeFileChangeOwners,
  truncateFilePathFromHead
} from './FileChangeSummaryCells'

describe('file-change owners', () => {
  it('prefers the role for labels, then the provider, then Agent', () => {
    expect(fileChangeOwnerLabel({ provider: 'codex', role: 'Work2' })).toBe('Work2')
    expect(fileChangeOwnerLabel({ provider: 'codex' })).toBe('Codex')
    expect(fileChangeOwnerLabel({ participantId: 'p4' })).toBe('Agent')
    expect(fileChangeOwnerLabel({})).toBe('Agent')
  })

  it('combines provider and role in titles and prefixes a truthy order', () => {
    expect(fileChangeOwnerTitle({ provider: 'codex', role: 'Work2' }, 7)).toBe('#7 Codex / Work2')
    expect(fileChangeOwnerTitle({ provider: 'codex' })).toBe('Codex')
    expect(fileChangeOwnerTitle({ role: 'Reviewer' })).toBe('Reviewer')
    expect(fileChangeOwnerTitle({}, 2)).toBe('#2 Agent')
    expect(fileChangeOwnerTitle({ role: 'Reviewer' }, 0)).toBe('Reviewer')
  })

  it('handles absent and malformed owner collections', () => {
    expect(normalizeFileChangeOwners(undefined)).toEqual([])
    expect(normalizeFileChangeOwners({} as unknown as DiffFileSummaryOwner[])).toEqual([])
  })

  it('filters empty owners while preserving identity, order, and duplicates', () => {
    const provider: DiffFileSummaryOwner = { provider: 'codex' }
    const participant: DiffFileSummaryOwner = { participantId: 'p4' }
    const role: DiffFileSummaryOwner = { role: 'Reviewer' }
    const owners = [null, {}, { order: 3 }, provider, participant, role, provider]
    const result = normalizeFileChangeOwners(owners as DiffFileSummaryOwner[])

    expect(result).toEqual([provider, participant, role, provider])
    expect(result[0]).toBe(provider)
    expect(result[3]).toBe(provider)
    expect(owners).toHaveLength(7)
  })
})

describe('FileChangeOwnerCell', () => {
  it.each([undefined, [], [{}]])('renders an aria-hidden empty cell for %j', (owners) => {
    expect(renderToStaticMarkup(<FileChangeOwnerCell owners={owners} />)).toBe(
      '<span class="file-change-summary-owner is-empty" aria-hidden="true"></span>'
    )
  })

  it('renders one owner with its role, full title, and provider logo', () => {
    const html = renderToStaticMarkup(
      <FileChangeOwnerCell owners={[{ provider: 'codex', role: 'Work2' }]} />
    )

    expect(html).toContain('title="Codex / Work2"')
    expect(html).toContain('class="file-change-summary-owner-label">Work2</span>')
    expect(html).toContain('class="file-change-summary-owner-icon provider-codex"')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).not.toContain('file-change-summary-owner-index')
    expect(html).not.toContain('is-multiple')
  })

  it.each([
    [{ role: 'Reviewer' }, 'Reviewer'],
    [{ participantId: 'p4' }, 'Agent']
  ] as const)('renders an owner without a provider logo: %j', (owner, label) => {
    const html = renderToStaticMarkup(<FileChangeOwnerCell owners={[owner]} />)

    expect(html).toContain('title="' + label + '"')
    expect(html).toContain('class="file-change-summary-owner-label">' + label + '</span>')
    expect(html).not.toContain('file-change-summary-owner-icon')
  })

  it('renders ordered chips with explicit, positional, and zero orders preserved', () => {
    const html = renderToStaticMarkup(
      <FileChangeOwnerCell
        owners={[
          { provider: 'codex', role: 'Work2', order: 7 },
          { participantId: 'p2' },
          { role: 'Reviewer', order: 0 }
        ]}
      />
    )

    expect(html).toContain(
      'class="file-change-summary-owner is-multiple" aria-label="File editors"'
    )
    expect(html.match(/class="file-change-summary-owner-chip"/g)).toHaveLength(3)
    expect(html).toContain('title="#7 Codex / Work2"')
    expect(html).toContain('title="#2 Agent"')
    expect(html).toContain('title="Reviewer"')
    expect(html.match(/class="file-change-summary-owner-index">#[0-9]+<\/span>/g)).toEqual([
      'class="file-change-summary-owner-index">#7</span>',
      'class="file-change-summary-owner-index">#2</span>',
      'class="file-change-summary-owner-index">#0</span>'
    ])
    expect(html).not.toContain('file-change-summary-owner-label')
  })
})

describe('file-change paths', () => {
  it('keeps paths through 44 characters and truncates longer paths from the head', () => {
    expect(truncateFilePathFromHead('')).toBe('')
    expect(truncateFilePathFromHead('x'.repeat(44))).toBe('x'.repeat(44))
    expect(truncateFilePathFromHead('HEAD' + 'z'.repeat(41))).toBe('...' + 'z'.repeat(41))
  })

  it('preserves shallow paths and normalizes deeper Unix and Windows paths', () => {
    expect(filePathTailSegments('')).toBe('')
    expect(filePathTailSegments('file.ts')).toBe('file.ts')
    expect(filePathTailSegments('src/file.ts')).toBe('src/file.ts')
    expect(filePathTailSegments('src\\file.ts')).toBe('src\\file.ts')
    expect(filePathTailSegments('/workspace//src/file.ts')).toBe('.../src/file.ts')
    expect(filePathTailSegments('C:\\workspace\\src\\file.ts')).toBe('.../src/file.ts')
  })

  it('also bounds the tail when the final path segments exceed 44 characters', () => {
    expect(filePathTailSegments('root/dir/' + 'z'.repeat(50))).toBe('...' + 'z'.repeat(41))
  })

  it('renders a full path tooltip and hidden head alongside the shortened tail', () => {
    const html = renderToStaticMarkup(<FileChangePathCell path="/workspace/src/file.ts" />)

    expect(html).toBe(
      '<span class="file-change-summary-path" title="/workspace/src/file.ts">' +
        '<span class="file-change-summary-path-head" aria-hidden="true">/workspace/src/file.ts</span>' +
        '<span class="file-change-summary-path-tail">.../src/file.ts</span></span>'
    )
  })

  it('lets React escape the tooltip and both path labels', () => {
    const html = renderToStaticMarkup(<FileChangePathCell path="src/<draft>&.ts" />)

    expect(html).toContain('title="src/&lt;draft&gt;&amp;.ts"')
    expect(html.match(/>src\/&lt;draft&gt;&amp;\.ts<\/span>/g)).toHaveLength(2)
    expect(html).not.toContain('<draft>')
  })
})
