import { describe, expect, it } from 'vitest'
import { externalAgentAttribution } from '../shared/messageOrigin'
import { wrapExternalContribution } from './collaboration/ExternalContributionContext'
import { projectTaggedTranscript } from './prompt/EnsemblePromptHistoryProjection'
import type { ChatMessage, ToolActivity } from './store/types'

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
const origin = { channel: 'local-control' as const, pid: 84536, label: 'Claude Code' }
const trace: ToolActivity = {
  id: 'read-receipt',
  toolName: 'read_file',
  displayName: 'Read file',
  category: 'read',
  status: 'success'
}
const message: ChatMessage = {
  id: 'external-agent-direction',
  role: 'user',
  content: 'Check the build.',
  timestamp: '2026-09-24T00:00:00.000Z',
  metadata: { origin }
}

describe('external agent attribution in the ensemble prompt', () => {
  it('renders the attribution at the single point a row becomes a transcript line', () => {
    expect(projectTaggedTranscript([message], 6).text).toBe(
      '[User]\n[External Agent · Claude Code · PID 84536]\nCheck the build.'
    )
  })

  it('retains attribution after the ordinary tool trace', () => {
    expect(projectTaggedTranscript([{ ...message, toolActivities: [trace] }], 6).text).toBe(
      '[User]\n(tools: read_file)\n[External Agent · Claude Code · PID 84536]\nCheck the build.'
    )
  })

  it('attributes the ordinary body, never the untrusted-collaborator frame', () => {
    const untrusted: ChatMessage = {
      ...message,
      toolActivities: [trace],
      metadata: { origin, sourceTrust: 'external_untrusted', collaboratorDisplayName: 'Guest' }
    }
    const text = projectTaggedTranscript([untrusted], 6).text
    expect(text).toBe(
      '[External collaborator (untrusted, not the host)]\n' +
        wrapExternalContribution(message.content, {
          senderDisplayName: 'Guest',
          messageId: message.id,
          timestamp: message.timestamp,
          review: 'auto-appended'
        })
    )
    expect(text).not.toContain(externalAgentAttribution(origin))
  })

  it('produces the exact line a receiving agent reads', () => {
    expect(
      externalAgentAttribution({ channel: 'local-control', pid: 84536, label: 'Claude Code' })
    ).toBe('[External Agent · Claude Code · PID 84536]')
  })
})
