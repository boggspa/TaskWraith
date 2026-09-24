/**
 * Compatibility re-export. The implementation moved to host-shared so the
 * standalone Node Host can compose the same work contract the App does - the
 * Host cannot import this bundle. Import sites in main are unchanged.
 */
export {
  buildAgentWorkContract,
  buildAgentWorkInvariants,
  buildAgentWorkState,
  TASKWRAITH_WORK_INVARIANTS_VERSION,
  type AgentWorkAssignmentContract,
  type AgentWorkCompletionAuthority,
  type AgentWorkContractInput,
  type AgentWorkGoalFacts
} from '../host-shared/AgentWorkContract'
