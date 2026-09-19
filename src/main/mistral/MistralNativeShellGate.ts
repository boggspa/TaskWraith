/**
 * Re-export shim. The gate is provider-generic and lives in
 * `../native-tools/NativeShellApprovalGate`; this file keeps the Mistral-named
 * imports working (notably the launch seal, which must call the same producer
 * the runtime does). Same pattern as `TaskWraithMcpTools.ts`.
 */
export {
  createNativeShellApprovalGate as createMistralNativeShellGate,
  nativeShellPermitted as mistralNativeShellPermitted
} from '../native-tools/NativeShellApprovalGate'
export type {
  NativeShellApprovalGateDeps as MistralNativeShellGateDeps,
  NativeShellGateDecision,
  NativeShellGateDenial
} from '../native-tools/NativeShellApprovalGate'
