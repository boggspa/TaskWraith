import type { AgenticServicesSettings } from '../../../main/store/types'

export const DEFAULT_AGENTIC_SERVICES: AgenticServicesSettings = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  externalPublish: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  crossThreadRead: 'ask',
  threadMessage: 'ask',
  mediaEditing: 'ask',
  mediaRecording: 'deny',
  canvasEval: 'ask',
  networkAccess: 'allow'
}
