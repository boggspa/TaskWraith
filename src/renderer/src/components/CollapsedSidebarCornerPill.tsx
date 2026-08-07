import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import type { AgentApprovalRequest } from '../lib/agentApprovalTypes'
import type { AgentQuestionState } from './AgentQuestionCard'
import { flattenPendingAgentQuestions } from '../lib/agentQuestionQueue'
import type { HumanCollaborationShare } from '../../../main/collaboration/HumanCollaborationStore'
import { IOS_REMOTE_ENABLED } from '../lib/featureFlags'
import {
  ApprovalsFooterPopover,
  ApprovalsShieldIcon,
  DevicesFooterPopover,
  GearSymbolIcon,
  RemoteConnectionSymbolIcon,
  ShareNetworkIcon,
  SharesFooterPopover,
  SidebarSettingsMenu,
  type PairedRemoteDeviceSummary,
  type SidebarSettingsMenuPane
} from './Sidebar'
import { useHostProjectionStore } from './HostProjectionProvider'
import { useHostProjection } from '../hooks/useHostProjection'
import { joinHostPendingApprovals } from '../hooks/usePendingApprovalsProjection'

type CornerPillPanel = 'settings' | 'approvals' | 'shares' | 'devices'

interface CollapsedSidebarCornerPillProps {
  chats: ChatRecord[]
  onSelectChat: (chat: ChatRecord) => void
  /** Settings-menu plumbing — identical to what the Sidebar footer passes. */
  quickSettings?: ComponentProps<typeof SidebarSettingsMenu>['quickSettings']
  onAppearanceQuickChange?: ComponentProps<typeof SidebarSettingsMenu>['onAppearanceQuickChange']
  onOpenSettings: () => void
  onOpenSettingsTab: (tab: 'pairing' | 'approval-ledger' | 'shares') => void
  onOpenWorkspacePopout?: ComponentProps<typeof SidebarSettingsMenu>['onOpenWorkspacePopout']
  canOpenWorkspacePopout?: boolean
  onQuitApp?: () => void
  /** Approvals — same per-chat head + queue maps the Sidebar receives. */
  pendingAgentApprovalByChatId?: Record<string, AgentApprovalRequest | null>
  pendingApprovalQueueByChatId?: Record<string, AgentApprovalRequest[]>
  onRespondAgentApproval?: ComponentProps<typeof ApprovalsFooterPopover>['onRespondApproval']
  /** Pending agent questions — glow + list alongside approvals. */
  pendingAgentQuestionsByChatId?: Record<string, readonly AgentQuestionState[]>
  onAnswerAgentQuestion?: ComponentProps<typeof ApprovalsFooterPopover>['onAnswerQuestion']
  onDismissAgentQuestion?: ComponentProps<typeof ApprovalsFooterPopover>['onDismissQuestion']
  /** Shares. */
  collaborationShares?: HumanCollaborationShare[]
  collaboratingChatIds?: Set<string>
  hasConnectedCollaborator?: boolean
  onRevokeShare?: (shareId: string) => void
}

/**
 * Bottom-left vertical glass pill, shown ONLY while the workspace sidebar is
 * collapsed. Restores the sidebar footer's quick controls — Settings,
 * Approvals, Shares, Devices — as a column of icon buttons (same glass shell
 * as the top corner pills, same popovers as the sidebar footer), so hiding
 * the sidebar doesn't cost access to approvals or device state.
 */
export function CollapsedSidebarCornerPill({
  chats,
  onSelectChat,
  quickSettings,
  onAppearanceQuickChange,
  onOpenSettings,
  onOpenSettingsTab,
  onOpenWorkspacePopout,
  canOpenWorkspacePopout,
  onQuitApp,
  pendingAgentApprovalByChatId = {},
  pendingApprovalQueueByChatId = {},
  onRespondAgentApproval,
  pendingAgentQuestionsByChatId = {},
  onAnswerAgentQuestion,
  onDismissAgentQuestion,
  collaborationShares = [],
  collaboratingChatIds,
  hasConnectedCollaborator,
  onRevokeShare
}: CollapsedSidebarCornerPillProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Exclusive panel state — mirrors the sidebar footer, where opening any
  // control closes the others so at most one popover is up.
  const [openPanel, setOpenPanel] = useState<CornerPillPanel | null>(null)
  const [settingsPane, setSettingsPane] = useState<SidebarSettingsMenuPane>('root')
  const [pairedDevices, setPairedDevices] = useState<PairedRemoteDeviceSummary[]>([])
  const [remoteDeviceConnected, setRemoteDeviceConnected] = useState(false)

  const togglePanel = useCallback((panel: CornerPillPanel) => {
    setSettingsPane('root')
    setOpenPanel((current) => (current === panel ? null : panel))
  }, [])

  // Same 5s paired-device poll as the sidebar footer; only runs while the
  // pill is mounted (sidebar collapsed), so it never doubles the poll.
  useEffect(() => {
    if (!IOS_REMOTE_ENABLED) {
      setRemoteDeviceConnected(false)
      return
    }
    let cancelled = false
    const refreshRemoteDevices = async (): Promise<void> => {
      try {
        const devices = (await window.api.bridgeListPairedDevices()) as PairedRemoteDeviceSummary[]
        if (!cancelled) {
          const list = devices ?? []
          setPairedDevices(list)
          setRemoteDeviceConnected(list.some((device) => device.connected))
        }
      } catch {
        if (!cancelled) {
          setPairedDevices([])
          setRemoteDeviceConnected(false)
        }
      }
    }
    void refreshRemoteDevices()
    const interval = window.setInterval(() => {
      void refreshRemoteDevices()
    }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  // Outside click / Escape closes whichever popover is open (one listener,
  // matching the sidebar footer's dismissal contract).
  useEffect(() => {
    if (!openPanel) return
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const wrap = wrapRef.current
      if (!wrap) return
      if (event.target instanceof Node && wrap.contains(event.target)) return
      setOpenPanel(null)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPanel(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openPanel])

  // Host Arc Wave 5c Phase 2 — dual-read join (same contract as Sidebar).
  const hostProjectionStore = useHostProjectionStore()
  const hostProjectionState = useHostProjection(hostProjectionStore)
  const pendingApprovalsFlat = useMemo(
    () =>
      joinHostPendingApprovals(
        hostProjectionState,
        pendingAgentApprovalByChatId,
        pendingApprovalQueueByChatId
      ),
    [hostProjectionState, pendingAgentApprovalByChatId, pendingApprovalQueueByChatId]
  )
  const pendingQuestionsFlat = useMemo(
    () => flattenPendingAgentQuestions(pendingAgentQuestionsByChatId),
    [pendingAgentQuestionsByChatId]
  )
  const hasPendingApprovals = pendingApprovalsFlat.length > 0
  const hasPendingQuestions = pendingQuestionsFlat.length > 0
  const hasNeedsInputAttention = hasPendingApprovals || hasPendingQuestions
  const loadRecentApprovals = useCallback(
    () => window.api.getApprovalLedger({ statuses: ['approved', 'denied'], limit: 3 }),
    []
  )

  const jumpToChat = useCallback(
    (chatId: string) => {
      setOpenPanel(null)
      const chat = chats.find((candidate) => candidate.appChatId === chatId)
      if (chat) onSelectChat(chat)
    },
    [chats, onSelectChat]
  )
  const resolveChatTitle = useCallback(
    (chatId: string) => chats.find((candidate) => candidate.appChatId === chatId)?.title,
    [chats]
  )

  return (
    <div
      ref={wrapRef}
      className="chat-corner-controls chat-corner-controls-bottom-left"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Quick controls"
    >
      <button
        className={`chat-corner-btn${openPanel === 'settings' ? ' active' : ''}`}
        type="button"
        onClick={() => togglePanel('settings')}
        title="Settings"
        aria-label="Open settings menu"
        aria-haspopup="menu"
        aria-expanded={openPanel === 'settings'}
      >
        <GearSymbolIcon />
      </button>
      <button
        className={`chat-corner-btn${hasNeedsInputAttention ? ' glow-red' : ''}${
          openPanel === 'approvals' ? ' active' : ''
        }`}
        type="button"
        onClick={() => togglePanel('approvals')}
        title={
          hasPendingQuestions && hasPendingApprovals
            ? 'Approvals — pending questions and approvals'
            : hasPendingQuestions
              ? 'Approvals — needs your input'
              : hasPendingApprovals
                ? 'Approvals — pending approval'
                : 'Approvals'
        }
        aria-label={
          hasPendingQuestions && hasPendingApprovals
            ? 'Approvals, questions and approvals are waiting'
            : hasPendingQuestions
              ? 'Approvals, an agent question is waiting'
              : hasPendingApprovals
                ? 'Approvals, a pending approval is waiting'
                : 'Approvals'
        }
        aria-haspopup="dialog"
        aria-expanded={openPanel === 'approvals'}
      >
        <ApprovalsShieldIcon />
      </button>
      <button
        className={`chat-corner-btn${hasConnectedCollaborator ? ' glow-yellow' : ''}${
          openPanel === 'shares' ? ' active' : ''
        }`}
        type="button"
        onClick={() => togglePanel('shares')}
        title={hasConnectedCollaborator ? 'People — someone connected' : 'People'}
        aria-label={hasConnectedCollaborator ? 'People, someone is connected' : 'People'}
        aria-haspopup="dialog"
        aria-expanded={openPanel === 'shares'}
      >
        <ShareNetworkIcon />
      </button>
      {IOS_REMOTE_ENABLED && (
        <button
          className={`chat-corner-btn${remoteDeviceConnected ? ' glow-green' : ''}${
            openPanel === 'devices' ? ' active' : ''
          }`}
          type="button"
          onClick={() => togglePanel('devices')}
          title={remoteDeviceConnected ? 'Devices — connected' : 'Devices'}
          aria-label={remoteDeviceConnected ? 'Devices, a device is connected' : 'Devices'}
          aria-haspopup="dialog"
          aria-expanded={openPanel === 'devices'}
        >
          <RemoteConnectionSymbolIcon />
        </button>
      )}
      {openPanel === 'settings' && (
        <SidebarSettingsMenu
          pane={settingsPane}
          setPane={setSettingsPane}
          quickSettings={quickSettings}
          onAppearanceQuickChange={onAppearanceQuickChange}
          onOpenSettings={() => {
            setOpenPanel(null)
            onOpenSettings()
          }}
          onOpenWorkspacePopout={onOpenWorkspacePopout}
          canOpenWorkspacePopout={canOpenWorkspacePopout}
          onQuitApp={onQuitApp}
          onClose={() => {
            setOpenPanel(null)
            setSettingsPane('root')
          }}
        />
      )}
      {openPanel === 'approvals' && (
        <ApprovalsFooterPopover
          pendingApprovals={pendingApprovalsFlat}
          pendingQuestions={pendingQuestionsFlat}
          resolveChatTitle={resolveChatTitle}
          onJumpToChat={jumpToChat}
          onRespondApproval={onRespondAgentApproval}
          onAnswerQuestion={onAnswerAgentQuestion}
          onDismissQuestion={onDismissAgentQuestion}
          loadRecent={loadRecentApprovals}
          onOpenSettings={() => {
            setOpenPanel(null)
            onOpenSettingsTab('approval-ledger')
          }}
        />
      )}
      {openPanel === 'shares' && (
        <SharesFooterPopover
          shares={collaborationShares}
          resolveChatTitle={(chatId) =>
            chats.find((candidate) => candidate.appChatId === chatId)?.title
          }
          connectedShareChatIds={collaboratingChatIds}
          onJumpToChat={jumpToChat}
          onRevokeShare={onRevokeShare}
          onOpenSettings={() => {
            setOpenPanel(null)
            onOpenSettingsTab('shares')
          }}
        />
      )}
      {openPanel === 'devices' && (
        <DevicesFooterPopover
          devices={pairedDevices}
          onOpenSettings={() => {
            setOpenPanel(null)
            onOpenSettingsTab('pairing')
          }}
        />
      )}
    </div>
  )
}
