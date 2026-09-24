// Compatibility re-export: the implementation lives in src/shared so renderer
// and main can both consume it without a renderer -> main runtime edge.
export {
  canPersistPlaintextFieldValue,
  isLikelySecretFieldName,
  isLikelySecretHeaderName,
  isSecretReferenceValue
} from '../shared/PlaintextSecretPolicy'
