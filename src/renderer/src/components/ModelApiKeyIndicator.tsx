import { ApiKeyRequiredIcon } from './icons/ApiKeyRequiredIcon'
import { API_KEY_MODEL_INDICATOR_LABEL } from '../../../shared/apiKeyModelIndicator'

/**
 * The API-key mark on a model picker row. Rendered when
 * `modelRequiresApiKey(provider, modelId)` holds — see that module for why the
 * predicate is narrow.
 *
 * Split out as a pure view for two reasons: both picker row layouts
 * (single-provider and cross-provider grouped) render the identical span, and
 * CombinedModelPicker's popover only mounts behind internal `open` state plus a
 * measured anchor position, so its rows cannot be reached by
 * `renderToStaticMarkup`. Keeping the mark here means the markup, class hook and
 * tooltip are actually covered by a render test instead of only asserted in CSS.
 */
export function ModelApiKeyIndicator(): React.JSX.Element {
  return (
    <span
      className="composer-combined-picker-api-indicator"
      title={API_KEY_MODEL_INDICATOR_LABEL}
      aria-label={API_KEY_MODEL_INDICATOR_LABEL}
    >
      <ApiKeyRequiredIcon className="api-key-required-icon" />
    </span>
  )
}
