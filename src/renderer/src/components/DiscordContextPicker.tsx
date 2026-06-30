import { useEffect, useMemo, useState } from 'react'
import type {
  DiscordContextLimit,
  DiscordContextSelection,
  DiscordContextTargetChannel,
  DiscordContextTargets
} from '../../../main/channels/DiscordContextService'

interface DiscordContextPickerProps {
  open: boolean
  targets: DiscordContextTargets | null
  loading: boolean
  error?: string
  currentSelection?: DiscordContextSelection | null
  onRefresh: () => void
  onSelect: (selection: DiscordContextSelection) => void
  onClose: () => void
}

const LIMIT_OPTIONS: DiscordContextLimit[] = [10, 25, 50, 100]

export function DiscordContextPicker({
  open,
  targets,
  loading,
  error,
  currentSelection,
  onRefresh,
  onSelect,
  onClose
}: DiscordContextPickerProps) {
  const [query, setQuery] = useState('')
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [limit, setLimit] = useState<DiscordContextLimit>(25)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedChannelId(currentSelection?.channelId || '')
    setLimit(currentSelection?.limit || 25)
  }, [currentSelection?.channelId, currentSelection?.limit, open])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, open])

  const channels = useMemo(() => {
    const all: DiscordContextTargetChannel[] = []
    for (const guild of targets?.guilds || []) {
      all.push(...guild.channels)
    }
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter((channel) =>
      `${channel.guildName} ${channel.label}`.toLowerCase().includes(needle)
    )
  }, [query, targets?.guilds])

  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId)
  const configured = Boolean(targets?.configured)
  const setupPath = targets?.setup?.configFilePath

  if (!open) return null

  return (
    <div className="discord-context-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="discord-context-picker-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discord-context-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="discord-context-picker-header">
          <div>
            <h2 id="discord-context-picker-title">Add Discord context</h2>
            <p>Attach a scoped, run-only snapshot as untrusted model context.</p>
          </div>
          <button type="button" className="discord-context-picker-close" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="discord-context-picker-body">
          {loading ? (
            <div className="discord-context-picker-empty">Loading Discord channels...</div>
          ) : error ? (
            <div className="discord-context-picker-error">
              <strong>Discord unavailable</strong>
              <span>{error}</span>
              <button type="button" onClick={onRefresh}>
                Retry
              </button>
            </div>
          ) : targets && !targets.configured ? (
            <div className="discord-context-picker-empty">
              <strong>Discord is not configured</strong>
              <span>{targets.reason}</span>
              {setupPath ? (
                <span>
                  Add the Discord bot token and server IDs to <code>{setupPath}</code>, then restart
                  TaskWraith.
                </span>
              ) : (
                <span>Add the Discord bot token and server IDs, then restart TaskWraith.</span>
              )}
            </div>
          ) : (
            <>
              <div className="discord-context-picker-controls">
                <label className="discord-context-picker-search" htmlFor="discord-context-picker-filter">
                  <span>Filter channels</span>
                  <input
                    id="discord-context-picker-filter"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter servers and channels"
                    aria-label="Filter channels"
                  />
                </label>
                <div className="discord-context-picker-limit" role="group" aria-label="Messages">
                  {LIMIT_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={option === limit ? 'is-active' : ''}
                      aria-pressed={option === limit}
                      onClick={() => setLimit(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <div className="discord-context-picker-list">
                {channels.length === 0 ? (
                  <div className="discord-context-picker-empty">
                    No readable Discord text channels found.
                  </div>
                ) : (
                  channels.map((channel) => (
                    <button
                      key={`${channel.guildId}-${channel.id}`}
                      type="button"
                      className={`discord-context-picker-channel${
                        channel.id === selectedChannelId ? ' is-selected' : ''
                      }`}
                      onClick={() => setSelectedChannelId(channel.id)}
                    >
                      <span className="discord-context-picker-channel-main">{channel.label}</span>
                      <span className="discord-context-picker-channel-sub">{channel.guildName}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <footer className="discord-context-picker-footer">
          <button type="button" className="discord-context-picker-secondary" onClick={onRefresh}>
            {configured ? 'Refresh' : 'Check again'}
          </button>
          {configured ? (
            <button
              type="button"
              className="discord-context-picker-primary"
              disabled={!selectedChannel}
              onClick={() => {
                if (!selectedChannel) return
                onSelect({
                  guildId: selectedChannel.guildId,
                  guildName: selectedChannel.guildName,
                  channelId: selectedChannel.id,
                  channelName: selectedChannel.name,
                  limit
                })
              }}
            >
              Add context
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  )
}
