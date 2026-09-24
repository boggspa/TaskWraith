import { describe, expect, it, vi } from 'vitest'
import { RunManager, type RunSession, type RunSessionStatus } from '../RunManager'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import { resolveCodexMcpToolRoute } from './CodexMcpRouteRecovery'
import type { CodexMcpRouteHint } from './CodexMcpRouting'

function fixture(status: RunSessionStatus = 'failed') {
  const sessions = new RunManager()
  const previous = sessions.create({
    runId: 'previous-boss',
    provider: 'codex',
    appChatId: 'task-1',
    workspacePath: '/workspace',
    providerSessionId: 'native-boss-thread',
    sender: {},
    status,
    state: { ensembleRun: { participantId: 'boss', roundId: 'round-1' } }
  })
  const current = sessions.create({
    ...previous,
    runId: 'resumed-boss',
    status: 'running',
    state: { ensembleRun: { participantId: 'boss', roundId: 'round-2', laneId: 'lane-1' } }
  })
  // Another task holds the shared daemon alive throughout the Boss restart.
  sessions.create({
    ...current,
    runId: 'peer-run',
    appChatId: 'task-2',
    providerSessionId: 'native-peer-thread'
  })
  const original = { appRunId: previous.runId, appChatId: previous.appChatId }
  const currentRoute = { appRunId: current.runId, appChatId: current.appChatId }
  const hints = new Map<string, CodexMcpRouteHint>([
    [
      'tool-1',
      {
        itemId: 'tool-1',
        toolName: 'ensemble_yield',
        args: { target: 'Advisor' },
        route: currentRoute,
        startedAtMs: 1_000
      }
    ]
  ])
  const onRecovery = vi.fn()
  const route = (override: Partial<Parameters<typeof resolveCodexMcpToolRoute>[0]> = {}) =>
    resolveCodexMcpToolRoute({
      route: original,
      toolName: 'ensemble_yield',
      args: { target: 'Advisor' },
      hints,
      sessions,
      nowMs: 1_500,
      maxAgeMs: 15_000,
      onRecovery,
      ...override
    })
  return { sessions, previous, current, original, currentRoute, hints, onRecovery, route }
}

describe('Codex MCP route recovery', () => {
  it.each(['failed', 'completed', 'cancelled'] as const)(
    'routes a retained MCP child from a %s turn to its witnessed resumed seat',
    (status) => {
      const f = fixture(status)
      expect(f.sessions.getActiveByProvider('codex')).toHaveLength(2)
      expect(f.route()).toEqual(f.currentRoute)
      expect(f.onRecovery).toHaveBeenCalledWith({
        previousRunId: 'previous-boss',
        currentRunId: 'resumed-boss',
        providerSessionId: 'native-boss-thread',
        toolCallId: 'tool-1'
      })
      expect(f.hints.size).toBe(0)
      expect(f.previous.status).toBe(status)
    }
  )

  it('consumes one witness at most once without reviving the old run', () => {
    const f = fixture()
    expect(f.route()).toEqual(f.currentRoute)
    expect(f.route()).toBe(f.original)
    expect(f.onRecovery).toHaveBeenCalledTimes(1)
    expect(f.previous.status).toBe('failed')
  })

  it.each(['starting', 'running'] as const)('preserves a %s exact route', (status) => {
    const f = fixture(status)
    expect(f.route()).toBe(f.original)
    expect(f.hints.size).toBe(1)
  })

  it('preserves a completed native-goal route that the host still allows', () => {
    const f = fixture('completed')
    expect(f.route({ allowsTerminalSession: (session) => session === f.previous })).toBe(f.original)
    expect(f.hints.size).toBe(1)
  })

  it.each([
    { appRunId: 'missing-run', appChatId: 'task-1' },
    { appRunId: 'previous-boss', appChatId: 'wrong-task' },
    { appChatId: 'task-1' }
  ])('does not guess past a missing or conflicting identity %j', (original: AgentRunRoute) => {
    const f = fixture()
    expect(f.route({ route: original })).toBe(original)
    expect(f.hints.size).toBe(1)
  })

  it.each([
    ['another provider', { provider: 'claude' }],
    ['another native thread', { providerSessionId: 'native-other-thread' }],
    ['another task', { appChatId: 'task-2' }],
    ['another workspace', { workspacePath: '/other-workspace' }],
    ['missing sender', { sender: undefined }],
    ['another seat', { state: { ensembleRun: { participantId: 'validator' } } }],
    ['solo instead of ensemble', { state: {} }],
    ['malformed seat identity', { state: { ensembleRun: {} } }],
    ['missing session state', { state: undefined }],
    ['malformed session state', { state: 'unavailable' }],
    ['failed successor', { status: 'failed' }],
    ['completed successor', { status: 'completed' }],
    ['cancelled successor', { status: 'cancelled' }]
  ] as Array<[string, Partial<RunSession>]>)('rejects %s', (_label, patch) => {
    const f = fixture()
    Object.assign(f.current, patch)
    expect(f.route()).toBe(f.original)
    expect(f.hints.size).toBe(1)
  })

  it('does not reinterpret another provider as Codex from a bridge stamp', () => {
    const f = fixture()
    f.previous.provider = 'claude'
    expect(f.route()).toBe(f.original)
  })

  it('does not infer a solo identity from missing predecessor state', () => {
    const f = fixture()
    f.previous.state = undefined
    f.current.state = {}
    expect(f.route()).toBe(f.original)
  })

  it('accepts two global scopes but does not equate a missing path with an empty path', () => {
    const f = fixture()
    f.previous.workspacePath = f.current.workspacePath = undefined
    f.current.workspacePath = ''
    expect(f.route()).toBe(f.original)
    f.current.workspacePath = undefined
    expect(f.route()).toEqual(f.currentRoute)
  })

  it('rejects a successor that has a terminal claim before provider shutdown joins', () => {
    const f = fixture()
    f.sessions.claimTerminalStatus(f.current.runId, 'cancelled')
    expect(f.route()).toBe(f.original)
    expect(f.hints.size).toBe(1)
  })

  it('requires the current provider-session index, not just a matching live hint', () => {
    const f = fixture()
    f.sessions.create({ ...f.current, runId: 'later-successor' })
    expect(f.route()).toBe(f.original)
  })

  it.each([0, 20_000, Number.NaN])('rejects a witness outside its time window at %s', (nowMs) => {
    const f = fixture()
    expect(f.route({ nowMs })).toBe(f.original)
    expect(f.hints.size).toBe(1)
  })

  it('rejects missing, conflicting, and duplicate tool-call witnesses', () => {
    const f = fixture()
    expect(f.route({ args: { target: 'Worker' } })).toBe(f.original)
    expect(f.route({ toolName: 'ensemble_control' })).toBe(f.original)
    const hint = f.hints.get('tool-1')!
    f.hints.set('tool-2', { ...hint, itemId: 'tool-2' })
    expect(f.route()).toBe(f.original)
    expect(f.hints.size).toBe(2)
    f.hints.clear()
    expect(f.route()).toBe(f.original)
  })

  it('cannot confuse identical calls from another native thread with this seat', () => {
    const f = fixture()
    f.hints.set('peer-tool', {
      ...f.hints.get('tool-1')!,
      itemId: 'peer-tool',
      route: { appRunId: 'peer-run', appChatId: 'task-2' }
    })
    expect(f.route()).toEqual(f.currentRoute)
    expect([...f.hints.keys()]).toEqual(['peer-tool'])
  })

  it('keeps portable control aliases and argument envelopes correlated', () => {
    const f = fixture()
    f.hints.get('tool-1')!.toolName = 'ensemble_control'
    f.hints.get('tool-1')!.args = {
      action: 'summon_participant',
      params: { targetParticipantId: 'writer' }
    }
    expect(
      f.route({
        toolName: 'ensemble_bossman_control',
        args: {
          action: 'summon_participant',
          targetParticipantId: 'writer'
        }
      })
    ).toEqual(f.currentRoute)
  })

  it('supports the same solo task and canonical workspace without changing scope', () => {
    const f = fixture()
    f.previous.state = f.current.state = {}
    f.current.workspacePath = '/workspace/subdirectory/..'
    expect(f.route()).toEqual(f.currentRoute)
  })

  it('preserves the legacy route-hint fallback for an unbound bridge', () => {
    const f = fixture()
    expect(f.route({ route: undefined })).toEqual(f.currentRoute)
  })

  it('does not revoke routing if recording the recovery diagnostic fails', () => {
    const f = fixture()
    expect(
      f.route({
        onRecovery: () => {
          throw new Error('journal unavailable')
        }
      })
    ).toEqual(f.currentRoute)
  })
})
