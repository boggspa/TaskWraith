import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostCliToolCard, HostCliToolInstallButton } from './HostCliToolInstall'

/**
 * Server-rendered coverage for the shared host-CLI setup surface. The codebase
 * has no jsdom, so click paths aren't simulated here — the decision logic that
 * matters (install vs upgrade command, uncovered platforms) is unit-tested in
 * `main/ipc/hostToolTerminalHandlers.test.ts`, where it actually lives.
 */
describe('HostCliToolCard', () => {
  it('reads as installed and names the resolved binary', () => {
    const html = renderToStaticMarkup(
      <HostCliToolCard toolId="gh" presence="present" resolvedPath="/opt/homebrew/bin/gh" />
    )
    expect(html).toContain('GitHub CLI')
    expect(html).toContain('Installed · ready')
    expect(html).toContain('/opt/homebrew/bin/gh')
    // Present ⇒ the action upgrades, never re-installs.
    expect(html).toContain('Upgrade GitHub CLI…')
    expect(html).not.toContain('Install GitHub CLI…')
  })

  it('reads as missing and explains what is degraded', () => {
    const html = renderToStaticMarkup(
      <HostCliToolCard toolId="gh" presence="absent" platform="darwin" />
    )
    expect(html).toContain('Not found · install it')
    expect(html).toContain('Install GitHub CLI…')
    expect(html).toContain('PR status, CI checks, and PR watching stay unavailable')
    expect(html).toContain('brew install gh')
  })

  it('shows the Windows command on Windows', () => {
    const html = renderToStaticMarkup(
      <HostCliToolCard toolId="gh" presence="absent" platform="win32" />
    )
    expect(html).toContain('winget install --id GitHub.cli')
    expect(html).not.toContain('brew install gh')
  })

  it('omits the command row on a platform with no vetted command', () => {
    // Refusing to print a command is the point: a Debian line shown to a Fedora
    // user is worse than no line at all.
    const html = renderToStaticMarkup(
      <HostCliToolCard toolId="gh" presence="absent" platform="linux" />
    )
    expect(html).not.toContain('brew install gh')
    expect(html).not.toContain('winget')
    expect(html).toContain('Install GitHub CLI…')
  })

  it('stays neutral while the presence probe is still pending', () => {
    // 'unknown' must never claim the tool is missing — flashing "not installed"
    // at someone who has it installed is the confusion this work removes.
    const html = renderToStaticMarkup(<HostCliToolCard toolId="gh" presence="unknown" />)
    expect(html).toContain('Checking…')
    expect(html).not.toContain('Not found')
    expect(html).not.toContain('Installed · ready')
  })

  it('marks the tool optional so it never reads as a required provider seat', () => {
    const html = renderToStaticMarkup(<HostCliToolCard toolId="gh" presence="absent" />)
    expect(html).toContain('Optional')
    expect(html).toContain('data-tool="gh"')
  })
})

describe('HostCliToolInstallButton', () => {
  it('labels by installed state', () => {
    expect(renderToStaticMarkup(<HostCliToolInstallButton toolId="gh" />)).toContain(
      'Install GitHub CLI…'
    )
    expect(renderToStaticMarkup(<HostCliToolInstallButton toolId="gh" installed />)).toContain(
      'Upgrade GitHub CLI…'
    )
  })

  it('disables itself when the host exposes no setup bridge', () => {
    // No `window.api` under SSR — the control must render inert rather than
    // offering an action that would silently do nothing.
    expect(renderToStaticMarkup(<HostCliToolInstallButton toolId="gh" />)).toContain('disabled')
  })
})
