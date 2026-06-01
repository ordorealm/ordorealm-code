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
import {
  type MasterAgentHistory,
  loadMasterAgentHistory,
  saveMasterAgentHistory,
  appendMasterAgentMessage,
  updateProviderSessionId,
} from './master-agent-storage'

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

// ─── Constants ───────────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 2000 // 2 秒防抖

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

  /** ★ 持久化：对话历史 */
  private history: MasterAgentHistory | null = null
  /** ★ 持久化：防抖保存定时器 */
  private saveTimer: NodeJS.Timeout | null = null
  /** ★ 持久化：是否有未保存的更改 */
  private hasUnsavedChanges: boolean = false
  /** ★ SDK provider session ID (用于恢复上下文) */
  private providerSessionId: string | null = null

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

    // ★ 加载历史记录
    this.history = await loadMasterAgentHistory()
    if (this.history?.providerSessionId) {
      this.providerSessionId = this.history.providerSessionId
      this.logger.info(`Loaded history with ${this.history.messages.length} messages, providerSessionId: ${this.providerSessionId}`)
    } else if (this.history) {
      this.logger.info(`Loaded history with ${this.history.messages.length} messages`)
    }

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
          // ★ 禁用归因指纹 (CCH)，防止第三方代理缓存失效
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
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

    // ★ 添加用户消息到历史
    this.history = await appendMasterAgentMessage('user', text, this.history || undefined)
    this.triggerDebouncedSave()

    return new Promise<string>((resolve, reject) => {
      this.turnResolve = resolve
      this.turnReject = reject
      this.turnOutput = ''
      this.inputStream!.enqueue({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    }).then((response: string) => {
      // ★ 添加 AI 响应到历史
      this.appendAssistantMessage(response)
      return response
    }).catch(err => {
      // ★ SDK 调用失败时也触发保存（用户消息已添加）
      this.logger.error('sendMessage failed:', err)
      this.triggerDebouncedSave()
      throw err
    })
  }

  /**
   * Destroy the session and free resources.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true

    this.logger.info('Destroying master agent session')

    // ★ 保存未保存的更改
    await this.forceSave()

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

  /**
   * ★ 强制保存历史（用于应用退出前）
   */
  async forceSave(): Promise<void> {
    // 取消定时器
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    // 保存未保存的更改
    if (this.hasUnsavedChanges && this.history) {
      await saveMasterAgentHistory(this.history)
      this.hasUnsavedChanges = false
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Append assistant message to history
   */
  private async appendAssistantMessage(content: string): Promise<void> {
    if (!this.history) {
      this.history = {
        version: '1.0.0',
        messages: [],
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }
    }
    this.history.messages.push({
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
    })
    this.triggerDebouncedSave()
  }

  /**
   * Trigger debounced save
   */
  private triggerDebouncedSave(): void {
    this.hasUnsavedChanges = true

    if (this.saveTimer) {
      return
    }

    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null
      if (this.hasUnsavedChanges && this.history) {
        await saveMasterAgentHistory(this.history)
        this.hasUnsavedChanges = false
      }
    }, SAVE_DEBOUNCE_MS)
  }

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
              // ★ 保存 provider session ID 用于恢复上下文
              if (msg.session_id) {
                this.providerSessionId = msg.session_id
                this.logger.debug(`Provider session ID: ${msg.session_id}`)
                // ★ 确保 history 对象存在
                if (!this.history) {
                  this.history = {
                    version: '1.0.0',
                    messages: [],
                    lastActiveAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                  }
                }
                // ★ 同步到内存中的 history 对象
                this.history.providerSessionId = msg.session_id
                // 持久化（传入内存中的 history 避免从磁盘重载）
                updateProviderSessionId(msg.session_id, this.history).catch(err => {
                  this.logger.warn('Failed to persist provider session ID:', err)
                })
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
