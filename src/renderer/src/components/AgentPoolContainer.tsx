import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import type {
  AgenticServicesSettings,
  ComposerStyle,
  EnsembleParticipant,
  PooledAgentStatsSummary
} from '../../../main/store/types'
import {
  accentFromHue,
  hueForSeed,
  listPooledAgents,
  pooledAgentConfigFromLike,
  POOLED_AGENT_DRAG_MIME,
  removePooledAgent,
  ROSTER_PARTICIPANT_DRAG_MIME,
  subscribeEnsembleAgentPool,
  upsertPooledAgent,
  type PooledAgent
} from '../lib/ensembleAgentPool'
import { NAMED_AGENT_IDENTICONS } from '../lib/agentIdentityCatalog'
import {
  poolIconAssetsByGroup,
  preparePoolIconSvg,
  type PoolIconAsset
} from '../lib/agentPoolIconAssets'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import { CommittedDraftField } from './CommittedDraftField'
import { ParticipantPickerCluster } from './ParticipantPickerCluster'
import { AgentPoolCard } from './AgentPoolCard'

interface AgentPoolContainerProps {
  composerStyle: ComposerStyle
  agenticServices?: AgenticServicesSettings
  grokAvailable: boolean
  cursorAvailable: boolean
  /** Save a participant (by working id) into the pool — wired to the panel's
   *  editingRef-reading handler so a dropped participant captures unblurred
   *  edits. Enables the participant→pool drag direction. */
  onSaveParticipantToPool?: (participantId: string) => void
}

/** A single icon-pool asset rendered in the picker, tinted to its own accent. */
function PoolAssetSwatch({ asset, size }: { asset: PoolIconAsset; size: number }): JSX.Element {
  const accent = asset.accent ?? '#9AA0AA'
  return (
    <span
      className="agent-pool-asset-icon"
      style={{ width: size, height: size, display: 'inline-flex', color: accent }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: preparePoolIconSvg(asset, size, accent) }}
    />
  )
}

/** Synthesize a participant-shaped object so the shared picker cluster can edit
 *  the Agent's config the same way it edits a live participant. */
function syntheticParticipant(agent: PooledAgent): EnsembleParticipant {
  return {
    ...agent.config,
    id: agent.agentId,
    enabled: true,
    order: 1,
    geminiAuthProfileId: agent.config.geminiAuthProfileId ?? null,
    linkedProviderSessionId: null
  }
}

export function AgentPoolContainer({
  composerStyle,
  agenticServices,
  grokAvailable,
  cursorAvailable,
  onSaveParticipantToPool
}: AgentPoolContainerProps): JSX.Element {
  const [agents, setAgents] = useState<PooledAgent[]>(() => listPooledAgents())
  const [editId, setEditId] = useState<string | null>(null)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [stats, setStats] = useState<Record<string, PooledAgentStatsSummary>>({})
  const [isDropTarget, setIsDropTarget] = useState(false)
  const [nickRejectNonce, setNickRejectNonce] = useState(0)

  useEffect(() => {
    const refresh = (): void => setAgents(listPooledAgents())
    refresh()
    return subscribeEnsembleAgentPool(refresh)
  }, [])

  const editing = useMemo(
    () => agents.find((agent) => agent.agentId === editId) ?? null,
    [agents, editId]
  )

  // Lazy stats fetch: only the ids actually rendered, async-only IPC, never an
  // empty-means-all sweep (cf. the 1GB runEvents beachball). Re-fetches when the
  // set of agent ids changes.
  const agentIdsKey = useMemo(() => agents.map((a) => a.agentId).join(','), [agents])
  const fetchSeqRef = useRef(0)
  useEffect(() => {
    const ids = agentIdsKey ? agentIdsKey.split(',') : []
    if (ids.length === 0) {
      setStats({})
      return
    }
    const api = window.api as unknown as {
      getAgentStatsSummaries?: (ids: string[]) => Promise<PooledAgentStatsSummary[]>
    }
    if (typeof api?.getAgentStatsSummaries !== 'function') return
    const seq = (fetchSeqRef.current += 1)
    void api
      .getAgentStatsSummaries(ids)
      .then((summaries) => {
        if (seq !== fetchSeqRef.current) return
        const next: Record<string, PooledAgentStatsSummary> = {}
        for (const summary of summaries) next[summary.agentId] = summary
        setStats(next)
      })
      .catch(() => {
        /* stats are best-effort; a fetch miss just hides the strip */
      })
  }, [agentIdsKey])

  const updateConfig = useCallback(
    (agent: PooledAgent, patch: Partial<EnsembleParticipant>): void => {
      const merged = { ...syntheticParticipant(agent), ...patch }
      upsertPooledAgent({ ...agent, config: pooledAgentConfigFromLike(merged) })
    },
    []
  )

  const updateIdentity = useCallback(
    (agent: PooledAgent, identity: Partial<PooledAgent['identity']>): void => {
      // Identity is not part of config, but linked presets need the frozen
      // display snapshot so transcript rows can preserve name/icon/hue.
      upsertPooledAgent({
        ...agent,
        identity: { ...agent.identity, ...identity }
      })
    },
    []
  )

  const handleDelete = useCallback((agent: PooledAgent): void => {
    const ok = window.confirm(
      `Delete the "${agent.identity.nickname}" agent? Roster presets already using it keep their copy; this only removes it from the pool.`
    )
    if (!ok) return
    removePooledAgent(agent.agentId)
    setEditId((current) => (current === agent.agentId ? null : current))
  }, [])

  const onCardDragStart = useCallback(
    (event: DragEvent<HTMLSpanElement>, agent: PooledAgent): void => {
      event.dataTransfer.setData(POOLED_AGENT_DRAG_MIME, agent.agentId)
      event.dataTransfer.effectAllowed = 'copy'
    },
    []
  )

  // participant -> pool drop (save-to-pool by drag). We can only inspect
  // `types` during dragover (the payload is read-protected until drop), so the
  // drop affordance keys on the MIME type alone.
  const dropEnabled = typeof onSaveParticipantToPool === 'function'
  const onPoolDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (!dropEnabled || !event.dataTransfer.types.includes(ROSTER_PARTICIPANT_DRAG_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setIsDropTarget(true)
    },
    [dropEnabled]
  )
  const onPoolDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      setIsDropTarget(false)
      if (!dropEnabled) return
      const participantId = event.dataTransfer.getData(ROSTER_PARTICIPANT_DRAG_MIME)
      if (!participantId) return
      event.preventDefault()
      onSaveParticipantToPool?.(participantId)
    },
    [dropEnabled, onSaveParticipantToPool]
  )
  const dropProps = dropEnabled
    ? {
        onDragOver: onPoolDragOver,
        onDragLeave: () => setIsDropTarget(false),
        onDrop: onPoolDrop
      }
    : {}

  return (
    <section className="agent-pool-band" aria-label="Agent pool">
      <div className="agent-pool-head">
        <h3 className="agent-pool-title">Agent pool</h3>
        <p className="agent-pool-intro">
          Reusable agents you can add to any preset. Editing an agent here updates every preset
          that uses it. Save a participant to the pool with the ☆ button on its row.
        </p>
      </div>

      {agents.length === 0 ? (
        <div
          className={`agent-pool-empty${isDropTarget ? ' is-drop-target' : ''}`}
          {...dropProps}
        >
          No agents yet. Drag a participant here, or use “☆ Save to pool” on a roster participant,
          to create your first reusable agent.
        </div>
      ) : (
        <div
          className={`agent-pool-grid${isDropTarget ? ' is-drop-target' : ''}`}
          {...dropProps}
        >
          {agents.map((agent) => (
            <AgentPoolCard
              key={agent.agentId}
              agent={agent}
              isActive={agent.agentId === editId}
              stats={stats[agent.agentId]}
              onSelect={(id) => {
                setIconPickerOpen(false)
                setEditId((current) => (current === id ? null : id))
              }}
              onDelete={handleDelete}
              draggable
              onDragStart={onCardDragStart}
            />
          ))}
        </div>
      )}

      {editing && (
        <div className="agent-pool-editor" key={editing.agentId}>
          <div className="agent-pool-editor-identity">
            <PooledAgentIcon agent={editing} size={40} />
            <div className="agent-pool-editor-identity-fields">
              <CommittedDraftField
                // Remount on a rejected (empty) commit so the field snaps back to
                // the stored nickname instead of lingering visually blank — its
                // `committed` prop is unchanged, so it won't otherwise re-sync.
                key={`${editing.agentId}:${nickRejectNonce}`}
                className="settings-roster-input agent-pool-nickname"
                committed={editing.identity.nickname}
                onCommit={(value) => {
                  const next = value.trim()
                  if (next) updateIdentity(editing, { nickname: next })
                  else setNickRejectNonce((n) => n + 1)
                }}
                aria-label="Agent nickname"
                placeholder="Nickname"
                spellCheck={false}
              />
              <div className="agent-pool-icon-controls">
                <button
                  type="button"
                  className="agent-pool-mini-btn"
                  onClick={() => setIconPickerOpen((open) => !open)}
                  aria-expanded={iconPickerOpen}
                >
                  Icon…
                </button>
                <button
                  type="button"
                  className="agent-pool-mini-btn"
                  title="Reroll the procedural glyph + colour"
                  onClick={() => {
                    const seed = `${editing.agentId}#${Date.now().toString(36)}`
                    updateIdentity(editing, {
                      iconKind: 'seed',
                      seed,
                      slug: undefined,
                      assetKey: undefined,
                      accent: accentFromHue(hueForSeed(seed)),
                      hue: hueForSeed(seed)
                    })
                  }}
                >
                  Shuffle
                </button>
                {editing.identity.iconKind === 'seed' && (
                  <label className="agent-pool-hue">
                    <span className="agent-pool-hue-label">Hue</span>
                    <input
                      type="range"
                      min={0}
                      max={359}
                      value={editing.identity.hue}
                      onChange={(event) => {
                        const hue = Number(event.target.value)
                        updateIdentity(editing, { hue, accent: accentFromHue(hue) })
                      }}
                      aria-label="Icon hue"
                    />
                  </label>
                )}
              </div>
            </div>
            <button
              type="button"
              className="agent-pool-editor-close"
              onClick={() => setEditId(null)}
              aria-label="Close editor"
            >
              Done
            </button>
          </div>

          {iconPickerOpen && (
            <div className="agent-pool-icon-picker">
              {poolIconAssetsByGroup().map((section) => (
                <div key={section.group} className="agent-pool-icon-section">
                  <div className="agent-pool-icon-section-label">{section.group}</div>
                  <div className="agent-pool-icon-grid" role="listbox" aria-label={section.group}>
                    {section.assets.map((asset) => {
                      const selected =
                        editing.identity.iconKind === 'asset' &&
                        editing.identity.assetKey === asset.key
                      return (
                        <button
                          key={asset.key}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`agent-pool-icon-cell${selected ? ' is-selected' : ''}`}
                          title={asset.label}
                          onClick={() => {
                            updateIdentity(editing, {
                              iconKind: 'asset',
                              assetKey: asset.key,
                              slug: undefined,
                              accent: asset.accent ?? editing.identity.accent,
                              hue: asset.hue ?? editing.identity.hue
                            })
                            setIconPickerOpen(false)
                          }}
                        >
                          <PoolAssetSwatch asset={asset} size={26} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className="agent-pool-icon-section">
                <div className="agent-pool-icon-section-label">Characters</div>
                <div className="agent-pool-icon-grid" role="listbox" aria-label="Characters">
                  {NAMED_AGENT_IDENTICONS.map((entry) => {
                    const selected =
                      editing.identity.iconKind === 'named' && editing.identity.slug === entry.slug
                    return (
                      <button
                        key={entry.slug}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`agent-pool-icon-cell${selected ? ' is-selected' : ''}`}
                        title={entry.name}
                        onClick={() => {
                          updateIdentity(editing, {
                            iconKind: 'named',
                            slug: entry.slug,
                            assetKey: undefined,
                            accent: entry.accent,
                            hue: entry.hue
                          })
                          setIconPickerOpen(false)
                        }}
                      >
                        <AgentIdentityIcon name={entry.name} color={entry.accent} size={26} />
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="agent-pool-editor-controls">
            <ParticipantPickerCluster
              participant={syntheticParticipant(editing)}
              composerStyle={composerStyle}
              agenticServices={agenticServices}
              grokAvailable={grokAvailable}
              cursorAvailable={cursorAvailable}
              onPatch={(patch) => updateConfig(editing, patch)}
            />
          </div>

          <div className="agent-pool-editor-field">
            <span className="settings-roster-field-label">Role goal</span>
            <CommittedDraftField
              as="textarea"
              className="settings-roster-textarea"
              rows={2}
              committed={editing.config.instructions}
              onCommit={(value) => updateConfig(editing, { instructions: value })}
              placeholder="What should this agent focus on each turn?"
            />
          </div>
        </div>
      )}
    </section>
  )
}
