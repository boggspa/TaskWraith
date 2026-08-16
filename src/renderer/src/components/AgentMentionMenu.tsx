import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ChatRecord,
  ChildAgentThread,
  ComposerStyle,
  EnsembleParticipant,
  ExternalPathGrant,
  AgentIdentity,
  ProviderId,
  WorkspaceFileEntry
} from '../../../main/store/types'
import { deriveChildAgentThreads } from '../lib/ChildAgentThreads'
import { getProviderName } from './Sidebar'
import type { ComposerMentionTriggerKind } from '../lib/ComposerMentionTrigger'
import {
  ENSEMBLE_GROUP_MENTIONS,
  ensembleGroupMentionMatchesStage
} from '../../../shared/ensembleGroupMention'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'

export type ComposerMentionKind =
  | 'agent'
  | 'group'
  | 'participant'
  | 'workspace-file'
  | 'external-grant'

export interface ComposerMentionPick {
  kind: ComposerMentionKind
  name: string
  agentId?: string
  /** Ensemble participant id when `kind === 'participant'`. Routes
   * the next run as a DM via an exact, non-visible picker selection. */
  participantId?: string
  /** Provider id for participant mentions, used by the renderer to
   * apply the matching `--provider-{name}-color` tint on the inserted
   * chip and the inline transcript token. */
  provider?: ProviderId
  path?: string
  isDirectory?: boolean
  access?: ExternalPathGrant['access']
}

export interface ComposerMentionCandidate extends ComposerMentionPick {
  id: string
  detail?: string
  color?: string
  identity?: AgentIdentity
}

interface AgentMentionMenuProps {
  chat?: ChatRecord
  provider?: ProviderId
  workspacePath?: string
  externalPathGrants?: ExternalPathGrant[]
  /** The current composer prompt value. Kept for compatibility with existing callers. */
  prompt?: string
  /** Caller-controlled visibility. Parent toggles this on `@` keypress. */
  open: boolean
  /** Anchor element (the textarea) used to position the popover. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Filter substring (what comes after the trailing `@`). */
  query: string
  /** Which trigger fired the popover. `'mention'` (`@`) surfaces
   * sub-agents in normal chats or participants in ensemble chats;
   * `'file-mention'` (`-@`) surfaces workspace files + external
   * path grants. Defaults to `'mention'` for compatibility with
   * existing callers that pre-date the trigger split. */
  triggerKind?: ComposerMentionTriggerKind
  /** Ensemble participants currently in the chat. Only consulted
   * when `triggerKind === 'mention'` AND `chat.chatKind === 'ensemble'`.
   * The pick handler turns one of these into an `ensemble-dm://`
   * markdown chip. */
  ensembleParticipants?: EnsembleParticipant[]
  /** Replace the `@<query>` token in the prompt with the selected mention target. */
  onPick: (mention: ComposerMentionPick) => void
  /** Dismiss without picking. */
  onDismiss: () => void
  /**
   * 1.0.6-EW67 — Active composer shell, mirrored onto the portal
   * root as `shell-${composerStyle}` so the theme-immune Obsidian /
   * Alabaster popover CSS reaches this body-portaled menu.
   */
  composerStyle?: ComposerStyle
}

export function filterComposerMentionCandidates(
  candidates: ComposerMentionCandidate[],
  query: string,
  limit = 80
): ComposerMentionCandidate[] {
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? candidates.filter((candidate) => {
        const haystack = [
          candidate.name,
          candidate.detail,
          candidate.path,
          candidate.kind.replace('-', ' ')
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(trimmed)
      })
    : candidates
  return filtered.slice(0, limit)
}

export function composerMentionParticipantColor(
  participant: Pick<EnsembleParticipant, 'provider' | 'model'>
): string {
  const providerClass = resolveProviderHueClass(participant.provider, participant.model)
  return `var(--provider-${providerClass}-color, var(--accent))`
}

/**
 * Provider-neutral group rows shown above individual participants. Their name
 * is also the exact insertion text (`@All`, etc.), so existing Composer
 * fallback insertion remains plain editable text and carries no hidden target
 * identity.
 */
export function composerEnsembleGroupMentionCandidates(
  participants: EnsembleParticipant[]
): ComposerMentionCandidate[] {
  const enabled = participants.filter((participant) => participant.enabled !== false)
  if (enabled.length === 0) return []
  return ENSEMBLE_GROUP_MENTIONS.flatMap<ComposerMentionCandidate>((definition) => {
    const count = enabled.filter((participant) =>
      ensembleGroupMentionMatchesStage(definition.id, participant.stageRole)
    ).length
    if (count === 0) return []
    return [
      {
        id: `group:${definition.id}`,
        kind: 'group',
        name: definition.token,
        detail: `${definition.description} · ${count} ${count === 1 ? 'seat' : 'seats'}`,
        color: 'var(--user-bubble-base, var(--accent))'
      }
    ]
  })
}

function nameFromPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

/**
 * Floating popover anchored to the composer textarea that lists active
 * subagents, workspace files, and already-granted external paths. Selecting
 * a subagent inserts the canonical agent markdown mention; selecting a file
 * or grant inserts plain path text only.
 */
export function AgentMentionMenu({
  chat,
  provider,
  workspacePath,
  externalPathGrants = [],
  open,
  anchorRef,
  query,
  triggerKind = 'mention',
  ensembleParticipants,
  onPick,
  onDismiss,
  composerStyle
}: AgentMentionMenuProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const workspaceFileCacheRef = useRef<Map<string, WorkspaceFileEntry[]>>(new Map())
  const loadingWorkspacePathsRef = useRef<Set<string>>(new Set())
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([])
  const [highlight, setHighlight] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const cleanupFrames: number[] = []
    const deferFiles = (files: WorkspaceFileEntry[]): void => {
      const frame = window.requestAnimationFrame(() => {
        if (!cancelled) setWorkspaceFiles(files)
      })
      cleanupFrames.push(frame)
    }

    // File listing is only relevant for the `-@` file trigger. The
    // plain `@` mention popover renders sub-agents or participants
    // and never consumes the workspace-file list, so skip the IPC
    // call when the trigger doesn't need it.
    if (!open || !workspacePath || triggerKind !== 'file-mention') {
      deferFiles([])
      return () => {
        cancelled = true
        cleanupFrames.forEach((frame) => window.cancelAnimationFrame(frame))
      }
    }
    const cached = workspaceFileCacheRef.current.get(workspacePath)
    if (cached) {
      deferFiles(cached)
      return () => {
        cancelled = true
        cleanupFrames.forEach((frame) => window.cancelAnimationFrame(frame))
      }
    }
    if (loadingWorkspacePathsRef.current.has(workspacePath)) {
      return () => {
        cancelled = true
        cleanupFrames.forEach((frame) => window.cancelAnimationFrame(frame))
      }
    }
    loadingWorkspacePathsRef.current.add(workspacePath)
    window.api
      .listWorkspaceFiles(workspacePath)
      .then((files) => {
        workspaceFileCacheRef.current.set(workspacePath, files)
        if (!cancelled) setWorkspaceFiles(files)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([])
      })
      .finally(() => {
        loadingWorkspacePathsRef.current.delete(workspacePath)
      })
    return () => {
      cancelled = true
      cleanupFrames.forEach((frame) => window.cancelAnimationFrame(frame))
    }
  }, [open, workspacePath, triggerKind])

  const activeSubagents = useMemo<ChildAgentThread[]>(() => {
    if (!chat || !provider) return []
    const all = deriveChildAgentThreads(provider, chat.appChatId, chat.messages || [], chat)
    return all.filter((thread) => thread.state === 'running' || thread.state === 'queued')
  }, [chat, provider])

  const candidates = useMemo<ComposerMentionCandidate[]>(() => {
    // `-@` file trigger surfaces workspace files + external grants
    // only. Sub-agents / participants are never in scope here — they
    // need `@`.
    if (triggerKind === 'file-mention') {
      const workspaceItems = workspaceFiles.map<ComposerMentionCandidate>((entry) => ({
        id: `workspace:${entry.path}`,
        kind: 'workspace-file',
        name: entry.path,
        path: entry.path,
        isDirectory: entry.isDirectory,
        detail: entry.isDirectory ? 'Workspace folder' : 'Workspace file'
      }))
      const externalItems = externalPathGrants.map<ComposerMentionCandidate>((grant) => ({
        id: `external:${grant.id || grant.path}`,
        kind: 'external-grant',
        name: nameFromPath(grant.path),
        path: grant.path,
        isDirectory: grant.kind === 'directory',
        access: grant.access,
        detail: `${grant.access === 'write' ? 'Editable' : 'Readable'} external path`
      }))
      return [...workspaceItems, ...externalItems]
    }

    // `@` trigger in ensemble chats: list participants so the user
    // can address a stage group or DM-target a specific provider.
    // Both picker forms write plain editable text; individual seats
    // additionally keep an exact id as short-lived dispatch metadata.
    if (chat?.chatKind === 'ensemble' && ensembleParticipants) {
      const groupItems = composerEnsembleGroupMentionCandidates(ensembleParticipants)
      const participantItems = ensembleParticipants
        .filter((participant) => participant.enabled)
        .sort((a, b) => a.order - b.order)
        .map<ComposerMentionCandidate>((participant) => {
          const role = participant.role?.trim() || ''
          const providerName = getProviderName(participant.provider)
          const modelDetail =
            participant.model && participant.model !== 'cli-default'
              ? `${providerName} · ${participant.model}`
              : providerName
          // Display name: prefer the user-set role (e.g. "Worker"),
          // fall back to the provider name. The detail line always
          // shows the provider so the user can disambiguate by
          // role-alone in a busy ensemble.
          const name = role || providerName
          return {
            id: `participant:${participant.id}`,
            kind: 'participant',
            participantId: participant.id,
            provider: participant.provider,
            name,
            detail: role ? modelDetail : participant.provider,
            // Resolve to the theme's `--provider-{name}-color` CSS
            // variable at popover-render time. Falls back to the
            // accent if the var isn't defined.
            color: composerMentionParticipantColor(participant)
          }
        })
      return [...groupItems, ...participantItems]
    }

    const subagentCandidates = activeSubagents.map<ComposerMentionCandidate>((thread) => {
      const identity = thread.identity
      const name = identity?.name || thread.name
      return {
        id: `agent:${thread.id}`,
        kind: 'agent',
        agentId: thread.id,
        name,
        detail: identity?.role || thread.role || 'Agent',
        color: identity?.color,
        identity
      }
    })
    return subagentCandidates
  }, [
    triggerKind,
    chat?.chatKind,
    ensembleParticipants,
    activeSubagents,
    externalPathGrants,
    provider,
    workspaceFiles
  ])

  const filtered = useMemo(
    () => filterComposerMentionCandidates(candidates, query),
    [candidates, query]
  )

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (!open) {
        setPosition(null)
        return
      }
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      setPosition({ left: rect.left + 8, top: rect.top - 8 })
    })
    return () => {
      cancelled = true
    }
  }, [open, anchorRef, query])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setHighlight(0)
    })
    return () => {
      cancelled = true
    }
  }, [filtered])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (!open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
      if (filtered.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => (current + 1) % filtered.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => (current - 1 + filtered.length) % filtered.length)
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const choice = filtered[highlight]
        if (choice) onPick(choice)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, highlight, onPick, onDismiss])

  useEffect(() => {
    if (!open) return
    const onMouse = (event: MouseEvent) => {
      const popover = popoverRef.current
      const anchor = anchorRef.current
      if (popover?.contains(event.target as Node)) return
      if (anchor?.contains(event.target as Node)) return
      onDismiss()
    }
    window.addEventListener('mousedown', onMouse, true)
    return () => window.removeEventListener('mousedown', onMouse, true)
  }, [open, anchorRef, onDismiss])

  if (!open || !position) return null

  return createPortal(
    <div
      ref={popoverRef}
      className={`agent-mention-menu shell-${composerStyle || 'default'}`}
      role="listbox"
      aria-label="Mentions"
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        transform: 'translateY(-100%)',
        zIndex: 50
      }}
    >
      {filtered.length === 0 ? (
        <div className="agent-mention-menu-empty">
          {candidates.length === 0
            ? triggerKind === 'file-mention'
              ? 'No workspace files or external paths available'
              : chat?.chatKind === 'ensemble'
                ? ensembleParticipants && ensembleParticipants.length > 0
                  ? 'All ensemble participants are disabled — enable one to mention it'
                  : 'No ensemble participants to mention'
                : 'No active sub-agents — type `-@` to mention files'
            : `No matches for "${query}"`}
        </div>
      ) : (
        <ul className="agent-mention-menu-list">
          {filtered.map((candidate, index) => {
            const isHighlighted = index === highlight
            return (
              <li
                key={candidate.id}
                role="option"
                aria-selected={isHighlighted}
                className={`agent-mention-menu-item ${isHighlighted ? 'is-highlighted' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => onPick(candidate)}
              >
                {candidate.kind === 'agent' ? (
                  <AgentIdentityIcon
                    identity={candidate.identity}
                    seed={candidate.agentId || candidate.name}
                    color={candidate.color}
                    size={18}
                    className="agent-mention-menu-icon"
                  />
                ) : (
                  <span
                    className={`agent-mention-menu-dot kind-${candidate.kind}`}
                    style={candidate.color ? { background: candidate.color } : undefined}
                    aria-hidden
                  />
                )}
                <span className="agent-mention-menu-copy">
                  <span
                    className="agent-mention-menu-name"
                    style={candidate.color ? { color: candidate.color } : undefined}
                  >
                    {candidate.name}
                  </span>
                  {candidate.detail && (
                    <span className="agent-mention-menu-role">{candidate.detail}</span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>,
    document.body
  )
}
