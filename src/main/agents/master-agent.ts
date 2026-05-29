/**
 * Master Agent for DevFlow IDE Remote Control
 *
 * This module implements the Master Agent that integrates:
 * - CommandParser: Parses user messages into structured commands
 * - PermissionController: Checks operation permissions
 * - OperationExecutor: Executes operations on the IDE
 *
 * The Master Agent handles all incoming messages from remote channels,
 * interprets user intent, enforces permissions, and executes operations.
 *
 * @module main/agents/master-agent
 */

// Import shared permission configuration
import { PERMISSIONS, type PermissionConfig, type OperationResult } from '../../shared/types/remote-control'
import { CommandParser, createCommandParser, type ParsedCommand, type ExtendedCommandType } from './command-parser'
import {
  permissionController,
  createPermissionController,
  type PermissionController,
  type PermissionResult,
} from './permission-controller'
import {
  operationExecutor,
  createOperationExecutor,
  type OperationExecutor,
  type ConfirmHandler,
} from './operation-executor'
import { MasterAgentSession } from './master-agent-session'
import { generateId } from '../utils/encryption'
import {
  OPERATIONS_REQUIRING_CONFIRMATION,
  requiresConfirmation,
  type OperationRequiringConfirmation,
} from './remote-control-constants'

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

// Re-export shared OperationResult for convenience
export type { OperationResult } from '../../shared/types/remote-control'

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
  handleMessage(message: string, context: AgentContext): Promise<OperationResult>

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
   * Update the parser context with known entity names for fuzzy matching
   *
   * @param options - Entity name lists
   */
  updateParserContext(options: {
    projectNames?: string[]
    mcpNames?: string[]
    skillgroupNames?: string[]
  }): void

  /**
   * Parse a message into a structured command without executing it.
   *
   * Returns the parsed command type so callers can decide whether
   * to route as a command or as a chat message.
   */
  parseMessage(message: string): ParsedCommand

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

  /**
   * Initialize the AI-powered session for natural language understanding.
   *
   * When active, unrecognised messages are routed to the AI session instead
   * of being forwarded to the project agent. The AI session receives IDE
   * state context before each message and responds conversationally.
   *
   * Falls back gracefully to CommandParser if initialization fails.
   */
  initializeSession(): Promise<void>

  /**
   * Destroy the AI session and free resources.
   */
  destroySession(): Promise<void>

  /**
   * Check whether the AI session is active.
   */
  isSessionActive(): boolean
}

// Re-export constants for convenience
export { OPERATIONS_REQUIRING_CONFIRMATION, requiresConfirmation }
export type { OperationRequiringConfirmation }

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

// ============ Master Agent Implementation ============

/**
 * Master Agent implementation that integrates all components
 *
 * Message processing flow:
 * 1. User message → CommandParser.parse()
 * 2. Parsed command → PermissionController.check()
 * 3. Allowed operation → OperationExecutor.execute()
 *
 * Confirmation flow:
 * 1. Sensitive operation → Generate confirmation request
 * 2. Wait for user confirmation
 * 3. Execute or cancel based on user response
 */
class MasterAgentImpl implements MasterAgent {
  private parser: CommandParser
  private permissionCtrl: PermissionController
  private executor: OperationExecutor
  private pendingConfirmations: Map<string, PendingConfirmation> = new Map()
  private confirmHandler: ConfirmHandler | null = null
  private aiSession: MasterAgentSession | null = null

  /**
   * Create a new MasterAgent instance
   *
   * @param options - Optional configuration for components
   */
  constructor(options?: {
    parser?: CommandParser
    permissionController?: PermissionController
    executor?: OperationExecutor
  }) {
    this.parser = options?.parser ?? createCommandParser()
    this.permissionCtrl = options?.permissionController ?? permissionController
    this.executor = options?.executor ?? operationExecutor

    // Set up confirmation handler in executor
    this.executor.setConfirmHandler(this.handleConfirmationRequest.bind(this))
  }

  /**
   * Process an incoming message from a remote channel
   *
   * Flow:
   * 1. Parse the message into a structured command
   * 2. Check if the command type is allowed
   * 3. Execute the command or return appropriate error
   *
   * @param message - User message content
   * @param context - Agent execution context
   * @returns Response message for the user
   */
  async handleMessage(message: string, context: AgentContext): Promise<OperationResult> {
    try {
      // Step 1: Parse the message
      const parsedCommand = this.parser.parse(message)

      // Step 2: Treat unrecognized messages as natural language — route to AI session
      // if available, otherwise fall back to forwarding to the project agent.
      if (parsedCommand.type === 'unknown') {
        if (this.aiSession) {
          const contextText = this.buildContextForAI(context)
          const prompt = `${contextText}\n[用户消息]\n${message}`
          try {
            const reply = await this.aiSession.sendMessage(prompt)
            return { success: true, message: reply }
          } catch (err) {
            console.error('[MasterAgent] AI session error:', err)
          }
        }
        return await this.executor.execute({
          type: 'chat',
          raw: message,
          params: { message },
          requiresConfirm: false,
        }, context)
      }

      // Step 3: Execute via operation executor (includes permission check)
      return await this.executor.execute(parsedCommand, context)
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error('[MasterAgent] Error handling message:', errorMessage)
      return {
        success: false,
        message: `❌ 处理消息时发生错误: ${errorMessage}`,
      }
    }
  }

  /**
   * Check if an operation is permitted for remote execution
   *
   * @param operation - Operation identifier
   * @returns true if operation is allowed
   */
  checkPermission(operation: string): boolean {
    return this.permissionCtrl.isAllowed(operation)
  }

  /**
   * Execute an operation with given parameters
   *
   * Creates a synthetic ParsedCommand and executes it through the executor.
   *
   * @param operation - Operation identifier
   * @param params - Operation parameters
   * @returns Promise resolving to operation result
   */
  async executeOperation(
    operation: string,
    params: Record<string, unknown>
  ): Promise<OperationResult> {
    // Map operation to command type
    const commandType = this.operationToCommandType(operation)

    // Create synthetic parsed command
    const command: ParsedCommand = {
      type: commandType,
      raw: operation,
      params: params as Record<string, string>,
      requiresConfirm: requiresConfirmation(operation),
    }

    // Create minimal context for execution
    const context: AgentContext = {
      currentProject: undefined,
      projects: [],
      mcpStatus: [],
      skillgroups: [],
      userId: 'system',
      channelId: 'internal',
      sessionId: generateId(),
    }

    // Check permission first
    const permissionResult = this.permissionCtrl.checkPermission(operation)
    if (!permissionResult.allowed) {
      return {
        success: false,
        message: permissionResult.reason || `操作 "${operation}" 被拒绝`,
      }
    }

    // Execute the operation
    return this.executor.execute(command, context)
  }

  /**
   * Get pending confirmation requests
   *
   * Combines confirmations from executor and local storage.
   *
   * @returns Array of pending confirmation requests
   */
  getPendingConfirmations(): PendingConfirmation[] {
    const executorConfirmations = this.executor.getPendingConfirmations()
    const localConfirmations = Array.from(this.pendingConfirmations.values())

    // Merge and deduplicate
    const allConfirmations = new Map<string, PendingConfirmation>()

    for (const conf of executorConfirmations) {
      allConfirmations.set(conf.confirmId, conf)
    }
    for (const conf of localConfirmations) {
      if (!allConfirmations.has(conf.confirmId)) {
        allConfirmations.set(conf.confirmId, conf)
      }
    }

    return Array.from(allConfirmations.values())
  }

  /**
   * Process a confirmation response
   *
   * Called when a user confirms or denies a pending operation.
   *
   * @param confirmId - Confirmation request ID
   * @param confirmed - Whether the user confirmed
   * @returns Promise resolving to operation result
   */
  async processConfirmation(confirmId: string, confirmed: boolean): Promise<OperationResult> {
    // Try executor first
    const executorConfirmations = this.executor.getPendingConfirmations()
    const inExecutor = executorConfirmations.some((c) => c.confirmId === confirmId)

    if (inExecutor) {
      return this.executor.processConfirmation(confirmId, confirmed)
    }

    // Check local pending confirmations
    const pending = this.pendingConfirmations.get(confirmId)
    if (!pending) {
      return {
        success: false,
        message: '确认请求不存在或已过期',
      }
    }

    // Remove from pending list
    this.pendingConfirmations.delete(confirmId)

    if (!confirmed) {
      return {
        success: false,
        message: '用户拒绝了操作',
      }
    }

    // Execute the confirmed operation
    return this.executeOperation(pending.operation, pending.params)
  }

  /**
   * Set a custom confirmation handler
   *
   * @param handler - Function to handle confirmation requests
   */
  setConfirmHandler(handler: ConfirmHandler): void {
    this.confirmHandler = handler
    this.executor.setConfirmHandler(handler)
  }

  /**
   * Parse a message into a structured command without executing it.
   */
  parseMessage(message: string): ParsedCommand {
    return this.parser.parse(message)
  }

  /**
   * Update the parser with known entity names for fuzzy matching
   *
   * @param options - Entity name lists
   */
  updateParserContext(options: {
    projectNames?: string[]
    mcpNames?: string[]
    skillgroupNames?: string[]
  }): void {
    if (options.projectNames) {
      this.parser.setProjectNames(options.projectNames)
    }
    if (options.mcpNames) {
      this.parser.setMcpNames(options.mcpNames)
    }
    if (options.skillgroupNames) {
      this.parser.setSkillgroupNames(options.skillgroupNames)
    }
  }

  /**
   * Get the command parser instance
   *
   * @returns CommandParser instance
   */
  getParser(): CommandParser {
    return this.parser
  }

  /**
   * Get help text for all supported commands
   *
   * @returns Formatted help text
   */
  getHelpText(): string {
    return this.parser.getHelpText()
  }

  /**
   * Initialize the AI-powered session.
   *
   * Creates a MasterAgentSession that handles natural-language messages
   * with IDE state context injection. Fails silently — callers can check
   * isSessionActive() to decide routing.
   */
  async initializeSession(): Promise<void> {
    if (this.aiSession) return

    try {
      this.aiSession = new MasterAgentSession()
      await this.aiSession.initialize()
      console.log('[MasterAgent] AI session initialized')
    } catch (err) {
      console.error('[MasterAgent] Failed to initialize AI session:', err)
      this.aiSession = null
    }
  }

  /**
   * Destroy the AI session and free resources.
   */
  async destroySession(): Promise<void> {
    if (this.aiSession) {
      await this.aiSession.destroy()
      this.aiSession = null
      console.log('[MasterAgent] AI session destroyed')
    }
  }

  /**
   * Check whether the AI session is active.
   */
  isSessionActive(): boolean {
    return this.aiSession !== null
  }

  // ============ Private Methods ============

  /**
   * Build a context text to inject before each AI message.
   *
   * Provides the AI with the current IDE state so it can answer questions
   * about projects, MCPs, and skill groups without needing tool access.
   */
  private buildContextForAI(context: AgentContext): string {
    const lines: string[] = ['[当前IDE状态]']

    // Projects
    if (context.projects.length > 0) {
      lines.push('项目列表:')
      for (const p of context.projects) {
        const marker = p.id === context.currentProject ? '▶️ ' : '   '
        const statusLabel = p.status === 'running' ? '运行中' : p.status === 'error' ? '错误' : '空闲'
        const taskInfo = p.currentTask ? ` — ${p.currentTask}` : ''
        lines.push(`  ${marker}${p.name} (${statusLabel})${taskInfo}`)
      }
    } else {
      lines.push('项目列表: (无)')
    }

    // Current project
    if (context.currentProject) {
      const current = context.projects.find((p) => p.id === context.currentProject)
      if (current) {
        lines.push(`当前项目: ${current.name}`)
      }
    }

    // MCPs
    if (context.mcpStatus.length > 0) {
      lines.push('MCP工具:')
      for (const m of context.mcpStatus) {
        const statusLabel = m.status === 'running' ? '运行中' : m.status === 'error' ? '错误' : '已停止'
        lines.push(`  - ${m.name} (${statusLabel})`)
      }
    }

    // Skill groups
    if (context.skillgroups.length > 0) {
      lines.push('技能组:')
      for (const s of context.skillgroups) {
        const activeLabel = s.isActive ? ' [当前]' : ''
        lines.push(`  - ${s.name}${activeLabel}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Handle confirmation request from executor
   */
  private async handleConfirmationRequest(
    confirmId: string,
    message: string
  ): Promise<boolean> {
    if (this.confirmHandler) {
      return this.confirmHandler(confirmId, message)
    }

    // Default: auto-confirm after timeout (not recommended for production)
    console.warn('[MasterAgent] No confirmation handler set, auto-confirming')
    return true
  }

  /**
   * Get help response for unknown commands
   */
  private getHelpResponse(message: string): string {
    return `❌ 无法识别的指令: "${message}"

${this.parser.getHelpText()}`
  }

  /**
   * Map operation identifier to command type
   */
  private operationToCommandType(operation: string): ExtendedCommandType {
    const mapping: Record<string, ExtendedCommandType> = {
      view_status: 'status',
      switch_project: 'switch',
      restart_session: 'restart',
      mcp_status: 'mcp_status',
      mcp_start: 'mcp_start',
      mcp_stop: 'mcp_stop',
      skillgroup_list: 'skillgroup_list',
      skillgroup_switch: 'skillgroup_switch',
    }

    return mapping[operation] || 'unknown'
  }
}

// ============ Singleton Instance ============

/**
 * Default Master Agent instance
 * Uses default configurations for all components
 */
export const masterAgent: MasterAgent = new MasterAgentImpl()

// ============ Factory Function ============

/**
 * Create a new MasterAgent instance with custom configuration
 *
 * @param options - Configuration options for components
 * @returns New MasterAgent instance
 *
 * @example
 * ```typescript
 * const customAgent = createMasterAgent({
 *   parser: createCommandParser({ projectNames: ['proj1', 'proj2'] }),
 *   permissionController: createPermissionController(customPermissions),
 * });
 * ```
 */
export function createMasterAgent(options?: {
  parser?: CommandParser
  permissionController?: PermissionController
  executor?: OperationExecutor
}): MasterAgent {
  return new MasterAgentImpl(options)
}
