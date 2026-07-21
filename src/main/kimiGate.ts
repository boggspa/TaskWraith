// Feature gate for the Kimi Code ACP transport (migration slice 4).
//
// Default ON as a transport selector only. It is not runtime qualification:
// descriptor-bound admission remains authoritative. Admission is structural
// and always-enabled in every build (packaged included); while the embedded
// reviewed roster stays empty, admitted runs are labelled
// unattested-development and cannot qualify a release.
// Managed Kimi execution is ACP-only. Set TASKWRAITH_KIMI_ACP=0 to force the
// transport off; TaskWraith fails closed and does not fall back to Wire/print.
export function kimiAcpEnabled(): boolean {
  const value = String(process.env.TASKWRAITH_KIMI_ACP || '').toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no'
}
