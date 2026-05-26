/**
 * Permission Controller for DevFlow IDE Remote Control
 *
 * This module implements the permission control logic for remote operations.
 * It determines which operations are allowed, denied, or require confirmation.
 *
 * @module main/agents/permission-controller
 */

import {
  PERMISSIONS,
  type PermissionConfig,
} from '../../shared/types/remote-control'
import {
  OPERATIONS_REQUIRING_CONFIRMATION,
  requiresConfirmation,
} from './master-agent'

// ============ Permission Result Types ============

/**
 * Result of a permission check
 * Contains detailed information about the permission status
 */
export interface PermissionResult {
  /** Whether the operation is allowed */
  allowed: boolean
  /** Whether the operation requires user confirmation */
  requiresConfirm: boolean
  /** Reason for denial (if not allowed) */
  reason?: string
}

// ============ Permission Controller Interface ============

/**
 * Permission Controller interface for managing operation permissions
 *
 * The controller provides methods to check, validate, and query
 * permissions for remote control operations.
 */
export interface PermissionController {
  /**
   * Check if an operation is allowed
   *
   * @param operation - Operation identifier
   * @returns true if operation is allowed, false otherwise
   */
  isAllowed(operation: string): boolean

  /**
   * Check if an operation requires user confirmation
   *
   * @param operation - Operation identifier
   * @returns true if operation requires confirmation
   */
  requiresConfirmation(operation: string): boolean

  /**
   * Get list of all allowed operations
   *
   * @returns Array of allowed operation identifiers
   */
  getAllowedOperations(): string[]

  /**
   * Get list of all denied operations
   *
   * @returns Array of denied operation identifiers
   */
  getDeniedOperations(): string[]

  /**
   * Check permission and return detailed result
   *
   * @param operation - Operation identifier
   * @returns Permission result with detailed information
   */
  checkPermission(operation: string): PermissionResult
}

// ============ Default Permission Controller Implementation ============

/**
 * Default Permission Controller implementation
 *
 * Uses the PERMISSIONS configuration and OPERATIONS_REQUIRING_CONFIRMATION
 * to determine permission status for operations.
 */
class DefaultPermissionController implements PermissionController {
  private readonly config: PermissionConfig

  /**
   * Create a new permission controller
   *
   * @param config - Permission configuration (defaults to PERMISSIONS)
   */
  constructor(config: PermissionConfig = PERMISSIONS) {
    this.config = config
  }

  /**
   * Check if an operation is allowed
   *
   * Logic:
   * 1. If operation is in deny list -> false
   * 2. If operation is in allow list -> true
   * 3. Otherwise -> false (deny by default)
   *
   * @param operation - Operation identifier
   * @returns true if operation is allowed
   */
  isAllowed(operation: string): boolean {
    // Denied operations are always blocked
    if (this.config.deny.includes(operation)) {
      return false
    }
    // Only explicitly allowed operations are permitted
    return this.config.allow.includes(operation)
  }

  /**
   * Check if an operation requires user confirmation
   *
   * Uses OPERATIONS_REQUIRING_CONFIRMATION list to determine
   * if the operation needs explicit user confirmation before execution.
   *
   * @param operation - Operation identifier
   * @returns true if operation requires confirmation
   */
  requiresConfirmation(operation: string): boolean {
    return requiresConfirmation(operation)
  }

  /**
   * Get list of all allowed operations
   *
   * @returns Copy of allowed operations array
   */
  getAllowedOperations(): string[] {
    return [...this.config.allow]
  }

  /**
   * Get list of all denied operations
   *
   * @returns Copy of denied operations array
   */
  getDeniedOperations(): string[] {
    return [...this.config.deny]
  }

  /**
   * Check permission and return detailed result
   *
   * Provides comprehensive permission information including:
   * - Whether the operation is allowed
   * - Whether it requires confirmation
   * - Reason for denial (if applicable)
   *
   * @param operation - Operation identifier
   * @returns Permission result with detailed information
   */
  checkPermission(operation: string): PermissionResult {
    // Check if operation is explicitly denied
    if (this.config.deny.includes(operation)) {
      return {
        allowed: false,
        requiresConfirm: false,
        reason: `操作 "${operation}" 被明确禁止`,
      }
    }

    // Check if operation is explicitly allowed
    if (this.config.allow.includes(operation)) {
      return {
        allowed: true,
        requiresConfirm: this.requiresConfirmation(operation),
      }
    }

    // Operation is not in allow or deny list - deny by default
    return {
      allowed: false,
      requiresConfirm: false,
      reason: `操作 "${operation}" 未在允许列表中`,
    }
  }
}

// ============ Singleton Instance ============

/**
 * Default permission controller instance
 * Uses the default PERMISSIONS configuration
 */
export const permissionController: PermissionController =
  new DefaultPermissionController()

// ============ Factory Function ============

/**
 * Create a new permission controller with custom configuration
 *
 * @param config - Custom permission configuration
 * @returns New PermissionController instance
 *
 * @example
 * ```typescript
 * const customController = createPermissionController({
 *   allow: ['view_status', 'mcp_status'],
 *   deny: ['delete_project']
 * });
 * ```
 */
export function createPermissionController(
  config: PermissionConfig
): PermissionController {
  return new DefaultPermissionController(config)
}

// ============ Utility Functions ============

/**
 * Quick check if an operation is allowed
 *
 * Convenience function that uses the default permission controller.
 *
 * @param operation - Operation identifier
 * @returns true if operation is allowed
 */
export function isOperationAllowed(operation: string): boolean {
  return permissionController.isAllowed(operation)
}

/**
 * Quick check if an operation requires confirmation
 *
 * Convenience function that uses the default permission controller.
 *
 * @param operation - Operation identifier
 * @returns true if operation requires confirmation
 */
export function operationRequiresConfirmation(operation: string): boolean {
  return permissionController.requiresConfirmation(operation)
}

/**
 * Quick permission check with detailed result
 *
 * Convenience function that uses the default permission controller.
 *
 * @param operation - Operation identifier
 * @returns Permission result with detailed information
 */
export function checkOperationPermission(operation: string): PermissionResult {
  return permissionController.checkPermission(operation)
}

// ============ Constants Export ============

/**
 * Operations that are always allowed without confirmation
 */
export const SAFE_OPERATIONS = PERMISSIONS.allow.filter(
  (op) => !OPERATIONS_REQUIRING_CONFIRMATION.includes(op as never)
)

/**
 * Operations that require confirmation before execution
 */
export const SENSITIVE_OPERATIONS = PERMISSIONS.allow.filter((op) =>
  OPERATIONS_REQUIRING_CONFIRMATION.includes(op as never)
)

/**
 * Operations that are explicitly denied
 */
export const FORBIDDEN_OPERATIONS = [...PERMISSIONS.deny]

// ============ Type Exports ============

export type { PermissionResult, PermissionController }
