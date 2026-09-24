import { describe, expect, it, vi } from 'vitest'
import type { AcpTurnHandle } from '../acp/AcpTurnClient'
import type { NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'
import { MISTRAL_WRITE_MODE_PROMPT_PREAMBLE } from './MistralCliArgs'
import {
  mistralIntroductionPrompt,
  runMistralAcknowledgedTurn,
  type MistralAcknowledgedTurnOptions
} from './MistralIntroduction'

function controlledHandle() {
  let finish!: () => void
  const closed = new Promise<void>((resolve) => {
    finish = resolve
  })
  const handle: AcpTurnHandle = {
    closed,
    cancel: vi.fn(finish),
    steer: vi.fn(() => true),
    cancelSteer: vi.fn()
  }
  return { handle, finish }
}

function fixture() {
  const intro = controlledHandle()
  const work = controlledHandle()
  let introEvent!: Parameters<MistralAcknowledgedTurnOptions['startIntroduction']>[1]
  let introClose!: Parameters<MistralAcknowledgedTurnOptions['startIntroduction']>[2]
  const events: NormalizedGrokRunEvent[] = []
  const onClose = vi.fn()
  const startWork = vi.fn(() => work.handle)
  const options: MistralAcknowledgedTurnOptions = {
    prompt: 'Read the code, implement the fix, and verify it.',
    startIntroduction: (_prompt, onEvent, onEnd) => {
      introEvent = onEvent
      introClose = onEnd
      return intro.handle
    },
    startWork,
    onEvent: (event) => events.push(event),
    onClose
  }
  return {
    intro,
    work,
    events,
    onClose,
    startWork,
    options,
    introEvent: (event: NormalizedGrokRunEvent) => introEvent(event),
    completeRawIntro: (text: string) => {
      introEvent({ type: 'content', text })
      introClose(0, true, 'end_turn')
      intro.finish()
    },
    completeIntro: (text: string, status = 'end_turn') => {
      introEvent({
        type: 'content',
        text: JSON.stringify({ opening: text === 'NO_OPENING' ? null : text })
      })
      introClose(0, true, status)
      intro.finish()
    }
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('Mistral private acknowledgement lifecycle', () => {
  it.each(['READY', 'null', '{"opening":null}'])(
    'does not expose a private direct answer or absent opening: %s',
    async (text) => {
      const f = fixture()
      const handle = runMistralAcknowledgedTurn(f.options)
      f.completeRawIntro(text)
      await tick()
      expect(f.events).toEqual([])
      expect(f.startWork).toHaveBeenCalledExactlyOnceWith(null)
      f.work.finish()
      await handle.closed
    }
  )

  it('accepts the fenced JSON descriptor returned by live Vibe', async () => {
    const f = fixture()
    const handle = runMistralAcknowledgedTurn(f.options)
    f.completeRawIntro('```json\n{"opening":"I will inspect the code."}\n```')
    await tick()
    expect(f.events).toEqual([{ type: 'content', text: 'I will inspect the code.\n\n' }])
    expect(f.startWork).toHaveBeenCalledExactlyOnceWith('I will inspect the code.')
    f.work.finish()
    await handle.closed
  })

  it('publishes only the opening, then waits for the actual working turn', async () => {
    const f = fixture()
    const handle = runMistralAcknowledgedTurn(f.options)
    const settled = vi.fn()
    void handle.closed.then(settled)
    f.introEvent({ type: 'thinking', text: 'private phase reasoning' })
    f.introEvent({ type: 'result', status: 'end_turn' })
    f.completeIntro('I will read the code and verify the fix.')
    await tick()
    expect(f.events).toEqual([
      { type: 'content', text: 'I will read the code and verify the fix.\n\n' }
    ])
    expect(f.startWork).toHaveBeenCalledWith('I will read the code and verify the fix.')
    expect(settled).not.toHaveBeenCalled()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(handle.steer('Also verify rounding.')).toBe(true)
    expect(f.work.handle.steer).toHaveBeenCalledWith('Also verify rounding.', undefined)
    f.work.finish()
    await handle.closed
    expect(settled).toHaveBeenCalledOnce()
  })

  it('cancels during the private opening without starting work or losing close ownership', async () => {
    const f = fixture()
    const handle = runMistralAcknowledgedTurn(f.options)
    expect(handle.steer('New task')).toBe(false)
    expect(f.intro.handle.steer).not.toHaveBeenCalled()
    handle.cancel()
    await handle.closed
    expect(f.startWork).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
    expect(f.onClose).toHaveBeenCalledExactlyOnceWith(130, false, 'cancelled')
  })

  it.each(['failed', 'NO_OPENING', 'tool'])(
    'continues actual work when the opening is %s',
    async (kind) => {
      const f = fixture()
      const handle = runMistralAcknowledgedTurn(f.options)
      if (kind === 'tool') f.introEvent({ type: 'tool_use', toolName: 'read_file' })
      f.completeIntro(
        kind === 'NO_OPENING' ? 'NO_OPENING' : 'opening',
        kind === 'failed' ? 'failed' : 'end_turn'
      )
      await tick()
      expect(f.events).toEqual([])
      expect(f.startWork).toHaveBeenCalledExactlyOnceWith(null)
      f.work.finish()
      await handle.closed
    }
  )

  it('cancels an opening that times out, then starts the working phase', async () => {
    const f = fixture()
    const handle = runMistralAcknowledgedTurn({ ...f.options, introductionTimeoutMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.intro.handle.cancel).toHaveBeenCalledOnce()
    expect(f.startWork).toHaveBeenCalledExactlyOnceWith(null)
    f.work.finish()
    await handle.closed
  })

  it('honours cancellation caused while the opening is being delivered', async () => {
    const f = fixture()
    const handle = runMistralAcknowledgedTurn({ ...f.options, onEvent: () => handle.cancel() })
    f.completeIntro('I will inspect the file.')
    await handle.closed
    expect(f.startWork).not.toHaveBeenCalled()
    expect(f.onClose).toHaveBeenCalledExactlyOnceWith(130, false, 'cancelled')
  })

  it('leaves slash commands alone and bounds the private context excerpt', async () => {
    const f = fixture()
    const startIntroduction = vi.fn(f.options.startIntroduction)
    const handle = runMistralAcknowledgedTurn({
      ...f.options,
      prompt: '/compact',
      startIntroduction
    })
    expect(startIntroduction).not.toHaveBeenCalled()
    expect(f.startWork).toHaveBeenCalledWith(null)
    f.work.finish()
    await handle.closed
    const prompt = mistralIntroductionPrompt('x'.repeat(20_000) + 'Fix the file.')
    expect(prompt).toContain('{"opening":null}')
    expect(prompt).toContain('Fix the file.')
    expect(prompt.length).toBeLessThan(14_000)
    const task = 'Fix pricing.py using the permitted TaskWraith tools.'
    const openingPrompt = mistralIntroductionPrompt(
      `${MISTRAL_WRITE_MODE_PROMPT_PREAMBLE}\n\n${task}`
    )
    expect(openingPrompt).not.toContain(MISTRAL_WRITE_MODE_PROMPT_PREAMBLE)
    expect(openingPrompt).toContain(JSON.stringify(task))
  })
})
