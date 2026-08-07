import type { AgenticServiceId } from '../main/store/types'

export const AGENTIC_SERVICE_LABELS: Record<AgenticServiceId, string> = {
  shellCommands: 'Shell commands',
  fileChanges: 'File changes',
  externalPublish: 'External publishing',
  mcpTools: 'Tool calls',
  subThreadDelegation: 'Sub-thread delegation',
  canvasInteraction: 'Canvas interaction',
  sketchCanvas: 'Sketch Canvas',
  meshCanvas: 'Mesh Canvas',
  simulatorCanvas: 'Simulator Canvas',
  crossThreadRead: 'Cross-thread read',
  threadMessage: 'Thread message',
  mediaEditing: 'Media editing',
  mediaRecording: 'Media recording',
  canvasEval: 'Canvas eval',
  webBrowsing: 'Browser navigation'
}
