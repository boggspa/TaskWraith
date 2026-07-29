import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CliPathDirectoriesEditor } from './CliPathDirectoriesEditor'

/**
 * Server-rendered coverage. No jsdom in this repo, so the add/remove/reorder
 * paths aren't clicked here — their decision logic is `shared/cliPathDirectories`,
 * which is unit-tested directly. What matters at this layer is that the editor
 * shows the user's real, normalized list in their real search order.
 */
describe('CliPathDirectoriesEditor', () => {
  it('lists configured directories in search order', () => {
    const html = renderToStaticMarkup(
      <CliPathDirectoriesEditor value={['/opt/homebrew/bin', '~/.local/bin']} onChange={() => {}} />
    )
    expect(html).toContain('/opt/homebrew/bin')
    expect(html).toContain('~/.local/bin')
    expect(html.indexOf('/opt/homebrew/bin')).toBeLessThan(html.indexOf('~/.local/bin'))
  })

  it('renders no list at all when empty, so the section reads as optional', () => {
    const html = renderToStaticMarkup(<CliPathDirectoriesEditor value={[]} onChange={() => {}} />)
    expect(html).not.toContain('cli-path-editor-list')
    expect(html).toContain('cli-path-editor-add')
    expect(html).toContain('/opt/homebrew/bin') // placeholder example only
  })

  it('drops entries the main-process sanitizer would reject', () => {
    // The editor and the sanitizer share one normalizer; showing a row that
    // cannot persist would be a setting that looks saved and is not.
    const html = renderToStaticMarkup(
      <CliPathDirectoriesEditor value={['relative/bin', '/opt/good/bin', '']} onChange={() => {}} />
    )
    expect(html).toContain('/opt/good/bin')
    expect(html).not.toContain('relative/bin')
  })

  it('disables reordering at the ends of the list', () => {
    const single = renderToStaticMarkup(
      <CliPathDirectoriesEditor value={['/opt/only/bin']} onChange={() => {}} />
    )
    // A one-entry list can move in neither direction.
    expect(single.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('marks the add control unusable until something is typed', () => {
    const html = renderToStaticMarkup(<CliPathDirectoriesEditor value={[]} onChange={() => {}} />)
    expect(html).toContain('disabled')
  })
})
