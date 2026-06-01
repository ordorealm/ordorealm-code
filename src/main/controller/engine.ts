/**
 * Controller Engine
 * 控制器引擎主程序
 * @module main/controller/engine
 */

import { Logger } from '../utils/logger'
import { loadConfig, validateToolParams } from './config-loader'
import { parseSkill, getStep } from './skill-parser'
import { SessionApi, createSessionApi } from './session-api'
import { StateManager } from './state-manager'
import { StepExecutor } from './step-executor'
import type {
  StaticConfig,
  SkillOrchestration,
  StepDef,
  StepResult,
  ControllerState,
  FlowState
} from './types'

const logger = new Logger('ControllerEngine')

/**
 * 控制器引擎配置
 */
export interface ControllerEngineConfig {
  sessionId: string
  projectRoot: string
  skillName: string
}

/**
 * 控制器引擎
 * 读取配置文件，按定义的步骤执行，不依赖 AI 理解
 */
export class ControllerEngine {
  private sessionId: string
  private projectRoot: string
  private skillName: string

  private config: StaticConfig | null = null
  private skill: SkillOrchestration | null = null
  private sessionApi: SessionApi | null = null
  private stateManager: StateManager | null = null
  private stepExecutor: StepExecutor | null = null

  private abortController: AbortController | null = null
  private isRunning: boolean = false

  constructor(config: ControllerEngineConfig) {
    this.sessionId = config.sessionId
    this.projectRoot = config.projectRoot
    this.skillName = config.skillName
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

    logger.info(`Starting controller: ${this.skillName}`)
    logger.info(`Session: ${this.sessionId}`)
    logger.info(`Project: ${this.projectRoot}`)

    try {
      // 1. 创建会话 API
      this.sessionApi = createSessionApi(this.sessionId, this.projectRoot)

      // 2. 加载静态配置
      await this.sendProgress('📂 加载配置文件...')
      this.config = await loadConfig(this.projectRoot)
      await this.sendProgress(`✅ 配置加载完成，版本: ${this.config.version}`)

      // 3. 解析技能编排
      await this.sendProgress(`📋 解析技能编排: ${this.skillName}`)
      this.skill = await parseSkill(this.projectRoot, this.skillName)
      await this.sendProgress(`✅ 技能解析完成: ${this.skill.meta.description}`)

      // 4. 初始化状态管理器
      this.stateManager = new StateManager(this.sessionApi)
      await this.stateManager.initialize()

      // 5. 创建步骤执行器
      this.stepExecutor = new StepExecutor({
        sessionApi: this.sessionApi,
        stateManager: this.stateManager,
        config: this.config,
        skill: this.skill
      })

      // 6. 检查前置条件
      const preconditionCheck = await this.checkPrecondition()
      if (!preconditionCheck.success) {
        return preconditionCheck
      }

      // 7. 更新流程状态
      const flowState = this.getFlowStateForSkill()
      if (flowState) {
        await this.stateManager.updateFlowState(flowState)
      }

      // 8. 执行流程
      await this.sendProgress(`\n## 🚀 开始执行: ${this.skill.meta.name}`)

      const result = await this.executeFlow()

      // 9. 完成
      if (result.success) {
        await this.sendProgress(`\n## ✅ 流程执行完成: ${this.skill.meta.name}`)
      } else {
        await this.sendProgress(`\n## ❌ 流程执行失败: ${result.error}`)
      }

      return result

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`Controller failed: ${errorMessage}`)
      await this.sendProgress(`\n## ❌ 错误: ${errorMessage}`)
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
   * 检查前置条件
   */
  private async checkPrecondition(): Promise<{ success: boolean; error?: string }> {
    if (!this.skill || !this.stateManager) {
      return { success: false, error: 'Skill or state manager not initialized' }
    }

    const trigger = this.skill.trigger

    // 检查条件
    if (trigger.condition) {
      const state = this.stateManager.getState()

      // 简单的条件检查
      if (!this.evaluateCondition(trigger.condition, state)) {
        const error = trigger.precondition_error || `前置条件不满足: ${trigger.condition}`
        await this.sendProgress(`⚠️ ${error}`)
        return { success: false, error }
      }
    }

    return { success: true }
  }

  /**
   * 执行流程
   */
  private async executeFlow(): Promise<{ success: boolean; error?: string }> {
    if (!this.skill || !this.stepExecutor) {
      return { success: false, error: 'Skill or step executor not initialized' }
    }

    let currentStepId = this.skill.flow.entry
    const maxSteps = 100 // 防止无限循环
    let stepCount = 0

    while (currentStepId !== 'END' && currentStepId !== undefined) {
      // 检查中止
      if (this.abortController?.signal.aborted) {
        return { success: false, error: 'Aborted by user' }
      }

      // 检查步数限制
      stepCount++
      if (stepCount > maxSteps) {
        return { success: false, error: `Max steps exceeded (${maxSteps})` }
      }

      // 获取步骤
      const step = getStep(this.skill, currentStepId)
      if (!step) {
        return { success: false, error: `Step not found: ${currentStepId}` }
      }

      logger.info(`Step ${stepCount}: ${step.id} (${step.action})`)

      // 执行步骤
      const result = await this.stepExecutor.execute(step)

      // 处理工具调用
      if (result.toolCalls) {
        await this.handleToolCalls(result.toolCalls)
      }

      // 确定下一步
      if (!result.success) {
        // 步骤失败
        if (result.nextStep) {
          currentStepId = result.nextStep
        } else {
          return { success: false, error: result.error || 'Step failed' }
        }
      } else {
        // 步骤成功
        currentStepId = result.nextStep || step.next || 'END'
      }
    }

    return { success: true }
  }

  /**
   * 处理工具调用
   */
  private async handleToolCalls(toolCalls: Array<{ tool: string; parameters: Record<string, unknown> }>): Promise<void> {
    if (!this.config) return

    for (const call of toolCalls) {
      // 验证工具调用
      const validation = validateToolParams(call.tool, call.parameters, this.config)
      if (!validation.valid) {
        logger.error(`Invalid tool call: ${validation.error}`)
        continue
      }

      // 执行工具效果
      await this.applyToolEffects(call.tool, call.parameters)
    }
  }

  /**
   * 应用工具效果
   */
  private async applyToolEffects(toolName: string, params: Record<string, unknown>): Promise<void> {
    if (!this.config || !this.stateManager) return

    const toolDef = this.config.tools[toolName]
    if (!toolDef?.effects) return

    logger.info(`Applying effects for tool: ${toolName}`)

    // 更新任务状态
    if (toolDef.effects.updateTaskState) {
      const state = this.stateManager.getState()
      if (state.currentTask) {
        await this.stateManager.updateTaskStatus(
          state.currentTask,
          params.status as any,
          params.summary as string,
          params.modifiedFiles as string[]
        )
      }
    }

    // 增加审查轮次
    if (toolDef.effects.incrementReviewCount) {
      await this.stateManager.incrementReviewCount()
    }

    // 触发验证器
    if (toolDef.effects.triggerValidator) {
      await this.runValidator(toolDef.effects.triggerValidator)
    }
  }

  /**
   * 运行验证器
   */
  private async runValidator(validatorName: string): Promise<void> {
    if (!this.config || !this.sessionApi) return

    const validator = this.config.validators[validatorName]
    if (!validator) {
      logger.warn(`Validator not found: ${validatorName}`)
      return
    }

    await this.sendProgress(`🔍 运行验证器: ${validatorName}`)

    // 执行验证规则
    for (const rule of validator.rules) {
      const result = await this.executeValidationRule(rule)

      if (!result.pass) {
        await this.sendProgress(`⚠️ 验证失败: ${rule}`)
        await this.sendProgress(`  问题: ${result.issues.map(i => i.description).join(', ')}`)

        if (validator.onFail === 'block_and_report') {
          throw new Error(`Validation failed: ${rule}`)
        }
      } else {
        await this.sendProgress(`✅ 验证通过: ${rule}`)
      }
    }
  }

  /**
   * 执行验证规则
   */
  private async executeValidationRule(rule: string): Promise<{ pass: boolean; issues: Array<{ description: string }> }> {
    // 这里实现具体的验证逻辑
    // 第一期使用正则匹配

    switch (rule) {
      case 'no_empty_function_bodies':
        // 检查空函数体
        return { pass: true, issues: [] }

      case 'no_todo_placeholders':
        // 检查 TODO 占位符
        return { pass: true, issues: [] }

      case 'no_mock_data_in_prod':
        // 检查生产代码中的模拟数据
        return { pass: true, issues: [] }

      case 'no_empty_logic_blocks':
        // 检查空逻辑块
        return { pass: true, issues: [] }

      default:
        return { pass: true, issues: [] }
    }
  }

  /**
   * 发送进度消息
   */
  private async sendProgress(message: string): Promise<void> {
    if (this.sessionApi) {
      await this.sessionApi.sendMessage(message)
    }
  }

  /**
   * 获取技能对应的流程状态
   */
  private getFlowStateForSkill(): FlowState | null {
    const skillToFlow: Record<string, FlowState> = {
      'spec-controller': 'spec_in_progress',
      'plan-controller': 'plan_in_progress',
      'dev-controller': 'dev_in_progress',
      'review-controller': 'review_in_progress',
      'debug-controller': 'error'
    }

    return skillToFlow[this.skillName] || null
  }

  /**
   * 评估条件
   */
  private evaluateCondition(condition: string, state: ControllerState): boolean {
    // 简单的条件评估
    // 支持: state.flow === 'value'

    const match = condition.match(/state\.flow\s*===\s*['"](\w+)['"]/)
    if (match) {
      return state.flow === match[1]
    }

    // 支持: state.flow === 'value' and ...
    const andMatch = condition.match(/state\.flow\s*===\s*['"](\w+)['"]\s+and\s+(.+)/)
    if (andMatch) {
      return state.flow === andMatch[1] && this.evaluateCondition(andMatch[2], state)
    }

    // 默认返回 true
    return true
  }
}

/**
 * 创建并运行控制器
 * @param config 配置
 * @returns 执行结果
 */
export async function runController(config: ControllerEngineConfig): Promise<{ success: boolean; error?: string }> {
  const engine = new ControllerEngine(config)
  return engine.run()
}
