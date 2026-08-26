/**
 * Pi RPC image wire type, extracted from src/main/pi/PiImageContent.ts so
 * host tsc does not emit main/pi or main/ClaudeImageContent.
 *
 * Runtime image loading stays in src/main/pi/PiImageContent.ts. This module
 * is Node-pure: no src/main imports. The two PiRpcImageContent declarations
 * remain structurally compatible.
 */

/** Pi RPC's `ImageContent` wire shape (`@earendil-works/pi-ai`). */
export interface PiRpcImageContent {
  type: 'image'
  mimeType: string
  data: string
}
