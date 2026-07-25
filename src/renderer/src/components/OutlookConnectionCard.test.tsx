import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OutlookConnectionCard } from './OutlookConnectionCard'

describe('OutlookConnectionCard', () => {
  it('renders the connect form with no account connected', () => {
    const html = renderToStaticMarkup(
      <OutlookConnectionCard initialStatus={{ connected: false, encryptionAvailable: true }} />
    )
    expect(html).toContain('Application (client) ID')
    expect(html).toContain('Connect Microsoft account')
    expect(html).toContain('TaskWraith stores no client secret')
    // Write access is opt-in, and its ceiling is stated up front: drafts
    // only, with no permission to send requested at all.
    expect(html).toContain('Nothing is ever sent')
    expect(html).toContain('never requests permission to send')
    expect(html).toContain('not-available')
  })

  it('shows the device code and directs sign-in to the user browser', () => {
    const html = renderToStaticMarkup(
      <OutlookConnectionCard
        initialStatus={{ connected: false, encryptionAvailable: true }}
        initialPending={{
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://microsoft.com/devicelogin',
          message: 'Enter the code'
        }}
      />
    )
    expect(html).toContain('ABCD-EFGH')
    expect(html).toContain('https://microsoft.com/devicelogin')
    expect(html).toContain('nothing is typed here')
  })

  it('summarizes a read-only connection and offers disconnect', () => {
    const html = renderToStaticMarkup(
      <OutlookConnectionCard
        initialStatus={{
          connected: true,
          encryptionAvailable: true,
          account: 'alice@example.com',
          scopeMode: 'read',
          updatedAt: '2026-07-25T10:00:00.000Z'
        }}
      />
    )
    expect(html).toContain('Connected as alice@example.com')
    expect(html).toContain('read-only')
    expect(html).toContain('since 2026-07-25')
    expect(html).toContain('Disconnect')
  })

  it('labels a write-scoped connection distinctly', () => {
    const html = renderToStaticMarkup(
      <OutlookConnectionCard
        initialStatus={{ connected: true, encryptionAvailable: true, scopeMode: 'write' }}
      />
    )
    expect(html).toContain('read + write')
  })

  it('refuses to connect when credentials cannot be encrypted', () => {
    const html = renderToStaticMarkup(
      <OutlookConnectionCard initialStatus={{ connected: false, encryptionAvailable: false }} />
    )
    expect(html).toContain('cannot encrypt stored credentials')
    expect(html).toContain('plain text')
    // The connect button is present but disabled.
    expect(html).toMatch(/Connect Microsoft account[\s\S]*?<\/button>/)
    expect(html).toContain('disabled')
  })

  it('surfaces an error without leaking internals', () => {
    const html = renderToStaticMarkup(
      <OutlookConnectionCard
        initialStatus={{ connected: false, encryptionAvailable: true }}
        initialError="The sign-in code expired. Try again."
      />
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('The sign-in code expired.')
  })
})
