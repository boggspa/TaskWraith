/**
 * RunExecutionErrorCard tests.
 *
 * The load-bearing assertions are the copy split: the calm surface title a
 * person reads ("The Host is currently offline") and the untouched raw error
 * behind the disclosure must BOTH come out of the same message. Calm without
 * the raw string would be hiding evidence; raw without the calm copy is the
 * red pill this card replaces.
 *
 * No DOM: `renderToStaticMarkup` per the HostStatusRow.test.tsx pattern. The
 * pure model carries every decision, so most assertions need no React at all.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '../../../main/store/types'
import type { HostLifecycleSnapshot } from '../../../shared/hostLifecycle'
import { RunExecutionErrorCard, RunExecutionErrorCardView } from './RunExecutionErrorCard'
import {
  classifyRunError,
  describeProviderRunFailureMessage,
  describeRunError,
  describeRunErrorHostControl,
  hostActionPrompt,
  RETRYABLE_RUN_KINDS
} from './RunExecutionErrorCardModel'

const HOST_ERROR =
  "Run execution failed unexpectedly: Error: Error invoking remote method 'run-ensemble-round': HostThreadRecordPersistError: Host projection transport error: host_unavailable"

const GENERIC_ERROR = 'Run execution failed unexpectedly: Error: socket hang up'

function message(content: string): ChatMessage {
  return { id: 'm1', role: 'error', content, timestamp: '2026-09-19T00:25:00.000Z' }
}

function failureMessage(overrides: {
  headline?: string
  exitCode?: number
  lines?: string[]
  hint?: string
  provider?: string
  participantId?: string
}): ChatMessage {
  return {
    id: 'm-fail',
    role: 'error',
    content: '',
    timestamp: '2026-09-11T17:41:23.696Z',
    metadata: {
      kind: 'providerRunFailure',
      ...(overrides.provider ? { provider: overrides.provider } : {}),
      ...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
      failureAt: '2026-09-11T17:41:23.696Z',
      headline: overrides.headline ?? 'Muse failed · exit 1',
      lines: (overrides.lines ?? []).map((text) => ({ text })),
      ...(overrides.hint ? { hint: overrides.hint } : {}),
      ...(overrides.participantId ? { ensembleParticipantId: overrides.participantId } : {})
    }
  }
}

function lifecycle(overrides: Partial<HostLifecycleSnapshot> = {}): HostLifecycleSnapshot {
  return {
    revision: 1,
    phase: 'stopped',
    desired: 'stopped',
    reason: 'user-stop',
    changedAt: '2026-09-19T00:20:00.000Z',
    ...overrides
  }
}

describe('classifyRunError', () => {
  it('classifies the run-ensemble-round host outage as host-unavailable', () => {
    expect(classifyRunError(HOST_ERROR)).toBe('host-unavailable')
  })

  it('matches host markers case-insensitively through any prefix', () => {
    expect(classifyRunError('Failed to start Mistral: Error: HOST_UNAVAILABLE')).toBe(
      'host-unavailable'
    )
    expect(classifyRunError('host projection transport error: boom')).toBe('host-unavailable')
  })

  it('leaves unrelated failures as run-failed', () => {
    expect(classifyRunError(GENERIC_ERROR)).toBe('run-failed')
    expect(classifyRunError('')).toBe('run-failed')
  })

  it('classifies auth and usage-limit failures to their own kinds', () => {
    expect(classifyRunError('Failed to start Codex: Error: HTTP error: 401 Unauthorized')).toBe(
      'auth-required'
    )
    expect(classifyRunError('Failed to start Mistral: Error: 429 rate_limit_reached_error')).toBe(
      'usage-limited'
    )
  })

  it('keeps host outages dominant over remedy markers', () => {
    expect(classifyRunError(`${HOST_ERROR} 429`)).toBe('host-unavailable')
  })

  it('classifies retired models and dispatch failures to their own kinds', () => {
    expect(
      classifyRunError(
        'Failed to start Codex: gpt-5.3-codex-spark was retired on 2026-09-18. Choose an active Codex model to continue.'
      )
    ).toBe('model-retired')
    expect(classifyRunError('Failed to start Kimi: spawn kimi ENOENT')).toBe('missing-cli')
    expect(
      classifyRunError('Run execution failed unexpectedly: Error: connect ECONNREFUSED 10.0.0.1')
    ).toBe('network-issue')
  })

  it('classifies the catalogue indexing race', () => {
    expect(
      classifyRunError(
        "Run execution failed unexpectedly: Error: Error invoking remote method 'thread-catalogue:read': ThreadCatalogueRequestError: History changed during indexing."
      )
    ).toBe('catalogue-reindexing')
    expect(RETRYABLE_RUN_KINDS.has('catalogue-reindexing')).toBe(true)
    expect(RETRYABLE_RUN_KINDS.has('auth-required')).toBe(false)
    expect(RETRYABLE_RUN_KINDS.has('host-unavailable')).toBe(false)
  })
})

describe('describeRunError', () => {
  it('pairs the calm Host-offline copy with the untouched raw string', () => {
    const description = describeRunError(HOST_ERROR)
    expect(description.kind).toBe('host-unavailable')
    expect(description.title).toBe('The Host is currently offline')
    expect(description.kicker).toBe('Run error')
    expect(description.body).toContain('conversation is intact')
    expect(description.raw).toBe(HOST_ERROR)
  })

  it('gives generic failures calm copy without promising Host context', () => {
    const description = describeRunError(GENERIC_ERROR)
    expect(description.kind).toBe('run-failed')
    expect(description.title).toBe('The run stopped unexpectedly')
    expect(description.body).not.toContain('Host')
    expect(description.raw).toBe(GENERIC_ERROR)
  })
})

describe('hostActionPrompt', () => {
  it('asks the restart question while Host is down', () => {
    expect(hostActionPrompt('stopped')).toBe('Would you like to restart the Host?')
    expect(hostActionPrompt(undefined)).toBe('Would you like to restart the Host?')
  })

  it('tracks the restart through the lifecycle phases', () => {
    expect(hostActionPrompt('starting')).toBe('Restarting the Host…')
    expect(hostActionPrompt('running')).toBe('Host is running again — you can retry your run.')
    expect(hostActionPrompt('failed')).toBe(
      'The Host did not start cleanly. Would you like to try again?'
    )
  })
})

describe('describeRunErrorHostControl', () => {
  it('relabels the shared start action as Restart Host', () => {
    const control = describeRunErrorHostControl(lifecycle())
    expect(control.action).toBe('start')
    expect(control.actionLabel).toBe('Restart Host')
    expect(control.disabled).toBe(false)
  })

  it('keeps the shared stop action and label while running', () => {
    const control = describeRunErrorHostControl(lifecycle({ phase: 'running', desired: 'running' }))
    expect(control.action).toBe('stop')
    expect(control.actionLabel).toBe('Stop Host')
  })

  it('disables the button while starting', () => {
    const control = describeRunErrorHostControl(
      lifecycle({ phase: 'starting', desired: 'running', reason: 'user-start' })
    )
    expect(control.actionLabel).toBe('Starting…')
    expect(control.disabled).toBe(true)
  })

  it('disables the control when no lifecycle snapshot has arrived', () => {
    const control = describeRunErrorHostControl(null)
    expect(control.action).toBeUndefined()
    expect(control.disabled).toBe(true)
  })
})

describe('RunExecutionErrorCardView', () => {
  it('renders the calm surface and keeps the raw error in the disclosure', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCardView
        description={describeRunError(HOST_ERROR)}
        hostControl={describeRunErrorHostControl(lifecycle())}
        hostPrompt={hostActionPrompt('stopped')}
        onHostAction={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('The Host is currently offline')
    expect(html).toContain('Would you like to restart the Host?')
    expect(html).toContain('Restart Host')
    expect(html).toContain('Technical details')
    expect(html).toContain('host_unavailable')
    expect(html).toContain('Copy details')
  })

  it('labels the restart button with how long the Host lives under leases', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCardView
        description={describeRunError(HOST_ERROR)}
        hostControl={describeRunErrorHostControl(lifecycle())}
        hostPrompt={hostActionPrompt('stopped')}
        onHostAction={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain(
      'aria-label="Restart Host. The Host runs while TaskWraith or a TUI holds it, and stops about 45 s after the last one leaves, once live work drains."'
    )
    // The Host outlives the window now; the no-daemon promise must not come back.
    expect(html).not.toContain('only while TaskWraith is open')
  })

  it('shows Copied feedback on the copy button', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCardView
        description={describeRunError(HOST_ERROR)}
        onCopy={() => undefined}
        copied
      />
    )
    expect(html).toContain('Copied')
  })

  it('omits the restart row entirely for generic failures', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCardView
        description={describeRunError(GENERIC_ERROR)}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('The run stopped unexpectedly')
    expect(html).not.toContain('Restart Host')
    expect(html).not.toContain('run-error-card-question')
  })

  it('renders the auth remedy with a login button and guidance', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCardView
        description={describeRunError('Failed to start Codex: Error: HTTP error: 401 Unauthorized')}
        loginLabel="Log in to Codex"
        onLogin={() => undefined}
        remedyNote="This looks like a sign-in problem — re-authenticate, then retry."
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('Codex needs you to sign in again')
    expect(html).toContain('Log in to Codex')
    expect(html).toContain('re-authenticate, then retry')
    expect(html).not.toContain('Restart Host')
    expect(html).toContain('Technical details')
  })

  it('renders the usage-limit remedy with swap guidance', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCardView
        description={describeRunError(
          'Failed to start Mistral: Error: 429 rate_limit_reached_error'
        )}
        remedyNote="Swap the model in the composer below, or wait for the limit to reset, then retry."
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('Mistral hit a usage limit')
    expect(html).toContain('Swap the model')
    expect(html).not.toContain('Log in to')
  })
})

describe('RunExecutionErrorCard', () => {
  it('renders the host restart row in its pre-fetch checking state', () => {
    // Static markup runs no effects, so the injected client is never queried:
    // the honest render is a disabled control, not an invented Host state.
    const client = {
      subscribe: vi.fn(() => () => undefined),
      status: vi.fn(),
      set: vi.fn()
    }
    const html = renderToStaticMarkup(
      <RunExecutionErrorCard
        message={message(HOST_ERROR)}
        onCopy={() => undefined}
        lifecycleClient={client as never}
      />
    )
    expect(html).toContain('The Host is currently offline')
    expect(html).toContain('Would you like to restart the Host?')
  })

  it('never mounts the lifecycle row for generic failures', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCard message={message(GENERIC_ERROR)} onCopy={() => undefined} />
    )
    expect(html).toContain('The run stopped unexpectedly')
    expect(html).not.toContain('host-lifecycle-toggle')
  })

  it('renders providerRunFailure metadata through the same card', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCard
        message={failureMessage({
          provider: 'codex',
          headline: 'Codex failed · exit 1',
          lines: ['HTTP error: 403 Forbidden']
        })}
        onCopy={() => undefined}
      />
    )
    expect(html).toContain('Codex needs you to sign in again')
    expect(html).toContain('Log in to Codex')
    expect(html).toContain('Technical details')
    expect(html).toContain('403 Forbidden')
  })

  it('offers seat Retry when the failure names an ensemble participant', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCard
        message={failureMessage({ provider: 'muse', participantId: 'p3' })}
        onCopy={() => undefined}
        onRetryParticipant={(_participantId: string) => ({ ok: false as const, reason: 'no' })}
      />
    )
    expect(html).toContain('Retry')
  })

  it('renders the message timestamp like every other transcript row', () => {
    const html = renderToStaticMarkup(
      <RunExecutionErrorCard message={message(GENERIC_ERROR)} onCopy={() => undefined} />
    )
    expect(html).toContain('run-error-card-time')
    expect(html).toContain('2026-09-19T00:25:00.000Z')
  })

  it('offers Retry run for transient kinds and gates it off for remedy-first kinds', () => {
    const transient = renderToStaticMarkup(
      <RunExecutionErrorCard
        message={message(
          "Run execution failed unexpectedly: Error: Error invoking remote method 'thread-catalogue:read': ThreadCatalogueRequestError: History changed during indexing."
        )}
        onCopy={() => undefined}
        onRetryRun={() => undefined}
      />
    )
    expect(transient).toContain('A background refresh interrupted this run')
    expect(transient).toContain('Retry run')

    const auth = renderToStaticMarkup(
      <RunExecutionErrorCard
        message={message('Failed to start Codex: Error: HTTP error: 401 Unauthorized')}
        onCopy={() => undefined}
        onRetryRun={() => undefined}
      />
    )
    expect(auth).not.toContain('Retry run')
    expect(auth).toContain('Log in to Codex')
  })
})

describe('describeProviderRunFailureMessage', () => {
  it('voices interrupted runs calmly, with the hint as the note', () => {
    const description = describeProviderRunFailureMessage(
      failureMessage({
        provider: 'muse',
        headline: 'Muse run interrupted',
        hint: 'No result will arrive for this run. Re-send the prompt to try again.'
      })
    )
    expect(description.kind).toBe('run-interrupted')
    expect(description.title).toBe('Muse was interrupted')
    expect(description.note).toBe(
      'No result will arrive for this run. Re-send the prompt to try again.'
    )
    expect(description.raw).toContain('Muse run interrupted')
  })

  it('classifies quota walls from the stderr lines', () => {
    const description = describeProviderRunFailureMessage(
      failureMessage({
        provider: 'codex',
        headline: 'Codex failed · exit 1',
        lines: ["You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"]
      })
    )
    expect(description.kind).toBe('usage-limited')
    expect(description.title).toBe('Codex hit a usage limit')
    expect(description.provider).toBe('codex')
  })

  it('keeps the Host restart remedy when a provider exit carries host_unavailable', () => {
    const description = describeProviderRunFailureMessage(
      failureMessage({
        provider: 'kimi',
        headline: 'Kimi failed · exit 1',
        lines: ['Host projection transport error: host_unavailable']
      })
    )
    expect(description.kind).toBe('host-unavailable')
    expect(description.title).toBe('The Host is currently offline')
  })

  it('falls back to the generic run copy when nothing classifies', () => {
    const description = describeProviderRunFailureMessage(
      failureMessage({ headline: 'Muse failed · exit 1', lines: ['segfault'] })
    )
    expect(description.kind).toBe('run-failed')
    expect(description.title).toBe('The run stopped unexpectedly')
  })
})
