/**
 * Setup-mutation helpers.
 *
 * The routing catalogue remains the single source of truth. This module only
 * gives the executor a narrow typed view and must not grow a parallel list.
 */

import type { HostCommand } from '../shared/hostProtocol'
import {
  HOST_SETUP_MUTATION_COMMAND_NAMES,
  parseSetupMutationCommandName
} from './HostCommandRouting'

export type HostSetupCommandName = (typeof HOST_SETUP_MUTATION_COMMAND_NAMES)[number]

export function isHostSetupCommandName(value: unknown): value is HostSetupCommandName {
  return parseSetupMutationCommandName(value) !== null
}

export function isHostSetupCommand(command: HostCommand): command is HostCommand & {
  readonly name: HostSetupCommandName
} {
  return isHostSetupCommandName(command.name)
}
