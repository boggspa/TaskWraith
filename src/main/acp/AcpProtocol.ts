// Provider-neutral barrel for the pure ACP (Agent Client Protocol) wire
// helpers. These were first written for Grok (`grok agent stdio`) but are
// protocol-level, not provider-level: JSON-RPC 2.0 over NDJSON, the
// initialize → session/new → session/prompt lifecycle, session/update
// streaming, and client-mediated session/request_permission. Kimi Code's
// `kimi acp` speaks the same protocol, so its client (KimiAcpClient) and the
// neutral AcpTurnClient both consume these through this barrel instead of
// reaching into the Grok module.
//
// No code moves — this re-exports the existing, test-covered implementations
// so GrokAcpProtocol.ts and its suite stay untouched. A future cleanup can
// physically relocate the source here; today the barrel is the seam.

export {
  encodeAcpFrame,
  parseAcpStreamChunk,
  acpMessageToRunEvents,
  isAcpPermissionRequest,
  parseAcpPermissionRequest,
  buildAcpPermissionResponse,
  isAcpInboundRequest,
  buildAcpMethodNotFoundResponse
} from '../grok/GrokAcpProtocol'

export type {
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionDecision
} from '../grok/GrokAcpProtocol'

// The normalized run-event shape is protocol-neutral (content / thinking /
// init / result / tool_use / tool_result / provider_warning); the Grok name is
// historical. Alias it so neutral + Kimi code reads naturally.
export type { NormalizedGrokRunEvent as AcpRunEvent } from './../grok/GrokAcpProtocol'
