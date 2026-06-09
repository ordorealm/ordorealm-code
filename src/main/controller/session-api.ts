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
import * as fs from 'fs'
import * as path from 'path'

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
    logger.info(`[${this.sessionId.slice(0, 8)}] Sending message: ${content.slice(0, 50)}...`)

    // 发送助手消息到前端
    this.webContents.send(IPC_CHANNELS.CONVERSATION_MESSAGE, {
      sessionId: this.sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        timestamp: new Date().toISOString()
      }
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
   * 调用 Agent（通过发送消息触发）
   * @param agentName Agent 名称
   * @param input 输入
   * @param timeoutMs 超时时间（毫秒）
   * @returns Agent 结果
   */
  async callAgent(agentName: string, input: Record<string, unknown>, timeoutMs?: number): Promise<AgentResult> {
    logger.info(`[${this.sessionId.slice(0, 8)}] Calling agent: ${agentName}`)

    // 构建 Agent 调用消息
    const prompt = this.buildAgentPrompt(agentName, input)

    // 发送消息到项目会话，让 AI 处理
    await this.sendMessage(`\n### 🤖 调用 ${agentName}\n`)

    // 注意：实际的 Agent 执行由项目会话的 AI 完成
    // 这里我们只是发送提示消息，让 AI 按照 Agent 定义执行
    await this.sendUserMessage(prompt)

    // 返回一个占位结果（实际结果需要等待 AI 响应）
    return {
      success: true,
      status: 'done',
      modifiedFiles: [],
      summary: `Agent ${agentName} 已触发，等待 AI 执行`
    }
  }

  /**
   * 构建 Agent 调用提示
   * @param agentName Agent 名称
   * @param input 输入
   * @returns 提示字符串
   */
  private buildAgentPrompt(agentName: string, input: Record<string, unknown>): string {
    const inputStr = Object.entries(input)
      .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
      .join('\n')

    return `请按照 .claude/agents/${agentName}.md 的定义执行任务。

输入参数：
${inputStr}

请严格按照 Agent 定义执行，并在完成后使用 task_complete 工具报告结果。`
  }

  /**
   * 读取文件
   * @param filePath 文件路径（相对于项目根目录）
   * @returns 文件内容
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = path.join(this.projectRoot, filePath)
    logger.info(`Reading file: ${fullPath}`)

    try {
      const content = await fs.promises.readFile(fullPath, 'utf-8')
      return content
    } catch (error) {
      logger.error(`Failed to read file: ${error}`)
      throw error
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
    try {
      return await this.readFile(PRODUCT_SPEC_PATH)
    } catch {
      return null
    }
  }

  /**
   * 读取开发计划
   * @returns 开发计划内容
   */
  async readDevPlan(): Promise<string | null> {
    try {
      return await this.readFile(DEV_PLAN_PATH)
    } catch {
      return null
    }
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
