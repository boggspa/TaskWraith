// Feature gate for the Kimi Code ACP transport (migration slice 4).
//
// Default ON, like Grok's ACP gate. The dossier's fence (ship A2 behind the flag
// until the contained posture is confirmed through real runs) has been cleared:
//   - the codified live containment trace (KimiAcpContainment.live.test.ts)
//     passed all assertions against the real binary — fs client-authority
//     routing, the FetchURL/WebSearch egress deny wall, sub-agent deny
//     inheritance, and the B3 project-config refusal + tripwire;
//   - in-app E2E soaks confirmed routing, streaming, teardown, multi-turn,
//     ensemble participation, the gateway MCP over the HTTP bridge, and a
//     workspace write;
//   - an independent review's B3 RCE blocker and correctness findings are fixed.
// A legacy Kimi CLI still routes to the retained Wire path (positively
// identified). Set TASKWRAITH_KIMI_ACP=0 to force the transport off (a
// kimi-code binary then lands on the setup-required gate).
export function kimiAcpEnabled(): boolean {
  const value = String(process.env.TASKWRAITH_KIMI_ACP || '').toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no'
}
