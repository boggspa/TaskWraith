import { useId, type CSSProperties, type ReactElement } from 'react'
import {
  accentFromHue,
  pooledAgentIconProps,
  pooledIconColor,
  type PooledAgent
} from '../../lib/ensembleAgentPool'
import { namedAgentIdenticonForSlug } from '../../lib/agentIdentityCatalog'
import { getPoolIconAsset, preparePoolIconSvg } from '../../lib/agentPoolIconAssets'
import { AgentIdentityIcon } from './AgentIdentityIcon'
import { ProviderBrandLogo } from './ProviderBrandLogo'
import type { PooledAgentIdentitySnapshot } from '../../../../main/store/types'

type IdentityColorSource = (PooledAgent['identity'] | PooledAgentIdentitySnapshot) & {
  brightness?: number
  saturation?: number
}

interface PooledAgentIconProps {
  agent?: PooledAgent
  identity?: PooledAgentIdentitySnapshot
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
}

function resolvedTintColor(identity: IdentityColorSource): string {
  const hasUserTone =
    (typeof identity.saturation === 'number' && Number.isFinite(identity.saturation)) ||
    (typeof identity.brightness === 'number' && Number.isFinite(identity.brightness))
  return pooledIconColor(
    hasUserTone ? identity.accent : undefined,
    identity.hue,
    identity.hueEnabled,
    identity.brightness,
    identity.saturation
  )
}

/**
 * Renders a pooled Agent's icon across all three identity kinds:
 *  - `asset`  → an app-wide icon-pool asset (agent-pool-icons / official
 *               provider logo or Ensemble glyph / ghost / action / command),
 *               tinted when appropriate; falls back to procedural rendering if
 *               the asset key no longer resolves (a removed/renamed asset).
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
  const instanceId = useId().replace(/:/g, '')
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
    const accent = resolvedTintColor(identity)
    if (asset.providerLogo) {
      return (
        <span
          className={['agent-pool-asset-icon', className].filter(Boolean).join(' ')}
          style={{
            ...style,
            width: size,
            height: size,
            display: 'inline-flex',
            fontSize: size
          }}
          data-asset-key={asset.key}
          role={title ? 'img' : undefined}
          aria-label={title}
          aria-hidden={title ? undefined : true}
        >
          <ProviderBrandLogo provider={asset.providerLogo} />
        </span>
      )
    }
    return (
      <span
        className={['agent-pool-asset-icon', className].filter(Boolean).join(' ')}
        style={{ ...style, width: size, height: size, display: 'inline-flex', color: accent }}
        data-asset-key={asset.key}
        role={title ? 'img' : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        dangerouslySetInnerHTML={{
          __html: preparePoolIconSvg(asset, size, accent, instanceId)
        }}
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
      color: resolvedTintColor(agent.identity)
    }
  } else if (identity.iconKind === 'named' && identity.slug) {
    const entry = namedAgentIdenticonForSlug(identity.slug)
    iconProps = entry
      ? {
          name: entry.name,
          color: resolvedTintColor(identity)
        }
      : {
          seed: identity.seed || agentId,
          color: resolvedTintColor(identity)
        }
  } else {
    iconProps = {
      seed: identity.seed || agentId,
      color: resolvedTintColor(identity)
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
