import type { CSSProperties, ReactElement } from 'react'
import {
  accentFromHue,
  pooledAgentIconProps,
  pooledIconColor,
  type PooledAgent
} from '../../lib/ensembleAgentPool'
import { namedAgentIdenticonForSlug } from '../../lib/agentIdentityCatalog'
import { getPoolIconAsset, preparePoolIconSvg } from '../../lib/agentPoolIconAssets'
import { AgentIdentityIcon } from './AgentIdentityIcon'
import type { PooledAgentIdentitySnapshot } from '../../../../main/store/types'

interface PooledAgentIconProps {
  agent?: PooledAgent
  identity?: PooledAgentIdentitySnapshot
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
}

/**
 * Renders a pooled Agent's icon across all three identity kinds:
 *  - `asset`  → an app-wide icon-pool SVG (agent-pool-icons / provider glyph /
 *               ghost / action / command), tinted to the accent when the SVG is
 *               recolourable; falls back to procedural rendering if the asset key
 *               no longer resolves (a removed/renamed asset).
 *  - `named`  → a named identicon (delegated to AgentIdentityIcon).
 *  - `seed`   → procedural AgentIdenticon (delegated).
 */
export function PooledAgentIcon({
  agent,
  identity: snapshotIdentity,
  size = 28,
  className,
  style,
  title
}: PooledAgentIconProps): ReactElement {
  const identity = agent?.identity ?? snapshotIdentity
  const agentId = agent?.agentId ?? snapshotIdentity?.agentId ?? 'pooled-agent'
  if (!identity) {
    return (
      <AgentIdentityIcon
        seed={agentId}
        color={accentFromHue(210)}
        size={size}
        className={className}
        style={style}
        title={title}
      />
    )
  }
  const asset = identity.iconKind === 'asset' ? getPoolIconAsset(identity.assetKey) : undefined

  if (asset) {
    const accent = pooledIconColor(
      identity.accent || asset.accent,
      identity.hue,
      identity.hueEnabled
    )
    return (
      <span
        className={['agent-pool-asset-icon', className].filter(Boolean).join(' ')}
        style={{ ...style, width: size, height: size, display: 'inline-flex', color: accent }}
        data-asset-key={asset.key}
        role={title ? 'img' : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        dangerouslySetInnerHTML={{ __html: preparePoolIconSvg(asset, size, accent) }}
      />
    )
  }

  // 'named' / 'seed' — or an 'asset' whose key no longer resolves (falls
  // through to the procedural seed via pooledAgentIconProps).
  let iconProps: { name?: string; seed?: string; color: string }
  if (agent) {
    const base = pooledAgentIconProps(agent)
    iconProps = {
      ...base,
      color: pooledIconColor(base.color, agent.identity.hue, agent.identity.hueEnabled)
    }
  } else if (identity.iconKind === 'named' && identity.slug) {
    const entry = namedAgentIdenticonForSlug(identity.slug)
    iconProps = entry
      ? {
          name: entry.name,
          color: pooledIconColor(identity.accent || entry.accent, identity.hue, identity.hueEnabled)
        }
      : {
          seed: identity.seed || agentId,
          color: pooledIconColor(identity.accent, identity.hue, identity.hueEnabled)
        }
  } else {
    iconProps = {
      seed: identity.seed || agentId,
      color: pooledIconColor(identity.accent, identity.hue, identity.hueEnabled)
    }
  }
  return (
    <AgentIdentityIcon
      name={iconProps.name}
      seed={iconProps.seed}
      color={iconProps.color}
      size={size}
      className={className}
      style={style}
      title={title}
    />
  )
}
