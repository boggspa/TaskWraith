import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { externalAgentAttribution } from '../shared/messageOrigin'

/**
 * A row that arrived over the local-control socket must reach the receiving
 * agent already saying who sent it. Before this, an outside agent had to write
 * "this is an external message, not a prompt from the user" into its own body
 * by hand, because the prompt rendered it as the operator speaking.
 *
 * The attribution is applied where a stored row becomes a transcript line —
 * the one place every append path already goes through — for the same reason
 * `buildExternalContributionBody` lives there: wrapping at a call site is only
 * as good as the set of call sites someone remembered, and a missed one fails
 * open as raw text in front of a model.
 */
const source = readFileSync(join(process.cwd(), 'src/main/EnsemblePrompt.ts'), 'utf8')

describe('external agent attribution in the ensemble prompt', () => {
  it('renders the attribution at the single point a row becomes a transcript line', () => {
    expect(source).toContain("import { externalAgentAttribution } from '../shared/messageOrigin'")
    // Pinned as one expression so the attribution cannot be reordered behind
    // the untrusted frame, which would put host-derived text inside it.
    expect(source).toContain(
      '    const originAttribution = externalAgentAttribution(message.metadata?.origin)\n' +
        '    const attributedText = originAttribution ? `${originAttribution}\\n${text}` : text'
    )
  })

  it('attributes the ordinary body, never the untrusted-collaborator frame', () => {
    expect(source).toContain(
      '    const body = isExternalUntrustedMessage(message)\n' +
        '      ? buildExternalContributionBody(message, text)\n' +
        '      : traceLines\n' +
        '        ? `${traceLines}\\n${attributedText}`\n' +
        '        : attributedText'
    )
  })

  it('produces the exact line a receiving agent reads', () => {
    expect(
      externalAgentAttribution({ channel: 'local-control', pid: 84536, label: 'Claude Code' })
    ).toBe('[External Agent · Claude Code · PID 84536]')
  })
})
