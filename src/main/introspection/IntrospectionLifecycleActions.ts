import {
  expireDueMemoryProposals,
  supersedeReviewedMemoryProposal,
  type ExpireDueMemoryProposalsInput,
  type IntrospectionLifecycleServiceStore,
  type ReviewedSupersedeMemoryProposalInput
} from './IntrospectionLifecycleService'

/** Settings lifecycle actions share one injected store and clock. */
export function createIntrospectionLifecycleActions(
  store: IntrospectionLifecycleServiceStore,
  now: () => string = () => new Date().toISOString()
) {
  const deps = { store, now }
  return {
    expireDueMemoryProposals: (input: ExpireDueMemoryProposalsInput) =>
      expireDueMemoryProposals(deps, input),
    supersedeMemoryProposal: (input: ReviewedSupersedeMemoryProposalInput) =>
      supersedeReviewedMemoryProposal(deps, input)
  }
}
