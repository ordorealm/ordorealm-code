/**
 * Remote Control Manager
 *
 * 简化为单账号模式，管理单一微信连接。
 *
 * 核心职责：
 * - 管理连接状态
 * - 处理登录/登出
 * - 消息收发
 * - 状态持久化
 *
 * @module main/services/remote-control-manager
 */

import { EventEmitter } from 'events'
import {
  ConnectionStatus,
  ConnectionInfo,
  RemoteControlSettings,
  RemoteControlStatus,
  REMOTE_CONTROL_CONSTRAINTS,
  type OperationResult,
} from '../../shared/types/remote-control'
import { WeClawSDKImpl, WeClawConnection, WeClawMessage, createWeClawSDK } from '../adapters/weclaw-sdk'
import { RemoteControlStorage } from './remote-control-storage'
import { Logger } from '../utils/logger'
import { masterAgent, type AgentContext } from '../agents/master-agent'
import { getIdeApiAdapter } from '../agents/operation-executor'
import { getWeClawManager } from './weclaw-manager'
import { getWxRelayServer } from './wx-relay-server'

// ============ Types ============

/**
 * Remote control manager events
 */
export type RemoteControlManagerEvent =
  | 'connection_changed'
  | 'message'
  | 'error'
  | 'confirm_request'
  | 'confirm_response'

// ============ Errors ============

export class RemoteControlError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'RemoteControlError'
  }
}

// ============ Main Class ============

/**
 * Remote Control Manager - Single Account Mode
 *
 * @example
 * ```typescript
 * const manager = new RemoteControlManager()
 * await manager.initialize()
 *
 * // Check status
 * const status = await manager.getStatus()
 *
 * // Connect
 * const { qrCode, alreadyLoggedIn } = await manager.connect()
 *
 * // Send message
 * await manager.sendMessage('Hello!')
 * ```
 */
export class RemoteControlManager {
  private storage: RemoteControlStorage
  private sdk: WeClawSDKImpl
  private eventEmitter: EventEmitter = new EventEmitter()
  private connection: ConnectionInfo | null = null
  private settings: RemoteControlSettings | null = null
  private logger: Logger
  private initialized: boolean = false
  private agent = masterAgent

  /** Current interaction mode: master (control panel) or project (AI agent) */
  private currentMode: 'master' | 'project' = 'master'
  /** Active project session ID when in project mode */
  private currentProjectId: string | null = null
  /** Serialization lock for project agent messages (prevent concurrent AI calls) */
  private projectAgentQueue: Promise<void> = Promise.resolve()
  /** Serialization lock for all incoming message handling */
  private messageQueue: Promise<void> = Promise.resolve()
  /** Health check interval timer */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  /** Consecutive health check failures */
  private healthCheckFailures: number = 0
  /** Temporary storage for confirmation reply to return from processIncomingMessage */
  private lastReply: string | null = null

  constructor() {
    this.logger = new Logger('RemoteControlManager', { enabled: true })
    this.storage = new RemoteControlStorage()
    this.sdk = createWeClawSDK() as WeClawSDKImpl

    // Prevent Node.js EventEmitter from throwing on 'error' events when no
    // listener is attached yet (e.g. during initialize() before IPC wiring).
    this.eventEmitter.on('error', () => {})
  }

  /**
   * Initialize the manager
   *
   * Loads settings from storage and attempts to restore connection if enabled.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Already initialized')
      return
    }

    this.logger.info('Initializing...')

    // Initialize storage
    await this.storage.initialize()

    // Load settings
    this.settings = await this.storage.getSettings()
    this.logger.info('Settings loaded:', {
      enabled: this.settings.enabled,
      requireConfirm: this.settings.requireConfirm,
      hasConnection: !!this.settings.connection,
    })

    // Initialize SDK
    this.sdk.init({ debug: false })

    // Set up SDK event handlers
    this.setupSdkEvents()

    // Start the HTTP relay server so the WeClaw daemon (in HTTP agent mode)
    // can forward incoming WeChat messages to our app for processing.
    // Uses startWithRetry to auto-resolve port conflicts (kill stale occupant + retry).
    const relayServer = getWxRelayServer()
    relayServer.setHandler(async (msg, convId) => {
      return this.processRelayMessage(msg, convId)
    })
    try {
      await relayServer.startWithRetry(3)
      this.logger.info('WxRelayServer started')
    } catch (err) {
      this.logger.error('WxRelayServer failed to start after retries:', err)
      // Emit error so renderer can show a warning to the user
      this.eventEmitter.emit('error', {
        code: 'RELAY_START_FAILED',
        message: `消息中继服务启动失败: ${relayServer.getLastError() || (err as Error).message}`,
      })
    }

    // Restore connection if enabled — credentials check is authoritative,
    // not the stored connection status (which may be stale from a failed restore)
    if (this.settings.enabled) {
      await this.restoreConnection()
    }

    this.initialized = true
    this.logger.info('Initialized successfully')
  }

  /**
   * Restore connection on startup.
   *
   * Uses getQRCode() which now correctly handles the "credentials exist
   * but daemon not running" case — it returns '' and initializes the
   * SDK's internal connection state. Only triggers startLogin() when
   * no credentials exist (i.e. truly not logged in).
   */
  private async restoreConnection(): Promise<void> {
    this.logger.info('Attempting to restore connection...')

    try {
      const qrCode = await this.sdk.getQRCode()

      if (!qrCode) {
        // Already logged in — SDK connection is fully initialized
        const sdkConnection = this.sdk.getConnection()!
        this.logger.info(`Restoring connection: ${sdkConnection.userId}`)

        this.connection = {
          status: 'connected',
          userId: sdkConnection.userId,
          nickname: sdkConnection.nickname,
          connectedAt: this.settings!.connection?.connectedAt || new Date().toISOString(),
          error: null,
        }

        await this.storage.updateConnection(this.connection)

        this.currentMode = 'master'
        this.currentProjectId = null

        this.startHealthMonitoring()

        // Initialize the master AI session for natural-language responses
        this.agent.initializeSession().catch((err) => {
          this.logger.warn('Failed to initialize master AI session:', err)
        })

        // Send welcome message (daemon may still be starting — fire-and-forget)
        const welcomeMsg = await this.getMasterWelcomeMessage()
        this.sdk.sendMessage(sdkConnection.userId, welcomeMsg).catch((err) => {
          this.logger.warn('Failed to send welcome message on restore:', err)
        })

        this.eventEmitter.emit('connection_changed', {
          status: 'connected',
          userId: sdkConnection.userId,
        })
      } else {
        // No credentials — truly not logged in, skip restore
        this.logger.info('Not logged in, skipping restore')
      }
    } catch (error) {
      this.logger.error('Failed to restore connection:', error)
      this.eventEmitter.emit('connection_changed', {
        status: 'error',
        error: `连接恢复失败: ${(error as Error).message}`,
      })
    }
  }

  /**
   * Set up SDK event handlers
   */
  private setupSdkEvents(): void {
    // Message handler — serialized via messageQueue to prevent concurrent
    // handleIncomingMessage calls when multiple messages arrive in one poll batch.
    // Timeout ensures the queue is released if processing hangs (> 20s).
    this.sdk.onMessage((message: WeClawMessage) => {
      const previous = this.messageQueue
      let resolve: () => void
      this.messageQueue = new Promise<void>((r) => { resolve = r })
      const SDK_MSG_TIMEOUT = 20_000
      previous.then(() => {
        const done = Promise.race([
          this.handleIncomingMessage(message),
          new Promise<void>((_, reject) =>
            setTimeout(() => {
              this.logger.warn('[SDK-MQ] Message processing timeout, releasing queue')
              reject(new Error('SDK_MSG_TIMEOUT'))
            }, SDK_MSG_TIMEOUT)
          ),
        ])
        return done.catch((err) => {
          if ((err as Error).message !== 'SDK_MSG_TIMEOUT') {
            this.logger.error('Unhandled error in message handler:', err)
          }
        }).finally(() => resolve())
      }).catch((err) => {
        this.logger.error('Unhandled error in message handler:', err)
      })
    })

    // Disconnected handler
    this.sdk.on('disconnected', () => {
      this.logger.info('SDK disconnected')
      this.stopHealthMonitoring()
      if (this.connection) {
        this.connection.status = 'disconnected'
        this.connection.connectedAt = null
        this.storage.updateConnection(this.connection).catch(() => {})
        this.eventEmitter.emit('connection_changed', { status: 'disconnected' })
      }
    })

    // Error handler
    this.sdk.on('error', (error: Error) => {
      this.logger.error('SDK error:', error)
      if (this.connection) {
        this.connection.status = 'error'
        this.connection.error = error.message
        this.storage.updateConnection(this.connection).catch(() => {})
        this.eventEmitter.emit('connection_changed', { status: 'error', error: error.message })
      }
    })
  }

  /**
   * Start periodic WeClaw daemon health monitoring.
   *
   * Checks the daemon health every 30s. After 3 consecutive failures,
   * marks the connection as disconnected and emits an event.
   * If health recovers, restarts message polling automatically.
   */
  private startHealthMonitoring(): void {
    this.stopHealthMonitoring()
    this.healthCheckFailures = 0

    this.healthCheckTimer = setInterval(async () => {
      // ── Check WeClaw daemon health ──
      try {
        const status = await this.sdk.checkServiceStatus()
        if (status.running && status.loggedIn) {
          // Health restored — if we were marked disconnected, restore
          if (this.healthCheckFailures > 0) {
            this.logger.info('WeClaw health restored after failures')
            if (this.connection && this.connection.status !== 'connected') {
              this.connection.status = 'connected'
              this.storage.updateConnection(this.connection).catch(() => {})
              this.eventEmitter.emit('connection_changed', { status: 'connected' })
              // Restart polling
              this.sdk.startMessagePolling()
            }
          }
          this.healthCheckFailures = 0
        } else {
          this.healthCheckFailures++
          this.logger.debug(`WeClaw health check failed (${this.healthCheckFailures}/3)`)
        }
      } catch {
        this.healthCheckFailures++
        this.logger.debug(`WeClaw health check error (${this.healthCheckFailures}/3)`)
      }

      // After 3 consecutive failures, mark as disconnected
      if (this.healthCheckFailures >= 3 && this.connection?.status === 'connected') {
        this.logger.warn('WeClaw daemon appears to be down, marking disconnected')
        this.connection.status = 'disconnected'
        this.connection.connectedAt = null
        this.storage.updateConnection(this.connection).catch(() => {})
        this.eventEmitter.emit('connection_changed', { status: 'disconnected' })
      }

      // ── Check relay server health ──
      // The relay is the inbound message bridge. If it crashes, incoming
      // WeChat messages will get "connection refused" from the daemon.
      const relayServer = getWxRelayServer()
      if (!relayServer.isRunning()) {
        this.logger.warn('Relay server is down, attempting restart...')
        try {
          await relayServer.startWithRetry(2)
          this.logger.info('Relay server restarted by health monitor')
        } catch (err) {
          this.logger.error('Health monitor failed to restart relay:', err)
          this.eventEmitter.emit('error', {
            code: 'RELAY_DOWN',
            message: `消息中继服务异常，无法接收微信消息: ${relayServer.getLastError() || (err as Error).message}`,
          })
        }
      }
    }, 30000)
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    this.healthCheckFailures = 0
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<RemoteControlStatus> {
    this.ensureInitialized()

    return {
      enabled: this.settings!.enabled,
      requireConfirm: this.settings!.requireConfirm,
      connected: this.connection?.status === 'connected',
      connection: this.connection,
    }
  }

  /**
   * Connect to WeChat
   *
   * Returns QR code immediately (if not already logged in).
   * Actual connection establishment happens asynchronously and
   * is communicated via the 'connection_changed' event.
   */
  async connect(): Promise<{ qrCode: string; alreadyLoggedIn: boolean; userId?: string }> {
    this.ensureInitialized()

    // Ensure relay server is running before attempting connection
    await this.ensureRelayRunning()

    this.logger.info('Connecting...')

    // Update connection status to pending
    this.connection = {
      status: 'pending',
      userId: null,
      nickname: null,
      connectedAt: null,
      error: null,
    }
    await this.storage.updateConnection(this.connection)
    this.eventEmitter.emit('connection_changed', { status: 'pending' })

    // Get QR code (or empty if already logged in)
    const qrCode = await this.sdk.getQRCode()

    if (!qrCode) {
      // Already logged in
      const sdkConnection = this.sdk.getConnection()!
      this.connection = {
        status: 'connected',
        userId: sdkConnection.userId,
        nickname: sdkConnection.nickname,
        connectedAt: new Date(sdkConnection.connectedAt).toISOString(),
        error: null,
      }
      await this.storage.updateConnection(this.connection)
      this.eventEmitter.emit('connection_changed', {
        status: 'connected',
        userId: sdkConnection.userId,
      })

      // Start health monitoring for already-connected sessions
      this.startHealthMonitoring()

      // Initialize the master AI session for natural-language responses
      this.agent.initializeSession().catch((err) => {
        this.logger.warn('Failed to initialize master AI session:', err)
      })

      // Reset to master mode and send welcome
      this.currentMode = 'master'
      this.currentProjectId = null

      // Send welcome message (fire-and-forget)
      const welcomeMsg = await this.getMasterWelcomeMessage()
      this.sdk.sendMessage(sdkConnection.userId, welcomeMsg).catch((err) => {
        this.logger.warn('Failed to send welcome message:', err)
      })

      return { qrCode: '', alreadyLoggedIn: true, userId: sdkConnection.userId }
    }

    // Return QR code immediately — do NOT block on waitForConnection.
    // Connection updates arrive asynchronously via events.
    this.handleAsyncConnection().catch((err) => {
      this.logger.error('Async connection failed:', err)
    })

    return { qrCode, alreadyLoggedIn: false }
  }

  /**
   * Handle async connection establishment after QR code is returned.
   */
  private async handleAsyncConnection(): Promise<void> {
    try {
      const connection = await this.sdk.waitForConnection(
        REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS
      )

      this.connection = {
        status: 'connected',
        userId: connection.userId,
        nickname: connection.nickname,
        connectedAt: new Date(connection.connectedAt).toISOString(),
        error: null,
      }
      await this.storage.updateConnection(this.connection)
      this.eventEmitter.emit('connection_changed', {
        status: 'connected',
        userId: connection.userId,
      })

      // Reset to master mode and start health monitoring
      this.currentMode = 'master'
      this.currentProjectId = null
      this.startHealthMonitoring()

      // Initialize the master AI session for natural-language responses
      this.agent.initializeSession().catch((err) => {
        this.logger.warn('Failed to initialize master AI session:', err)
      })

      // Send welcome message to the newly connected user
      const welcomeMsg = await this.getMasterWelcomeMessage()
      this.sdk.sendMessage(connection.userId, welcomeMsg).catch((err) => {
        this.logger.warn('Failed to send welcome message:', err)
      })
    } catch (error) {
      this.logger.error('Async connection failed:', error)

      this.connection = {
        status: 'error',
        userId: null,
        nickname: null,
        connectedAt: null,
        error: (error as Error).message,
      }
      await this.storage.updateConnection(this.connection)
      this.eventEmitter.emit('connection_changed', {
        status: 'error',
        error: (error as Error).message,
      })
    }
  }

  /**
   * Disconnect from WeChat
   */
  async disconnect(): Promise<void> {
    this.ensureInitialized()

    this.logger.info('Disconnecting...')

    // Stop health monitoring
    this.stopHealthMonitoring()

    // Destroy the master AI session
    await this.agent.destroySession().catch((err) => {
      this.logger.warn('Failed to destroy master AI session:', err)
    })

    // Disconnect SDK
    await this.sdk.disconnect()

    // Update connection state
    this.connection = {
      status: 'disconnected',
      userId: this.connection?.userId || null,
      nickname: this.connection?.nickname || null,
      connectedAt: null,
      error: null,
    }
    await this.storage.updateConnection(this.connection)
    this.eventEmitter.emit('connection_changed', { status: 'disconnected' })
  }

  /**
   * Enable remote control
   */
  async enable(): Promise<void> {
    this.ensureInitialized()
    await this.storage.updateSettings({ enabled: true })
    this.settings!.enabled = true
    this.logger.info('Remote control enabled')
  }

  /**
   * Disable remote control
   */
  async disable(): Promise<void> {
    this.ensureInitialized()

    // Disconnect if connected
    if (this.connection?.status === 'connected') {
      await this.disconnect()
    }

    await this.storage.updateSettings({ enabled: false })
    this.settings!.enabled = false
    this.logger.info('Remote control disabled')
  }

  /**
   * Update settings
   */
  async updateSettings(partial: { enabled?: boolean; requireConfirm?: boolean }): Promise<void> {
    this.ensureInitialized()

    // Handle enable/disable with side effects
    if (partial.enabled === true && !this.settings!.enabled) {
      await this.enable()
    } else if (partial.enabled === false && this.settings!.enabled) {
      await this.disable()
    }

    // Update requireConfirm if provided
    if (partial.requireConfirm !== undefined) {
      this.settings!.requireConfirm = partial.requireConfirm
      await this.storage.updateSettings({ requireConfirm: partial.requireConfirm })
    }

    this.logger.info('Settings updated:', partial)
  }

  /**
   * Ensure the relay server is running.
   * Attempts a restart if it's down.
   */
  private async ensureRelayRunning(): Promise<void> {
    const relayServer = getWxRelayServer()
    if (relayServer.isRunning()) return

    this.logger.warn('Relay server is not running, attempting restart...')
    try {
      await relayServer.startWithRetry(2)
      this.logger.info('Relay server restarted')
    } catch (err) {
      const errorMsg = relayServer.getLastError() || (err as Error).message
      this.logger.error('Failed to restart relay server:', errorMsg)
      this.eventEmitter.emit('error', {
        code: 'RELAY_DOWN',
        message: `消息中继服务未运行，无法接收微信消息: ${errorMsg}`,
      })
    }
  }

  /**
   * Send a message to the connected user
   */
  async sendMessage(message: string): Promise<void> {
    this.ensureInitialized()

    if (!this.connection || this.connection.status !== 'connected') {
      throw new RemoteControlError('Not connected', 'NOT_CONNECTED')
    }

    if (!this.connection.userId) {
      throw new RemoteControlError('No user ID in connection', 'NOT_CONNECTED')
    }

    // Warn if relay is down — outbound still works, but inbound replies won't arrive
    if (!getWxRelayServer().isRunning()) {
      this.logger.warn('Sending message while relay server is down — inbound replies will be lost')
    }

    await this.sdk.sendMessage(this.connection.userId, message)
    this.logger.debug('Message sent:', message.substring(0, 50))
  }

  /**
   * Request confirmation from the user via text message
   *
   * Sends an inline confirmation prompt and waits for user reply.
   * Used for programmatic confirmation requests.
   */
  async requestConfirm(message: string, timeout?: number): Promise<boolean> {
    this.ensureInitialized()

    if (!this.connection || this.connection.status !== 'connected') {
      throw new RemoteControlError('Not connected', 'NOT_CONNECTED')
    }

    const confirmId = `confirm_${Date.now().toString(36)}`
    const actualTimeout = timeout ?? REMOTE_CONTROL_CONSTRAINTS.CONFIRM_TIMEOUT_MS

    const confirmMessage = `[确认请求] ${message}\n\n请回复 "确认 ${confirmId}" 或 "取消 ${confirmId}"`
    await this.sendMessage(confirmMessage)

    this.eventEmitter.emit('confirm_request', {
      confirmId,
      message,
      timestamp: new Date().toISOString(),
    })

    return new Promise<boolean>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new RemoteControlError(`Confirmation timeout: ${confirmId}`, 'TIMEOUT'))
      }, actualTimeout)

      const handler = (response: { confirmId: string; confirmed: boolean }) => {
        if (response.confirmId === confirmId) {
          clearTimeout(timeoutHandle)
          this.eventEmitter.off('confirm_response', handler)
          resolve(response.confirmed)
        }
      }

      this.eventEmitter.on('confirm_response', handler)
    })
  }

  /**
   * Handle incoming message from SDK message polling.
   * Routes through processIncomingMessage and sends the reply via SDK.
   */
  private async handleIncomingMessage(message: WeClawMessage): Promise<void> {
    this.logger.info(`[WX-SDK] Received message: ${message.content.substring(0, 50)}...`)

    try {
      const reply = await this.processIncomingMessage(message)
      if (reply) {
        await this.sdk.sendMessage(message.from, reply)
      }
    } catch (err) {
      this.logger.error('Unhandled error in handleIncomingMessage:', err)
      try {
        await this.sdk.sendMessage(message.from, '处理消息时发生内部错误，请稍后重试。')
      } catch (sendErr) {
        this.logger.error('Failed to send error reply:', sendErr)
      }
    }
  }

  /**
   * Process a message received from the WeClaw HTTP agent relay.
   *
   * Called by WxRelayServer when the WeClaw daemon (in HTTP agent mode)
   * forwards a WeChat message as an OpenAI-compatible chat completion request.
   * Routes through the same logic as processIncomingMessage but returns
   * the reply text directly without using the SDK to send.
   *
   * @param message - The user's message content
   * @param conversationId - The daemon's conversation identifier
   * @returns Reply text to return in the OpenAI response
   */
  async processRelayMessage(message: string, conversationId: string): Promise<string> {
    const wcMessage: WeClawMessage = {
      id: `relay_${Date.now().toString(36)}`,
      from: this.connection?.userId || conversationId,
      content: message,
      type: 'text',
      timestamp: Date.now(),
    }

    // Serialize with the same message queue used by SDK polling
    // to prevent concurrent processing
    const previous = this.messageQueue
    let resolve: () => void
    this.messageQueue = new Promise<void>((r) => { resolve = r })

    await previous

    // Race against a timeout shorter than WeClaw's ~30s client timeout
    // If SDK takes too long, release the queue immediately so subsequent
    // messages aren't blocked, but let the processing continue in background
    const PROCESSING_TIMEOUT = 20_000
    try {
      const reply = await Promise.race([
        this.processIncomingMessage(wcMessage),
        new Promise<string>((_, reject) =>
          setTimeout(() => {
            // Fire-and-forget: continue processing in background
            this.processIncomingMessage(wcMessage).catch((bgErr) => {
              this.logger.warn('[WX-RELAY] Background processing error:', bgErr)
            })
            reject(new Error('PROCESSING_TIMEOUT'))
          }, PROCESSING_TIMEOUT)
        ),
      ])
      resolve!()
      return reply
    } catch (err) {
      resolve!()
      if ((err as Error).message === 'PROCESSING_TIMEOUT') {
        this.logger.warn('[WX-RELAY] Message processing timeout, continuing in background')
        return '⏳ 正在处理你的请求，请稍等片刻再试...'
      }
      this.logger.error('[WX-RELAY] Unhandled error:', err)
      return `处理消息时发生内部错误: ${(err as Error).message}`
    }
  }

  /**
   * Process incoming message with full routing logic.
   * Returns the reply text to be sent back to the user.
   */
  private async processIncomingMessage(message: WeClawMessage): Promise<string> {

    // ── Debug: log incoming message with session context ──
    this.logger.info(
      `[WX-IN] from=${message.from} | mode=${this.currentMode}` +
      (this.currentProjectId ? ` | projectId=${this.currentProjectId}` : '') +
      ` | content="${message.content.substring(0, 120)}"`
    )

    // ── Return to master mode keywords ──
    // Matches: "切换项目", "切换 项目", "切换"(单独), "返回主控", "主控制面板", "返回"(单独)
    // Avoids matching "切换到 xxx 项目" (project-switch command)
    if (/(?<!到)切换\s*项目|^\s*切换\s*$|返回主控|主控制面板|^\s*返回\s*$/.test(message.content)) {
      this.logger.info(`[WX-ROUTE] → returning to master mode (was ${this.currentMode})`)
      this.currentMode = 'master'
      this.currentProjectId = null
      const welcomeMsg = await this.getMasterWelcomeMessage()
      this.logger.info(`[WX-OUT] → master welcome (${welcomeMsg.length} chars)`)
      return welcomeMsg
    }

    // ── Confirmation response ──
    const confirmResponse = this.parseConfirmResponse(message.content)
    if (confirmResponse) {
      await this.handleConfirmation(confirmResponse)
      const reply = this.lastReply || ''
      this.lastReply = null
      return reply
    }

    // ── Standalone affirmation (e.g. "是的", "是", "好", "可以") ──
    // When a user replies with a simple "yes" without the confirmId,
    // match it to the most recent pending confirmation.
    if (/^(?:是的|是[的]?|对[的]?|好[的]?|可以|行|嗯|ok|yes|y|confirm)\s*$/i.test(message.content)) {
      const pending = this.agent.getPendingConfirmations()
      if (pending.length > 0) {
        const mostRecent = pending[pending.length - 1]
        this.logger.info(`[WX-ROUTE] → standalone affirmation → confirmId=${mostRecent.confirmId}`)
        await this.handleConfirmation({ confirmId: mostRecent.confirmId, confirmed: true })
        const reply = this.lastReply || ''
        this.lastReply = null
        return reply
      }
    }

    // ── Project mode: intercept commands before forwarding to AI ──
    if (this.currentMode === 'project' && this.currentProjectId) {
      // Check if the message is a recognized command (switch, restart, status, etc.)
      const parsed = this.agent.parseMessage(message.content)
      if (parsed.type !== 'unknown' && parsed.type !== 'chat') {
        this.logger.info(`[WX-ROUTE] → command intercepted in project mode: ${parsed.type}`)
        const context = await this.buildAgentContext(message.from)
        const cmdResult = await this.agent.handleMessage(message.content, context)
        if (cmdResult.success && cmdResult.data) {
          const data = cmdResult.data as Record<string, unknown>
          if (data.operation === 'switch_project' && typeof data.projectId === 'string') {
            this.currentMode = 'project'
            this.currentProjectId = data.projectId
            cmdResult.message += '\n\n现在可以直接和我对话，输入"切换"或"切换项目"返回主控制面板。'
          }
        }
        return cmdResult.message || ''
      }
      // Not a command — forward to project AI
      this.logger.info(`[WX-ROUTE] → forwarding to project agent: projectId=${this.currentProjectId}`)
      const reply = await this.forwardToProjectAgent(message)
      this.logger.info(`[WX-OUT] → project reply (${reply.length} chars)`)
      return reply
    }

    // ── Master mode: parse and execute commands ──
    this.logger.info(`[WX-ROUTE] → master agent handling`)

    // Lazy-init the master AI session if it hasn't been initialized yet
    // (e.g. provider config wasn't available at connect/restore time)
    if (!this.agent.isSessionActive()) {
      this.agent.initializeSession().catch((err) => {
        this.logger.warn('Lazy AI session init failed:', err)
      })
    }

    const context = await this.buildAgentContext(message.from)

    const result: OperationResult = await this.agent.handleMessage(
      message.content,
      context
    )

    // On successful switch, enter project mode; restart stays in master
    if (result.success && result.data) {
      const data = result.data as Record<string, unknown>
      if (data.operation === 'switch_project' && typeof data.projectId === 'string') {
        this.logger.info(`[WX-MODE] → entering project mode: projectId=${data.projectId}`)
        this.currentMode = 'project'
        this.currentProjectId = data.projectId
        result.message += '\n\n现在可以直接和我对话，输入"切换项目"返回主控制面板。'
      }
    }

    const reply = result.message || ''
    if (reply) {
      this.logger.info(`[WX-OUT] → master reply (${reply.length} chars): "${reply.substring(0, 100)}"`)
    }

    // Emit event
    if (result.requiresConfirm && result.confirmId) {
      this.eventEmitter.emit('confirm_request', {
        confirmId: result.confirmId,
        message: result.message,
        timestamp: new Date().toISOString(),
      })
    } else {
      this.eventEmitter.emit('message', {
        userId: message.from,
        content: message.content,
        timestamp: new Date(message.timestamp).toISOString(),
      })
    }

    return reply
  }

  /**
   * Forward a message to the current project's AI agent and return the reply text.
   *
   * Uses a serialization lock (projectAgentQueue) to prevent concurrent AI calls
   * when multiple WeChat messages arrive in the same poll batch. Without this,
   * two simultaneous sendMessage() calls would both reset session.output = '',
   * corrupting each other's responses.
   */
  private async forwardToProjectAgent(message: WeClawMessage): Promise<string> {
    const previous = this.projectAgentQueue
    let resolve: () => void
    this.projectAgentQueue = new Promise<void>((r) => { resolve = r })

    await previous

    if (this.currentMode !== 'project' || !this.currentProjectId) {
      this.logger.info(`[WX-PROJECT] aborted — mode changed during queue wait`)
      resolve!()
      return '会话已切换，请输入"切换项目"返回主控制面板。'
    }

    const ideApi = getIdeApiAdapter()
    if (!ideApi) {
      resolve!()
      return '无法连接到项目会话，请输入"切换项目"返回主控制面板。'
    }

    // ★ 先释放队列锁再调用 AI（避免长时间阻塞队列）
    // 利用 ideApi.sendMessage 内部的 sessionLocks 保护同一会话的并发
    resolve!()

    try {
      this.logger.info(`[WX-PROJECT] → sending to project AI: projectId=${this.currentProjectId}`)
      const startTime = Date.now()
      // Race with timeout: release queue lock early, still await result with soft deadline
      const PJA_TIMEOUT = 30_000
      const result = await Promise.race([
        ideApi.sendMessage(this.currentProjectId, message.content),
        new Promise<{ success: boolean; message: string }>((_, reject) =>
          setTimeout(() => reject(new Error('PJA_TIMEOUT')), PJA_TIMEOUT)
        ),
      ])
      const elapsed = Date.now() - startTime
      this.logger.info(`[WX-PROJECT] ← AI response in ${elapsed}ms (${result.message.length} chars)`)

      const reply = result.message.length > 4000
        ? result.message.substring(0, 4000) + '\n\n...(内容过长已截断)'
        : result.message
      return reply
    } catch (err) {
      const errMsg = (err as Error).message
      if (errMsg === 'PJA_TIMEOUT') {
        this.logger.warn('[WX-PROJECT] AI response timeout, session may still be processing')
        return '⏳ AI 正在处理你的请求，请稍等 1-2 分钟后重试...'
      }
      this.logger.error('[WX-PROJECT] Failed to forward to project agent:', err)

      if (errMsg.includes('不存在') || errMsg.includes('not found')) {
        this.currentMode = 'master'
        this.currentProjectId = null
        return `项目会话已关闭，已自动返回主控制面板。`
      }
      return `处理失败: ${errMsg}`
    }
  }

  /**
   * Get the master agent welcome message with live IDE project/session info.
   */
  private async getMasterWelcomeMessage(): Promise<string> {
    const ideApi = getIdeApiAdapter()

    let projectSection = ''
    if (ideApi) {
      try {
        const projects = await ideApi.getProjects()
        const currentProjectId = await ideApi.getCurrentProject()

        if (projects.length > 0) {
          const lines = projects.map((p) => {
            const isCurrent = p.id === currentProjectId
            const statusEmoji = p.status === 'running' ? '🟢' : p.status === 'error' ? '🔴' : '🟡'
            const marker = isCurrent ? '▶️ ' : '   '
            const taskInfo = p.currentTask ? ` — ${p.currentTask}` : ''
            return `${marker}${statusEmoji} **${p.name}**${taskInfo}`
          })
          projectSection = `\n📂 **当前 IDE 项目会话**\n${lines.join('\n')}\n`
        } else {
          projectSection = '\n📂 当前没有活跃的项目会话\n'
        }
      } catch {
        projectSection = ''
      }
    }

    return `👋 欢迎使用 DevFlow 远程控制！
${projectSection}
📋 基础指令：
  • 查看状态 — 查看所有项目会话状态
  • 切换到 <项目名> — 进入指定项目的 AI 对话
  • 重启 <项目名> — 重启指定项目会话
  • 帮助 — 显示完整指令帮助

🔧 管理指令：
  • MCP状态 — 查看 MCP 工具状态
  • 技能组列表 — 查看可用技能组

💡 切换项目后，所有对话将直接与该项目 AI Agent 进行。
输入"切换"或"切换项目"返回主控制面板。`
  }

  /**
   * Parse confirmation response from user message text
   */
  private parseConfirmResponse(content: string): { confirmId: string; confirmed: boolean } | null {
    if (content.length > 200) return null

    const confirmPattern = /^(?:确认|confirm|yes|ok)\s+([a-zA-Z0-9_-]+)$/i
    const cancelPattern = /^(?:取消|cancel|no)\s+([a-zA-Z0-9_-]+)$/i

    const confirmMatch = content.trim().match(confirmPattern)
    if (confirmMatch) {
      return { confirmId: confirmMatch[1], confirmed: true }
    }

    const cancelMatch = content.trim().match(cancelPattern)
    if (cancelMatch) {
      return { confirmId: cancelMatch[1], confirmed: false }
    }

    return null
  }

  /**
   * Process a confirmation response and update mode state.
   */
  private async handleConfirmation(
    confirmResponse: { confirmId: string; confirmed: boolean }
  ): Promise<void> {
    this.logger.info(
      `[WX-ROUTE] → confirmation: id=${confirmResponse.confirmId}, confirmed=${confirmResponse.confirmed}`
    )
    const result = await this.agent.processConfirmation(
      confirmResponse.confirmId,
      confirmResponse.confirmed
    )

    // After confirmed switch, enter project mode; confirmed restart stays in master
    if (result.success && result.data) {
      const data = result.data as Record<string, unknown>
      if (data.operation === 'switch_project' && typeof data.projectId === 'string') {
        this.logger.info(`[WX-MODE] → entering project mode: projectId=${data.projectId}`)
        this.currentMode = 'project'
        this.currentProjectId = data.projectId
        result.message += '\n\n现在可以直接和我对话，输入"切换"或"切换项目"返回主控制面板。'
      }
    }

    const reply = result.message || ''
    if (reply) {
      this.logger.info(`[WX-OUT] → confirmation result (${reply.length} chars)`)
    }

    this.eventEmitter.emit('confirm_response', {
      confirmId: confirmResponse.confirmId,
      confirmed: confirmResponse.confirmed,
    })

    this.lastReply = reply
  }

  /**
   * Build agent context with real IDE state for MasterAgent
   */
  private async buildAgentContext(userId: string): Promise<AgentContext> {
    const ideApi = getIdeApiAdapter()

    const [projects, currentProject, mcpStatus, skillgroups] = await Promise.all([
      ideApi?.getProjects().catch(() => []) ?? [],
      ideApi?.getCurrentProject().catch(() => undefined) ?? undefined,
      ideApi?.getMcpStatus().catch(() => []) ?? [],
      ideApi?.getSkillGroups().catch(() => []) ?? [],
    ])

    // Update parser context for fuzzy matching
    this.agent.updateParserContext({
      projectNames: projects.map((p) => p.name),
      mcpNames: mcpStatus.map((m) => m.name),
      skillgroupNames: skillgroups.map((s) => s.name),
    })

    return {
      currentProject,
      projects,
      mcpStatus,
      skillgroups,
      userId,
      channelId: 'wechat',
      sessionId: `rc_${userId}_${Date.now()}`,
    }
  }

  /**
   * Subscribe to events
   */
  on<T = unknown>(event: RemoteControlManagerEvent, handler: (data: T) => void): () => void {
    this.eventEmitter.on(event, handler)
    return () => this.eventEmitter.off(event, handler)
  }

  /**
   * Ensure initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new RemoteControlError('Not initialized. Call initialize() first.', 'NOT_INITIALIZED')
    }
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up...')

    // Stop health monitoring
    this.stopHealthMonitoring()

    // Destroy the master AI session
    await this.agent.destroySession().catch((err) => {
      this.logger.warn('Failed to destroy master AI session:', err)
    })

    // Stop the relay server
    await getWxRelayServer().stop().catch(() => {})

    // Disconnect SDK
    await this.sdk.disconnect().catch(() => {})

    // Clear event listeners
    this.eventEmitter.removeAllListeners()

    this.initialized = false
    this.logger.info('Cleanup complete')
  }

  /**
   * ★ 强制保存 Master AI 会话历史（用于应用退出前）
   */
  async forceSaveSession(): Promise<void> {
    await this.agent.forceSaveSession().catch((err) => {
      this.logger.warn('Failed to force save master AI session:', err)
    })
  }
}

// ============ Singleton ============

let instance: RemoteControlManager | null = null

export function getRemoteControlManager(): RemoteControlManager {
  if (!instance) {
    instance = new RemoteControlManager()
  }
  return instance
}

export async function initRemoteControlManager(): Promise<RemoteControlManager> {
  const manager = getRemoteControlManager()
  await manager.initialize()
  return manager
}
