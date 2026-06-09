/**
 * Controller Engine
 * 通用控制器引擎
 * @module main/controller/engine
 */

import { Logger } from '../utils/logger'
import { SessionApi, createSessionApi } from './session-api'
import { StateManager } from './state-manager'
import { ScriptExecutor } from './script-executor'
import { AgentRegistry } from './agent-registry'
import { initDebugLogger, debugLog, closeDebugLogger, getLogFilePath } from './debug-logger'
import * as fs from 'fs'
import * as path from 'path'

const logger = new Logger('ControllerEngine')

/**
 * 控制器引擎配置
 */
export interface ControllerEngineConfig {
  sessionId: string
  projectRoot: string
  skillName: string
  externalAbortSignal?: AbortSignal
}

/**
 * 控制器引擎
 * 通用控制器，支持执行 JS 脚本
 */
export class ControllerEngine {
  private sessionId: string
  private projectRoot: string
  private skillName: string
  private sessionApi: SessionApi | null = null
  private stateManager: StateManager | null = null
  private abortController: AbortController | null = null
  private isRunning: boolean = false
  private externalAbortSignal?: AbortSignal

  constructor(config: ControllerEngineConfig) {
    this.sessionId = config.sessionId
    this.projectRoot = config.projectRoot
    this.skillName = config.skillName
    this.externalAbortSignal = config.externalAbortSignal
  }

  /**
   * 运行控制器
   */
  async run(): Promise<{ success: boolean; error?: string }> {
    if (this.isRunning) {
      return { success: false, error: 'Controller is already running' }
    }

    this.isRunning = true
    this.abortController = new AbortController()

    initDebugLogger(this.projectRoot)
    debugLog('ENGINE', `控制器启动: ${this.skillName}`, {
      sessionId: this.sessionId,
      projectRoot: this.projectRoot
    })

    // 监听外部中止信号
    if (this.externalAbortSignal) {
      if (this.externalAbortSignal.aborted) {
        this.isRunning = false
        return { success: false, error: 'Aborted by parent controller' }
      }
      this.externalAbortSignal.addEventListener('abort', () => this.abort(), { once: true })
    }

    logger.info(`Starting controller: ${this.skillName}`)
    logger.info(`Session: ${this.sessionId}`)
    logger.info(`Project: ${this.projectRoot}`)

    try {
      // 步骤1: 创建会话 API
      debugLog('ENGINE', '步骤1: 创建会话 API')
      this.sessionApi = createSessionApi(this.sessionId, this.projectRoot)

      // 步骤2: 初始化状态管理器
      debugLog('ENGINE', '步骤2: 初始化状态管理器')
      await this.sendProgress('📂 初始化状态...')
      this.stateManager = new StateManager(this.sessionApi)
      await this.stateManager.initialize()

      // 步骤3: 查找 JS 脚本
      debugLog('ENGINE', `步骤3: 查找 JS 脚本: ${this.skillName}`)
      const scriptPath = this.findScriptFile()
      if (!scriptPath) {
        const error = `Script file not found: ${this.skillName}.js`
        debugLog('ENGINE', error)
        return { success: false, error }
      }

      await this.sendProgress(`📋 执行脚本: ${scriptPath}`)

      // 步骤4: 创建 Agent 注册表
      debugLog('ENGINE', '步骤4: 创建 Agent 注册表')
      const agentRegistry = this.createAgentRegistry()

      // 步骤5: 创建脚本执行器
      debugLog('ENGINE', '步骤5: 创建脚本执行器')
      const scriptExecutor = new ScriptExecutor({
        sessionApi: this.sessionApi,
        stateManager: this.stateManager,
        agentRegistry,
        projectRoot: this.projectRoot,
        skillName: this.skillName,
        abortSignal: this.abortController.signal
      })

      // 步骤6: 执行脚本
      debugLog('ENGINE', '步骤6: 执行脚本')
      await this.sendProgress(`
## 🚀 开始执行: ${this.skillName}`)

      const result = await scriptExecutor.executeScriptFile(scriptPath)

      if (result.success) {
        debugLog('ENGINE', `脚本执行完成`)
        await this.sendProgress(`
## ✅ 执行完成: ${this.skillName}`)
      } else {
        debugLog('ENGINE', `脚本执行失败: ${result.error}`)
        await this.sendProgress(`
## ❌ 执行失败: ${result.error}`)
      }

      closeDebugLogger()
      debugLog('ENGINE', `日志文件: ${getLogFilePath()}`)

      return result

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`Controller failed: ${errorMessage}`)
      debugLog('ENGINE', `错误: ${errorMessage}`)
      await this.sendProgress(`
## ❌ 错误: ${errorMessage}`)
      closeDebugLogger()
      return { success: false, error: errorMessage }
    } finally {
      this.isRunning = false
      this.abortController = null
    }
  }

  /**
   * 中止执行
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      logger.info('Controller aborted')
    }
  }

  /**
   * 获取技能名称
   */
  getSkillName(): string {
    return this.skillName
  }

  /**
   * 查找 JS 脚本文件
   */
  private findScriptFile(): string | null {
    const skillflowDir = path.join(this.projectRoot, '.claude', 'skillflow')

    if (!fs.existsSync(skillflowDir)) {
      logger.warn(`Skillflow directory not found: ${skillflowDir}`)
      return null
    }

    const scriptFile = `${this.skillName}.js`
    const scriptPath = path.join(skillflowDir, scriptFile)

    if (fs.existsSync(scriptPath)) {
      return path.join('.claude', 'skillflow', scriptFile)
    }

    return null
  }

  /**
   * 创建 Agent 注册表
   */
  private createAgentRegistry(): AgentRegistry {
    const agentRegistry = new AgentRegistry()

    // 发现可用 Agent
    const agentsDir = path.join(this.projectRoot, '.claude', 'agents')
    let availableAgents: string[] = []

    if (fs.existsSync(agentsDir)) {
      try {
        const files = fs.readdirSync(agentsDir)
        availableAgents = files
          .filter(f => f.endsWith('.md'))
          .map(f => f.replace('.md', ''))
        logger.info(`Discovered agents: ${availableAgents.join(', ')}`)
      } catch (err) {
        logger.warn(`Failed to read agents directory: ${err}`)
      }
    }

    // 获取超时配置
    const state = this.stateManager?.getState()
    const timeoutMinutes = (state?.config as { default_agent_timeout_minutes?: number })?.default_agent_timeout_minutes || 30
    const timeoutMs = timeoutMinutes * 60 * 1000
    logger.info(`Agent timeout: ${timeoutMinutes} minutes (${timeoutMs}ms)`)

    // 注册 Agent
    for (const agentName of availableAgents) {
      agentRegistry.register(agentName, {
        name: agentName,
        description: `Agent: ${agentName}`,
        execute: async (input: Record<string, unknown>) => {
          return await this.sessionApi!.callAgent(agentName, input, timeoutMs)
        }
      })
    }

    return agentRegistry
  }

  /**
   * 发送进度消息
   */
  private async sendProgress(message: string): Promise<void> {
    if (this.sessionApi) {
      await this.sessionApi.sendMessage(message)
    }
  }
}

/**
 * 运行控制器
 */
export async function runController(
  sessionId: string,
  projectRoot: string,
  skillName: string
): Promise<{ success: boolean; error?: string }> {
  const engine = new ControllerEngine({
    sessionId,
    projectRoot,
    skillName
  })
  return engine.run()
}
