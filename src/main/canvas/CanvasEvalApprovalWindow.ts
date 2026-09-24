export const CANVAS_EVAL_APPROVAL_WINDOW_HOURS = 12
export const CANVAS_EVAL_APPROVAL_WINDOW_MS = CANVAS_EVAL_APPROVAL_WINDOW_HOURS * 60 * 60 * 1000

/**
 * The exact capability the first desktop approval opens.
 *
 * Canvas ids identify live surfaces, not documents. The window deliberately
 * follows that surface across navigation and later agent turns; a different
 * canvas id is never covered, and the in-memory store disappears on restart.
 */
export const CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE =
  'Approving runs this script now and opens a 12-hour canvas_eval window for this live Canvas surface. During that window, agents may run additional scripts on this surface without another prompt, including after navigation and in later turns. Other Canvas surfaces are not covered, and restarting TaskWraith ends the window.'

export function appendCanvasEvalApprovalWindowDisclosure(body: string | null | undefined): string {
  const prefix = typeof body === 'string' ? body.trimEnd() : ''
  return prefix
    ? `${prefix}\n\n${CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE}`
    : CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE
}
