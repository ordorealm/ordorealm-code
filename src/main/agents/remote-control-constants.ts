/**
 * Shared constants for DevFlow IDE Remote Control
 *
 * This module contains constants that are shared between multiple agent modules
 * to avoid circular dependencies.
 *
 * @module main/agents/remote-control-constants
 */

// ============ Operations Requiring Confirmation ============

/**
 * List of operations that require user confirmation before execution
 * These are sensitive operations that could have significant impact
 */
export const OPERATIONS_REQUIRING_CONFIRMATION = [
  'switch_project',
  'restart_session',
  'mcp_start',
  'mcp_stop',
  'skillgroup_switch',
] as const

export type OperationRequiringConfirmation = typeof OPERATIONS_REQUIRING_CONFIRMATION[number]

/**
 * Check if an operation requires confirmation
 *
 * @param operation - Operation identifier
 * @returns true if operation requires confirmation
 */
export function requiresConfirmation(operation: string): boolean {
  return OPERATIONS_REQUIRING_CONFIRMATION.includes(operation as OperationRequiringConfirmation)
}
