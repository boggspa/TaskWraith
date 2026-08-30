/**
 * Maximum model rows projected for one provider in picker/catalog payloads.
 * Producers truncate to this boundary and transport decoders reject anything
 * larger so both sides share one bounded wire contract.
 */
export const PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER = 64
