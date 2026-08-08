/**
 * Composition-root registration for Skills + Hooks IPC (Wave A).
 * Call once from main bootstrap next to registerPluginHandlers.
 */
import type { IpcMainInvokeEvent } from 'electron'
import { SkillsStore } from '../skills/SkillsStore'
import { HooksStore } from '../hooks/HooksStore'
import { registerSkillsHandlers } from '../ipc/skillsHandlers'
import { registerHooksHandlers } from '../ipc/hooksHandlers'

export interface SkillsHooksSubsystemOptions {
  userDataPath: string
  revealPathInFinder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  requireNonEmptyString: (value: unknown, label: string) => string
}

export interface SkillsHooksSubsystem {
  skillsStore: SkillsStore
  hooksStore: HooksStore
}

let activeSubsystem: SkillsHooksSubsystem | null = null

export function getSkillsHooksSubsystem(): SkillsHooksSubsystem | null {
  return activeSubsystem
}

export function createSkillsHooksSubsystem(
  options: SkillsHooksSubsystemOptions
): SkillsHooksSubsystem {
  const skillsStore = new SkillsStore({ userDataPath: options.userDataPath })
  const hooksStore = new HooksStore({ userDataPath: options.userDataPath })

  registerSkillsHandlers({
    skillsStore,
    revealPathInFinder: options.revealPathInFinder,
    isMainRendererSender: options.isMainRendererSender,
    requireRegisteredWorkspace: options.requireRegisteredWorkspace,
    assertSenderScope: options.assertSenderScope
  })

  registerHooksHandlers({
    hooksStore,
    requireRegisteredWorkspace: options.requireRegisteredWorkspace,
    assertSenderScope: options.assertSenderScope,
    isMainRendererSender: options.isMainRendererSender,
    requireNonEmptyString: options.requireNonEmptyString
  })

  const subsystem = { skillsStore, hooksStore }
  activeSubsystem = subsystem
  return subsystem
}
