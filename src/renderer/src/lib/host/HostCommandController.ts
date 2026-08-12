/**
 * Renderer-owned state machine for governed Desktop Host actions.
 *
 * Components submit compact command intents through this controller and
 * render its observable state. The controller owns receipt truth: pending is
 * visible as pending, approval cards are joined only by commandId, and no UI
 * callback can rewrite a timeout or failure into success.
 */

import type {
  HostApprovalDecideDecision,
  HostCommandName,
  HostCommandReceipt
} from '../../../../shared/hostProtocol'
import {
  HostCommandClient,
  type HostCommandRunOutcome,
  type HostCommandSubmitInput
} from './HostCommandClient'

export interface HostPendingDesktopCommand {
  readonly commandId: string
  readonly name: HostCommandName
  readonly approvalId?: string
}

export type HostCommandNoticeTone = 'neutral' | 'good' | 'warning' | 'error'

export interface HostCommandNotice {
  readonly text: string
  readonly tone: HostCommandNoticeTone
}

export interface HostCommandControllerState {
  readonly busy: boolean
  readonly approvalBusy: boolean
  readonly pending?: HostPendingDesktopCommand
  readonly notice?: HostCommandNotice
}

export interface HostCommandControllerClient {
  submitAndResolve(
    input: HostCommandSubmitInput,
    hooks?: {
      onPending?: (receipt: HostCommandReceipt, approvalId?: string) => void
      onTick?: (receipt: HostCommandReceipt) => void
    }
  ): Promise<HostCommandRunOutcome>
  decideApproval(input: {
    approvalId: string
    decision: HostApprovalDecideDecision
    message?: string
  }): Promise<HostCommandRunOutcome>
}

export interface HostCommandControllerOptions {
  readonly client: HostCommandControllerClient | HostCommandClient
}

type Listener = (state: HostCommandControllerState) => void

function noticeForOutcome(outcome: HostCommandRunOutcome): HostCommandNotice {
  if (outcome.kind === 'error') return { text: outcome.error, tone: 'error' }
  if (outcome.kind === 'pending-timeout') {
    return { text: `${outcome.description.text} · timed out`, tone: 'warning' }
  }
  return outcome.description
}

export class HostCommandController {
  private readonly client: HostCommandControllerClient
  private readonly listeners = new Set<Listener>()
  private state: HostCommandControllerState = { busy: false, approvalBusy: false }
  private activeOperations = 0
  private approvalResponseInFlight = false

  constructor(options: HostCommandControllerOptions) {
    if (!options || typeof options !== 'object' || !options.client) {
      throw new Error('HostCommandController requires a client')
    }
    this.client = options.client
  }

  getState(): HostCommandControllerState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clearNotice(): void {
    if (!this.state.notice) return
    const { notice: _notice, ...rest } = this.state
    void _notice
    this.setState(rest)
  }

  async submit(input: HostCommandSubmitInput): Promise<HostCommandRunOutcome> {
    this.beginOperation()
    try {
      const outcome = await this.client.submitAndResolve(input, {
        onPending: (receipt, approvalId) => {
          this.setState({
            ...this.state,
            pending: {
              commandId: receipt.commandId,
              name: receipt.name,
              ...(approvalId ? { approvalId } : {})
            },
            notice: {
              text: `Awaiting Host approval · ${receipt.name}`,
              tone: 'warning'
            }
          })
        },
        onTick: (receipt) => {
          if (receipt.status !== 'pending') return
          this.setState({
            ...this.state,
            notice: {
              text: `Awaiting Host approval · ${receipt.name}`,
              tone: 'warning'
            }
          })
        }
      })
      const { pending: _pending, ...rest } = this.state
      void _pending
      this.setState({ ...rest, notice: noticeForOutcome(outcome) })
      return outcome
    } catch (error) {
      const outcome: HostCommandRunOutcome = {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
      this.setState({ ...this.state, notice: noticeForOutcome(outcome) })
      return outcome
    } finally {
      this.endOperation()
    }
  }

  async decidePendingApproval(
    decision: HostApprovalDecideDecision
  ): Promise<HostCommandRunOutcome> {
    const approvalId = this.state.pending?.approvalId
    if (!approvalId) {
      const outcome: HostCommandRunOutcome = {
        kind: 'error',
        error: 'No correlated Host approval is available.'
      }
      this.setState({ ...this.state, notice: noticeForOutcome(outcome) })
      return outcome
    }

    if (this.approvalResponseInFlight) {
      return { kind: 'error', error: 'A Host approval response is already in flight.' }
    }

    this.approvalResponseInFlight = true
    this.beginOperation()
    this.setState({ ...this.state, approvalBusy: true })
    try {
      const outcome = await this.client.decideApproval({ approvalId, decision })
      this.setState({ ...this.state, notice: noticeForOutcome(outcome) })
      return outcome
    } catch (error) {
      const outcome: HostCommandRunOutcome = {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
      this.setState({ ...this.state, notice: noticeForOutcome(outcome) })
      return outcome
    } finally {
      this.approvalResponseInFlight = false
      this.setState({ ...this.state, approvalBusy: false })
      this.endOperation()
    }
  }

  private beginOperation(): void {
    this.activeOperations += 1
    this.setState({ ...this.state, busy: true })
  }

  private endOperation(): void {
    this.activeOperations = Math.max(0, this.activeOperations - 1)
    this.setState({ ...this.state, busy: this.activeOperations > 0 })
  }

  private setState(state: HostCommandControllerState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}
