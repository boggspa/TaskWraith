import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderAccountSummary } from '../../../main/providers/ProviderAccounts'
import {
  ProviderAccountsSection,
  ProviderAccountsSectionView,
  accountStatusVariant,
  primaryAccountLabel,
  type ProviderAccountsSectionViewProps
} from './ProviderAccountsSection'

const work: ProviderAccountSummary = {
  id: 'claude-work-abc123',
  provider: 'claude',
  label: 'Work',
  configDir: '/Users/tester/.claude-work',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  active: true,
  envKey: 'CLAUDE_CONFIG_DIR'
}

const home: ProviderAccountSummary = {
  ...work,
  id: 'claude-home-def456',
  label: 'Home',
  configDir: '/Users/tester/.claude-home',
  active: false
}

function render(overrides: Partial<ProviderAccountsSectionViewProps> = {}): string {
  const props: ProviderAccountsSectionViewProps = {
    provider: 'claude',
    accounts: [work, home],
    authStates: { [work.id]: 'authenticated', [home.id]: 'missing' },
    busy: false,
    error: null,
    showAddForm: false,
    draftLabel: '',
    draftConfigDir: '',
    onToggleAddForm: () => {},
    onDraftLabelChange: () => {},
    onDraftConfigDirChange: () => {},
    onPickFolder: () => {},
    onAdd: () => {},
    onRename: () => {},
    onRemove: () => {},
    onSetActive: () => {},
    onSignIn: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<ProviderAccountsSectionView {...props} />)
}

describe('ProviderAccountsSectionView', () => {
  it('lists the primary plus each account with its status dot, folder, active chip and actions', () => {
    const html = render()
    expect(html).toContain('aria-label="Claude accounts"')
    expect(html).toContain('Accounts <span>(3)</span>')
    expect(html).toContain(`<option value="">${primaryAccountLabel('claude')}</option>`)
    expect(html).toContain(`<option value="${work.id}" selected="">Work</option>`)
    expect(html).toContain(`<option value="${home.id}">Home</option>`)
    expect(html.match(/settings-provider-accounts-row/g)).toHaveLength(2)
    expect(html).toContain('settings-provider-accounts-row is-active')
    expect(html).toContain('settings-provider-auth-status-dot-signed-in')
    expect(html).toContain('settings-provider-auth-status-dot-not-signed-in')
    expect(html).toContain('>Signed in</span>')
    expect(html).toContain('>Not signed in</span>')
    expect(html).toContain('/Users/tester/.claude-work')
    expect(html.match(/settings-provider-accounts-active-chip/g)).toHaveLength(1)
    expect(html.match(/>Sign in…</g)).toHaveLength(2)
    expect(html).toContain('aria-label="Remove Home"')
    expect(html).toContain('CLAUDE_CONFIG_DIR')
  })

  it('shows the add form with a folder chooser for Claude but not for Codex', () => {
    const claude = render({ showAddForm: true, draftLabel: 'Work', draftConfigDir: '' })
    expect(claude).toContain('placeholder="~/.claude-work"')
    expect(claude).toContain('>Choose…<')
    expect(claude).toContain('>Cancel<')
    // A Claude account without a folder cannot be added yet.
    expect(claude).toMatch(/<button[^>]*disabled=""[^>]*>Add<\/button>/)

    const codex = render({
      provider: 'codex',
      accounts: [],
      authStates: {},
      showAddForm: true,
      draftLabel: 'Second'
    })
    expect(codex).toContain('aria-label="Codex accounts"')
    expect(codex).toContain(`<option value="" selected="">${primaryAccountLabel('codex')}</option>`)
    expect(codex).not.toContain('placeholder="~/.claude-work"')
    expect(codex).not.toContain('>Choose…<')
    expect(codex).toMatch(/<button[^>]*type="button"[^>]*>Add<\/button>/)
    expect(codex).not.toMatch(/<button[^>]*disabled=""[^>]*>Add<\/button>/)
    expect(codex).toContain('seats keep running from the primary home')
  })

  it('surfaces a registry error and an unprobed status honestly', () => {
    const html = render({
      error: 'Another Claude account already uses that folder.',
      authStates: {}
    })
    expect(html).toContain('settings-provider-auth-error')
    expect(html).toContain('Another Claude account already uses that folder.')
    expect(html.match(/>Not checked</g)).toHaveLength(2)
    expect(accountStatusVariant(undefined)).toEqual({ dot: 'partial', text: 'Not checked' })
    expect(accountStatusVariant('api-key').dot).toBe('signed-in')
    expect(accountStatusVariant('missing').dot).toBe('not-signed-in')
  })

  it('renders nothing from the shell when the preload bridge is absent (SSR)', () => {
    expect(renderToStaticMarkup(<ProviderAccountsSection provider="claude" />)).toBe('')
  })
})
