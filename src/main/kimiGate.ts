// Feature gate for the Kimi Code ACP transport (migration slice 4).
//
// Default ON as a transport selector only. It is not runtime qualification:
// reviewed descriptor-bound admission remains authoritative, and the embedded
// packaged roster is intentionally empty until an exact build is commissioned.
// Consequently packaged Kimi remains unavailable even when this flag is on.
// Managed Kimi execution is ACP-only. Set TASKWRAITH_KIMI_ACP=0 to force the
// transport off; TaskWraith fails closed and does not fall back to Wire/print.
export function kimiAcpEnabled(): boolean {
  const value = String(process.env.TASKWRAITH_KIMI_ACP || '').toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no'
}
