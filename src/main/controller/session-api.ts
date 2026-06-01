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
   * @returns Agent 结果
   */
  async callAgent(agentName: string, input: Record<string, unknown>): Promise<AgentResult> {
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
    state.updatedAt = new Date().toISOString()

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
