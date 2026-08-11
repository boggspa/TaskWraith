import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { GlobalInstructionsDocument, InstructionStore } from '../instructions/InstructionStore'
import type { ResolvedInstructionContext } from '../../shared/instructions/InstructionTypes'

export interface InstructionsHandlerDeps {
  instructionStore: Pick<InstructionStore, 'readGlobalDocument' | 'writeGlobalDocument'>
  /**
   * Resolve the layers exactly as a run would see them (settings toggle +
   * global document + workspace TASKWRAITH.md), so the settings UI can show
   * honest applied/skipped statuses. Content is stripped before returning —
   * the editor owns its own draft and the preview only needs statuses.
   */
  resolveInstructionStatus: (workspacePath: string | null) => ResolvedInstructionContext
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertMainRenderer(deps: InstructionsHandlerDeps, event: IpcMainInvokeEvent): void {
  if (!deps.isMainRendererSender(event)) {
    throw new Error('Only the main renderer may manage custom instructions.')
  }
}

function stripLayerContent(context: ResolvedInstructionContext): ResolvedInstructionContext {
  return {
    ...context,
    layers: context.layers.map((layer) => {
      const { content: _content, ...rest } = layer
      return rest
    })
  }
}

export function registerInstructionsHandlers(deps: InstructionsHandlerDeps): void {
  ipcMain.handle('instructions:get-global', (event): GlobalInstructionsDocument => {
    assertMainRenderer(deps, event)
    return deps.instructionStore.readGlobalDocument()
  })

  ipcMain.handle(
    'instructions:set-global',
    (event, payload: unknown): GlobalInstructionsDocument => {
      assertMainRenderer(deps, event)
      if (!isRecord(payload)) throw new Error('Invalid instructions:set-global payload.')
      if (typeof payload.content !== 'string') {
        throw new Error('content must be a string.')
      }
      // The store enforces the byte cap; this bound only keeps a hostile
      // renderer from shoving arbitrarily large strings across IPC.
      if (payload.content.length > 500_000) {
        throw new Error('content is too long.')
      }
      return deps.instructionStore.writeGlobalDocument(payload.content)
    }
  )

  ipcMain.handle(
    'instructions:resolve-status',
    (event, payload: unknown): ResolvedInstructionContext => {
      assertMainRenderer(deps, event)
      const record = isRecord(payload) ? payload : {}
      let workspacePath: string | null = null
      if (typeof record.workspacePath === 'string' && record.workspacePath.trim()) {
        const registered = deps.requireRegisteredWorkspace(record.workspacePath.trim())
        deps.assertSenderScope(event, registered)
        workspacePath = registered
      }
      return stripLayerContent(deps.resolveInstructionStatus(workspacePath))
    }
  )
}
