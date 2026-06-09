/**
 * Config Loader
 * 静态配置加载器
 * @module main/controller/config-loader
 */

import * as fs from 'fs'
import * as path from 'path'
import { Logger } from '../utils/logger'
import type { StaticConfig, ToolEffects, ConstraintsDef } from './types'
import { CONTROLLER_CONFIG_PATH } from './types'

const logger = new Logger('ConfigLoader')

/**
 * 默认工具效果
 */
const DEFAULT_TOOL_EFFECTS: ToolEffects = {
  updateState: undefined,
  incrementCounter: undefined,
  triggerValidator: undefined,
  blockOnFail: undefined
}

/**
 * 默认约束
 */
const DEFAULT_CONSTRAINTS: ConstraintsDef = {
  max_iterations: 100,
  default_timeout_minutes: 30,
  require_tools_for_state_change: true
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: StaticConfig = {
  version: '1.0.0',
  tools: {
    task_complete: {
      description: '任务完成时调用',
      parameters: {
        status: { type: 'string', enum: ['done', 'failed', 'blocked'], required: true },
        modifiedFiles: { type: 'array', required: true },
        summary: { type: 'string', required: true }
      },
      effects: {
        ...DEFAULT_TOOL_EFFECTS,
        updateState: 'task',
        triggerValidator: 'hallucination_check'
      }
    },
    review_complete: {
      description: '审查完成时调用',
      parameters: {
        issues: { type: 'array', required: true },
        verdict: { type: 'string', enum: ['pass', 'needs_fix'], required: true }
      },
      effects: {
        ...DEFAULT_TOOL_EFFECTS,
        incrementCounter: 'review_count',
        blockOnFail: true
      }
    },
    request_input: {
      description: '请求用户输入',
      parameters: {
        question: { type: 'string', required: true },
        type: { type: 'string', enum: ['text', 'choice', 'confirm'], required: true },
        options: { type: 'array', required: false }
      }
    }
  },
  validators: {
    hallucination_check: {
      trigger: 'after_task_complete',
      rules: [
        'no_empty_function_bodies',
        'no_todo_placeholders',
        'no_mock_data_in_prod',
        'no_empty_logic_blocks'
      ],
      onFail: 'block_and_report'
    }
  },
  constraints: DEFAULT_CONSTRAINTS
}

/**
 * 已加载的配置缓存
 */
let cachedConfig: StaticConfig | null = null

/**
 * 加载静态配置
 * @param projectRoot 项目根目录
 * @returns 静态配置
 */
export async function loadConfig(projectRoot: string): Promise<StaticConfig> {
  // 如果已缓存，直接返回
  if (cachedConfig) {
    return cachedConfig
  }

  const configPath = path.join(projectRoot, CONTROLLER_CONFIG_PATH)
  logger.info(`Loading config from: ${configPath}`)

  try {
    // 检查配置文件是否存在
    if (!fs.existsSync(configPath)) {
      logger.warn(`Config file not found, using default config: ${configPath}`)
      cachedConfig = DEFAULT_CONFIG
      return cachedConfig
    }

    // 读取配置文件
    const content = await fs.promises.readFile(configPath, 'utf-8')
    const config = JSON.parse(content) as StaticConfig

    // 验证配置版本
    if (!config.version) {
      logger.warn('Config missing version, using default version')
      config.version = DEFAULT_CONFIG.version
    }

    // 合并默认值（确保所有字段都存在）
    cachedConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      tools: { ...DEFAULT_CONFIG.tools, ...config.tools },
      validators: { ...DEFAULT_CONFIG.validators, ...config.validators },
      constraints: { ...DEFAULT_CONSTRAINTS, ...config.constraints }
    }

    logger.info(`Config loaded successfully, version: ${cachedConfig.version}`)
    return cachedConfig

  } catch (error) {
    logger.error(`Failed to load config: ${error}`)
    logger.warn('Using default config')
    cachedConfig = DEFAULT_CONFIG
    return cachedConfig
  }
}

/**
 * 获取缓存的配置（如果已加载）
 */
export function getCachedConfig(): StaticConfig | null {
  return cachedConfig
}

/**
 * 清除配置缓存
 */
export function clearConfigCache(): void {
  cachedConfig = null
}

/**
 * 验证工具调用参数
 * @param toolName 工具名称
 * @param params 参数
 * @param config 配置
 * @returns 验证结果
 */
export function validateToolParams(
  toolName: string,
  params: Record<string, unknown>,
  config: StaticConfig
): { valid: boolean; error?: string } {
  const toolDef = config.tools[toolName]
  if (!toolDef) {
    return { valid: false, error: `Unknown tool: ${toolName}` }
  }

  // 检查必需参数
  for (const [paramName, paramDef] of Object.entries(toolDef.parameters)) {
    if (paramDef.required && !(paramName in params)) {
      return { valid: false, error: `Missing required parameter: ${paramName}` }
    }

    // 检查枚举值
    if (paramDef.enum && paramName in params) {
      const value = params[paramName]
      if (!paramDef.enum.includes(value as string)) {
        return {
          valid: false,
          error: `Invalid value for ${paramName}: ${value}. Must be one of: ${paramDef.enum.join(', ')}`
        }
      }
    }
  }

  return { valid: true }
}
