import type { ReactNode } from 'react'
import type { RightDockTab } from '../lib/rightDockState'
import {
  ChatMediaIcon,
  FileMenuSelectionIcon,
  PinnedMessagesIcon,
  RunRailSymbolIcon
} from './AppChromeSymbols'

export type RightDockHomeInspectorDestination =
  | 'diff'
  | 'raw'
  | 'delegation'
  | 'timeline'
  | 'background-tasks'
  | 'safety'
  | 'capabilities'

export type RightDockHomeSurface = Extract<RightDockTab, 'run' | 'media' | 'pins' | 'files'>

type RightDockHomeTarget =
  | { surface: RightDockHomeSurface }
  | { surface: 'inspector'; inspectorTab: RightDockHomeInspectorDestination }

export interface RightDockHomeDestination {
  id: string
  label: string
  description: string
  group: 'session' | 'inspect' | 'invocations' | 'governance'
  target: RightDockHomeTarget
  requires?: 'chat' | 'workspace'
  nested?: boolean
}

export const RIGHT_DOCK_HOME_DESTINATIONS: readonly RightDockHomeDestination[] = [
  {
    id: 'run',
    label: 'Live Lanes',
    description: 'Runs, handoffs, and active work',
    group: 'session',
    target: { surface: 'run' }
  },
  {
    id: 'media',
    label: 'Media Attachments',
    description: 'Images, audio, video, and paths',
    group: 'session',
    target: { surface: 'media' }
  },
  {
    id: 'pins',
    label: 'Pinned Messages',
    description: 'Notes and saved transcript items',
    group: 'session',
    target: { surface: 'pins' },
    requires: 'chat'
  },
  {
    id: 'files',
    label: 'File Editor',
    description: 'Browse and edit workspace files',
    group: 'session',
    target: { surface: 'files' },
    requires: 'workspace'
  },
  {
    id: 'diff',
    label: 'Diff Studio',
    description: 'Review workspace and run changes',
    group: 'inspect',
    target: { surface: 'inspector', inspectorTab: 'diff' }
  },
  {
    id: 'raw',
    label: 'Raw Events',
    description: 'Read provider and tool event output',
    group: 'inspect',
    target: { surface: 'inspector', inspectorTab: 'raw' }
  },
  {
    id: 'invocations',
    label: 'Invocations',
    description: 'Provider-native invocation details',
    group: 'invocations',
    target: { surface: 'inspector', inspectorTab: 'delegation' }
  },
  {
    id: 'timeline',
    label: 'Invocation Timeline',
    description: 'Parent and child execution history',
    group: 'invocations',
    target: { surface: 'inspector', inspectorTab: 'timeline' },
    nested: true
  },
  {
    id: 'live',
    label: 'Live Invocations',
    description: 'Active and background provider work',
    group: 'invocations',
    target: { surface: 'inspector', inspectorTab: 'background-tasks' },
    nested: true
  },
  {
    id: 'safety',
    label: 'Safety',
    description: 'Trust, permissions, and external access',
    group: 'governance',
    target: { surface: 'inspector', inspectorTab: 'safety' }
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    description: 'Provider tools, skills, and integrations',
    group: 'governance',
    target: { surface: 'inspector', inspectorTab: 'capabilities' }
  }
]

const RIGHT_DOCK_HOME_GROUPS = [
  { id: 'session', label: 'Session' },
  { id: 'inspect', label: 'Inspect' },
  { id: 'invocations', label: 'Invocations' },
  { id: 'governance', label: 'Governance' }
] as const

interface RightDockHomeProps {
  mediaCount: number
  pinnedCount: number
  hasCurrentChat: boolean
  hasWorkspaceContext: boolean
  onOpenSurface: (surface: RightDockHomeSurface) => void
  onOpenInspector: (destination: RightDockHomeInspectorDestination) => void
}

interface HomeCardProps {
  id: string
  label: string
  description: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  badge?: number
  nested?: boolean
}

function HomeGlyph({
  kind
}: {
  kind: 'diff' | 'raw' | 'invocations' | 'timeline' | 'live' | 'safety' | 'capabilities'
}) {
  const path = {
    diff: 'M3 5h7M3 9h10M3 13h6',
    raw: 'm3 5 3 3-3 3M8 12h5',
    invocations: 'M4 4v3c0 1.2 1 2 2.2 2H12M9 6l3 3-3 3',
    timeline: 'M4 3v12M7 5h6M7 9h4M7 13h7',
    live: 'M8 4v4l3 2M8 2a6 6 0 1 0 6 6',
    safety: 'M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4zM6 8l1.5 1.5L10.5 6',
    capabilities: 'm9 2-5 8h4l-1 6 6-9H9z'
  }[kind]
  return (
    <svg
      viewBox="0 0 16 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  )
}

function destinationIcon(id: string): ReactNode {
  if (id === 'run') return <RunRailSymbolIcon />
  if (id === 'media') return <ChatMediaIcon />
  if (id === 'pins') return <PinnedMessagesIcon />
  if (id === 'files') return <FileMenuSelectionIcon />
  return (
    <HomeGlyph
      kind={id as 'diff' | 'raw' | 'invocations' | 'timeline' | 'live' | 'safety' | 'capabilities'}
    />
  )
}

function HomeCard({
  id,
  label,
  description,
  icon,
  onClick,
  disabled,
  badge,
  nested
}: HomeCardProps) {
  return (
    <button
      type="button"
      data-right-dock-home-destination={id}
      className={`right-dock-home-card${nested ? ' right-dock-home-card--nested' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={`${label}. ${description}`}
    >
      <span className="right-dock-home-card-icon" aria-hidden>
        {icon}
      </span>
      <span className="right-dock-home-card-copy">
        <span className="right-dock-home-card-title">{label}</span>
        <span className="right-dock-home-card-description">{description}</span>
      </span>
      {typeof badge === 'number' && badge > 0 && (
        <span className="right-dock-home-card-badge" aria-label={`${badge} items`}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      <span className="right-dock-home-card-arrow" aria-hidden>
        ›
      </span>
    </button>
  )
}

/** Calm launch surface for every substantial right-dock destination. */
export function RightDockHome({
  mediaCount,
  pinnedCount,
  hasCurrentChat,
  hasWorkspaceContext,
  onOpenSurface,
  onOpenInspector
}: RightDockHomeProps) {
  const openDestination = (destination: RightDockHomeDestination): void => {
    if (destination.target.surface === 'inspector') {
      onOpenInspector(destination.target.inspectorTab)
      return
    }
    onOpenSurface(destination.target.surface)
  }

  return (
    <nav className="right-dock-home" aria-labelledby="right-dock-home-title">
      <header className="right-dock-home-header">
        <span className="right-dock-home-eyebrow">Sidebar</span>
        <h2 id="right-dock-home-title">Home</h2>
        <p>Open a workspace tool or inspect the current session.</p>
      </header>

      {RIGHT_DOCK_HOME_GROUPS.map((group) => (
        <section
          key={group.id}
          className={`right-dock-home-section${group.id === 'invocations' ? ' right-dock-home-section--nested' : ''}`}
          aria-labelledby={`right-dock-home-${group.id}`}
        >
          <h3 id={`right-dock-home-${group.id}`}>{group.label}</h3>
          <div className="right-dock-home-card-stack">
            {RIGHT_DOCK_HOME_DESTINATIONS.filter(
              (destination) => destination.group === group.id
            ).map((destination) => (
              <HomeCard
                key={destination.id}
                id={destination.id}
                label={destination.label}
                description={destination.description}
                icon={destinationIcon(destination.id)}
                nested={destination.nested}
                badge={
                  destination.id === 'media'
                    ? mediaCount
                    : destination.id === 'pins'
                      ? pinnedCount
                      : undefined
                }
                disabled={
                  (destination.requires === 'chat' && !hasCurrentChat) ||
                  (destination.requires === 'workspace' && !hasWorkspaceContext)
                }
                onClick={() => openDestination(destination)}
              />
            ))}
          </div>
        </section>
      ))}
    </nav>
  )
}
