/**
 * Master Agent interface definitions for DevFlow IDE Remote Control
 *
 * This module defines the core agent interfaces for handling remote control commands.
 * The Master Agent is responsible for:
 * - Processing user messages from remote channels
 * - Enforcing permission controls
 * - Executing operations on the IDE
 *
 * @module main/agents/master-agent
 */

// Import shared permission configuration
import { PERMISSIONS, type PermissionConfig } from '../../shared/types/remote-control'

// ============ Supporting Types ============

/**
 * Project session information
 */
export interface ProjectInfo {
  /** Project unique identifier */
  id: string
  /** Project display name */
  name: string
  /** Project running status */
  status: 'running' | 'idle' | 'error'
  /** Current task description */
  currentTask?: string
  /** Progress percentage (0-100) */
  progress?: number
  /** Last activity timestamp (ISO8601) */
  lastActivity: string
}

/**
 * MCP tool status information
 */
export interface MCPStatus {
  /** MCP tool unique identifier */
  id: string
  /** MCP tool display name */
  name: string
  /** MCP running status */
  status: 'running' | 'stopped' | 'error'
  /** Connection info */
  connectionInfo?: string
  /** Last started timestamp (ISO8601) */
  startedAt?: string
}

/**
 * Skill group information
 */
export interface SkillGroup {
  /** Skill group unique identifier */
  id: string
  /** Skill group display name */
  name: string
  /** Skill group description */
  description?: string
  /** Whether this is the currently active skill group */
  isActive: boolean
  /** Number of skills in this group */
  skillCount: number
}

// ============ Agent Context ============

/**
 * Agent execution context
 * Provides all necessary context for processing remote control commands
 */
export interface AgentContext {
  /** Currently active project session (if any) */
  currentProject?: string
  /** List of all available project sessions */
  projects: ProjectInfo[]
  /** MCP tools status list */
  mcpStatus: MCPStatus[]
  /** Available skill groups */
  skillgroups: SkillGroup[]
  /** User identifier who sent the command */
  userId: string
  /** Channel that received the message */
  channelId: string
  /** Session identifier for this remote control session */
  sessionId: string
}

// ============ Operation Result ============

/**
 * Result of an operation execution
 * Contains success status, message, and optional confirmation requirements
 */
export interface OperationResult {
  /** Whether the operation succeeded */
  success: boolean
  /** Human-readable result message */
  message: string
  /** Whether this operation requires user confirmation */
  requiresConfirm?: boolean
  /** Confirmation request ID (if requiresConfirm is true) */
  confirmId?: string
  /** Optional operation result data */
  data?: unknown
}

/**
 * Internal confirmation request data
 */
export interface PendingConfirmation {
  /** Confirmation request ID */
  confirmId: string
  /** Operation to execute if confirmed */
  operation: string
  /** Operation parameters */
  params: Record<string, unknown>
  /** Request timestamp */
  requestedAt: string
  /** Timeout timestamp */
  expiresAt: string
  /** Channel that needs to confirm */
  channelId: string
  /** User who needs to confirm */
  userId: string
}

// ============ Master Agent Interface ============

/**
 * Master Agent interface for remote control
 *
 * The Master Agent handles all incoming messages from remote channels,
 * interprets user intent, enforces permissions, and executes operations.
 *
 * Responsibilities:
 * - Parse and understand user messages (natural language + commands)
 * - Check operation permissions before execution
 * - Execute allowed operations and return results
 * - Handle confirmation flow for sensitive operations
 */
export interface MasterAgent {
  /**
   * Process an incoming message from a remote channel
   *
   * @param message - User message content (natural language or command)
   * @param context - Agent execution context with session/project info
   * @returns Promise resolving to response message for the user
   *
   * @example
   * ```typescript
   * const response = await agent.handleMessage('/status', context);
   * // Returns: "当前有 3 个项目会话运行中..."
   * ```
   */
  handleMessage(message: string, context: AgentContext): Promise<string>

  /**
   * Check if an operation is permitted for remote execution
   *
   * Uses the PERMISSIONS configuration to determine if the operation
   * is explicitly allowed or denied.
   *
   * @param operation - Operation identifier (e.g., 'view_status', 'switch_project')
   * @returns true if operation is allowed, false if denied
   *
   * @example
   * ```typescript
   * agent.checkPermission('view_status'); // true
   * agent.checkPermission('delete_project'); // false
   * ```
   */
  checkPermission(operation: string): boolean

  /**
   * Execute an operation with given parameters
   *
   * This method performs the actual operation on the IDE.
   * It should be called after checkPermission returns true.
   *
   * @param operation - Operation identifier
   * @param params - Operation parameters
   * @returns Promise resolving to operation result
   *
   * @example
   * ```typescript
   * const result = await agent.executeOperation('switch_project', { projectId: 'proj-123' });
   * if (result.success) {
   *   console.log(result.message);
   * }
   * ```
   */
  executeOperation(operation: string, params: Record<string, unknown>): Promise<OperationResult>

  /**
   * Get pending confirmation requests
   *
   * Returns all confirmation requests that are awaiting user response.
   *
   * @returns Array of pending confirmation requests
   */
  getPendingConfirmations(): PendingConfirmation[]

  /**
   * Process a confirmation response
   *
   * Called when a user confirms or denies a pending operation.
   *
   * @param confirmId - Confirmation request ID
   * @param confirmed - Whether the user confirmed
   * @returns Promise resolving to operation result
   */
  processConfirmation(confirmId: string, confirmed: boolean): Promise<OperationResult>
}

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

// ============ Permission Checking ============

/**
 * Default permission configuration for Master Agent
 * Re-exported from shared types for convenience
 */
export { PERMISSIONS }

/**
 * Check if operation is allowed based on permission config
 *
 * Logic:
 * 1. If operation is in deny list -> false
 * 2. If operation is in allow list -> true
 * 3. Otherwise -> false (deny by default)
 *
 * @param operation - Operation identifier
 * @param config - Permission configuration (defaults to PERMISSIONS)
 * @returns true if operation is allowed
 */
export function isOperationAllowed(
  operation: string,
  config: PermissionConfig = PERMISSIONS
): boolean {
  // Denied operations are always blocked
  if (config.deny.includes(operation)) {
    return false
  }
  // Only explicitly allowed operations are permitted
  return config.allow.includes(operation)
}

// ============ Type Exports ============

export type {
  ProjectInfo,
  MCPStatus,
  SkillGroup,
  AgentContext,
  OperationResult,
  PendingConfirmation,
  MasterAgent,
}
