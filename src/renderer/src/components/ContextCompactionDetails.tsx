import type { ProviderContextPolicy } from '../../../shared/providerContextPolicy'
import { providerContextPolicyDetails } from '../../../shared/providerContextPolicy'
import './ContextCompactionDetails.css'

export function ContextCompactionDetails({
  policy
}: {
  policy?: ProviderContextPolicy
}): React.JSX.Element | null {
  if (!policy) return null
  return (
    <details className="context-compaction-details">
      <summary>Context limits</summary>
      <dl>
        {providerContextPolicyDetails(policy).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>The token count before compaction can exceed its trigger between provider checks.</p>
    </details>
  )
}
