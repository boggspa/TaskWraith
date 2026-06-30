import type { CSSProperties, ReactElement } from 'react'
import { accentFromHue, pooledAgentIconProps, type PooledAgent } from '../../lib/ensembleAgentPool'
import { getPoolIconAsset, preparePoolIconSvg } from '../../lib/agentPoolIconAssets'
import { AgentIdentityIcon } from './AgentIdentityIcon'

interface PooledAgentIconProps {
  agent: PooledAgent
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
  size = 28,
  className,
  style,
  title
}: PooledAgentIconProps): ReactElement {
  const { identity, agentId } = agent
  const asset = identity.iconKind === 'asset' ? getPoolIconAsset(identity.assetKey) : undefined

  if (asset) {
    const accent = identity.accent || asset.accent || accentFromHue(identity.hue)
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

  // 'named' / 'seed' — or an 'asset' whose key no longer resolves (props fall
  // through to the procedural seed via pooledAgentIconProps).
  const props =
    identity.iconKind === 'asset'
      ? { seed: identity.seed || agentId, color: identity.accent || accentFromHue(identity.hue) }
      : pooledAgentIconProps(agent)
  return (
    <AgentIdentityIcon
      name={props.name}
      seed={props.seed}
      color={props.color}
      size={size}
      className={className}
      style={style}
      title={title}
    />
  )
}
