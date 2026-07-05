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

export {
  chatTouchesWindow,
  harvestIntrospectionEvidence,
  isTimestampInWindow,
  timestampMs,
  type HarvestEvidenceOptions,
  type IntrospectionHarvestSubstrate,
  type IntrospectionHarvestWindow
} from './IntrospectionEvidenceHarvester'

export {
  createIntrospectionRunServiceDeps,
  loadIntrospectionSubstrate,
  runManualIntrospection,
  type IntrospectionRunServiceDeps,
  type IntrospectionRunServiceStore,
  type RunManualIntrospectionInput,
  type RunManualIntrospectionResult
} from './IntrospectionRunService'