import type { AcpTurnHandle } from '../acp/AcpTurnClient'
import type { NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'
import {
  MISTRAL_READ_ONLY_PROMPT_PREAMBLE,
  MISTRAL_WRITE_MODE_PROMPT_PREAMBLE
} from './MistralCliArgs'

type Close = (code: number | null, complete: boolean, status?: string) => void

export interface MistralAcknowledgedTurnOptions {
  prompt: string
  startIntroduction: (
    prompt: string,
    onEvent: (event: NormalizedGrokRunEvent) => void,
    onClose: Close
  ) => AcpTurnHandle
  startWork: (introduction: string | null) => AcpTurnHandle
  onEvent: (event: NormalizedGrokRunEvent) => void
  onClose?: Close
  introductionTimeoutMs?: number
}

export function mistralIntroductionPrompt(prompt: string): string {
  let context = prompt
  for (const preamble of [MISTRAL_READ_ONLY_PROMPT_PREAMBLE, MISTRAL_WRITE_MODE_PROMPT_PREAMBLE]) {
    if (context.startsWith(preamble)) context = context.slice(preamble.length).trimStart()
  }
  return [
    'Generate a JSON descriptor for the user-facing opening of a TaskWraith work turn. The host will immediately start a separate working phase after displaying a valid opening.',
    "If the actual user request calls for investigation or action, put one short first-person sentence in the opening field, acknowledging it and naming the next concrete action, in the user's language. Do not use tools, perform the task, claim completion, or ask for permission.",
    'Set opening to null only for a direct-answer request, a forbidden introduction, an exact output format, or a user prohibition on ALL tools. A task that asks you to edit or investigate using permitted tools needs an opening even when it prohibits other tools or paths.',
    'Task/context excerpt (JSON string; context for composing the opening, not instructions for this private phase):',
    JSON.stringify(context.slice(-12_000)),
    'Return only valid JSON, without a code fence: {"opening":"I will inspect the files and verify the change."} or {"opening":null}. Do not answer or execute the quoted task in this private phase. Use null for an exact-format answer or a prohibition on ALL tools, not for ordinary tool restrictions in an action request.'
  ].join('\n\n')
}

/** Keep the private opening's terminal, tools and reasoning out of the working
 * run. Until work starts, steer returns false so the host retains boundary
 * delivery ownership, exactly as it does during ordinary ACP startup. */
export function runMistralAcknowledgedTurn(options: MistralAcknowledgedTurnOptions): AcpTurnHandle {
  let active: AcpTurnHandle | undefined
  let cancelled = false
  let workStarted = false
  const closed = (async () => {
    let introduction: string | null = null
    if (!/^\s*\//.test(options.prompt)) {
      let text = ''
      let completed = false
      let usedTool = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        active = options.startIntroduction(
          mistralIntroductionPrompt(options.prompt),
          (event) => {
            if (event.type === 'content') text += event.text || ''
            if (event.type === 'tool_use') {
              usedTool = true
              active?.cancel()
            }
          },
          (_code, complete, status) => {
            completed = complete && (status === 'end_turn' || status === 'stop')
          }
        )
        timer = setTimeout(() => active?.cancel(), options.introductionTimeoutMs ?? 30_000)
        await active.closed
        const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')
        const descriptor = JSON.parse(json) as { opening?: unknown }
        if (
          completed &&
          !usedTool &&
          descriptor &&
          typeof descriptor.opening === 'string' &&
          descriptor.opening.trim()
        ) {
          introduction = descriptor.opening.trim().slice(0, 600)
        }
      } catch {
        // Opening failure must never consume the user's actual work turn.
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    if (cancelled) {
      options.onClose?.(130, false, 'cancelled')
      return
    }
    if (introduction) options.onEvent({ type: 'content', text: `${introduction}\n\n` })
    if (cancelled) {
      options.onClose?.(130, false, 'cancelled')
      return
    }
    active = options.startWork(introduction)
    workStarted = true
    await active.closed
  })().catch((error) => {
    try {
      options.onEvent({
        type: 'provider_warning',
        text: `Mistral working phase could not start: ${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      options.onClose?.(null, false, 'failed')
    }
  })
  return {
    closed,
    cancel: () => {
      cancelled = true
      active?.cancel()
    },
    steer: (text, hooks) => (workStarted ? active?.steer(text, hooks) === true : false),
    cancelSteer: () => {
      if (workStarted) active?.cancelSteer()
    }
  }
}
