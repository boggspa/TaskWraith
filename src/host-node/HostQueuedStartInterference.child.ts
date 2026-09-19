/**
 * M2 HostQueuedStartInterference — forked-child fixture.
 *
 * Boots the REAL HostNodeProductionServer and the REAL local socket under a
 * temp profile, with exactly one test seam used: ONE real
 * `createHostNodeRunAdmission({ maxConcurrentRuns: 16, maxQueuedStarts: 1 })`
 * instance is created here and injected into the domain through the additive
 * `domainOptions.runAdmission` seam, so this child can witness the SAME
 * admission object the domain acquires from. A hold/release fake
 * HostNodeProvider (injected via the existing `domainOptions.providers`) keeps
 * 16 runs in-flight deterministically until the parent releases one.
 *
 * IPC protocol (newline-free JSON, one message per `process.send`):
 *   parent → child: { type: 'release', commandId }   — release one held run
 *                    { type: 'stop' }                 — graceful server stop
 *   child → parent: { type: 'ready' }                — socket + discovery live
 *                    { type: 'occupancy', inflight, queued } — after every change
 *                    { type: 'released', commandId }
 *                    { type: 'stopped' } / { type: 'fatal', message }
 *
 * There is NO env-gated shipping debug route: occupancy leaves the process
 * only over this test-owned IPC channel, never over the Host wire surface.
 */

import { HostNodeProductionServer } from './HostNodeProductionServer'
import { createHostNodeRunAdmission } from './HostNodeRunAdmission'
import type {
  HostNodeProvider,
  HostNodeProviderInstance,
  HostNodeProviderRunRequest,
  HostNodeProviderRunResult
} from './HostNodeProvider'
import type { HostProviderRunPort } from '../host-runtime/HostProviderRunPort'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'

interface ChildReleaseMessage {
  readonly type: 'release'
  readonly commandId: string
}
interface ChildStopMessage {
  readonly type: 'stop'
}
type ChildInbound = ChildReleaseMessage | ChildStopMessage

function isInbound(value: unknown): value is ChildInbound {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.type === 'stop') return true
  return record.type === 'release' && typeof record.commandId === 'string'
}

function send(message: Record<string, unknown>): void {
  if (typeof process.send === 'function') {
    process.send(message)
  }
}

const profilePath = process.argv[2]
if (!profilePath) {
  send({ type: 'fatal', message: 'profile path argument is required' })
  process.exit(2)
}

const isoNow = () => new Date().toISOString()

/**
 * Hold/release fake provider. `run()` performs the real persisted-start
 * writes through the injected run port (beginRun + user transcript, exactly
 * what `awaitPersistedStart` polls for), then parks until the parent releases
 * the exact commandId. Only then does it finish the run and resolve, which is
 * what makes the domain release the admission lease.
 */
function createHoldReleaseProvider(): HostNodeProvider & { release(commandId: string): boolean } {
  const held = new Map<string, () => void>()
  return {
    providerId: 'muse',
    displayProvider: 'Muse',
    shortCode: 'MUSE',
    offers: {
      providerId: 'muse',
      offerRevision: 'interference-offer-1',
      models: [
        {
          modelId: 'muse-spark-1.2',
          label: 'Muse Spark',
          available: true,
          default: true,
          reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
        }
      ],
      postures: [
        {
          postureId: 'workspace_write',
          label: 'Workspace write',
          available: true,
          requiresExplicitConsent: true,
          ceiling: 'workspace_write'
        },
        {
          postureId: 'default',
          label: 'Default',
          available: true,
          requiresExplicitConsent: false,
          ceiling: 'workspace_write'
        }
      ]
    },
    supportsApprovals: false,
    supportsQuestions: false,
    create(input: { runPort: HostProviderRunPort; interactions: HostNodeInteractionResolver }) {
      void input.interactions
      const port = input.runPort
      const instance: HostNodeProviderInstance = {
        providerId: 'muse',
        async getStatus() {
          return { providerId: 'muse', status: 'ready', label: 'Muse' }
        },
        async getAuthStatus() {
          return { providerId: 'muse', state: 'authenticated' }
        },
        async getAuthFlows() {
          return []
        },
        async beginAuth() {
          return undefined
        },
        async cancelAuth() {
          return true
        },
        run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
          const startedAt = isoNow()
          const begin = port.beginRun({
            runId: request.runId,
            threadId: request.threadId,
            providerId: 'muse',
            modelId: 'muse-spark-1.2',
            startedAt
          })
          if (begin.kind !== 'started') throw new Error('interference fixture beginRun refused')
          port.appendTranscript({
            runId: request.runId,
            threadId: request.threadId,
            role: 'user',
            text: request.prompt,
            createdAt: startedAt
          })
          return new Promise<HostNodeProviderRunResult>((resolve) => {
            held.set(request.runId, () => {
              port.finishRun({
                runId: request.runId,
                status: 'completed',
                finishedAt: isoNow(),
                warningSummaries: []
              })
              resolve({ runId: request.runId, status: 'completed' })
            })
          })
        },
        cancel(runId: string): boolean {
          const release = held.get(runId)
          if (!release) return false
          held.delete(runId)
          release()
          return true
        },
        async shutdown() {
          for (const [runId, release] of [...held.entries()]) {
            held.delete(runId)
            release()
          }
        }
      }
      return instance
    },
    // Test-owned release surface; not part of HostNodeProvider.
    release(commandId: string): boolean {
      const release = held.get(commandId)
      if (!release) return false
      held.delete(commandId)
      release()
      return true
    }
  }
}

async function main(): Promise<void> {
  // ONE real admission instance with the M2 scenario bounds. The domain owns
  // its behavior; this child owns the witness handle.
  const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 16, maxQueuedStarts: 1 })
  const provider = createHoldReleaseProvider()

  let lastInflight = -1
  let lastQueued = -1
  const occupancyTimer = setInterval(() => {
    const inflight = admission.inflightCount()
    const queued = admission.queuedCount()
    if (inflight !== lastInflight || queued !== lastQueued) {
      lastInflight = inflight
      lastQueued = queued
      send({ type: 'occupancy', inflight, queued })
    }
  }, 10)
  occupancyTimer.unref?.()

  const server = new HostNodeProductionServer({
    profilePath: profilePath!,
    mode: 'production',
    resolveIdentity: () => ({
      hostId: 'host-queued-start-interference',
      hostVersion: 'node-host-v1'
    }),
    domainOptions: {
      providers: [provider],
      runAdmission: admission,
      health: () => ({
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      })
    }
  })

  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      clearInterval(occupancyTimer)
      try {
        await server.stop()
      } finally {
        send({ type: 'stopped' })
        process.disconnect?.()
      }
    })()
    return stopPromise
  }

  process.on('message', (message: unknown) => {
    if (!isInbound(message)) return
    if (message.type === 'stop') {
      void stop()
      return
    }
    if (provider.release(message.commandId)) {
      send({ type: 'released', commandId: message.commandId })
    }
  })
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())

  await server.start()
  send({ type: 'ready' })
}

main().catch((error) => {
  send({
    type: 'fatal',
    message: error instanceof Error ? error.message : String(error)
  })
  process.exitCode = 1
})
