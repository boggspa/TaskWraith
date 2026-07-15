// Feature gate for the Kimi Code ACP transport (migration slice 4).
//
// Unlike Grok's ACP gate (default ON, a mature transport), the Kimi ACP path is
// default OFF: it is a brand-new transport whose containment is proven by live
// trace but which has not yet had in-app end-to-end soak. Default-OFF means a
// Kimi Code install still lands on the honest "temporarily unavailable" setup
// gate (slice 1b) until an operator opts in, so a bug in the new path can never
// silently degrade a default run. Flip on with TASKWRAITH_KIMI_ACP=1.
//
// The dossier's fence: A2 (ACP transport) ships behind this default-OFF flag;
// the flag is flipped to default-ON only after in-app E2E confirms the
// contained posture holds through real runs.
export function kimiAcpEnabled(): boolean {
  const value = String(process.env.TASKWRAITH_KIMI_ACP || '').toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}
