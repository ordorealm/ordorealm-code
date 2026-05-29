/**
 * Master Agent AI Session
 *
 * Creates and manages a dedicated Claude Agent SDK session for the master
 * control agent. Unlike project sessions, this session is purely conversational
 * — tool usage is denied, and IDE state is injected as context before each
 * user message.
 *
 * @module main/agents/master-agent-session
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { AsyncIterableQueue } from '../../../electron/shared/async-queue'
import { Logger } from '../utils/logger'
import {
  type MasterSessionConfig,
  getMasterSessionConfig,
} from './session-config'

// ─── System Prompt ──────────────────────────────────────────────────────────

const MASTER_AGENT_SYSTEM_PROMPT = `
## 角色

你是 DevFlow 的远程控制助手，运行在用户的 macOS 桌面应用内。
用户通过微信远程与你交互，你需要帮助他们管理和操作 IDE 项目。

## 能力

你通过接收 IDE 状态上下文来了解当前环境。每条用户消息前都会附带最新的 IDE 状态信息，包括：

- **项目列表**：所有项目会话及其状态（运行中/空闲/错误）、当前任务
- **当前活跃项目**：用户正在查看的项目
- **MCP 工具**：已启动的 MCP 工具及其状态
- **技能组**：可用的技能组列表

## 行为规则

1. **基于上下文回答**：所有关于项目状态、MCP、技能组的回答，必须基于上下文中的实际数据，不要编造
2. **简洁直接**：用简洁的中文回复，直接给出用户需要的信息
3. **引导操作**：当用户表达意图时，引导用户使用明确的命令（如"切换到 xxx 项目"）
4. **不执行操作**：你是一个信息助手，不直接执行切换项目、重启等操作。当用户需要执行操作时，告诉他们使用明确的命令词
5. **对话记忆**：记住用户在本会话中的上下文，可以引用之前的对话内容

## 示例

用户：「有哪些项目？」
上下文显示：项目A（运行中），项目B（空闲）
回复：「当前有 2 个项目：🟢 项目A（运行中），🟡 项目B（空闲）」

用户：「帮我看看项目A在做什么」
上下文显示：项目A 当前任务为"修复登录bug"
回复：「项目A 正在处理：修复登录bug。输入"切换到 项目A"可直接与该项目的 AI 对话。」
`

// ─── MasterAgentSession ─────────────────────────────────────────────────────

export class MasterAgentSession {
  private inputStream: AsyncIterableQueue<{ type: string; message: { role: string; content: Array<{ type: string; text: string }> } }> | null = null
  private sdkQuery: any = null
  private abortController: AbortController | null = null
  private logger: Logger
  private workingDir: string

  /** Resolves when the current turn completes */
  private turnResolve: ((text: string) => void) | null = null
  private turnReject: ((err: Error) => void) | null = null
  /** Accumulated output for the current turn */
  private turnOutput: string = ''
  /** Whether the session is initialized */
  private initialized: boolean = false
  /** Whether the session is destroyed */
  private destroyed: boolean = false

  constructor() {
    this.logger = new Logger('MasterAgentSession')
    this.workingDir = path.join(os.tmpdir(), 'devflow-master-agent')
  }

  /**
   * Initialize the AI session.
   *
   * Creates a Claude Agent SDK session with a conversational-only setup
   * (no file tools, no code execution).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Already initialized')
      return
    }

    const config = getMasterSessionConfig()
    if (!config) {
      throw new Error('Master session config not set. Call setMasterSessionConfig() first.')
    }

    if (config.apiType !== 'anthropic') {
      throw new Error(
        `Master agent session only supports Anthropic API. Current: ${config.apiType}`
      )
    }

    // Ensure working directory exists
    if (!fs.existsSync(this.workingDir)) {
      fs.mkdirSync(this.workingDir, { recursive: true })
    }

    this.logger.info(`Initializing master agent session in ${this.workingDir}`)

    // Dynamically import the Claude Agent SDK
    const sdk = await import('@anthropic-ai/claude-agent-sdk')

    // Create input stream and abort controller
    this.inputStream = new AsyncIterableQueue<{ type: string; message: { role: string; content: Array<{ type: string; text: string }> } }>()
    this.abortController = new AbortController()

    // Build environment
    const env: Record<string, string> = {}
    // Forward proxy settings
    if (process.env.HTTP_PROXY) env.HTTP_PROXY = process.env.HTTP_PROXY
    if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY
    if (process.env.NO_PROXY) env.NO_PROXY = process.env.NO_PROXY

    // Build SDK options — minimal setup, conversational only
    const sdkOptions: Record<string, any> = {
      cwd: this.workingDir,
      env,
      permissionMode: 'default',
      betas: [
        'advanced-tool-use-2025-11-20',
        'token-counting-2024-11-01',
      ],
      includePartialMessages: true,
      abortController: this.abortController,
      // Replace the default Claude Code system prompt with our custom one.
      // Use 'preset' + 'append' so the AI retains basic Claude Code awareness
      // but the append overrides its role to be a remote control assistant.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: MASTER_AGENT_SYSTEM_PROMPT,
      },
      // Deny all tool usage — master agent is conversational only.
      // IDE state is injected as context before each user message.
      canUseTool: async () => {
        return { behavior: 'deny', message: 'Tools are disabled for the remote control assistant.' }
      },
    }

    // Set API credentials via flag settings
    if (config.apiKey) {
      sdkOptions.settings = {
        env: {
          ANTHROPIC_API_KEY: config.apiKey,
          ANTHROPIC_AUTH_TOKEN: config.apiKey,
          ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
          ...(config.model ? {
            ANTHROPIC_MODEL: config.model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
          } : {}),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_MAX_RETRIES: '2',
        },
      }
    }

    if (config.model) {
      sdkOptions.model = config.model
    }

    if (config.pathToClaudeCodeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = config.pathToClaudeCodeExecutable
    }

    // Create the SDK query session
    this.sdkQuery = sdk.query({
      prompt: this.inputStream,
      options: sdkOptions,
    })

    // Start the background stream consumer
    this.consumeStream()

    this.initialized = true
    this.logger.info('Master agent session initialized')
  }

  /**
   * Send a message and wait for the AI response.
   *
   * @param text - The message text (should include IDE context if desired)
   * @returns The AI's response text
   */
  async sendMessage(text: string): Promise<string> {
    if (!this.initialized || !this.inputStream) {
      throw new Error('Master agent session not initialized')
    }

    if (this.destroyed) {
      throw new Error('Master agent session has been destroyed')
    }

    return new Promise((resolve, reject) => {
      this.turnResolve = resolve
      this.turnReject = reject
      this.turnOutput = ''
      this.inputStream!.enqueue({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    })
  }

  /**
   * Destroy the session and free resources.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true

    this.logger.info('Destroying master agent session')

    // Reject any pending turn
    if (this.turnReject) {
      this.turnReject(new Error('Session destroyed'))
      this.turnReject = null
      this.turnResolve = null
    }

    // Close the SDK query
    if (this.sdkQuery) {
      try {
        this.sdkQuery.close()
      } catch (err) {
        this.logger.warn('Error closing SDK query:', err)
      }
      this.sdkQuery = null
    }

    // Close the input stream
    if (this.inputStream) {
      this.inputStream.close()
      this.inputStream = null
    }

    this.abortController = null
    this.initialized = false
    this.logger.info('Master agent session destroyed')
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Background stream consumer.
   *
   * Iterates over SDK query messages, collects assistant text per turn,
   * and resolves the turn promise when a 'result' message arrives.
   */
  private async consumeStream(): Promise<void> {
    if (!this.sdkQuery) return

    try {
      for await (const msg of this.sdkQuery) {
        if (this.destroyed) break

        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              this.logger.info(`Master agent session model: ${msg.model}`)
              // Save provider session ID for potential resume
              if (msg.session_id) {
                this.logger.debug(`Provider session ID: ${msg.session_id}`)
              }
            }
            break

          case 'assistant':
            // Accumulate text content from assistant messages
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text' && block.text) {
                  this.turnOutput += block.text
                }
              }
            }
            break

          case 'result':
            // End of turn — resolve the pending promise
            if (this.turnResolve) {
              const output = this.turnOutput.trim()
              this.turnOutput = ''
              const resolve = this.turnResolve
              this.turnResolve = null
              this.turnReject = null
              resolve(output || '(empty response)')
            }
            break

          case 'error':
            // SDK error — reject the pending promise
            this.logger.error('SDK error:', (msg as any).error || msg)
            if (this.turnReject) {
              const reject = this.turnReject
              this.turnResolve = null
              this.turnReject = null
              reject(new Error((msg as any).error?.message || 'SDK error'))
            }
            break
        }
      }
    } catch (err) {
      this.logger.error('Stream consumer error:', err)
      if (this.turnReject) {
        const reject = this.turnReject
        this.turnResolve = null
        this.turnReject = null
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }
}
