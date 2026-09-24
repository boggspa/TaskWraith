import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RunManager } from '../RunManager'
import { buildEnsembleYieldToolResult } from '../EnsembleYieldToolResult'
import { dispatchResolvedGatewayTarget } from '../mcp/McpGatewayTargetDispatch'
import { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord } from '../store/types'
import { resolveCodexMcpToolRoute } from './CodexMcpRouteRecovery'
import type { CodexMcpRouteHint } from './CodexMcpRouting'

describe('resumed Codex MCP handoff integration', () => {
  it('delivers a retained bridge call through the gateway to the resumed Boss and then Advisor', async () => {
    let chat: ChatRecord = {
      appChatId: 'task-1',
      chatKind: 'ensemble',
      scope: 'workspace',
      provider: 'codex',
      title: 'Resumed Boss',
      workspacePath: '/workspace',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        orchestrationMode: 'continuous',
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['advisor'],
        maxContinuationHops: 6,
        fanoutPolicy: 'off',
        participants: [
          {
            id: 'boss',
            provider: 'codex',
            role: 'Boss',
            order: 1,
            enabled: true,
            instructions: 'Coordinate.',
            permissionPresetId: 'workspace_write'
          },
          {
            id: 'advisor',
            provider: 'grok',
            role: 'Advisor',
            order: 2,
            enabled: true,
            instructions: 'Advise.',
            permissionPresetId: 'read_only'
          }
        ]
      }
    }
    const sessions = new RunManager()
    const previous = sessions.create({
      runId: 'old-boss',
      provider: 'codex',
      providerSessionId: 'native-boss',
      appChatId: chat.appChatId,
      workspacePath: chat.workspacePath,
      sender: {},
      status: 'failed',
      state: { ensembleRun: { participantId: 'boss' } }
    })
    sessions.create({
      ...previous,
      runId: 'other-task-live',
      providerSessionId: 'native-other',
      appChatId: 'task-2',
      status: 'running'
    })
    const dispatched: AgentRunPayload[] = []
    const orchestrator = new EnsembleOrchestrator({
      getChat: () => chat,
      saveChat: (next) => {
        chat = next
      },
      getSettings: () =>
        ({ storeLocalChatHistory: true, ensembleModeEnabled: true }) as AppSettings,
      dispatch: async (payload) => {
        dispatched.push(payload)
        sessions.create({
          runId: payload.appRunId!,
          provider: payload.provider,
          appChatId: chat.appChatId,
          workspacePath: chat.workspacePath,
          providerSessionId: payload.provider === 'codex' ? 'native-boss' : 'native-advisor',
          sender: {},
          status: 'running',
          state: { ensembleRun: payload.ensembleRun }
        })
        return { dispatched: true, appRunId: payload.appRunId! }
      },
      cancelRun: async () => true,
      createRunId: (provider) => `${provider}-${dispatched.length}`,
      now: () => 1_000,
      nowIso: () => '2026-09-05T15:16:00.000Z'
    })
    try {
      orchestrator.startRound({
        chatId: chat.appChatId,
        prompt: 'Continue.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(dispatched).toHaveLength(1))
      const currentRoute = { appRunId: dispatched[0].appRunId!, appChatId: chat.appChatId }
      const args = { name: 'ensemble_yield', arguments: { target: 'Advisor' } }
      const hints = new Map<string, CodexMcpRouteHint>([
        [
          'item-1',
          {
            itemId: 'item-1',
            toolName: 'capability_invoke',
            args,
            route: currentRoute,
            startedAtMs: 1_000
          }
        ]
      ])
      const resolveRoute = (route: AgentRunRoute | null, toolName: string, toolArgs: unknown) =>
        resolveCodexMcpToolRoute({
          route,
          toolName,
          args: toolArgs,
          hints,
          sessions,
          nowMs: 1_200,
          maxAgeMs: 15_000
        })
      const recovered = resolveRoute(
        { appRunId: previous.runId, appChatId: chat.appChatId },
        'capability_invoke',
        args
      )
      expect(recovered).toEqual(currentRoute)
      const executeCanonical = vi.fn(
        async (name: string, targetArgs: Record<string, unknown>, route: AgentRunRoute | null) => {
          const nestedRoute = resolveRoute(route, name, targetArgs)
          // The gateway must preserve the recovered active route after its
          // single-use outer witness has been consumed.
          expect(nestedRoute).toEqual(currentRoute)
          const context = sessions.resolve('codex', nestedRoute)
          expect(context?.status).toBe('running')
          expect(sessions.getClaimedTerminalStatus(context?.runId)).toBeUndefined()
          return buildEnsembleYieldToolResult({
            outcome: orchestrator.markYielded(context!.runId, 'Take over.', 'Advisor'),
            target: 'Advisor'
          })
        }
      )
      const result = await dispatchResolvedGatewayTarget({
        targetName: 'ensemble_yield',
        targetArguments: { target: 'Advisor' },
        route: recovered,
        parentProvider: 'codex',
        callerContext: { callerWorkspacePath: '/workspace' },
        executeCanonical
      })
      expect(result).toMatchObject({ ok: true, targetParticipantId: 'advisor' })
      await vi.waitFor(() => expect(dispatched).toHaveLength(2))
      expect(dispatched[1].ensembleRun?.participantId).toBe('advisor')
      expect(executeCanonical).toHaveBeenCalledTimes(1)
      expect(hints.size).toBe(0)
      expect(previous.status).toBe('failed')
      expect(sessions.get('other-task-live')?.status).toBe('running')
    } finally {
      await orchestrator.cancelRound(chat.appChatId)
    }
  })

  it('wires explicit Codex routes through recovery before the shared MCP context lookup', () => {
    const source = readFileSync(resolve('src/main/index.ts'), 'utf8')
    const routeStart = source.indexOf(
      '  const effectiveRoute =',
      source.indexOf('const receivedArgs = normalizeMcpToolArguments(rawArgs)')
    )
    const contextStart = source.indexOf(
      'const context = getAgentToolContext(parentProvider, effectiveRoute)',
      routeStart
    )
    const routing = source.slice(routeStart, contextStart)
    expect(routeStart).toBeGreaterThan(0)
    expect(contextStart).toBeGreaterThan(routeStart)
    expect(routing).toContain('resolveCodexMcpRouteFromHints(toolName, args, route)')
    expect(routing).not.toContain('!route?.appRunId')
  })
})
