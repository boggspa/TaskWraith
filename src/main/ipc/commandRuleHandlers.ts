import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { CommandRuleMutationResult, CommandRuleListItem } from '../../shared/commandRules'
import { commandRuleListItem } from '../command-rules/CommandRuleApprovalFlow'
import type { CommandRuleService } from '../command-rules/CommandRuleService'

export interface CommandRuleHandlerDeps {
  service: Pick<CommandRuleService, 'list' | 'remove'>
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
}

export function registerCommandRuleHandlers(deps: CommandRuleHandlerDeps): void {
  ipcMain.handle('command-rules:list', (event): CommandRuleListItem[] => {
    deps.assertMainRendererSender(event)
    return deps.service.list().map(commandRuleListItem)
  })

  ipcMain.handle('command-rules:remove', (event, ruleId: string): CommandRuleMutationResult => {
    deps.assertMainRendererSender(event)
    const id = typeof ruleId === 'string' ? ruleId.trim() : ''
    if (!id) return { ok: false, error: 'Command rule id is required.' }
    const rule = deps.service.list().find((entry) => entry.id === id)
    if (!rule) return { ok: false, error: 'Command rule was not found.' }
    const removed = deps.service.remove({
      id: rule.id,
      workspaceId: rule.workspaceId,
      workspacePath: rule.primaryWorkspaceRealPath
    })
    return removed
      ? { ok: true, rule: commandRuleListItem(rule) }
      : { ok: false, error: 'Command rule could not be revoked.' }
  })
}
