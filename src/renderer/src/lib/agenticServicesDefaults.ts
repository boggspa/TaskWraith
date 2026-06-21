import type { AgenticServicesSettings } from '../../../main/store/types'

export const DEFAULT_AGENTIC_SERVICES: AgenticServicesSettings = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  networkAccess: 'allow'
}
