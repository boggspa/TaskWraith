import { describe, expect, it } from 'vitest'

import {
  closeOllamaHostToolTurn,
  createOllamaHostToolTurnState,
  foldOllamaHostToolOutcome,
  HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES,
  HOST_OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS,
  ollamaHostToolCeilingContent,
  ollamaHostToolCeilingReached,
  type OllamaHostToolTurnState
} from './OllamaHostToolTurns'

function failNTimes(count: number, result = 'ENOENT: no such file'): OllamaHostToolTurnState {
  let state = createOllamaHostToolTurnState()
  for (let index = 0; index < count; index += 1) {
    state = foldOllamaHostToolOutcome(state, { toolName: 'read_file', ok: false, result }).state
  }
  return state
}

describe('foldOllamaHostToolOutcome', () => {
  it('counts a successful tool as progress', () => {
    const folded = foldOllamaHostToolOutcome(createOllamaHostToolTurnState(), {
      toolName: 'read_file',
      ok: true,
      result: 'contents'
    })
    expect(folded.productive).toBe(true)
    expect(folded.state.identicalFailureStreak).toBe(0)
  })

  it('credits a failure that is new, so compile-error to read to fix keeps going', () => {
    const first = foldOllamaHostToolOutcome(createOllamaHostToolTurnState(), {
      toolName: 'replace_in_file',
      ok: false,
      result: 'does not occur'
    })
    const second = foldOllamaHostToolOutcome(first.state, {
      toolName: 'replace_in_file',
      ok: false,
      result: 'escapes the workspace'
    })
    expect(second.productive).toBe(true)
    expect(second.state.identicalFailureStreak).toBe(1)
  })

  it('stops crediting the SAME failure once the streak reaches the breaker', () => {
    const state = failNTimes(HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES - 1)
    const breaking = foldOllamaHostToolOutcome(state, {
      toolName: 'read_file',
      ok: false,
      result: 'ENOENT: no such file'
    })
    expect(breaking.state.identicalFailureStreak).toBe(
      HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES
    )
    expect(breaking.productive).toBe(false)
  })

  it('keys failure identity on the tool as well as the message', () => {
    const first = foldOllamaHostToolOutcome(createOllamaHostToolTurnState(), {
      toolName: 'read_file',
      ok: false,
      result: 'escapes the workspace'
    })
    const other = foldOllamaHostToolOutcome(first.state, {
      toolName: 'list_dir',
      ok: false,
      result: 'escapes the workspace'
    })
    expect(other.state.identicalFailureStreak).toBe(1)
  })

  it('clears a live streak on any success', () => {
    const state = failNTimes(HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES)
    const recovered = foldOllamaHostToolOutcome(state, {
      toolName: 'read_file',
      ok: true,
      result: 'contents'
    })
    expect(recovered.state.identicalFailureStreak).toBe(0)
    expect(recovered.state.lastFailureKey).toBeNull()
    expect(recovered.productive).toBe(true)
  })
})

describe('the non-productive turn ceiling', () => {
  it('does not fire while turns keep making progress', () => {
    let state = createOllamaHostToolTurnState()
    for (let turn = 0; turn < HOST_OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS * 3; turn += 1) {
      state = closeOllamaHostToolTurn(state, { productive: true })
    }
    expect(ollamaHostToolCeilingReached(state)).toBe(false)
  })

  it('fires after the configured run of non-productive turns', () => {
    let state = createOllamaHostToolTurnState()
    for (let turn = 0; turn < HOST_OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS - 1; turn += 1) {
      state = closeOllamaHostToolTurn(state, { productive: false })
    }
    expect(ollamaHostToolCeilingReached(state)).toBe(false)
    state = closeOllamaHostToolTurn(state, { productive: false })
    expect(ollamaHostToolCeilingReached(state)).toBe(true)
  })

  it('resets the run when a later turn makes progress', () => {
    let state = createOllamaHostToolTurnState()
    for (let turn = 0; turn < HOST_OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS - 1; turn += 1) {
      state = closeOllamaHostToolTurn(state, { productive: false })
    }
    state = closeOllamaHostToolTurn(state, { productive: true })
    state = closeOllamaHostToolTurn(state, { productive: false })
    expect(ollamaHostToolCeilingReached(state)).toBe(false)
  })
})

describe('ollamaHostToolCeilingContent', () => {
  it('ends the run with a spoken reason rather than silence', () => {
    expect(ollamaHostToolCeilingContent()).toContain('stopping instead of looping')
  })
})
