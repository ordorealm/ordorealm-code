/**
 * Claude Code Agent SDK Adapter (V1 query API)
 *
 * Interacts with Claude Code via @anthropic-ai/claude-agent-sdk V1 stable query() API.
 * V1 API supports full settingSources / mcpServers / plugins configuration loading.
 *
 * Uses bundled runtimes (Node.js, Git) for offline operation.
 *
 * Following SpectrAI's ClaudeSdkAdapter implementation
 * @module adapters/ClaudeSdkAdapter
 */

import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import type {
  ConversationMessage,
  AdapterSessionConfig,
  ProviderEvent,
} from '@shared/index'
import { BaseProviderAdapter } from './BaseProviderAdapter'
import { AsyncIterableQueue } from '../shared/async-queue'
import { RuntimeManager, type RuntimeEnvConfig } from '../main/runtime-manager'

// ─── V1 Query Types (runtime loaded from SDK) ─────────────────────────────────

type SDKQuery = {
  close(): void
  interrupt(): Promise<void>
  supportedCommands(): Promise<any[]>
  mcpServerStatus(): Promise<any[]>
  setMcpServers(servers: Record<string, any>): Promise<any>
  toggleMcpServer(name: string, enabled: boolean): Promise<void>
  reconnectMcpServer(name: string): Promise<void>
  streamInput(stream: AsyncIterable<any>): Promise<void>
  [Symbol.asyncIterator](): AsyncIterator<any>
}

// ─── Session State ──────────────────────────────────────────────────────────

interface ClaudeSession {
  /** SpectrAI unified session state */
  adapterSessionId: string
  /** SDK query instance */
  sdkQuery?: SDKQuery
  /** Input stream for multi-turn */
  inputStream?: AsyncIterableQueue<any>
  /** AbortController */
  abortController?: AbortController
  /** Configuration */
  config: AdapterSessionConfig
  /** Current accumulated text */
  currentText: string
  /** Provider session ID (for resume, if SDK supports it) */
  providerSessionId?: string
}

// ─── Adapter Implementation ─────────────────────────────────────────────────

export class ClaudeSdkAdapter extends BaseProviderAdapter {
  readonly providerId = 'claude-code'
  readonly displayName = 'Claude Code'

  private sessions: Map<string, ClaudeSession> = new Map()
  private sdkModule: any = null
  private claudeExecutablePath: string | null = null
  private runtimeManager: RuntimeManager | null = null
  private runtimeEnvConfig: RuntimeEnvConfig | null = null

  constructor() {
    super()
    this.claudeExecutablePath = this.findClaudeExecutable()
    console.log(`[ClaudeSdkAdapter] Executable path: ${this.claudeExecutablePath}`)
  }

  /**
   * Set runtime manager (called during app initialization)
   */
  setRuntimeManager(runtimeManager: RuntimeManager): void {
    this.runtimeManager = runtimeManager
    this.runtimeEnvConfig = runtimeManager.getEnvConfig()
    console.log('[ClaudeSdkAdapter] Runtime manager configured')
    console.log('[ClaudeSdkAdapter] Node.js:', this.runtimeEnvConfig.nodePath)
    console.log('[ClaudeSdkAdapter] Git:', this.runtimeEnvConfig.gitPath)
    console.log('[ClaudeSdkAdapter] Shell:', this.runtimeEnvConfig.shell)
  }

  /**
   * Find Claude executable
   */
  private findClaudeExecutable(): string | null {
    try {
      const cmd = process.platform === 'win32' ? 'where claude' : 'which claude'
      const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 })
      return result.trim().split(/\r?\n/)[0].trim() || null
    } catch {
      return null
    }
  }

  /**
   * Load SDK module lazily
   */
  private async loadSdk(): Promise<any> {
    if (!this.sdkModule) {
      try {
        this.sdkModule = await import('@anthropic-ai/claude-agent-sdk')
        console.log('[ClaudeSdkAdapter] SDK loaded successfully')
      } catch (err) {
        console.error('[ClaudeSdkAdapter] Failed to load SDK:', err)
        throw new Error(
          `Failed to load @anthropic-ai/claude-agent-sdk. ` +
          `Please install: npm install @anthropic-ai/claude-agent-sdk\n` +
          `Original error: ${err}`
        )
      }
    }
    return this.sdkModule
  }

  // ── Public Interface ───────────────────────────────────────────────────────

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    console.log(`[ClaudeSdkAdapter] Starting session: ${sessionId}`)

    // Create session context
    const session: ClaudeSession = {
      adapterSessionId: sessionId,
      config,
      currentText: '',
    }
    this.sessions.set(sessionId, session)

    // Update session status
    this.updateSessionStatus(sessionId, 'connecting')

    const sdk = await this.loadSdk()

    // Build environment using bundled runtimes or system defaults
    const cleanEnv: NodeJS.ProcessEnv = {
      // Use bundled PATH if available, otherwise system PATH
      PATH: this.runtimeEnvConfig?.pathEnv || process.env.PATH || '',
      HOME: os.homedir(), // Cross-platform home directory
      USER: process.env.USER || os.userInfo().username,
      // Use bundled shell if available
      SHELL: this.runtimeEnvConfig?.shell || process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh'),
      TMPDIR: os.tmpdir(), // Cross-platform temp directory
      LANG: process.env.LANG || 'en_US.UTF-8',
    }

    // Add Node.js specific environment if using bundled runtime
    if (this.runtimeEnvConfig) {
      // Ensure Node.js can find its modules
      const nodeDir = path.dirname(this.runtimeEnvConfig.nodePath)
      const nodeModulesDir = path.join(nodeDir, 'node_modules')
      if (fs.existsSync(nodeModulesDir)) {
        cleanEnv.NODE_PATH = nodeModulesDir
      }
    }

    // Add env overrides
    if (config.envOverrides) {
      Object.assign(cleanEnv, config.envOverrides)
    }

    // Build SDK options
    const abortController = new AbortController()
    const inputStream = new AsyncIterableQueue<any>()

    const sdkOptions: Record<string, any> = {
      cwd: config.workingDirectory,
      env: cleanEnv,
      permissionMode: config.autoAccept ? 'bypassPermissions' : 'auto',
      allowDangerouslySkipPermissions: config.autoAccept,
      includePartialMessages: true,
      abortController,
      settingSources: [],
    }

    // Model override
    if (config.model) {
      sdkOptions.model = config.model
    }

    // Executable path override
    if (config.executablePath) {
      sdkOptions.executablePath = config.executablePath
    } else if (this.claudeExecutablePath) {
      sdkOptions.executablePath = this.claudeExecutablePath
    }

    // Git Bash path (Windows: use bundled MinGit Bash)
    if (process.platform === 'win32') {
      if (config.gitBashPath) {
        sdkOptions.gitBashPath = config.gitBashPath
      } else if (this.runtimeEnvConfig?.bashPath) {
        sdkOptions.gitBashPath = this.runtimeEnvConfig.bashPath
      }
    }

    // Additional directories
    if (config.additionalDirectories?.length) {
      sdkOptions.additionalDirectories = config.additionalDirectories
    }

    // MCP config path
    if (config.mcpConfigPath) {
      sdkOptions.mcpConfigPath = config.mcpConfigPath
    }

    // Extra MCP servers
    if (config.extraMcpServers) {
      sdkOptions.mcpServers = config.extraMcpServers
    }

    console.log('[ClaudeSdkAdapter] Starting query with model:', config.model || 'default')

    // Create SDK query
    const sdkQuery: SDKQuery = sdk.query({
      prompt: inputStream,
      options: sdkOptions,
    })

    session.sdkQuery = sdkQuery
    session.inputStream = inputStream
    session.abortController = abortController

    // Start stream consumer
    this.consumeStream(sessionId, session)

    // Handle initial prompt if provided
    if (config.initialPrompt) {
      console.log('[ClaudeSdkAdapter] Sending initial prompt')
      inputStream.enqueue({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: config.initialPrompt }],
        },
      })
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.inputStream) {
      throw new Error(`Session ${sessionId} not ready`)
    }

    console.log(`[ClaudeSdkAdapter] Sending message to session: ${sessionId}`)

    // Reset current text
    session.currentText = ''
    this.updateSessionStatus(sessionId, 'streaming')

    // Enqueue user message
    session.inputStream.enqueue({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    })

    console.log(`[ClaudeSdkAdapter] Message enqueued`)
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    // Claude SDK uses autoAccept mode, no manual confirmation needed
    console.log(`[ClaudeSdkAdapter] Confirmation requested: ${accept}`)
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[ClaudeSdkAdapter] Aborting turn for session: ${sessionId}`)

    if (session.sdkQuery) {
      try {
        await session.sdkQuery.interrupt()
      } catch (err) {
        console.error('[ClaudeSdkAdapter] Interrupt failed:', err)
      }
    }

    // Rebuild input stream
    session.inputStream = new AsyncIterableQueue<any>()
    session.abortController = new AbortController()

    this.updateSessionStatus(sessionId, 'connected')
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[ClaudeSdkAdapter] Terminating session: ${sessionId}`)

    // Close input stream
    session.inputStream?.close()

    // Abort
    session.abortController?.abort()

    // Close SDK query
    if (session.sdkQuery) {
      try {
        session.sdkQuery.close()
      } catch (err) {
        console.warn('[ClaudeSdkAdapter] Error closing query:', err)
      }
    }

    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // Claude SDK V1 doesn't support resume directly
    // Start a new session instead
    await this.startSession(sessionId, config)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId)
    return session?.providerSessionId
  }

  getConversation(sessionId: string): ConversationMessage[] {
    const session = this.sessions.get(sessionId)
    return session?.config ? [] : [] // Conversation managed by SDK
  }

  hasSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session !== undefined && session.sdkQuery !== undefined
  }

  cleanup(): void {
    console.log(`[ClaudeSdkAdapter] Cleaning up`)
    for (const [sessionId, session] of this.sessions) {
      session.inputStream?.close()
      session.abortController?.abort()
      if (session.sdkQuery) {
        try {
          session.sdkQuery.close()
        } catch {}
      }
    }
    this.sessions.clear()
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private async consumeStream(sessionId: string, session: ClaudeSession): Promise<void> {
    if (!session.sdkQuery) return

    console.log(`[ClaudeSdkAdapter] Starting stream consumer for session: ${sessionId}`)

    try {
      for await (const msg of session.sdkQuery) {
        console.log(`[ClaudeSdkAdapter] Message type: ${msg.type}, subtype: ${msg.subtype}`)
        this.handleSdkMessage(sessionId, msg, session)
      }

      console.log(`[ClaudeSdkAdapter] Stream ended for session: ${sessionId}`)
    } catch (err: any) {
      this.handleStreamError(sessionId, err)
    }
  }

  private handleSdkMessage(sessionId: string, msg: any, session: ClaudeSession): void {
    switch (msg.type) {
      case 'system':
        this.handleSystemMessage(sessionId, msg)
        break

      case 'stream_event':
        this.handleStreamEvent(sessionId, msg, session)
        break

      case 'assistant':
        this.handleAssistantMessage(sessionId, msg, session)
        break

      case 'user':
        this.handleUserMessage(sessionId, msg)
        break

      case 'result':
        this.handleResultMessage(sessionId, msg, session)
        break
    }
  }

  private handleSystemMessage(sessionId: string, msg: any): void {
    if (msg.subtype === 'init') {
      console.log('[ClaudeSdkAdapter] Initialized:', msg.model)
      this.updateSessionStatus(sessionId, 'connected')
    }
  }

  private handleStreamEvent(sessionId: string, msg: any, session: ClaudeSession): void {
    const evt = msg.event
    if (evt?.type === 'content_block_delta') {
      const delta = evt.delta
      if (delta?.type === 'text_delta' && delta.text) {
        session.currentText += delta.text
        this.emitTextDelta(sessionId, delta.text)
      }
    }
  }

  private handleAssistantMessage(sessionId: string, msg: any, session: ClaudeSession): void {
    const content = msg.message?.content || []
    for (const block of content) {
      if (block.type === 'text') {
        const text = block.text || ''
        if (!session.currentText.includes(text)) {
          session.currentText += text
          this.emitTextDelta(sessionId, text)
        }
      } else if (block.type === 'tool_use') {
        this.emitToolUseStart(
          sessionId,
          block.id,
          block.name,
          block.input
        )
      }
    }
  }

  private handleUserMessage(sessionId: string, msg: any): void {
    const userContent = msg.message?.content || []
    for (const block of userContent) {
      if (block.type === 'tool_result') {
        this.emitToolUseEnd(
          sessionId,
          block.tool_use_id,
          '',
          String(block.content || '').slice(0, 500),
          block.is_error
        )
      }
    }
  }

  private handleResultMessage(sessionId: string, msg: any, session: ClaudeSession): void {
    const isSuccess = msg.subtype === 'success'
    console.log('[ClaudeSdkAdapter] Result:', isSuccess ? 'success' : 'failed')

    if (isSuccess) {
      this.emitTurnComplete(sessionId, msg.usage)
      this.updateSessionStatus(sessionId, 'connected')
    } else {
      this.emitProviderError(sessionId, msg.result || 'Unknown error')
      this.updateSessionStatus(sessionId, 'error')
    }
  }

  private handleStreamError(sessionId: string, err: any): void {
    console.error(`[ClaudeSdkAdapter] Stream error for session ${sessionId}:`, err)
    this.updateSessionStatus(sessionId, 'error')

    const isAbort = err.name === 'AbortError' || /\baborted\b/i.test(err.message || '')
    this.emitProviderError(
      sessionId,
      isAbort ? 'Session aborted' : err.message || String(err)
    )
  }
}
