import type { ExternalProviderThreadImportMetadata } from '../../../shared/externalProviderThreadImport'
import { externalProviderThreadImportLabel } from '../../../shared/externalProviderThreadImport'
import './ExternalProviderThreadImportBanner.css'

export function ExternalProviderThreadImportBanner({
  metadata
}: {
  metadata: ExternalProviderThreadImportMetadata
}): React.JSX.Element {
  const provider = externalProviderThreadImportLabel(metadata.provider)
  return (
    <aside className="external-provider-thread-import-banner" role="note">
      <strong>
        Imported {provider} snapshot · {metadata.sourceFileName}
      </strong>
      <span>
        External and untrusted · Add to prompt to bridge deliberately · native resume disabled
        {metadata.truncated ? ' · source truncated by import limits' : ''}
      </span>
    </aside>
  )
}
