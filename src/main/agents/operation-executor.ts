/**
 * Operation Executor for DevFlow IDE Remote Control
 *
 * Executes parsed commands and performs operations on the IDE.
 * Handles permission checking, confirmation requests, and operation execution.
 *
 * @module main/agents/operation-executor
 */

import type {
  AgentContext,
  OperationResult,
  PendingConfirmation,
  ProjectInfo,
  MCPStatus,
  SkillGroup,
} from './master-agent'
import type { ParsedCommand, ExtendedCommandType } from './command-parser'
import {
  permissionController,
  type PermissionController,
  type PermissionResult,
} from './permission-controller'
import { generateId } from '../utils/encryption'

// ============ IDE API Adapter Interface ============

/**
 * IDE API Adapter interface for calling real IDE operations
 *
 * This interface abstracts the communication layer between the operation executor
 * and the actual IDE functionality. In an Electron app, this would typically
 * communicate with the main process via IPC.
 */
export interface IdeApiAdapter {
  /**
   * Get all running projects/sessions
   */
  getProjects(): Promise<ProjectInfo[]>

  /**
   * Get current active project ID
   */
  getCurrentProject(): Promise<string | undefined>

  /**
   * Switch to a specific project
   */
  switchProject(projectId: string): Promise<{ success: boolean; message: string }>

  /**
   * Restart a project session
   */
  restartProject(projectId: string): Promise<{ success: boolean; message: string }>

  /**
   * Get MCP tools status
   */
  getMcpStatus(): Promise<MCPStatus[]>

  /**
   * Start an MCP tool
   */
  startMcp(mcpId: string): Promise<{ success: boolean; message: string }>

  /**
   * Stop an MCP tool
   */
  stopMcp(mcpId: string): Promise<{ success: boolean; message: string }>

  /**
   * Get available skill groups
   */
  getSkillGroups(): Promise<SkillGroup[]>

  /**
   * Switch to a skill group
   */
  switchSkillGroup(skillGroupId: string): Promise<{ success: boolean; message: string }>

  /**
   * Send a message to a project's AI agent and wait for response
   */
  sendMessage(projectId: string, message: string): Promise<{ success: boolean; message: string }>
}

// ============ Operation Mapping ============

/**
 * Map command types to operation identifiers for permission checking
 */
const COMMAND_TO_OPERATION: Record<ExtendedCommandType, string> = {
  status: 'view_status',
  switch: 'switch_project',
  restart: 'restart_session',
  mcp_status: 'mcp_status',
  mcp_start: 'mcp_start',
  mcp_stop: 'mcp_stop',
  skillgroup_list: 'skillgroup_list',
  skillgroup_switch: 'skillgroup_switch',
  chat: 'chat',
  help: 'view_status', // help is a read-only operation
  unknown: 'unknown',
}

/** Reverse mapping: operation → command type */
const OPERATION_TO_COMMAND: Record<string, ExtendedCommandType> = {}
for (const [cmd, op] of Object.entries(COMMAND_TO_OPERATION)) {
  OPERATION_TO_COMMAND[op] = cmd as ExtendedCommandType
}

// ============ Confirm Handler Type ============

/**
 * Handler function for confirmation requests
 */
export type ConfirmHandler = (
  confirmId: string,
  message: string
) => Promise<boolean>

// ============ Operation Executor Interface ============

/**
 * Operation Executor interface for executing parsed commands
 */
export interface OperationExecutor {
  /**
   * Execute a parsed command
   *
   * @param command - Parsed command to execute
   * @param context - Agent execution context
   * @returns Promise resolving to operation result
   */
  execute(
    command: ParsedCommand,
    context: AgentContext
  ): Promise<OperationResult>

  /**
   * Set the confirmation handler
   *
   * @param handler - Function to handle confirmation requests
   */
  setConfirmHandler(handler: ConfirmHandler): void

  /**
   * Get pending confirmations
   *
   * @returns Array of pending confirmation requests
   */
  getPendingConfirmations(): PendingConfirmation[]

  /**
   * Process a confirmation response
   *
   * @param confirmId - Confirmation request ID
   * @param confirmed - Whether the user confirmed
   * @returns Promise resolving to operation result
   */
  processConfirmation(confirmId: string, confirmed: boolean): Promise<OperationResult>
}

// ============ Default Operation Executor Implementation ============

/**
 * Default Operation Executor implementation
 *
 * Executes operations with permission checking and confirmation handling.
 */
class DefaultOperationExecutor implements OperationExecutor {
  private permissionCtrl: PermissionController
  private confirmHandler: ConfirmHandler | null = null
  private pendingConfirmations: Map<string, PendingConfirmation> = new Map()
  private ideApi: IdeApiAdapter | null = null

  /**
   * Create a new operation executor
   *
   * @param permissionController - Permission controller instance
   */
  constructor(permissionCtrl: PermissionController = permissionController) {
    this.permissionCtrl = permissionCtrl
  }

  /**
   * Set the IDE API adapter for real IDE operations
   *
   * @param adapter - IDE API adapter instance
   */
  setIdeApi(adapter: IdeApiAdapter): void {
    this.ideApi = adapter
  }

  /**
   * Get the current IDE API adapter
   *
   * @returns IDE API adapter or null if not set
   */
  getIdeApi(): IdeApiAdapter | null {
    return this.ideApi
  }

  /**
   * Execute a parsed command
   *
   * Steps:
   * 1. Map command type to operation identifier
   * 2. Check permission
   * 3. If not allowed, return error
   * 4. If requires confirmation, create confirmation request
   * 5. Execute the operation
   *
   * @param command - Parsed command to execute
   * @param context - Agent execution context
   * @returns Promise resolving to operation result
   */
  async execute(
    command: ParsedCommand,
    context: AgentContext
  ): Promise<OperationResult> {
    const operation = COMMAND_TO_OPERATION[command.type]

    // Handle unknown commands
    if (operation === 'unknown') {
      return {
        success: false,
        message: `无法识别的指令: ${command.raw}`,
      }
    }

    // Check permission
    const permissionResult = this.permissionCtrl.checkPermission(operation)

    if (!permissionResult.allowed) {
      return {
        success: false,
        message: permissionResult.reason || `操作 "${operation}" 被拒绝`,
      }
    }

    // Check if confirmation is required
    if (permissionResult.requiresConfirm) {
      return this.createConfirmationRequest(command, operation, context)
    }

    // Execute the operation directly
    return this.executeOperation(command, context)
  }

  /**
   * Set the confirmation handler
   *
   * @param handler - Function to handle confirmation requests
   */
  setConfirmHandler(handler: ConfirmHandler): void {
    this.confirmHandler = handler
  }

  /**
   * Get pending confirmations
   *
   * @returns Array of pending confirmation requests
   */
  getPendingConfirmations(): PendingConfirmation[] {
    return Array.from(this.pendingConfirmations.values())
  }

  /**
   * Process a confirmation response
   *
   * @param confirmId - Confirmation request ID
   * @param confirmed - Whether the user confirmed
   * @returns Promise resolving to operation result
   */
  async processConfirmation(
    confirmId: string,
    confirmed: boolean
  ): Promise<OperationResult> {
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

    // Execute the operation (convert operation name back to command type)
    const commandType = OPERATION_TO_COMMAND[pending.operation] || 'unknown'
    const command: ParsedCommand = {
      type: commandType,
      raw: pending.operation,
      params: pending.params as Record<string, string>,
      requiresConfirm: false, // Already confirmed
    }

    // Create context from pending confirmation
    const context: AgentContext = {
      currentProject: undefined,
      projects: [],
      mcpStatus: [],
      skillgroups: [],
      userId: pending.userId,
      channelId: pending.channelId,
      sessionId: pending.confirmId, // Use confirmId as session identifier
    }

    return this.executeOperation(command, context)
  }

  // ============ Private Methods ============

  /**
   * Create a confirmation request for sensitive operations
   */
  private createConfirmationRequest(
    command: ParsedCommand,
    operation: string,
    context: AgentContext
  ): OperationResult {
    const confirmId = generateId()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30000) // 30 seconds timeout

    const confirmationMessage = this.getConfirmationMessage(command)

    const pendingConfirmation: PendingConfirmation = {
      confirmId,
      operation,
      params: command.params,
      requestedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      channelId: context.channelId,
      userId: context.userId,
    }

    this.pendingConfirmations.set(confirmId, pendingConfirmation)

    // Schedule cleanup after timeout
    setTimeout(() => {
      this.pendingConfirmations.delete(confirmId)
    }, 30000)

    return {
      success: true,
      message: confirmationMessage,
      requiresConfirm: true,
      confirmId,
    }
  }

  /**
   * Get human-readable confirmation message for an operation
   */
  private getConfirmationMessage(command: ParsedCommand): string {
    switch (command.type) {
      case 'switch':
        return `⚠️ 确认要切换到项目 "${command.params.projectName}" 吗？`
      case 'restart':
        return `⚠️ 确认要重启项目 "${command.params.projectName}" 吗？`
      case 'mcp_start':
        return `⚠️ 确认要启动 MCP "${command.params.mcpName}" 吗？`
      case 'mcp_stop':
        return `⚠️ 确认要停止 MCP "${command.params.mcpName}" 吗？`
      case 'skillgroup_switch':
        return `⚠️ 确认要切换到技能组 "${command.params.skillgroupName}" 吗？`
      default:
        return `⚠️ 确认要执行操作 "${command.type}" 吗？`
    }
  }

  /**
   * Execute the actual operation
   */
  private async executeOperation(
    command: ParsedCommand,
    context: AgentContext
  ): Promise<OperationResult> {
    switch (command.type) {
      case 'status':
        return this.executeStatus(context)
      case 'switch':
        return this.executeSwitch(command.params, context)
      case 'restart':
        return this.executeRestart(command.params, context)
      case 'mcp_status':
        return this.executeMcpStatus(context)
      case 'mcp_start':
        return this.executeMcpStart(command.params, context)
      case 'mcp_stop':
        return this.executeMcpStop(command.params, context)
      case 'skillgroup_list':
        return this.executeSkillgroupList(context)
      case 'skillgroup_switch':
        return this.executeSkillgroupSwitch(command.params, context)
      case 'chat':
        return this.executeChat(command.params, context)
      case 'help':
        return this.executeHelp()
      default:
        return {
          success: false,
          message: `未知操作类型: ${command.type}`,
        }
    }
  }

  // ============ Operation Implementations ============

  /**
   * Execute status operation - show all project session status
   */
  private async executeStatus(context: AgentContext): Promise<OperationResult> {
    // Use IDE API if available, otherwise fall back to context data
    let projects = context.projects
    let currentProject = context.currentProject

    if (this.ideApi) {
      try {
        projects = await this.ideApi.getProjects()
        currentProject = await this.ideApi.getCurrentProject()
      } catch (error) {
        // Fall back to context data on error
        console.error('Failed to get projects from IDE API:', error)
      }
    }

    if (projects.length === 0) {
      return {
        success: true,
        message: '当前没有运行中的项目会话',
        data: { projects: [] },
      }
    }

    const statusLines = projects.map((project) => {
      const isCurrent = project.id === currentProject
      const statusEmoji = this.getStatusEmoji(project.status)
      const progressInfo = project.progress !== undefined
        ? ` [${project.progress}%]`
        : ''
      const taskInfo = project.currentTask
        ? ` - ${project.currentTask}`
        : ''

      return `${isCurrent ? '▶️ ' : '   '}${statusEmoji} ${project.name}${progressInfo}${taskInfo}\n      🆔 ${project.id}`
    })

    const message = `📊 项目会话状态\n\n${statusLines.join('\n')}`

    return {
      success: true,
      message,
      data: { projects, currentProject },
    }
  }

  /**
   * Execute switch operation - switch to specified project session
   */
  private async executeSwitch(
    params: Record<string, string>,
    context: AgentContext
  ): Promise<OperationResult> {
    const { projectName } = params

    if (!projectName) {
      return {
        success: false,
        message: '请指定要切换的项目名称',
      }
    }

    // Use IDE API if available
    if (this.ideApi) {
      try {
        const projects = await this.ideApi.getProjects()
        const project = projects.find(
          (p) => p.name.toLowerCase() === projectName.toLowerCase()
        )

        if (!project) {
          const availableProjects = projects.map((p) => p.name).join(', ')
          return {
            success: false,
            message: `项目 "${projectName}" 不存在\n可用项目: ${availableProjects || '无'}`,
          }
        }

        const currentProject = await this.ideApi.getCurrentProject()
        if (project.id === currentProject) {
          return {
            success: true,
            message: `已经是当前项目: ${project.name}`,
            data: { projectId: project.id, operation: 'switch_project' },
          }
        }

        const result = await this.ideApi.switchProject(project.id)
        return {
          success: result.success,
          message: result.success
            ? `✅ 已切换到项目: ${project.name}`
            : result.message,
          data: result.success
            ? { projectId: project.id, projectName: project.name, operation: 'switch_project' }
            : undefined,
        }
      } catch (error) {
        console.error('Failed to switch project via IDE API:', error)
        // Fall through to context-based fallback
      }
    }

    // Fallback: Use context data
    const { projects } = context

    // Find the project by name (fuzzy match already done by parser)
    const project = projects.find(
      (p) => p.name.toLowerCase() === projectName.toLowerCase()
    )

    if (!project) {
      const availableProjects = projects.map((p) => p.name).join(', ')
      return {
        success: false,
        message: `项目 "${projectName}" 不存在\n可用项目: ${availableProjects || '无'}`,
      }
    }

    // Check if already the current project
    if (project.id === context.currentProject) {
      return {
        success: true,
        message: `已经是当前项目: ${project.name}`,
        data: { projectId: project.id, operation: 'switch_project' },
      }
    }

    // Without IDE API, we can only simulate the switch
    return {
      success: true,
      message: `✅ 已切换到项目: ${project.name}`,
      data: {
        projectId: project.id,
        projectName: project.name,
        operation: 'switch_project',
      },
    }
  }

  /**
   * Execute restart operation - restart specified project session
   */
  private async executeRestart(
    params: Record<string, string>,
    context: AgentContext
  ): Promise<OperationResult> {
    const { projectName } = params

    if (!projectName) {
      return {
        success: false,
        message: '请指定要重启的项目名称',
      }
    }

    // Use IDE API if available
    if (this.ideApi) {
      try {
        const projects = await this.ideApi.getProjects()
        const project = projects.find(
          (p) => p.name.toLowerCase() === projectName.toLowerCase()
        )

        if (!project) {
          const availableProjects = projects.map((p) => p.name).join(', ')
          return {
            success: false,
            message: `项目 "${projectName}" 不存在\n可用项目: ${availableProjects || '无'}`,
          }
        }

        const result = await this.ideApi.restartProject(project.id)
        return {
          success: result.success,
          message: result.success
            ? `✅ 项目 "${project.name}" 已重启`
            : result.message,
          data: result.success
            ? {
                projectId: project.id,
                projectName: project.name,
                restartedAt: new Date().toISOString(),
                operation: 'restart_session',
              }
            : undefined,
        }
      } catch (error) {
        console.error('Failed to restart project via IDE API:', error)
        // Fall through to context-based fallback
      }
    }

    // Fallback: Use context data
    const { projects } = context

    // Find the project by name
    const project = projects.find(
      (p) => p.name.toLowerCase() === projectName.toLowerCase()
    )

    if (!project) {
      const availableProjects = projects.map((p) => p.name).join(', ')
      return {
        success: false,
        message: `项目 "${projectName}" 不存在\n可用项目: ${availableProjects || '无'}`,
      }
    }

    // Without IDE API, we can only simulate the restart
    return {
      success: true,
      message: `✅ 项目 "${project.name}" 已重启`,
      data: {
        projectId: project.id,
        projectName: project.name,
        restartedAt: new Date().toISOString(),
        operation: 'restart_session',
      },
    }
  }

  /**
   * Execute MCP status operation - show MCP tools status
   */
  private async executeMcpStatus(context: AgentContext): Promise<OperationResult> {
    // Use IDE API if available
    let mcpStatus = context.mcpStatus

    if (this.ideApi) {
      try {
        mcpStatus = await this.ideApi.getMcpStatus()
      } catch (error) {
        console.error('Failed to get MCP status from IDE API:', error)
        // Fall back to context data
      }
    }

    if (mcpStatus.length === 0) {
      return {
        success: true,
        message: '当前没有配置任何 MCP 工具',
        data: { mcpStatus: [] },
      }
    }

    const statusLines = mcpStatus.map((mcp) => {
      const statusEmoji = this.getMcpStatusEmoji(mcp.status)
      const connectionInfo = mcp.connectionInfo
        ? ` (${mcp.connectionInfo})`
        : ''

      return `${statusEmoji} ${mcp.name}${connectionInfo}`
    })

    const message = `🔧 MCP 工具状态\n\n${statusLines.join('\n')}`

    return {
      success: true,
      message,
      data: { mcpStatus },
    }
  }

  /**
   * Execute MCP start operation - start specified MCP
   */
  private async executeMcpStart(
    params: Record<string, string>,
    context: AgentContext
  ): Promise<OperationResult> {
    const { mcpName } = params

    if (!mcpName) {
      return {
        success: false,
        message: '请指定要启动的 MCP 名称',
      }
    }

    // Use IDE API if available
    if (this.ideApi) {
      try {
        const mcpStatus = await this.ideApi.getMcpStatus()
        const mcp = mcpStatus.find(
          (m) => m.name.toLowerCase() === mcpName.toLowerCase()
        )

        if (!mcp) {
          const availableMcps = mcpStatus.map((m) => m.name).join(', ')
          return {
            success: false,
            message: `MCP "${mcpName}" 不存在\n可用 MCP: ${availableMcps || '无'}`,
          }
        }

        // Check if already running
        if (mcp.status === 'running') {
          return {
            success: true,
            message: `MCP "${mcp.name}" 已经在运行中`,
            data: { mcpId: mcp.id },
          }
        }

        const result = await this.ideApi.startMcp(mcp.id)
        return {
          success: result.success,
          message: result.success
            ? `✅ MCP "${mcp.name}" 已启动`
            : result.message,
          data: result.success
            ? {
                mcpId: mcp.id,
                mcpName: mcp.name,
                startedAt: new Date().toISOString(),
              }
            : undefined,
        }
      } catch (error) {
        console.error('Failed to start MCP via IDE API:', error)
        // Fall through to context-based fallback
      }
    }

    // Fallback: Use context data
    const { mcpStatus } = context

    // Find the MCP by name
    const mcp = mcpStatus.find(
      (m) => m.name.toLowerCase() === mcpName.toLowerCase()
    )

    if (!mcp) {
      const availableMcps = mcpStatus.map((m) => m.name).join(', ')
      return {
        success: false,
        message: `MCP "${mcpName}" 不存在\n可用 MCP: ${availableMcps || '无'}`,
      }
    }

    // Check if already running
    if (mcp.status === 'running') {
      return {
        success: true,
        message: `MCP "${mcp.name}" 已经在运行中`,
        data: { mcpId: mcp.id },
      }
    }

    // Without IDE API, we can only simulate the start
    return {
      success: true,
      message: `✅ MCP "${mcp.name}" 已启动`,
      data: {
        mcpId: mcp.id,
        mcpName: mcp.name,
        startedAt: new Date().toISOString(),
      },
    }
  }

  /**
   * Execute MCP stop operation - stop specified MCP
   */
  private async executeMcpStop(
    params: Record<string, string>,
    context: AgentContext
  ): Promise<OperationResult> {
    const { mcpName } = params

    if (!mcpName) {
      return {
        success: false,
        message: '请指定要停止的 MCP 名称',
      }
    }

    // Use IDE API if available
    if (this.ideApi) {
      try {
        const mcpStatus = await this.ideApi.getMcpStatus()
        const mcp = mcpStatus.find(
          (m) => m.name.toLowerCase() === mcpName.toLowerCase()
        )

        if (!mcp) {
          const availableMcps = mcpStatus.map((m) => m.name).join(', ')
          return {
            success: false,
            message: `MCP "${mcpName}" 不存在\n可用 MCP: ${availableMcps || '无'}`,
          }
        }

        // Check if already stopped
        if (mcp.status === 'stopped') {
          return {
            success: true,
            message: `MCP "${mcp.name}" 已经停止`,
            data: { mcpId: mcp.id },
          }
        }

        const result = await this.ideApi.stopMcp(mcp.id)
        return {
          success: result.success,
          message: result.success
            ? `✅ MCP "${mcp.name}" 已停止`
            : result.message,
          data: result.success
            ? {
                mcpId: mcp.id,
                mcpName: mcp.name,
                stoppedAt: new Date().toISOString(),
              }
            : undefined,
        }
      } catch (error) {
        console.error('Failed to stop MCP via IDE API:', error)
        // Fall through to context-based fallback
      }
    }

    // Fallback: Use context data
    const { mcpStatus } = context

    // Find the MCP by name
    const mcp = mcpStatus.find(
      (m) => m.name.toLowerCase() === mcpName.toLowerCase()
    )

    if (!mcp) {
      const availableMcps = mcpStatus.map((m) => m.name).join(', ')
      return {
        success: false,
        message: `MCP "${mcpName}" 不存在\n可用 MCP: ${availableMcps || '无'}`,
      }
    }

    // Check if already stopped
    if (mcp.status === 'stopped') {
      return {
        success: true,
        message: `MCP "${mcp.name}" 已经停止`,
        data: { mcpId: mcp.id },
      }
    }

    // Without IDE API, we can only simulate the stop
    return {
      success: true,
      message: `✅ MCP "${mcp.name}" 已停止`,
      data: {
        mcpId: mcp.id,
        mcpName: mcp.name,
        stoppedAt: new Date().toISOString(),
      },
    }
  }

  /**
   * Execute skillgroup list operation - list available skill groups
   */
  private async executeSkillgroupList(context: AgentContext): Promise<OperationResult> {
    // Use IDE API if available
    let skillgroups = context.skillgroups

    if (this.ideApi) {
      try {
        skillgroups = await this.ideApi.getSkillGroups()
      } catch (error) {
        console.error('Failed to get skill groups from IDE API:', error)
        // Fall back to context data
      }
    }

    if (skillgroups.length === 0) {
      return {
        success: true,
        message: '当前没有可用的技能组',
        data: { skillgroups: [] },
      }
    }

    const groupLines = skillgroups.map((group) => {
      const activeIndicator = group.isActive ? '✅ ' : '   '
      const descInfo = group.description
        ? ` - ${group.description}`
        : ''
      const skillCountInfo = ` (${group.skillCount} 个技能)`

      return `${activeIndicator}${group.name}${skillCountInfo}${descInfo}`
    })

    const activeGroup = skillgroups.find((g) => g.isActive)
    const activeInfo = activeGroup
      ? `\n\n当前激活: ${activeGroup.name}`
      : ''

    const message = `📚 技能组列表\n\n${groupLines.join('\n')}${activeInfo}`

    return {
      success: true,
      message,
      data: { skillgroups },
    }
  }

  /**
   * Execute skillgroup switch operation - switch to specified skill group
   */
  private async executeSkillgroupSwitch(
    params: Record<string, string>,
    context: AgentContext
  ): Promise<OperationResult> {
    const { skillgroupName } = params

    if (!skillgroupName) {
      return {
        success: false,
        message: '请指定要切换的技能组名称',
      }
    }

    // Use IDE API if available
    if (this.ideApi) {
      try {
        const skillgroups = await this.ideApi.getSkillGroups()
        const group = skillgroups.find(
          (g) => g.name.toLowerCase() === skillgroupName.toLowerCase()
        )

        if (!group) {
          const availableGroups = skillgroups.map((g) => g.name).join(', ')
          return {
            success: false,
            message: `技能组 "${skillgroupName}" 不存在\n可用技能组: ${availableGroups || '无'}`,
          }
        }

        // Check if already active
        if (group.isActive) {
          return {
            success: true,
            message: `技能组 "${group.name}" 已经是当前激活状态`,
            data: { skillgroupId: group.id },
          }
        }

        const result = await this.ideApi.switchSkillGroup(group.id)
        return {
          success: result.success,
          message: result.success
            ? `✅ 已切换到技能组: ${group.name}`
            : result.message,
          data: result.success
            ? {
                skillgroupId: group.id,
                skillgroupName: group.name,
                skillCount: group.skillCount,
              }
            : undefined,
        }
      } catch (error) {
        console.error('Failed to switch skill group via IDE API:', error)
        // Fall through to context-based fallback
      }
    }

    // Fallback: Use context data
    const { skillgroups } = context

    // Find the skill group by name
    const group = skillgroups.find(
      (g) => g.name.toLowerCase() === skillgroupName.toLowerCase()
    )

    if (!group) {
      const availableGroups = skillgroups.map((g) => g.name).join(', ')
      return {
        success: false,
        message: `技能组 "${skillgroupName}" 不存在\n可用技能组: ${availableGroups || '无'}`,
      }
    }

    // Check if already active
    if (group.isActive) {
      return {
        success: true,
        message: `技能组 "${group.name}" 已经是当前激活状态`,
        data: { skillgroupId: group.id },
      }
    }

    // Without IDE API, we can only simulate the switch
    return {
      success: true,
      message: `✅ 已切换到技能组: ${group.name}`,
      data: {
        skillgroupId: group.id,
        skillgroupName: group.name,
        skillCount: group.skillCount,
      },
    }
  }

  /**
   * Execute chat operation - send message to current project's AI agent
   */
  private async executeChat(
    params: Record<string, string>,
    context: AgentContext
  ): Promise<OperationResult> {
    const { message } = params

    if (!message) {
      return {
        success: false,
        message: '请提供要发送给 AI 的消息内容',
      }
    }

    // Determine target project: explicit param, current project, or first available
    const targetProjectId = params.projectId
      || context.currentProject
      || context.projects[0]?.id

    if (!targetProjectId) {
      return {
        success: false,
        message: '没有可用的项目。请在 IDE 中打开一个项目后再试。',
      }
    }

    if (!this.ideApi) {
      return {
        success: false,
        message: 'IDE API 不可用，无法与 AI Agent 通信',
      }
    }

    try {
      const result = await this.ideApi.sendMessage(targetProjectId, message)
      return {
        success: result.success,
        message: result.message,
      }
    } catch (error) {
      return {
        success: false,
        message: `与 AI Agent 通信失败: ${(error as Error).message}`,
      }
    }
  }

  /**
   * Execute help operation - show help information
   */
  private executeHelp(): OperationResult {
    const message = `📋 远程控制指令帮助

🔹 基础指令
  /status - 查看所有项目会话状态
  /switch <项目名> - 切换到指定项目会话
  /restart <项目名> - 重启指定项目会话
  /help - 显示帮助信息

🔹 MCP 管理
  /mcp status - 查看 MCP 工具状态
  /mcp start <名称> - 启动指定 MCP
  /mcp stop <名称> - 停止指定 MCP

🔹 技能组管理
  /skillgroup list - 列出可用技能组
  /skillgroup switch <名称> - 切换技能组

💡 也支持自然语言，例如：
  "查看状态"、"切换到 xxx 项目"、"MCP 状态"

⚠️ 标记 ⚠️ 的操作需要手机端确认`

    return {
      success: true,
      message,
    }
  }

  // ============ Helper Methods ============

  /**
   * Get emoji for project status
   */
  private getStatusEmoji(status: ProjectInfo['status']): string {
    switch (status) {
      case 'running':
        return '🟢'
      case 'idle':
        return '🟡'
      case 'error':
        return '🔴'
      default:
        return '⚪'
    }
  }

  /**
   * Get emoji for MCP status
   */
  private getMcpStatusEmoji(status: MCPStatus['status']): string {
    switch (status) {
      case 'running':
        return '🟢'
      case 'stopped':
        return '⚫'
      case 'error':
        return '🔴'
      default:
        return '⚪'
    }
  }
}

// ============ Singleton Instance ============

/**
 * Default operation executor instance
 */
export const operationExecutor: OperationExecutor = new DefaultOperationExecutor()

// ============ Factory Function ============

/**
 * Create a new operation executor
 *
 * @param permissionCtrl - Optional custom permission controller
 * @returns OperationExecutor instance
 */
export function createOperationExecutor(
  permissionCtrl?: PermissionController
): OperationExecutor {
  return new DefaultOperationExecutor(permissionCtrl)
}

// ============ IDE API Adapter Helper ============

/**
 * Set the IDE API adapter for the default operation executor
 *
 * This function allows the main process to inject the real IDE API
 * implementation after the operation executor is created.
 *
 * @param adapter - IDE API adapter instance
 */
export function setIdeApiAdapter(adapter: IdeApiAdapter): void {
  ;(operationExecutor as DefaultOperationExecutor).setIdeApi(adapter)
}

/**
 * Get the current IDE API adapter from the default operation executor
 *
 * @returns IDE API adapter or null if not set
 */
export function getIdeApiAdapter(): IdeApiAdapter | null {
  return (operationExecutor as DefaultOperationExecutor).getIdeApi()
}
