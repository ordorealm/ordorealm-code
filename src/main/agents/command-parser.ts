/**
 * Command Parser for DevFlow IDE Remote Control
 *
 * Parses user messages (natural language and command format) into structured commands.
 * Supports both explicit commands (/status, /switch xxx) and natural language
 * ("查看状态", "切换到 xxx 项目").
 *
 * @module main/agents/command-parser
 */

import type { AgentContext } from '../../shared/types/remote-control'

// ============ Extended Types ============

/**
 * Extended command type including 'unknown' for unrecognized commands
 */
export type ExtendedCommandType =
  | 'status'
  | 'switch'
  | 'restart'
  | 'mcp_status'
  | 'mcp_start'
  | 'mcp_stop'
  | 'skillgroup_list'
  | 'skillgroup_switch'
  | 'help'
  | 'unknown'

/**
 * Parsed command result with confirmation requirement
 */
export interface ParsedCommand {
  /** Command type */
  type: ExtendedCommandType
  /** Original message text */
  raw: string
  /** Extracted parameters */
  params: Record<string, string>
  /** Whether this command requires user confirmation */
  requiresConfirm: boolean
}

/**
 * Command handler function type
 */
export type CommandHandler = (
  params: Record<string, string>,
  context: AgentContext
) => Promise<{ success: boolean; message: string; data?: unknown }>

/**
 * Custom command definition
 */
export interface CustomCommand {
  /** Regular expression pattern to match */
  pattern: RegExp
  /** Handler function for the command */
  handler: CommandHandler
  /** Whether this command requires confirmation */
  requiresConfirm: boolean
}

// ============ Command Patterns ============

/**
 * Explicit command patterns (e.g., /status, /switch xxx)
 */
const EXPLICIT_COMMAND_PATTERNS: Array<{
  pattern: RegExp
  type: ExtendedCommandType
  paramExtractor?: (match: RegExpMatchArray) => Record<string, string>
  requiresConfirm: boolean
}> = [
  {
    pattern: /^\/status$/i,
    type: 'status',
    requiresConfirm: false,
  },
  {
    pattern: /^\/switch\s+(.+)$/i,
    type: 'switch',
    paramExtractor: (match) => ({ projectName: match[1].trim() }),
    requiresConfirm: true,
  },
  {
    pattern: /^\/restart\s+(.+)$/i,
    type: 'restart',
    paramExtractor: (match) => ({ projectName: match[1].trim() }),
    requiresConfirm: true,
  },
  {
    pattern: /^\/mcp\s+status$/i,
    type: 'mcp_status',
    requiresConfirm: false,
  },
  {
    pattern: /^\/mcp\s+start\s+(.+)$/i,
    type: 'mcp_start',
    paramExtractor: (match) => ({ mcpName: match[1].trim() }),
    requiresConfirm: true,
  },
  {
    pattern: /^\/mcp\s+stop\s+(.+)$/i,
    type: 'mcp_stop',
    paramExtractor: (match) => ({ mcpName: match[1].trim() }),
    requiresConfirm: true,
  },
  {
    pattern: /^\/skillgroup\s+list$/i,
    type: 'skillgroup_list',
    requiresConfirm: false,
  },
  {
    pattern: /^\/skillgroup\s+switch\s+(.+)$/i,
    type: 'skillgroup_switch',
    paramExtractor: (match) => ({ skillgroupName: match[1].trim() }),
    requiresConfirm: true,
  },
  {
    pattern: /^\/help$/i,
    type: 'help',
    requiresConfirm: false,
  },
]

/**
 * Natural language patterns for Chinese
 * Note: More specific patterns (like MCP commands) should come before general patterns
 */
const NATURAL_LANGUAGE_PATTERNS_CN: Array<{
  pattern: RegExp
  type: ExtendedCommandType
  paramExtractor?: (match: RegExpMatchArray) => Record<string, string>
  requiresConfirm: boolean
}> = [
  // MCP status commands - must come before general status commands
  {
    pattern: /MCP状态|查看MCP|MCP工具状态/i,
    type: 'mcp_status',
    requiresConfirm: false,
  },
  // MCP start commands
  {
    pattern: /启动MCP(.+)|启动(.+?)MCP|开启MCP(.+)|开启(.+?)MCP/i,
    type: 'mcp_start',
    paramExtractor: (match) => {
      const mcpName = match[1] || match[2] || match[3] || match[4]
      return { mcpName: mcpName.trim() }
    },
    requiresConfirm: true,
  },
  // MCP stop commands
  {
    pattern: /停止MCP(.+)|停止(.+?)MCP|关闭MCP(.+)|关闭(.+?)MCP/i,
    type: 'mcp_stop',
    paramExtractor: (match) => {
      const mcpName = match[1] || match[2] || match[3] || match[4]
      return { mcpName: mcpName.trim() }
    },
    requiresConfirm: true,
  },
  // Switch project commands
  {
    pattern: /切换到(.+?)项目|切换项目(.+)|切换到(.+)/i,
    type: 'switch',
    paramExtractor: (match) => {
      const projectName = match[1] || match[2] || match[3]
      return { projectName: projectName.trim() }
    },
    requiresConfirm: true,
  },
  // Restart project commands
  {
    pattern: /重启(.+?)项目|重启项目(.+)|重启(.+)/i,
    type: 'restart',
    paramExtractor: (match) => {
      const projectName = match[1] || match[2] || match[3]
      return { projectName: projectName.trim() }
    },
    requiresConfirm: true,
  },
  // Skillgroup commands - must come before general status commands
  {
    pattern: /技能组列表|查看技能组|技能列表|所有技能组/i,
    type: 'skillgroup_list',
    requiresConfirm: false,
  },
  // Skillgroup switch commands
  {
    pattern: /切换技能组(.+)|切换到技能组(.+)|使用技能组(.+)/i,
    type: 'skillgroup_switch',
    paramExtractor: (match) => {
      const skillgroupName = match[1] || match[2] || match[3]
      return { skillgroupName: skillgroupName.trim() }
    },
    requiresConfirm: true,
  },
  // Help commands - must come before general status commands
  {
    pattern: /帮助|帮助信息|使用帮助|指令帮助|命令帮助/i,
    type: 'help',
    requiresConfirm: false,
  },
  // Status commands - general, should come last
  {
    pattern: /查看状态|^状态$|当前状态|项目状态|运行状态/i,
    type: 'status',
    requiresConfirm: false,
  },
]

/**
 * Natural language patterns for English
 * Note: More specific patterns (like MCP commands) should come before general patterns
 */
const NATURAL_LANGUAGE_PATTERNS_EN: Array<{
  pattern: RegExp
  type: ExtendedCommandType
  paramExtractor?: (match: RegExpMatchArray) => Record<string, string>
  requiresConfirm: boolean
}> = [
  // MCP status commands - must come before general status commands
  {
    pattern: /MCP status|check MCP|show MCP|MCP tools status/i,
    type: 'mcp_status',
    requiresConfirm: false,
  },
  // MCP start commands
  {
    pattern: /start MCP (.+)|start (.+?) MCP|enable MCP (.+)|enable (.+?) MCP/i,
    type: 'mcp_start',
    paramExtractor: (match) => {
      const mcpName = match[1] || match[2] || match[3] || match[4]
      return { mcpName: mcpName.trim() }
    },
    requiresConfirm: true,
  },
  // MCP stop commands
  {
    pattern: /stop MCP (.+)|stop (.+?) MCP|disable MCP (.+)|disable (.+?) MCP/i,
    type: 'mcp_stop',
    paramExtractor: (match) => {
      const mcpName = match[1] || match[2] || match[3] || match[4]
      return { mcpName: mcpName.trim() }
    },
    requiresConfirm: true,
  },
  // Switch project commands
  {
    pattern: /switch to (.+?) project|switch project to (.+)|switch to (.+)/i,
    type: 'switch',
    paramExtractor: (match) => {
      const projectName = match[1] || match[2] || match[3]
      return { projectName: projectName.trim() }
    },
    requiresConfirm: true,
  },
  // Restart project commands
  {
    pattern: /restart (.+?) project|restart project (.+)|restart (.+)/i,
    type: 'restart',
    paramExtractor: (match) => {
      const projectName = match[1] || match[2] || match[3]
      return { projectName: projectName.trim() }
    },
    requiresConfirm: true,
  },
  // Skillgroup list commands
  {
    pattern: /skill group list|show skill groups|list skill groups|all skill groups/i,
    type: 'skillgroup_list',
    requiresConfirm: false,
  },
  // Skillgroup switch commands
  {
    pattern: /switch skill group to (.+)|use skill group (.+)|change skill group to (.+)/i,
    type: 'skillgroup_switch',
    paramExtractor: (match) => {
      const skillgroupName = match[1] || match[2] || match[3]
      return { skillgroupName: skillgroupName.trim() }
    },
    requiresConfirm: true,
  },
  // Help commands - must come before general status commands
  {
    pattern: /^help$|show help|command help|usage help/i,
    type: 'help',
    requiresConfirm: false,
  },
  // Status commands - general, should come last
  {
    pattern: /show status|check status|current status|project status|what'?s the status/i,
    type: 'status',
    requiresConfirm: false,
  },
]

// ============ Command Parser Implementation ============

/**
 * Command Parser class for parsing user messages into structured commands
 */
export class CommandParser {
  private customCommands: Map<string, CustomCommand> = new Map()
  private projectNames: string[] = []
  private mcpNames: string[] = []
  private skillgroupNames: string[] = []

  /**
   * Create a new CommandParser instance
   * @param options - Optional configuration
   */
  constructor(options?: {
    projectNames?: string[]
    mcpNames?: string[]
    skillgroupNames?: string[]
  }) {
    if (options?.projectNames) {
      this.projectNames = options.projectNames
    }
    if (options?.mcpNames) {
      this.mcpNames = options.mcpNames
    }
    if (options?.skillgroupNames) {
      this.skillgroupNames = options.skillgroupNames
    }
  }

  /**
   * Parse a user message into a structured command
   *
   * @param message - User message content
   * @returns Parsed command result
   *
   * @example
   * ```typescript
   * const parser = new CommandParser();
   * const result = parser.parse('/status');
   * // { type: 'status', raw: '/status', params: {}, requiresConfirm: false }
   *
   * const result2 = parser.parse('切换到 my-project 项目');
   * // { type: 'switch', raw: '...', params: { projectName: 'my-project' }, requiresConfirm: true }
   * ```
   */
  parse(message: string): ParsedCommand {
    const trimmedMessage = message.trim()

    // 1. Try explicit command patterns first
    const explicitResult = this.tryParseExplicit(trimmedMessage)
    if (explicitResult) {
      return explicitResult
    }

    // 2. Try custom registered commands
    const customResult = this.tryParseCustom(trimmedMessage)
    if (customResult) {
      return customResult
    }

    // 3. Try natural language patterns (Chinese)
    const cnResult = this.tryParseNaturalLanguage(trimmedMessage, NATURAL_LANGUAGE_PATTERNS_CN)
    if (cnResult) {
      return cnResult
    }

    // 4. Try natural language patterns (English)
    const enResult = this.tryParseNaturalLanguage(trimmedMessage, NATURAL_LANGUAGE_PATTERNS_EN)
    if (enResult) {
      return enResult
    }

    // 5. Return unknown command
    return {
      type: 'unknown',
      raw: message,
      params: {},
      requiresConfirm: false,
    }
  }

  /**
   * Register a custom command pattern
   *
   * @param name - Command name for identification
   * @param pattern - Regular expression to match
   * @param handler - Handler function
   * @param requiresConfirm - Whether confirmation is required
   *
   * @example
   * ```typescript
   * parser.registerCommand(
   *   'custom-action',
   *   /^\/custom\s+(.+)$/i,
   *   async (params) => ({ success: true, message: 'Done' }),
   *   false
   * );
   * ```
   */
  registerCommand(
    name: string,
    pattern: RegExp,
    handler: CommandHandler,
    requiresConfirm: boolean = false
  ): void {
    this.customCommands.set(name, {
      pattern,
      handler,
      requiresConfirm,
    })
  }

  /**
   * Unregister a custom command
   * @param name - Command name to unregister
   */
  unregisterCommand(name: string): void {
    this.customCommands.delete(name)
  }

  /**
   * Update the list of known project names for fuzzy matching
   * @param names - Array of project names
   */
  setProjectNames(names: string[]): void {
    this.projectNames = names
  }

  /**
   * Update the list of known MCP names for fuzzy matching
   * @param names - Array of MCP names
   */
  setMcpNames(names: string[]): void {
    this.mcpNames = names
  }

  /**
   * Update the list of known skillgroup names for fuzzy matching
   * @param names - Array of skillgroup names
   */
  setSkillgroupNames(names: string[]): void {
    this.skillgroupNames = names
  }

  /**
   * Get all supported command types
   * @returns Array of supported command types
   */
  getSupportedCommands(): ExtendedCommandType[] {
    return [
      'status',
      'switch',
      'restart',
      'mcp_status',
      'mcp_start',
      'mcp_stop',
      'skillgroup_list',
      'skillgroup_switch',
      'help',
    ]
  }

  /**
   * Get help text for all commands
   * @returns Formatted help text
   */
  getHelpText(): string {
    return `📋 远程控制指令帮助

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

⚠️ 标记 ✅ 的操作需要手机端确认`
  }

  // ============ Private Methods ============

  /**
   * Try to parse as explicit command
   */
  private tryParseExplicit(message: string): ParsedCommand | null {
    for (const { pattern, type, paramExtractor, requiresConfirm } of EXPLICIT_COMMAND_PATTERNS) {
      const match = message.match(pattern)
      if (match) {
        const params = paramExtractor ? paramExtractor(match) : {}
        // Apply fuzzy matching for parameters
        const enhancedParams = this.applyFuzzyMatching(type, params)

        return {
          type,
          raw: message,
          params: enhancedParams,
          requiresConfirm,
        }
      }
    }
    return null
  }

  /**
   * Try to parse as custom registered command
   */
  private tryParseCustom(message: string): ParsedCommand | null {
    const customCommandsArray = Array.from(this.customCommands.entries())
    for (const [name, { pattern, handler, requiresConfirm }] of customCommandsArray) {
      const match = message.match(pattern)
      if (match) {
        return {
          type: name as ExtendedCommandType,
          raw: message,
          params: { matched: match[0], groups: JSON.stringify(match.groups || {}) },
          requiresConfirm,
        }
      }
    }
    return null
  }

  /**
   * Try to parse as natural language
   */
  private tryParseNaturalLanguage(
    message: string,
    patterns: Array<{
      pattern: RegExp
      type: ExtendedCommandType
      paramExtractor?: (match: RegExpMatchArray) => Record<string, string>
      requiresConfirm: boolean
    }>
  ): ParsedCommand | null {
    for (const { pattern, type, paramExtractor, requiresConfirm } of patterns) {
      const match = message.match(pattern)
      if (match) {
        const params = paramExtractor ? paramExtractor(match) : {}
        // Apply fuzzy matching for parameters
        const enhancedParams = this.applyFuzzyMatching(type, params)

        return {
          type,
          raw: message,
          params: enhancedParams,
          requiresConfirm,
        }
      }
    }
    return null
  }

  /**
   * Apply fuzzy matching to enhance parameters
   * For example, partial project name matching
   */
  private applyFuzzyMatching(
    type: ExtendedCommandType,
    params: Record<string, string>
  ): Record<string, string> {
    const result = { ...params }

    // Fuzzy match project name
    if ('projectName' in params && this.projectNames.length > 0) {
      const inputName = params.projectName.toLowerCase()
      const matched = this.fuzzyMatch(inputName, this.projectNames)
      if (matched && matched !== params.projectName) {
        result.projectName = matched
        result.originalInput = params.projectName
        result.fuzzyMatched = 'true'
      }
    }

    // Fuzzy match MCP name
    if ('mcpName' in params && this.mcpNames.length > 0) {
      const inputName = params.mcpName.toLowerCase()
      const matched = this.fuzzyMatch(inputName, this.mcpNames)
      if (matched && matched !== params.mcpName) {
        result.mcpName = matched
        result.originalInput = params.mcpName
        result.fuzzyMatched = 'true'
      }
    }

    // Fuzzy match skillgroup name
    if ('skillgroupName' in params && this.skillgroupNames.length > 0) {
      const inputName = params.skillgroupName.toLowerCase()
      const matched = this.fuzzyMatch(inputName, this.skillgroupNames)
      if (matched && matched !== params.skillgroupName) {
        result.skillgroupName = matched
        result.originalInput = params.skillgroupName
        result.fuzzyMatched = 'true'
      }
    }

    return result
  }

  /**
   * Fuzzy match input against a list of candidates
   * Returns the best matching candidate or null
   */
  private fuzzyMatch(input: string, candidates: string[]): string | null {
    // 1. Exact match (case-insensitive)
    const exactMatch = candidates.find(
      (c) => c.toLowerCase() === input.toLowerCase()
    )
    if (exactMatch) {
      return exactMatch
    }

    // 2. Prefix match
    const prefixMatches = candidates.filter(
      (c) => c.toLowerCase().startsWith(input)
    )
    if (prefixMatches.length === 1) {
      return prefixMatches[0]
    }

    // 3. Contains match
    const containsMatches = candidates.filter(
      (c) => c.toLowerCase().includes(input)
    )
    if (containsMatches.length === 1) {
      return containsMatches[0]
    }

    // 4. Levenshtein distance match (for typos)
    const distanceMatches = candidates
      .map((c) => ({
        name: c,
        distance: this.levenshteinDistance(input, c.toLowerCase()),
      }))
      .filter((m) => m.distance <= 2) // Allow up to 2 character differences
      .sort((a, b) => a.distance - b.distance)

    if (distanceMatches.length > 0) {
      return distanceMatches[0].name
    }

    return null
  }

  /**
   * Calculate Levenshtein distance between two strings
   * Used for fuzzy matching with typo tolerance
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = []

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i]
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          )
        }
      }
    }

    return matrix[b.length][a.length]
  }
}

// ============ Factory Function ============

/**
 * Create a new CommandParser instance
 *
 * @param options - Optional configuration
 * @returns CommandParser instance
 */
export function createCommandParser(options?: {
  projectNames?: string[]
  mcpNames?: string[]
  skillgroupNames?: string[]
}): CommandParser {
  return new CommandParser(options)
}

// ============ Default Export ============

export default CommandParser
