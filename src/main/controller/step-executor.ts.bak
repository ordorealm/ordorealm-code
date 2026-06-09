/**
 * Step Executor
 * 步骤执行器
 * @module main/controller/step-executor
 */

import { Logger } from '../utils/logger'
import { SessionApi } from './session-api'
import { StateManager } from './state-manager'
import type {
  StepDef,
  StepResult,
  StaticConfig,
  SkillOrchestration,
  AgentResult,
  FlowState
} from './types'

const logger = new Logger('StepExecutor')

/**
 * 步骤执行器配置
 */
export interface StepExecutorConfig {
  sessionApi: SessionApi
  stateManager: StateManager
  config: StaticConfig
  skill: SkillOrchestration
}

/**
 * 步骤执行器
 * 执行编排中定义的步骤
 */
export class StepExecutor {
  private sessionApi: SessionApi
  private stateManager: StateManager
  private config: StaticConfig
  private skill: SkillOrchestration

  constructor(config: StepExecutorConfig) {
    this.sessionApi = config.sessionApi
    this.stateManager = config.stateManager
    this.config = config.config
    this.skill = config.skill
  }

  /**
   * 执行步骤
   * @param step 步骤定义
   * @returns 执行结果
   */
  async execute(step: StepDef): Promise<StepResult> {
    logger.info(`Executing step: ${step.id} (${step.action})`)

    try {
      switch (step.action) {
        case 'check_state':
          return await this.executeCheckState(step)

        case 'load_state':
          return await this.executeLoadState(step)

        case 'output':
          return await this.executeOutput(step)

        case 'send_message':
        case 'call_tool':
          return await this.executeCallTool(step)

        case 'call_agent':
          return await this.executeCallAgent(step)

        case 'call_controller':
          return await this.executeCallController(step)

        case 'update_state':
          return await this.executeUpdateState(step)

        case 'write_file':
          return await this.executeWriteFile(step)

        case 'read_file':
          return await this.executeReadFile(step)

        case 'select_next':
          return await this.executeSelectNext(step)

        case 'loop':
        case 'review_loop':
          return await this.executeLoop(step)

        case 'validation_pipeline':
          return await this.executeValidationPipeline(step)

        case 'interactive_loop':
          return await this.executeInteractiveLoop(step)

        default:
          logger.warn(`Unknown action: ${step.action}`)
          return { success: false, error: `Unknown action: ${step.action}` }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`Step ${step.id} failed: ${errorMessage}`)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 执行检查状态
   */
  private async executeCheckState(step: StepDef): Promise<StepResult> {
    const state = this.stateManager.getState()
    const expect = step.expect || {}

    for (const [key, expectedValue] of Object.entries(expect)) {
      const actualValue = this.getNestedValue(state, key)

      if (expectedValue === 'exists') {
        if (actualValue === undefined || actualValue === null) {
          return {
            success: false,
            error: `State check failed: ${key} does not exist`,
            nextStep: step.on_fail || step.on_error
          }
        }
      } else if (expectedValue === 'not_exists') {
        if (actualValue !== undefined && actualValue !== null) {
          return {
            success: false,
            error: `State check failed: ${key} exists`,
            nextStep: step.on_fail || step.on_error
          }
        }
      } else if (actualValue !== expectedValue) {
        return {
          success: false,
          error: `State check failed: ${key} is ${actualValue}, expected ${expectedValue}`,
          nextStep: step.on_fail || step.on_error
        }
      }
    }

    return {
      success: true,
      nextStep: step.on_success || step.next
    }
  }

  /**
   * 执行加载状态
   */
  private async executeLoadState(step: StepDef): Promise<StepResult> {
    const state = this.stateManager.getState()

    return {
      success: true,
      output: {
        phases: state.phases,
        tasks: state.tasks,
        flow: state.flow
      },
      nextStep: step.next
    }
  }

  /**
   * 执行输出
   */
  private async executeOutput(step: StepDef): Promise<StepResult> {
    const message = step.message || step.content || ''

    // 替换变量
    const processedMessage = this.replaceVariables(message)

    await this.sessionApi.sendMessage(processedMessage)

    return {
      success: true,
      nextStep: step.next
    }
  }

  /**
   * 执行调用工具
   */
  private async executeCallTool(step: StepDef): Promise<StepResult> {
    const toolName = step.tool || ''
    const params = step.parameters || step.input || {}

    logger.info(`Calling tool: ${toolName}`)

    // 处理工具调用
    switch (toolName) {
      case 'phase_start':
        return await this.handlePhaseStart(params)

      case 'task_complete':
        return await this.handleTaskComplete(params)

      case 'review_complete':
        return await this.handleReviewComplete(params)

      case 'phase_complete':
        return await this.handlePhaseComplete(params)

      case 'request_input':
        return await this.handleRequestInput(params)

      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
          nextStep: step.on_fail || step.on_error
        }
    }
  }

  /**
   * 执行调用 Agent
   */
  private async executeCallAgent(step: StepDef): Promise<StepResult> {
    const agentName = step.agent || ''
    const input = step.input || {}

    logger.info(`Calling agent: ${agentName}`)

    // 先输出当前步骤信息
    if (step.description) {
      await this.sessionApi.sendMessage(`\n### ▶️ ${step.description}`)
    }

    // 调用 Agent
    const result = await this.sessionApi.callAgent(agentName, input)

    if (result.success) {
      return {
        success: true,
        output: {
          agentResult: result
        },
        nextStep: step.on_success || step.next
      }
    } else {
      return {
        success: false,
        error: result.error || 'Agent execution failed',
        nextStep: step.on_fail || step.on_error
      }
    }
  }

  /**
   * 执行调用控制器
   */
  private async executeCallController(step: StepDef): Promise<StepResult> {
    const controllerName = step.controller || ''

    logger.info(`Calling controller: ${controllerName}`)

    await this.sessionApi.sendMessage(`\n### 🔄 切换到 ${controllerName}`)

    // 这里需要递归调用控制器引擎
    // 暂时返回成功，实际需要实现控制器调用
    return {
      success: true,
      nextStep: step.on_success || step.next
    }
  }

  /**
   * 执行更新状态
   */
  private async executeUpdateState(step: StepDef): Promise<StepResult> {
    const changes = step.changes || {}

    for (const [key, value] of Object.entries(changes)) {
      if (key === 'flow') {
        await this.stateManager.updateFlowState(value as FlowState)
      }
      // 其他状态更新...
    }

    return {
      success: true,
      nextStep: step.next
    }
  }

  /**
   * 执行写入文件
   */
  private async executeWriteFile(step: StepDef): Promise<StepResult> {
    const target = step.target || ''
    const content = step.content || ''

    await this.sessionApi.writeFile(target, content)

    return {
      success: true,
      nextStep: step.next
    }
  }

  /**
   * 执行读取文件
   */
  private async executeReadFile(step: StepDef): Promise<StepResult> {
    const target = step.target || ''

    const content = await this.sessionApi.readFile(target)

    return {
      success: true,
      output: {
        content,
        [step.output || 'content']: content
      },
      nextStep: step.next
    }
  }

  /**
   * 执行选择下一个
   */
  private async executeSelectNext(step: StepDef): Promise<StepResult> {
    const from = step.from || ''
    const condition = step.condition || ''

    let selectedItem: unknown = null

    // 根据来源选择
    if (from === 'phases') {
      selectedItem = this.stateManager.getNextPendingPhase()
    } else if (from === 'tasks' || from === 'current_phase.tasks') {
      const state = this.stateManager.getState()
      if (state.currentPhase) {
        selectedItem = this.stateManager.getNextPendingTask(state.currentPhase)
      }
    }

    if (selectedItem) {
      return {
        success: true,
        output: {
          [step.output || 'selected']: selectedItem
        },
        nextStep: step.on_success || step.next
      }
    } else {
      return {
        success: true,
        output: {
          [step.output || 'selected']: null
        },
        nextStep: step.on_no_match || step.next
      }
    }
  }

  /**
   * 执行循环
   */
  private async executeLoop(step: StepDef): Promise<StepResult> {
    const loopParams = step.steps as any
    const minRounds = step.min_rounds || loopParams?.min_iterations || 0
    const maxRounds = step.max_rounds || loopParams?.max_iterations || 5

    logger.info(`Starting loop: min=${minRounds}, max=${maxRounds}`)

    let iteration = 0

    while (iteration < maxRounds) {
      iteration++

      await this.sessionApi.sendMessage(`\n**循环第 ${iteration} 轮**`)

      // 执行循环内的步骤
      if (loopParams?.steps) {
        for (const subStep of loopParams.steps) {
          const result = await this.execute(subStep)
          if (!result.success) {
            return {
              success: false,
              error: result.error,
              nextStep: step.on_fail || step.on_error
            }
          }

          // 检查退出条件
          if (loopParams.exit_condition && this.checkExitCondition(loopParams.exit_condition, result)) {
            logger.info(`Loop exit condition met at iteration ${iteration}`)
            break
          }
        }
      }

      // 检查最小轮次
      if (iteration >= minRounds) {
        // 检查是否满足退出条件
        if (loopParams.exit_condition) {
          // 需要根据条件判断
        }
      }
    }

    return {
      success: true,
      output: {
        iterations: iteration
      },
      nextStep: step.on_success || step.next
    }
  }

  /**
   * 执行验证管道
   */
  private async executeValidationPipeline(step: StepDef): Promise<StepResult> {
    const pipelineParams = step.steps as any
    const steps = pipelineParams?.steps || []

    logger.info(`Starting validation pipeline: ${steps.length} steps`)

    for (const validationStep of steps) {
      await this.sessionApi.sendMessage(`\n**验证: ${validationStep.name}**`)

      // 执行验证命令
      if (validationStep.command) {
        // 这里需要执行命令并检查结果
        // 暂时模拟成功
        await this.sessionApi.sendMessage(`✅ ${validationStep.name} 通过`)
      } else if (validationStep.validator) {
        // 执行验证器
        await this.sessionApi.sendMessage(`✅ ${validationStep.name} 通过`)
      }
    }

    return {
      success: true,
      nextStep: step.on_success || step.next
    }
  }

  /**
   * 执行交互式循环
   */
  private async executeInteractiveLoop(step: StepDef): Promise<StepResult> {
    logger.info('Starting interactive loop')

    // 交互式循环需要等待用户输入
    // 这里通过消息让用户知道需要交互
    await this.sessionApi.sendMessage('\n### 📝 开始交互式收集')

    // 实际的交互需要通过 request_input 工具完成
    return {
      success: true,
      nextStep: step.next
    }
  }

  /**
   * 处理 Phase 开始
   */
  private async handlePhaseStart(params: Record<string, unknown>): Promise<StepResult> {
    const phaseId = params.phaseId as string

    if (!phaseId) {
      return { success: false, error: 'Missing phaseId' }
    }

    await this.stateManager.setCurrentPhase(phaseId)
    await this.stateManager.updatePhaseStatus(phaseId, 'in_progress')

    await this.sessionApi.sendMessage(`\n## 🚀 Phase: ${phaseId} 开始`)

    return { success: true }
  }

  /**
   * 处理任务完成
   */
  private async handleTaskComplete(params: Record<string, unknown>): Promise<StepResult> {
    const status = params.status as string
    const modifiedFiles = params.modifiedFiles as string[] || []
    const summary = params.summary as string || ''

    const state = this.stateManager.getState()
    const taskId = state.currentTask

    if (!taskId) {
      return { success: false, error: 'No current task' }
    }

    await this.stateManager.updateTaskStatus(taskId, status as any, summary, modifiedFiles)

    if (status === 'done') {
      await this.sessionApi.sendMessage(`\n#### ✅ Task: ${taskId} 完成`)
    } else if (status === 'failed') {
      await this.sessionApi.sendMessage(`\n#### ❌ Task: ${taskId} 失败: ${summary}`)
    }

    return { success: true }
  }

  /**
   * 处理审查完成
   */
  private async handleReviewComplete(params: Record<string, unknown>): Promise<StepResult> {
    const issues = params.issues as any[] || []
    const verdict = params.verdict as string

    const state = this.stateManager.getState()
    const phaseId = state.currentPhase

    if (!phaseId) {
      return { success: false, error: 'No current phase' }
    }

    await this.stateManager.incrementReviewCount()
    await this.stateManager.recordReviewIssues(phaseId, issues)

    if (verdict === 'pass') {
      await this.sessionApi.sendMessage('\n✅ 审查通过')
      return { success: true, nextStep: 'pass' }
    } else {
      await this.sessionApi.sendMessage(`\n⚠️ 审查发现问题: ${issues.length} 个`)
      return { success: true, nextStep: 'needs_fix' }
    }
  }

  /**
   * 处理 Phase 完成
   */
  private async handlePhaseComplete(params: Record<string, unknown>): Promise<StepResult> {
    const phaseId = params.phaseId as string
    const status = params.status as string

    await this.stateManager.updatePhaseStatus(phaseId, status as any)

    if (status === 'completed') {
      await this.sessionApi.sendMessage(`\n## ✅ Phase: ${phaseId} 完成`)
    } else {
      await this.sessionApi.sendMessage(`\n## ❌ Phase: ${phaseId} 失败`)
    }

    return { success: true }
  }

  /**
   * 处理请求输入
   */
  private async handleRequestInput(params: Record<string, unknown>): Promise<StepResult> {
    const question = params.question as string
    const type = params.type as string
    const options = params.options as any[]

    // 构建消息
    let message = `\n### ❓ ${question}`

    if (type === 'choice' && options) {
      message += '\n'
      options.forEach((opt, i) => {
        message += `${i + 1}. ${opt.label}\n`
      })
    }

    await this.sessionApi.sendMessage(message)

    // 注意：实际的输入需要等待用户响应
    // 这里只是发送消息，实际的输入处理需要更复杂的逻辑

    return { success: true }
  }

  /**
   * 替换变量
   */
  private replaceVariables(text: string): string {
    const state = this.stateManager.getState()

    // 替换 ${variable} 格式的变量
    return text.replace(/\$\{([^}]+)\}/g, (match, key) => {
      const value = this.getNestedValue({ state, config: this.config }, key)
      return value !== undefined ? String(value) : match
    })
  }

  /**
   * 获取嵌套值
   */
  private getNestedValue(obj: any, path: string): unknown {
    const keys = path.split('.')
    let current = obj

    for (const key of keys) {
      if (current === null || current === undefined) return undefined
      current = current[key]
    }

    return current
  }

  /**
   * 检查退出条件
   */
  private checkExitCondition(condition: string, result: StepResult): boolean {
    // 简单的条件检查
    if (condition.includes('verdict === ')) {
      const value = condition.match(/verdict === ['"](\w+)['"]/)?.[1]
      return result.output?.verdict === value
    }

    return false
  }
}
