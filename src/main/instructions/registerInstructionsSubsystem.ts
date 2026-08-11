/**
 * Composition-root registration for the Custom Instructions subsystem.
 * Call once from main bootstrap next to createSkillsHooksSubsystem.
 *
 * Owns the global instructions document store and the per-run layer
 * resolution closure that ComposerService, the delegated/sub-thread
 * composer, the bridge composer, and the ensemble orchestrator all share —
 * one resolver, so every producer applies identical safety gates.
 */
import type { IpcMainInvokeEvent } from 'electron'
import { InstructionStore } from './InstructionStore'
import { resolveInstructionContext } from './InstructionResolver'
import { registerInstructionsHandlers } from '../ipc/instructionsHandlers'
import type { ResolvedInstructionContext } from '../../shared/instructions/InstructionTypes'
import type { AppSettings } from '../store/types'

export interface InstructionsSubsystemOptions {
  userDataPath: string
  getSettings: () => AppSettings
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
}

export interface InstructionsSubsystem {
  instructionStore: InstructionStore
  /**
   * Resolve the instruction layers for a run. `workspacePath: null` = global
   * (General-chat) scope — global layer only. Never throws; failures surface
   * as skipped-layer statuses in the returned context.
   */
  resolveForRun: (workspacePath: string | null) => ResolvedInstructionContext
}

let activeSubsystem: InstructionsSubsystem | null = null

export function getInstructionsSubsystem(): InstructionsSubsystem | null {
  return activeSubsystem
}

export function createInstructionsSubsystem(
  options: InstructionsSubsystemOptions
): InstructionsSubsystem {
  const instructionStore = new InstructionStore({ userDataPath: options.userDataPath })

  const resolveForRun = (workspacePath: string | null): ResolvedInstructionContext => {
    const enabled = options.getSettings().customInstructionsEnabled !== false
    return resolveInstructionContext({
      enabled,
      globalContent: enabled ? instructionStore.readGlobalDocument().content : '',
      workspacePath
    })
  }

  registerInstructionsHandlers({
    instructionStore,
    resolveInstructionStatus: resolveForRun,
    isMainRendererSender: options.isMainRendererSender,
    requireRegisteredWorkspace: options.requireRegisteredWorkspace,
    assertSenderScope: options.assertSenderScope
  })

  const subsystem = { instructionStore, resolveForRun }
  activeSubsystem = subsystem
  return subsystem
}
