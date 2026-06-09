/**
 * Session API
 * 项目会话 API 封装
 * 控制器通过此 API 与项目会话交互
 * @module main/controller/session-api
 */

import { BrowserWindow } from 'electron'
import { Logger } from '../utils/logger'
import { IPC_CHANNELS } from '../../shared/index'
import type { AgentResult, ControllerState, DocReviewResult } from './types'
import { STATE_FILE_PATH, PRODUCT_SPEC_PATH, DEV_PLAN_PATH } from './types'
import { debugLog } from './debug-logger'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'

const execAsync = promisify(execCallback)

const logger = new Logger('SessionApi')

/**
 * 会话 API 配置
 */
export interface SessionApiConfig {
  sessionId: string
  projectRoot: string
  webContents: Electron.WebContents
}

/**
 * 会话 API
 * 封装与项目会话的交互
 */
export class SessionApi {
  private sessionId: string
  private projectRoot: string
  private webContents: Electron.WebContents

  constructor(config: SessionApiConfig) {
    this.sessionId = config.sessionId
    this.projectRoot = config.projectRoot
    this.webContents = config.webContents
  }

  /**
   * 发送消息到对话框（流式显示）
   * @param content 消息内容
   */
  async sendMessage(content: string): Promise<void> {
    logger.info(`[${this.sessionId.slice(0, 8)}] Sending message: ${content.slice(0, 100)}...`)

    debugLog('SESSION_API', 'sendMessage 被调用', {
      sessionId: this.sessionId,
      contentLength: content.length,
      contentPreview: content.slice(0, 200),
      webContentsId: this.webContents.id,
      isDestroyed: this.webContents.isDestroyed()
    })

    // 发送助手消息到前端
    this.webContents.send(IPC_CHANNELS.CONVERSATION_MESSAGE, {
      sessionId: this.sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        timestamp: new Date().toISOString()
      }
    })

    debugLog('SESSION_API', 'sendMessage 已发送', {
      channel: IPC_CHANNELS.CONVERSATION_MESSAGE,
      sessionId: this.sessionId
    })
  }

  /**
   * 发送用户消息（模拟用户输入）
   * @param content 消息内容
   */
  async sendUserMessage(content: string): Promise<void> {
    logger.info(`[${this.sessionId.slice(0, 8)}] Sending user message: ${content.slice(0, 50)}...`)

    this.webContents.send(IPC_CHANNELS.CONVERSATION_MESSAGE, {
      sessionId: this.sessionId,
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
        timestamp: new Date().toISOString()
      }
    })
  }

  /**
   * 调用 Agent（通过发送消息触发，等待结果）
   * @param agentName Agent 名称
   * @param input 输入
   * @param timeoutMs 超时时间（毫秒），默认 30 分钟
   * @param abortSignal 中止信号
   * @returns Agent 结果
   */
  async callAgent(
    agentName: string,
    input: Record<string, unknown>,
    timeoutMs: number = 30 * 60 * 1000,
    abortSignal?: AbortSignal
  ): Promise<AgentResult> {
    logger.info(`[${this.sessionId.slice(0, 8)}] Calling agent: ${agentName}`)
    debugLog('SESSION_API', `callAgent 开始: ${agentName}`, { input, timeout: timeoutMs })
    return this.callAgentInternal(agentName, input, timeoutMs, abortSignal)
  }

  /**
   * Agent 调用内部实现
   */
  private async callAgentInternal(
    agentName: string,
    input: Record<string, unknown>,
    timeout: number,
    abortSignal?: AbortSignal
  ): Promise<AgentResult> {
    const prompt = this.buildAgentPrompt(agentName, input)
    debugLog('SESSION_API', `构建的 prompt 长度: ${prompt.length}`)
    const toolCallId = `agent-${agentName}-${Date.now()}`
    debugLog('SESSION_API', `生成的 toolCallId: ${toolCallId}`)

    // 发送 Agent 调用提示
    await this.sendMessage(`
### 🤖 调用 ${agentName}
\`\`\`
${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}
\`\`\`
`)

    return new Promise((resolve) => {
      let resolved = false
      let timeoutId: NodeJS.Timeout | null = null
      let listener: ((_: unknown, channel: string, ...args: unknown[]) => void) | null = null

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (listener) {
          this.webContents.removeListener('ipc-message', listener)
          listener = null
        }
      }

      // 处理中止信号
      const onAbort = () => {
        if (!resolved) {
          resolved = true
          cleanup()
          abortSignal?.removeEventListener('abort', onAbort)
          debugLog('SESSION_API', `Agent ${agentName} 被取消`)
          resolve({
            success: false,
            status: 'failed',
            modifiedFiles: [],
            summary: `Agent ${agentName} 已被取消`,
            error: 'Agent execution cancelled'
          })
        }
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort()
          return
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      // 超时处理
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup()
          abortSignal?.removeEventListener('abort', onAbort)
          debugLog('SESSION_API', `Agent ${agentName} 超时 (${timeout}ms)`)
          this.webContents.send(IPC_CHANNELS.CONTROLLER_TIMEOUT, {
            sessionId: this.sessionId,
            type: 'agent',
            agentName,
            timeout
          })
          resolve({
            success: false,
            status: 'failed',
            modifiedFiles: [],
            summary: `Agent ${agentName} 执行超时`,
            error: 'Agent execution timeout'
          })
        }
      }, timeout)

      // 监听 Agent 结果
      listener = (_event: unknown, channel: string, ...args: unknown[]) => {
        if (channel === IPC_CHANNELS.CONTROLLER_AGENT_RESULT && !resolved) {
          const response = args[0] as { toolCallId: string; result: AgentResult }
          debugLog('SESSION_API', `收到 AGENT_RESULT`, {
            responseToolCallId: response.toolCallId,
            expectedToolCallId: toolCallId,
            resultSuccess: response.result?.success,
            resultStatus: response.result?.status,
            hasOutput: !!response.result?.output,
            outputKeys: response.result?.output ? Object.keys(response.result.output) : []
          })
          if (response.toolCallId === toolCallId) {
            resolved = true
            cleanup()
            abortSignal?.removeEventListener('abort', onAbort)
            debugLog('SESSION_API', `Agent ${agentName} 返回成功`, {
              hasOutput: !!response.result.output,
              outputKeys: response.result.output ? Object.keys(response.result.output) : []
            })
            resolve(response.result)
          }
        }
      }

      this.webContents.on('ipc-message', listener)

      debugLog('SESSION_API', `发送 CONTROLLER_AGENT_CALL IPC`, {
        sessionId: this.sessionId,
        agentName,
        toolCallId,
        prompt
      })

      // 发送 Agent 调用请求
      this.webContents.send(IPC_CHANNELS.CONTROLLER_AGENT_CALL, {
        sessionId: this.sessionId,
        agentName,
        toolCallId,
        prompt
      })
    })
  }

  /**
   * 构建 Agent 调用提示
   * @param agentName Agent 名称
   * @param input 输入
   * @returns 提示字符串
   */
  buildAgentPrompt(agentName: string, input: Record<string, unknown>): string {
    const inputStr = Object.entries(input)
      .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
      .join('\n')

    return `请重新读取 .claude/agents/${agentName}.md 的定义执行任务。

输入参数：
${inputStr}

请严格按照 Agent 定义执行。

**重要**：完成后必须在最后一条消息中输出 Agent 定义的返回 JSON 格式的结果，**必须同时包含 \`success\` 和 \`status\` 两个必填字段**。`
  }

  /**
   * 读取文件
   * @param filePath 文件路径（相对于项目根目录）
   * @returns 文件内容，文件不存在时返回 null
   */
  async readFile(filePath: string): Promise<string | null> {
    const fullPath = path.join(this.projectRoot, filePath)
    logger.info(`Reading file: ${fullPath}`)

    try {
      if (!fs.existsSync(fullPath)) {
        logger.warn(`File not found: ${fullPath}`)
        return null
      }
      const content = await fs.promises.readFile(fullPath, 'utf-8')
      return content
    } catch (error) {
      logger.error(`Failed to read file: ${error}`)
      return null
    }
  }

  /**
   * 写入文件
   * @param filePath 文件路径（相对于项目根目录）
   * @param content 文件内容
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.projectRoot, filePath)
    logger.info(`Writing file: ${fullPath}`)

    // 确保目录存在
    const dir = path.dirname(fullPath)
    await fs.promises.mkdir(dir, { recursive: true })

    await fs.promises.writeFile(fullPath, content, 'utf-8')
  }

  /**
   * 获取当前状态
   * @returns 控制器状态
   */
  async getState(): Promise<ControllerState | null> {
    const statePath = path.join(this.projectRoot, STATE_FILE_PATH)
    logger.info(`Reading state: ${statePath}`)

    try {
      if (!fs.existsSync(statePath)) {
        return null
      }

      const content = await fs.promises.readFile(statePath, 'utf-8')
      return JSON.parse(content) as ControllerState
    } catch (error) {
      logger.error(`Failed to read state: ${error}`)
      return null
    }
  }

  /**
   * 保存状态
   * @param state 控制器状态
   */
  async saveState(state: ControllerState): Promise<void> {
    const statePath = path.join(this.projectRoot, STATE_FILE_PATH)
    logger.info(`Saving state: ${statePath}`)

    // 确保目录存在
    const dir = path.dirname(statePath)
    await fs.promises.mkdir(dir, { recursive: true })

    // 更新时间戳
    state.meta.updatedAt = new Date().toISOString()

    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8')
  }

  /**
   * 读取需求文档
   * @returns 需求文档内容
   */
  async readProductSpec(): Promise<string | null> {
    return await this.readFile(PRODUCT_SPEC_PATH)
  }

  /**
   * 读取开发计划
   * @returns 开发计划内容
   */
  async readDevPlan(): Promise<string | null> {
    return await this.readFile(DEV_PLAN_PATH)
  }

  /**
   * 检查文件是否存在
   * @param filePath 文件路径
   * @returns 是否存在
   */
  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.projectRoot, filePath)
    return fs.existsSync(fullPath)
  }

  /**
   * 执行命令
   * @param command 命令字符串
   * @param timeout 超时时间（毫秒），默认 60000
   * @returns 命令执行结果
   */
  async executeCommand(
    command: string,
    timeout: number = 60000
  ): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
    logger.info(`Executing command: ${command}`)

    try {
      const result = await execAsync(command, {
        cwd: this.projectRoot,
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        env: {
          ...process.env,
          // 添加项目特定的环境变量
          PROJECT_ROOT: this.projectRoot
        }
      })

      return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0
      }
    } catch (error) {
      const execError = error as { message: string; stdout?: string; stderr?: string; code?: number }
      logger.error(`Command failed: ${execError.message}`)

      return {
        success: false,
        stdout: execError.stdout || '',
        stderr: execError.stderr || execError.message,
        exitCode: execError.code || 1
      }
    }
  }

  /**
   * 请求用户输入（阻塞等待）
   * @param question 问题
   * @param type 输入类型
   * @param options 选项（用于 choice 类型）
   * @param timeout 超时时间（毫秒），默认 300000 (5分钟)
   * @returns 用户输入
   */
  async requestUserInput(
    question: string,
    type: 'text' | 'choice' | 'confirm',
    options?: Array<{ value: string; label: string }>,
    timeout: number = 300000
  ): Promise<{ success: boolean; answer?: string | string[]; error?: string }> {
    logger.info(`Requesting user input: ${question}`)
    return new Promise((resolve) => {
      const requestId = `${this.sessionId}-${Date.now()}`
      let resolved = false
      let timeoutId: NodeJS.Timeout | null = null
      let listener: ((_: unknown, channel: string, ...args: unknown[]) => void) | null = null

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (listener) {
          this.webContents.removeListener('ipc-message', listener)
          listener = null
        }
      }

      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup()
          this.webContents.send(IPC_CHANNELS.CONTROLLER_TIMEOUT, {
            sessionId: this.sessionId,
            type: 'user_input',
            question,
            timeout
          })
          resolve({
            success: false,
            error: 'User input timeout'
          })
        }
      }, timeout)

      listener = (_: unknown, channel: string, ...args: unknown[]) => {
        if (channel === IPC_CHANNELS.CONTROLLER_INPUT_RESPONSE && !resolved) {
          const response = args[0] as { requestId: string; answer?: string | string[]; error?: string }
          if (response.requestId === requestId) {
            resolved = true
            cleanup()
            if (response.error) {
              resolve({ success: false, error: response.error })
            } else {
              resolve({ success: true, answer: response.answer })
            }
          }
        }
      }

      this.webContents.on('ipc-message', listener)
      this.webContents.send(IPC_CHANNELS.CONTROLLER_INPUT_REQUEST, {
        requestId,
        sessionId: this.sessionId,
        question,
        type,
        options
      })
    })
  }

  /**
   * 请求 Agent 调用（通知前端）
   * @param agentName Agent 名称
   * @param toolCallId 工具调用 ID
   * @param prompt 提示内容
   */
  async requestAgentCall(
    agentName: string,
    toolCallId: string,
    prompt: string
  ): Promise<void> {
    logger.info(`Requesting agent call: ${agentName}`)
    this.webContents.send(IPC_CHANNELS.CONTROLLER_AGENT_CALL, {
      sessionId: this.sessionId,
      agentName,
      toolCallId,
      prompt
    })
  }

  /**
   * 获取会话 ID
   */
  getSessionId(): string {
    return this.sessionId
  }

  /**
   * 获取项目根目录
   */
  getProjectRoot(): string {
    return this.projectRoot
  }
}

/**
 * 创建会话 API
 * @param sessionId 会话 ID
 * @param projectRoot 项目根目录
 * @returns 会话 API 实例
 */
export function createSessionApi(
  sessionId: string,
  projectRoot: string
): SessionApi {
  // 获取主窗口
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow) {
    throw new Error('No main window found')
  }

  return new SessionApi({
    sessionId,
    projectRoot,
    webContents: mainWindow.webContents
  })
}
