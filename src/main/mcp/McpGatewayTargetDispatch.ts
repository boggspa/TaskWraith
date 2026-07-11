import { CAPABILITY_INVOKE_TOOL_NAME } from './McpToolGateway'

export interface GatewayTargetDispatchMarker {
  viaGateway: true
  gatewayToolName: typeof CAPABILITY_INVOKE_TOOL_NAME
}

/**
 * Re-enter the canonical tool executor after capability resolution. Keeping
 * this seam injectable makes the security contract executable in tests: the
 * wrapper never owns approval, routing, locking, budgets, media, or audit;
 * those decisions receive the exact canonical target and original context.
 */
export async function dispatchResolvedGatewayTarget<
  TName extends string,
  TRoute,
  TProvider,
  TCaller,
  TResult
>(input: {
  targetName: TName
  targetArguments: Record<string, unknown>
  route: TRoute
  parentProvider: TProvider
  callerContext: TCaller
  executeCanonical: (
    targetName: TName,
    targetArguments: Record<string, unknown>,
    route: TRoute,
    parentProvider: TProvider,
    callerContext: TCaller,
    marker: GatewayTargetDispatchMarker
  ) => Promise<TResult>
}): Promise<TResult> {
  return input.executeCanonical(
    input.targetName,
    input.targetArguments,
    input.route,
    input.parentProvider,
    input.callerContext,
    { viaGateway: true, gatewayToolName: CAPABILITY_INVOKE_TOOL_NAME }
  )
}
