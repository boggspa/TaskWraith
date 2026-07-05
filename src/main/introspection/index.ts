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

export {
  applyMemoryProposal,
  type ApplyMemoryProposalBlockReason,
  type ApplyMemoryProposalResult,
  type IntrospectionApplyServiceDeps,
  type IntrospectionApplyServiceStore
} from './IntrospectionApplyService'

export {
  expireDueMemoryProposals,
  supersedeMemoryProposal,
  type ExpireDueMemoryProposalsInput,
  type ExpireDueMemoryProposalsResult,
  type IntrospectionLifecycleServiceDeps,
  type IntrospectionLifecycleServiceStore,
  type MemoryProposalPatch,
  type SupersedeMemoryProposalBlockReason,
  type SupersedeMemoryProposalInput,
  type SupersedeMemoryProposalResult
} from './IntrospectionLifecycleService'

export {
  INTROSPECTION_SCHEDULE_INTERVAL_MS,
  buildRolling24hWindow,
  calendarDayKey,
  computeNextIntrospectionRunAt,
  dispatchDueIntrospectionSchedules,
  getNextIntrospectionScheduleRunAtMs,
  hasScheduledIntrospectionForDay,
  isIntrospectionScheduleDue,
  mergeIntrospectionScheduleUpdate,
  normalizeIntrospectionScheduleRecord,
  scheduleWorkspaceKey,
  toIntrospectionScheduleSettings,
  type DispatchDueIntrospectionSchedulesResult,
  type IntrospectionSchedulerStore
} from './IntrospectionScheduler'