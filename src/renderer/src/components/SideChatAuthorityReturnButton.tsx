import { PeerThreadMessageSymbolIcon } from './AppChromeSymbols'

interface SideChatAuthorityReturnButtonProps {
  enabled: boolean
  onToggle: () => void
}

export function SideChatAuthorityReturnButton({
  enabled,
  onToggle
}: SideChatAuthorityReturnButtonProps) {
  return (
    <button
      type="button"
      className={`side-chat-action-btn side-chat-return-toggle ${enabled ? 'active' : ''}`}
      onClick={onToggle}
      title={
        enabled
          ? 'Return is on: completed replies queue to the parent authority inbox without interrupting its active run'
          : 'Return completed replies to the parent authority inbox; active parent runs are never interrupted'
      }
      aria-label="Return side-chat results to parent"
      aria-pressed={enabled}
    >
      <PeerThreadMessageSymbolIcon />
    </button>
  )
}
