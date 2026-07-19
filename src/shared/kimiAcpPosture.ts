/**
 * Durable identity for Kimi ACP sessions born after TaskWraith stopped exposing
 * the workspace through the provider process cwd or ACP client-fs capability.
 *
 * This value is deliberately persisted next to the linked provider session id.
 * An older boolean-only `kimiAcpNativeSession` marker is decode-only and must
 * never authorize `session/resume`.
 */
export const KIMI_ACP_PRODUCTION_POSTURE_VERSION = 'synthetic-cwd-gateway-v1' as const

export function isKimiAcpProductionPosture(value: unknown): boolean {
  return value === KIMI_ACP_PRODUCTION_POSTURE_VERSION
}
