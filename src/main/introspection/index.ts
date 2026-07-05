export {
  INTROSPECTION_SCHEMA_VERSION,
  defaultScopeForKind,
  dedupeMemoryProposals,
  evidenceItemToRef,
  normalizeIntrospectionEvidenceItem,
  normalizeIntrospectionEvidenceRef,
  normalizeIntrospectionRunRecord,
  normalizeMemoryProposal,
  normalizeMemoryProposalPack,
  proposalRequiresReview
} from './IntrospectionModel'

export {
  buildMemoryProposalPackInput,
  buildProposalDedupKey,
  classifyEvidenceSignal,
  generateProposalsFromEvidence,
  proposalFromEvidenceItem,
  type EvidenceSignalClassification,
  type GenerateProposalsOptions
} from './IntrospectionProposalGenerator'