/**
 * WeClaw SDK Local Implementation
 *
 * 简化为单账号模式，提供清晰的登录状态检测和连接管理。
 *
 * 登录状态检测流程：
 * 1. 检查 WeClaw 服务是否运行（HTTP /health）
 * 2. 检查是否有有效的账号凭证（~/.weclaw/accounts/*.json）
 * 3. 验证凭证是否有效（尝试调用 API）
 *
 * @module main/adapters/weclaw-sdk
 */

import { EventEmitter } from 'events'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { Logger } from '../utils/logger'
import { getWeClawManager, WeClawManager } from '../services/weclaw-manager'
import {
  ConnectionStatus,
  ConnectionInfo,
  REMOTE_CONTROL_CONSTRAINTS,
} from '../../shared/types/remote-control'

// ============ Type Definitions ============

/**
 * WeClaw SDK Configuration
 */
export interface WeClawConfig {
  /** Enable debug logging */
  debug?: boolean
  /** WeClaw HTTP API address (default: 127.0.0.1:18011) */
  apiAddr?: string
}

/**
 * WeClaw Connection Information
 */
export interface WeClawConnection {
  /** User ID (WeChat openId or unionId) */
  userId: string
  /** User nickname */
  nickname: string
  /** Authorization token */
  token: string
  /** Connection timestamp */
  connectedAt: number
}

/**
 * WeClaw Message Structure
 */
export interface WeClawMessage {
  /** Message unique identifier */
  id: string
  /** Sender user ID */
  from: string
  /** Message content */
  content: string
  /** Message type */
  type: 'text' | 'image' | 'voice'
  /** Message timestamp (Unix milliseconds) */
  timestamp: number
}

/**
 * WeClaw service status
 */
export interface WeClawServiceStatus {
  /** Whether the service is running */
  running: boolean
  /** Whether logged in to WeChat */
  loggedIn: boolean
  /** User ID if logged in */
  userId?: string
  /** Bot token if logged in */
  botToken?: string
}

/**
 * WeClaw SDK Events
 */
export type WeClawEvent =
  | 'connected'
  | 'disconnected'
  | 'message'
  | 'error'
  | 'qrcode'

/**
 * WeClaw Error Types
 */
export type WeClawErrorType =
  | 'connection_timeout'
  | 'scan_timeout'
  | 'send_failed'
  | 'not_connected'
  | 'not_logged_in'
  | 'invalid_config'
  | 'binary_not_found'
  | 'internal_error'

/**
 * WeClaw Error Structure
 */
export interface WeClawError extends Error {
  type: WeClawErrorType
  cause?: Error
}

// ============ Constants ============

const DEFAULT_API_ADDR = '127.0.0.1:18011'
const SDK_VERSION = '2.0.0-single-account'

// ============ Utility Functions ============

function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 11)
  return `wc_${timestamp}_${random}`
}

function generateMessageId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 11)
  return `msg_${timestamp}_${random}`
}

function createError(type: WeClawErrorType, message: string, cause?: Error): WeClawError {
  const error = new Error(message) as WeClawError
  error.type = type
  error.cause = cause
  return error
}

// ============ Main SDK Class ============

/**
 * WeClaw SDK Implementation - Single Account Mode
 *
 * @example
 * ```typescript
 * const sdk = new WeClawSDKImpl()
 * sdk.init({ debug: true })
 *
 * // Check if already logged in
 * const status = await sdk.checkServiceStatus()
 * if (status.loggedIn) {
 *   console.log('Already logged in:', status.userId)
 * } else {
 *   // Get QR code for login
 *   const qrUrl = await sdk.getQRCode()
 *   // Wait for user to scan
 *   const connection = await sdk.waitForConnection()
 * }
 * ```
 */
export class WeClawSDKImpl implements WeClawSDK {
  private config: WeClawConfig = {}
  private eventEmitter: EventEmitter = new EventEmitter()
  private connection: WeClawConnection | null = null
  private logger: Logger
  private sessionId: string | null = null
  private connectionTimeout: NodeJS.Timeout | null = null
  private messagePollingDisconnectHandler: (() => void) | null = null

  constructor() {
    this.logger = new Logger('WeClawSDK', { enabled: true, debug: false })
  }

  /**
   * Initialize the SDK with configuration
   */
  init(config: WeClawConfig): void {
    this.config = { debug: false, ...config }
    this.logger = new Logger('WeClawSDK', { enabled: true, debug: this.config.debug ?? false })
    this.logger.info(`SDK initialized (v${SDK_VERSION})`)
  }

  /**
   * Check WeClaw service status
   *
   * This method performs real status detection:
   * 1. HTTP health check to verify service is running
   * 2. Check for credentials file
   * 3. Validate credentials by testing API
   *
   * @returns Service status with login information
   */
  async checkServiceStatus(): Promise<WeClawServiceStatus> {
    const apiAddr = this.config.apiAddr || DEFAULT_API_ADDR
    const timeout = REMOTE_CONTROL_CONSTRAINTS.HEALTH_CHECK_TIMEOUT_MS

    // Step 1: Check if WeClaw service is running
    let daemonRunning = false
    try {
      const response = await fetch(`http://${apiAddr}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      })

      if (response.ok) {
        const text = await response.text()
        if (text.trim() === 'ok') {
          daemonRunning = true
          this.logger.debugLog('WeClaw service is running')
        }
      }
    } catch {
      this.logger.debugLog('Health check failed (daemon not running)')
    }

    // Step 2: Check for credentials (works even when daemon is not running)
    const credentials = this.loadCredentials()
    if (credentials) {
      this.logger.info(`Credentials found: ${credentials.ilink_user_id}`)

      // If daemon is not running but credentials exist, try to start it
      if (!daemonRunning) {
        this.logger.info('Daemon not running, starting...')
        try {
          const manager = getWeClawManager({
            apiAddr: this.config.apiAddr || DEFAULT_API_ADDR,
            debug: this.config.debug,
          })
          await manager.start()
          // Wait for daemon HTTP API to be actually ready (up to 10 seconds)
          daemonRunning = await this.waitForDaemonReady(apiAddr, 10000)
          if (!daemonRunning) {
            this.logger.warn('Daemon started but health check still failing')
          }
        } catch (err) {
          this.logger.warn('Failed to auto-start daemon:', err)
        }
      }

      return {
        running: daemonRunning,
        loggedIn: true,
        userId: credentials.ilink_user_id,
        botToken: credentials.bot_token,
      }
    }

    this.logger.debugLog('No credentials found')
    return { running: daemonRunning, loggedIn: false }
  }

  /**
   * Load stored WeClaw credentials
   * WeClaw stores credentials in ~/.weclaw/accounts/*.json
   */
  private loadCredentials(): { ilink_user_id: string; bot_token: string } | null {
    const homeDir = os.homedir()
    const accountsDir = path.join(homeDir, '.weclaw', 'accounts')

    if (!fs.existsSync(accountsDir)) {
      return null
    }

    try {
      const files = fs.readdirSync(accountsDir)
      const jsonFile = files.find((f: string) => f.endsWith('.json'))

      if (!jsonFile) {
        return null
      }

      const filePath = path.join(accountsDir, jsonFile)
      const content = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(content)

      if (!data.ilink_user_id || !data.bot_token) {
        this.logger.warn('Credentials file missing required fields')
        return null
      }

      return {
        ilink_user_id: data.ilink_user_id,
        bot_token: data.bot_token,
      }
    } catch (error) {
      this.logger.debugLog('Failed to load credentials:', error)
      return null
    }
  }

  /**
   * Get QR code for WeChat login
   *
   * If already logged in, returns empty string and triggers 'connected' event.
   * If not logged in, starts WeClaw login process and returns QR URL.
   *
   * @returns QR URL for scanning, or empty string if already logged in
   */
  async getQRCode(): Promise<string> {
    this.logger.info('Checking WeClaw login status...')

    const status = await this.checkServiceStatus()

    // Already logged in - restore connection (credentials exist, daemon may still be starting)
    if (status.loggedIn) {
      this.sessionId = generateSessionId()
      this.connection = {
        userId: status.userId!,
        nickname: 'WeChat User',
        token: status.botToken!,
        connectedAt: Date.now(),
      }

      this.logger.info(`Already logged in as: ${status.userId}`)
      this.eventEmitter.emit('connected', this.connection)
      return '' // Empty string indicates already logged in
    }

    // Not logged in - start login process
    this.logger.info('Not logged in, starting login process...')

    const manager = getWeClawManager({
      apiAddr: this.config.apiAddr || DEFAULT_API_ADDR,
      debug: this.config.debug,
    })

    // Check if binary exists
    if (!manager.isBinaryAvailable()) {
      const binaryPath = manager.getBinaryPath()
      this.logger.error(`WeClaw binary not found: ${binaryPath}`)
      throw createError(
        'binary_not_found',
        `WeClaw 二进制文件未找到。检测路径: ${binaryPath || '系统 PATH'}。请确保应用程序已正确安装。`
      )
    }

    // Start WeClaw and capture QR URL
    try {
      const qrUrl = await manager.startLogin()
      this.logger.info(`Login started, QR URL: ${qrUrl}`)

      this.sessionId = generateSessionId()

      if (qrUrl) {
        this.eventEmitter.emit('qrcode', qrUrl)
        return qrUrl
      } else {
        // No QR URL - might already be logged in
        const newStatus = await this.checkServiceStatus()
        if (newStatus.loggedIn) {
          this.sessionId = generateSessionId()
          this.connection = {
            userId: newStatus.userId!,
            nickname: 'WeChat User',
            token: newStatus.botToken!,
            connectedAt: Date.now(),
          }
          this.logger.info(`Connected: ${newStatus.userId}`)
          this.eventEmitter.emit('connected', this.connection)
          return ''
        }

        throw createError('not_logged_in', '未能获取登录二维码，请重试。')
      }
    } catch (error) {
      this.logger.error('Failed to start login:', error)

      if ((error as WeClawError).type) {
        throw error
      }

      throw createError(
        'not_logged_in',
        `登录启动失败: ${(error as Error).message}`
      )
    }
  }

  /**
   * Wait for user to scan QR code and establish connection
   *
   * Polls for connection status until timeout.
   *
   * @param timeout - Maximum time to wait in milliseconds
   * @returns Connection information
   */
  async waitForConnection(
    timeout: number = REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS
  ): Promise<WeClawConnection> {
    if (!this.sessionId) {
      throw createError('invalid_config', 'No active session. Call getQRCode() first.')
    }

    // If already connected, return immediately
    if (this.connection) {
      return this.connection
    }

    this.logger.info(`Waiting for connection (timeout: ${timeout}ms)...`)

    return new Promise<WeClawConnection>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.connectionTimeout = null
        this.logger.warn('Connection timeout')
        reject(createError('scan_timeout', `扫码超时（${timeout / 1000}秒）`))
      }, timeout)

      this.connectionTimeout = timeoutId

      const onConnected = (connection: WeClawConnection) => {
        clearTimeout(timeoutId)
        this.connectionTimeout = null
        this.eventEmitter.off('connected', onConnected)
        this.eventEmitter.off('error', onError)
        resolve(connection)
      }

      const onError = (error: WeClawError) => {
        clearTimeout(timeoutId)
        this.connectionTimeout = null
        this.eventEmitter.off('connected', onConnected)
        this.eventEmitter.off('error', onError)
        reject(error)
      }

      this.eventEmitter.on('connected', onConnected)
      this.eventEmitter.on('error', onError)

      // Start polling for real connection
      this.pollForConnection()
    })
  }

  /**
   * Start polling for incoming messages from the WeClaw HTTP API.
   * Runs continuously while connected; stops on disconnect.
   */
  startMessagePolling(): void {
    const apiAddr = this.config.apiAddr || DEFAULT_API_ADDR
    const pollInterval = REMOTE_CONTROL_CONSTRAINTS.POLL_INTERVAL_MS
    const seenMessageIds = new Set<string>()
    let stopped = false

    // Stop any existing polling
    this.stopMessagePolling()

    this.messagePollingDisconnectHandler = () => {
      stopped = true
    }
    this.eventEmitter.on('disconnected', this.messagePollingDisconnectHandler)

    const poll = async (): Promise<void> => {
      if (stopped || !this.connection) return

      try {
        const response = await fetch(`http://${apiAddr}/api/messages`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })

        if (!response.ok) {
          setTimeout(poll, pollInterval)
          return
        }

        const messages: WeClawMessage[] = await response.json()
          .catch(() => [])

        if (!Array.isArray(messages)) {
          setTimeout(poll, pollInterval)
          return
        }

        for (const msg of messages) {
          if (seenMessageIds.has(msg.id)) continue
          seenMessageIds.add(msg.id)

          this.logger.info(`Received message: ${msg.content?.substring(0, 50)}...`)
          this.eventEmitter.emit('message', msg)
        }

        if (!stopped) {
          setTimeout(poll, pollInterval)
        }
      } catch {
        // Silently retry on network errors
        if (!stopped) {
          setTimeout(poll, pollInterval)
        }
      }
    }

    poll()
  }

  /**
   * Stop message polling
   */
  stopMessagePolling(): void {
    if (this.messagePollingDisconnectHandler) {
      this.eventEmitter.off('disconnected', this.messagePollingDisconnectHandler)
      this.messagePollingDisconnectHandler = null
    }
  }

  /**
   * Poll for connection by checking credentials
   *
   * Checks for credentials first (no daemon needed), then starts
   * the daemon once credentials are found.
   */
  private pollForConnection(): void {
    const pollInterval = REMOTE_CONTROL_CONSTRAINTS.POLL_INTERVAL_MS
    const maxAttempts = REMOTE_CONTROL_CONSTRAINTS.MAX_POLL_ATTEMPTS
    let attempts = 0
    let stopped = false

    const poll = async (): Promise<void> => {
      if (stopped) return

      attempts++

      try {
        // Step 1: Check for credentials (doesn't require daemon to be running)
        const credentials = this.loadCredentials()
        if (credentials) {
          // Credentials found! Now start the daemon
          this.logger.info(`Credentials found: ${credentials.ilink_user_id}`)
          stopped = true

          try {
            const manager = getWeClawManager({
              apiAddr: this.config.apiAddr || DEFAULT_API_ADDR,
              debug: this.config.debug,
            })
            await manager.start()
            this.logger.info('WeClaw daemon started after login')
          } catch (err) {
            this.logger.warn('Failed to start daemon (may already be running):', err)
          }

          const connection: WeClawConnection = {
            userId: credentials.ilink_user_id,
            nickname: 'WeChat User',
            token: credentials.bot_token,
            connectedAt: Date.now(),
          }

          this.handleConnection(connection)
          return
        }

        // No credentials yet — retry
        this.logger.debugLog(`No credentials yet (attempt ${attempts}/${maxAttempts})`)
        if (attempts < maxAttempts && !stopped) {
          setTimeout(poll, pollInterval)
        }
      } catch (error) {
        this.logger.debugLog(`Poll error (attempt ${attempts}/${maxAttempts}):`, error)
        if (attempts < maxAttempts && !stopped) {
          setTimeout(poll, pollInterval)
        }
      }
    }

    // Stop polling on external connection
    this.eventEmitter.once('connected', () => {
      stopped = true
    })

    poll()
  }

  /**
   * Handle incoming connection
   */
  private handleConnection(connection: WeClawConnection): void {
    this.connection = connection
    this.logger.info(`Connected: ${connection.nickname} (${connection.userId})`)
    this.eventEmitter.emit('connected', connection)
  }

  /**
   * Send a message to a WeChat user
   *
   * @param to - Recipient user ID (usually the connected user)
   * @param message - Message content
   */
  async sendMessage(to: string, message: string): Promise<void> {
    if (!this.connection) {
      throw createError('not_connected', '未连接，请先登录。')
    }

    this.logger.info(`Sending message to ${to}: ${message.substring(0, 50)}...`)

    const credentials = this.loadCredentials()
    if (!credentials) {
      throw createError('not_logged_in', '未找到凭证，请重新登录。')
    }

    const apiAddr = this.config.apiAddr || DEFAULT_API_ADDR

    try {
      const response = await fetch(`http://${apiAddr}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_token: credentials.bot_token,
          to,
          text: message,
        }),
        signal: AbortSignal.timeout(REMOTE_CONTROL_CONSTRAINTS.MAX_RESPONSE_DELAY_MS),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        this.logger.error(`Send failed: ${response.status} ${errorText}`)
        throw createError('send_failed', `发送失败: ${response.status} ${errorText}`)
      }

      this.logger.debugLog('Message sent successfully')
    } catch (error) {
      if ((error as WeClawError).type) throw error

      this.logger.error('Send error:', error)
      throw createError('send_failed', `发送失败: ${(error as Error).message}`)
    }
  }

  /**
   * Register callback for incoming messages
   */
  onMessage(callback: (message: WeClawMessage) => void): void {
    this.eventEmitter.on('message', callback)
  }

  /**
   * Remove message listener
   */
  offMessage(callback: (message: WeClawMessage) => void): void {
    this.eventEmitter.off('message', callback)
  }

  /**
   * Disconnect from WeChat and clean up all state (daemon, credentials)
   * so the user can re-connect with a different WeChat account.
   */
  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting...')

    // Stop message polling
    this.stopMessagePolling()

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout)
      this.connectionTimeout = null
    }

    const previousUser = this.connection?.userId
    this.connection = null
    this.sessionId = null

    // Stop the WeClaw daemon and delete credentials so a different
    // WeChat account can be used on next connect.
    try {
      const manager = getWeClawManager({
        apiAddr: this.config.apiAddr || DEFAULT_API_ADDR,
        debug: this.config.debug,
      })
      await manager.logout()
    } catch (err) {
      this.logger.warn('Failed to logout WeClaw manager:', err)
    }

    this.logger.info('Disconnected')
    this.eventEmitter.emit('disconnected', { userId: previousUser })
  }

  /**
   * Get current connection info
   */
  getConnection(): WeClawConnection | null {
    return this.connection ? { ...this.connection } : null
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connection !== null
  }

  /**
   * Subscribe to SDK events
   */
  on<T = unknown>(event: WeClawEvent, handler: (data: T) => void): () => void {
    this.eventEmitter.on(event, handler)
    return () => this.eventEmitter.off(event, handler)
  }

  /**
   * Unsubscribe from SDK events
   */
  off<T = unknown>(event: WeClawEvent, handler: (data: T) => void): void {
    this.eventEmitter.off(event, handler)
  }

  /**
   * Get SDK version
   */
  getVersion(): string {
    return SDK_VERSION
  }

  /**
   * Get session ID
   */
  getSessionId(): string | null {
    return this.sessionId
  }

  /**
   * Wait for the WeClaw daemon HTTP API to become ready.
   * Polls /health until it returns "ok" or timeout expires.
   */
  private async waitForDaemonReady(apiAddr: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const interval = 500

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${apiAddr}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        })

        if (response.ok) {
          const text = await response.text()
          if (text.trim() === 'ok') {
            this.logger.info(`Daemon ready after ${timeoutMs - (deadline - Date.now())}ms`)
            return true
          }
        }
      } catch {
        // Daemon not ready yet, retry
      }

      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    this.logger.warn(`Daemon not ready after ${timeoutMs}ms`)
    return false
  }
}

// ============ SDK Interface ============

export interface WeClawSDK {
  init(config: WeClawConfig): void
  checkServiceStatus(): Promise<WeClawServiceStatus>
  getQRCode(): Promise<string>
  waitForConnection(timeout?: number): Promise<WeClawConnection>
  sendMessage(to: string, message: string): Promise<void>
  onMessage(callback: (message: WeClawMessage) => void): void
  offMessage(callback: (message: WeClawMessage) => void): void
  startMessagePolling(): void
  stopMessagePolling(): void
  disconnect(): Promise<void>
  getConnection(): WeClawConnection | null
  isConnected(): boolean
  on<T = unknown>(event: WeClawEvent, handler: (data: T) => void): () => void
  off<T = unknown>(event: WeClawEvent, handler: (data: T) => void): void
  getVersion(): string
}

// ============ Factory Function ============

export function createWeClawSDK(config?: WeClawConfig): WeClawSDK {
  const sdk = new WeClawSDKImpl()
  if (config) {
    sdk.init(config)
  }
  return sdk
}

export default WeClawSDKImpl
