/**
 * Reference-counted network-cut gate shared by overlapping canvas_eval calls.
 * Each enter returns an idempotent release; egress reopens only after the final
 * in-flight call (including its post-eval hold window) releases.
 */
export class CanvasEvalEgressGate {
  private depth = 0

  get active(): boolean {
    return this.depth > 0
  }

  enter(): () => void {
    this.depth += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.depth = Math.max(0, this.depth - 1)
    }
  }
}
