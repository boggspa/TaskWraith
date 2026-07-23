import type { AgenticServiceId, AgenticServicesSettings } from '../../../main/store/types'
import type { WorkspacePolicyService } from './workspacePolicyServices'

export function toolGrantCanBeApplied(
  service: AgenticServiceId,
  agenticServices: AgenticServicesSettings
): boolean {
  return agenticServices[service] !== 'deny'
}

export function countEffectiveToolGrants(
  grantServices: WorkspacePolicyService[],
  enabledGrantIds: Set<AgenticServiceId>,
  agenticServices: AgenticServicesSettings
): number {
  return grantServices.filter(
    (service) =>
      enabledGrantIds.has(service.id) && toolGrantCanBeApplied(service.id, agenticServices)
  ).length
}
