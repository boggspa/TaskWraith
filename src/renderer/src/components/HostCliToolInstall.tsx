import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  hostCliTool,
  hostCliToolInstallCommand,
  type HostCliToolId
} from '../../../shared/hostCliToolCatalog'
import { PillButton } from './PillButton'

/**
 * Install / upgrade affordances for optional host CLIs — today only `gh`.
 *
 * Shared by three surfaces on purpose (first-launch sheet, Settings → Providers,
 * and the composer's PR popover) so the button a user meets in the popover is
 * literally the same control, chrome, and state machine as the one in
 * onboarding. The alternative — a bespoke button per surface — is how the three
 * of them drift into three different ideas of "installed".
 *
 * Desktop only. There is no iOS mirror and there must not be: installing a
 * desktop CLI is meaningless on a phone, and the whole lane is gated behind
 * `window.api`, which the iOS surface does not have.
 */

export type HostCliToolPresence = 'unknown' | 'present' | 'absent'

export interface HostCliToolStatus {
  presence: HostCliToolPresence
  path?: string
  refresh: () => void
}

/**
 * Live presence for a host tool.
 *
 * `presence` starts at 'unknown', NOT 'absent'. That distinction is the whole
 * point of this hook: an install affordance that renders before the probe
 * answers would flash "not installed" at users who have it installed, which is
 * the exact confusion this work is fixing. Callers gate on `=== 'absent'`.
 */
export function useHostCliToolStatus(toolId: HostCliToolId, enabled = true): HostCliToolStatus {
  const [presence, setPresence] = useState<HostCliToolPresence>('unknown')
  const [path, setPath] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined' || typeof window.api?.hostToolStatus !== 'function') {
      return
    }
    let cancelled = false
    void window.api
      .hostToolStatus(toolId)
      .then((status) => {
        if (cancelled) return
        setPresence(status?.available ? 'present' : 'absent')
        setPath(status?.path)
      })
      .catch(() => {
        // A failed probe is not evidence of absence — stay 'unknown' so no
        // surface offers to install something that may already be there.
        if (!cancelled) setPresence('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [toolId, enabled, nonce])

  return { presence, path, refresh }
}

type InstallState = 'idle' | 'opening' | 'opened' | 'error'

export interface HostCliToolInstallButtonProps {
  toolId: HostCliToolId
  /** True when the tool resolves — flips the control to an upgrade. */
  installed?: boolean
  size?: 'regular' | 'compact'
  variant?: 'primary' | 'secondary'
  /** Called after the terminal opens, so the host can re-probe presence. */
  onOpened?: () => void
  className?: string
}

/**
 * The shared Install / Upgrade control.
 *
 * MAIN decides install-vs-upgrade from what actually resolves on this machine;
 * `installed` only picks the label, so a stale prop can never send the wrong
 * command.
 */
export function HostCliToolInstallButton({
  toolId,
  installed = false,
  size = 'compact',
  variant = 'primary',
  onOpened,
  className
}: HostCliToolInstallButtonProps): ReactElement {
  const [state, setState] = useState<InstallState>('idle')
  const [error, setError] = useState<string | null>(null)
  const entry = hostCliTool(toolId)
  const label = installed ? 'Upgrade' : 'Install'
  const available =
    typeof window !== 'undefined' && typeof window.api?.openHostToolInstallTerminal === 'function'

  const run = useCallback(() => {
    if (!available) return
    setState('opening')
    setError(null)
    void window.api
      .openHostToolInstallTerminal(toolId)
      .then((result) => {
        if (result?.ok) {
          setState('opened')
          onOpened?.()
        } else {
          setState('error')
          setError(result?.error || 'Could not open the install terminal.')
        }
      })
      .catch((cause) => {
        setState('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [available, toolId, onOpened])

  return (
    <div className={`host-cli-tool-install${className ? ` ${className}` : ''}`}>
      <PillButton
        size={size}
        variant={variant}
        onClick={run}
        disabled={!available || state === 'opening'}
        title={
          available
            ? `Open a Terminal that ${installed ? 'upgrades' : 'installs'} ${entry?.label ?? toolId} for TaskWraith.`
            : `${entry?.label ?? toolId} setup is unavailable in this window.`
        }
        aria-label={`${label} ${entry?.label ?? toolId}`}
      >
        {state === 'opening' ? 'Opening…' : `${label} ${entry?.label ?? toolId}…`}
      </PillButton>
      {state === 'opened' && (
        <span className="host-cli-tool-install-hint">
          Terminal opened. Finish there, then reopen this panel.
        </span>
      )}
      {state === 'error' && error && (
        <span className="host-cli-tool-install-hint is-error">{error}</span>
      )}
    </div>
  )
}

export interface HostCliToolCardProps {
  toolId: HostCliToolId
  presence: HostCliToolPresence
  resolvedPath?: string
  onOpened?: () => void
  /** Platform used to show the command that will run. Defaults to the host. */
  platform?: string
}

/**
 * Full setup card. Same visual family as the provider cards, in its own
 * section — `gh` is a host tool, not a provider seat, and merging it into the
 * provider grid would imply it has a model, posture, and run lane.
 */
export function HostCliToolCard({
  toolId,
  presence,
  resolvedPath,
  onOpened,
  platform
}: HostCliToolCardProps): ReactElement | null {
  const entry = hostCliTool(toolId)
  if (!entry) return null
  const effectivePlatform =
    platform ??
    (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '') ? 'win32' : 'darwin')
  const command = hostCliToolInstallCommand(toolId, effectivePlatform)
  const statusVariant =
    presence === 'present' ? 'signed-in' : presence === 'absent' ? 'not-available' : 'partial'
  const statusText =
    presence === 'present'
      ? 'Installed · ready'
      : presence === 'absent'
        ? 'Not found · install it'
        : 'Checking…'

  return (
    <div className="host-cli-tool-card" data-tool={toolId} data-presence={presence}>
      <div className="host-cli-tool-card-header">
        <span className="host-cli-tool-card-label">{entry.label}</span>
        <span className="host-cli-tool-card-optional-badge">Optional</span>
      </div>
      <div className="host-cli-tool-card-status">
        <span
          className={`first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-${statusVariant}`}
          aria-hidden
        />
        <span>{statusText}</span>
      </div>
      <p className="host-cli-tool-card-description">{entry.purpose}</p>
      <p className="host-cli-tool-card-hint">
        {presence === 'present' ? (
          <>
            TaskWraith resolves it at <code>{resolvedPath || entry.binaryName}</code>.
          </>
        ) : (
          entry.missingConsequence
        )}
      </p>
      {command && (
        <div className="host-cli-tool-card-command">
          <code title={`Official ${entry.source} install command`}>{command.command}</code>
          <span>{command.platform}</span>
        </div>
      )}
      <div className="host-cli-tool-card-actions">
        <HostCliToolInstallButton
          toolId={toolId}
          installed={presence === 'present'}
          onOpened={onOpened}
        />
      </div>
    </div>
  )
}
