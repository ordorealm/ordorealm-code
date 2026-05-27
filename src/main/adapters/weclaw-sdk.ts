/**
 * WeClaw SDK Local Implementation
 *
 * This module provides a local implementation of the WeClaw SDK interface
 * for WeChat remote control functionality. Since the npm package 'weclaw'
 * is a placeholder (v0.0.0, 134B), this implementation provides the actual
 * functionality needed for the remote control system.
 *
 * @module main/adapters/weclaw-sdk
 * @see {@link https://github.com/weclaw/sdk} WeClaw SDK (placeholder)
 */

import { EventEmitter } from 'events'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { Logger } from '../utils/logger'
import { getWeClawManager, WeClawManager } from '../services/weclaw-manager'

// ============ Type Definitions ============

/**
 * WeClaw SDK Configuration
 */
export interface WeClawConfig {
  /** API Key for authentication */
  apiKey?: string
  /** API Secret for authentication */
  apiSecret?: string
  /** Custom API endpoint URL */
  endpoint?: string
  /** Enable debug logging */
  debug?: boolean
  /** WeClaw HTTP API address (default: 127.0.0.1:18011) */
  apiAddr?: string
}

/**
 * WeClaw Connection Information
 * Returned after successful QR code scan
 */
export interface WeClawConnection {
  /** User ID (WeChat openId or unionId) */
  userId: string
  /** User nickname */
  nickname: string
  /** User avatar URL */
  avatarUrl?: string
  /** Authorization token for subsequent operations */
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
 * WeClaw Connection Status
 */
export interface WeClawStatus {
  /** Whether currently connected */
  connected: boolean
  /** Connection timestamp (Unix milliseconds), undefined if not connected */
  connectedAt?: number
  /** Connected user information, undefined if not connected */
  user?: WeClawConnection
  /** Session ID for current connection */
  sessionId?: string
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
  | 'invalid_config'
  | 'internal_error'

/**
 * WeClaw Error Structure
 */
export interface WeClawError extends Error {
  /** Error type identifier */
  type: WeClawErrorType
  /** Original error if wrapped */
  cause?: Error
}

// ============ Constants ============

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<Pick<WeClawConfig, 'debug'>> = {
  debug: false,
}

/**
 * Default timeouts
 */
const DEFAULT_TIMEOUTS = {
  /** Default scan timeout: 60 seconds */
  SCAN: 60000,
  /** Default message send timeout: 10 seconds */
  SEND: 10000,
  /** Default connection timeout: 30 seconds */
  CONNECTION: 30000,
} as const

/**
 * WeClaw HTTP API default address
 */
const WECLAW_API_DEFAULT_ADDR = '127.0.0.1:18011'

/**
 * WeClaw service status response
 */
interface WeClawServiceStatus {
  /** Whether the service is running */
  running: boolean
  /** Whether logged in to WeChat */
  loggedIn: boolean
  /** User ID if logged in */
  userId?: string
}

/**
 * SDK version
 */
const SDK_VERSION = '1.0.0-local'

// ============ Utility Functions ============

/**
 * Generate a UUID-like session ID
 * Format: wc_{timestamp}_{random}
 * @returns Session ID string
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 11)
  return `wc_${timestamp}_${random}`
}

/**
 * Generate a UUID-like message ID
 * Format: msg_{timestamp}_{random}
 * @returns Message ID string
 */
function generateMessageId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 11)
  return `msg_${timestamp}_${random}`
}

/**
 * Create a WeClaw error
 * @param type - Error type
 * @param message - Error message
 * @param cause - Original error
 * @returns WeClawError instance
 */
function createError(type: WeClawErrorType, message: string, cause?: Error): WeClawError {
  const error = new Error(message) as WeClawError
  error.type = type
  error.cause = cause
  return error
}

// ============ Main SDK Class ============

/**
 * WeClaw SDK Implementation
 *
 * Provides WeChat remote control functionality through QR code scanning
 * and message-based communication.
 *
 * @example
 * ```typescript
 * const sdk = new WeClawSDKImpl()
 * sdk.init({ debug: true })
 *
 * // Get QR code for user to scan
 * const qrCode = await sdk.getQRCode()
 *
 * // Wait for user to scan and connect
 * const connection = await sdk.waitForConnection(60000)
 *
 * // Send a message
 * await sdk.sendMessage(connection.userId, 'Hello!')
 *
 * // Listen for messages
 * sdk.onMessage((message) => {
 *   console.log('Received:', message.content)
 * })
 * ```
 */
export class WeClawSDKImpl implements WeClawSDK {
  private config: WeClawConfig = {}
  private eventEmitter: EventEmitter = new EventEmitter()
  private status: WeClawStatus = { connected: false }
  private logger: Logger
  private sessionId: string | null = null
  private connectionTimeout: NodeJS.Timeout | null = null

  /**
   * Create a new WeClaw SDK instance
   */
  constructor() {
    this.logger = new Logger('WeClawSDK', { enabled: true, debug: false })
  }

  /**
   * Initialize the SDK with configuration
   * @param config - SDK configuration options
   */
  init(config: WeClawConfig): void {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.logger = new Logger('WeClawSDK', { enabled: true, debug: this.config.debug ?? false })
    this.logger.info(`SDK initialized (v${SDK_VERSION})`)
    this.logger.debugLog('Config:', { ...config, apiKey: config.apiKey ? '[REDACTED]' : undefined, apiSecret: config.apiSecret ? '[REDACTED]' : undefined })
  }

  /**
   * Check WeClaw service status via HTTP API
   *
   * WeClaw official API only has two endpoints:
   * - GET /health - Returns "ok" if service is running
   * - POST /api/send - Send messages
   *
   * We check login status by looking for credentials file.
   *
   * @returns Service status information
   */
  async checkServiceStatus(): Promise<WeClawServiceStatus> {
    const apiAddr = this.config.apiAddr || WECLAW_API_DEFAULT_ADDR

    // Step 1: Check if WeClaw service is running via /health endpoint
    try {
      const response = await fetch(`http://${apiAddr}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      if (response.ok) {
        const text = await response.text()
        if (text.trim() === 'ok') {
          this.logger.debugLog('WeClaw health check passed')

          // Step 2: Check login status via credentials file
          const credentials = this.loadCredentials()

          return {
            running: true,
            loggedIn: !!credentials,
            userId: credentials?.ilink_user_id,
          }
        }
      }
    } catch (error) {
      this.logger.debugLog('WeClaw health check failed:', error)
    }

    return { running: false, loggedIn: false }
  }

  /**
   * Load stored WeClaw credentials
   * WeClaw stores credentials in ~/.weclaw/accounts/{id}.json
   * @returns Credentials object or null if not found
   * @private
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
   * Generate a QR code for WeChat scanning
   *
   * This method checks if the WeClaw service is running and logged in.
   * - If already logged in: returns session ID directly
   * - If not running: starts WeClaw and returns QR URL for user to scan
   * - If running but not logged in: returns QR URL for user to scan
   *
   * The QR URL is displayed to the user as a clickable link or QR code image.
   * After scanning, the user will be logged in and the HTTP API becomes available.
   *
   * @returns Promise resolving to QR URL (for scanning) or session ID (if already connected)
   * @throws WeClawError if service cannot be started
   */
  async getQRCode(): Promise<string> {
    this.logger.info('Checking WeClaw service status...')

    const status = await this.checkServiceStatus()

    // 如果服务已运行且已登录，直接创建 session
    if (status.running && status.loggedIn) {
      this.sessionId = generateSessionId()
      this.status = {
        connected: true,
        connectedAt: Date.now(),
        user: {
          userId: status.userId || `user_${Date.now().toString(36)}`,
          nickname: 'WeChat User',
          token: `token_${Math.random().toString(36).substring(2, 15)}`,
          connectedAt: Date.now(),
        },
        sessionId: this.sessionId,
      }

      this.logger.info(`WeClaw service already connected, session: ${this.sessionId}`)
      this.eventEmitter.emit('connected', this.status.user)
      return this.sessionId
    }

    // 服务未运行或未登录，需要启动并获取 QR URL
    this.logger.info('WeClaw service not ready, starting login process...')

    const manager = getWeClawManager({
      apiAddr: this.config.apiAddr || WECLAW_API_DEFAULT_ADDR,
      debug: this.config.debug
    })

    // 检查二进制是否存在
    if (!manager.isBinaryAvailable()) {
      throw createError(
        'not_connected',
        'WeClaw 二进制文件未找到。请确保应用程序已正确安装。'
      )
    }

    // 启动 WeClaw 并捕获 QR URL
    try {
      const qrUrl = await manager.startLogin()
      this.logger.info(`WeClaw login started, QR URL: ${qrUrl}`)

      // 创建 session ID 用于追踪
      this.sessionId = generateSessionId()
      this.status.sessionId = this.sessionId

      // 如果获取到了 QR URL，返回给前端显示
      if (qrUrl) {
        // 发出 qrcode 事件，包含 QR URL
        this.eventEmitter.emit('qrcode', qrUrl)
        return qrUrl  // 返回 QR URL 而不是 session ID
      } else {
        // 没有获取到 QR URL，可能已经登录了
        // 重新检查状态
        const newStatus = await this.checkServiceStatus()
        if (newStatus.loggedIn) {
          this.sessionId = generateSessionId()
          this.status = {
            connected: true,
            connectedAt: Date.now(),
            user: {
              userId: newStatus.userId || `user_${Date.now().toString(36)}`,
              nickname: 'WeChat User',
              token: `token_${Math.random().toString(36).substring(2, 15)}`,
              connectedAt: Date.now(),
            },
            sessionId: this.sessionId,
          }
          this.logger.info(`WeClaw service connected, session: ${this.sessionId}`)
          this.eventEmitter.emit('connected', this.status.user)
          return this.sessionId
        }

        throw createError('not_connected', '未能获取登录二维码。请重试。')
      }
    } catch (error) {
      this.logger.error('Failed to start WeClaw login:', error)

      // 如果是启动失败，提供更具体的错误信息
      if (error instanceof Error) {
        throw createError('not_connected', `WeClaw 登录启动失败: ${error.message}`)
      }
      throw createError('not_connected', 'WeClaw 登录启动失败。请检查应用程序日志。')
    }
  }

  /**
   * Wait for user to scan QR code and establish connection
   *
   * This method polls for connection status or waits for a websocket
   * notification indicating the user has scanned the QR code.
   *
   * @param timeout - Maximum time to wait in milliseconds
   * @returns Promise resolving to connection information
   * @throws WeClawError on timeout or error
   */
  async waitForConnection(timeout: number = DEFAULT_TIMEOUTS.SCAN): Promise<WeClawConnection> {
    if (!this.sessionId) {
      throw createError('invalid_config', 'No active session. Call getQRCode() first.')
    }

    this.logger.info(`Waiting for connection (timeout: ${timeout}ms)...`)

    return new Promise<WeClawConnection>((resolve, reject) => {
      // Set up timeout handler
      const timeoutId = setTimeout(() => {
        this.connectionTimeout = null
        this.logger.warn('Connection timeout')
        reject(createError('scan_timeout', `Scan timeout after ${timeout}ms`))
      }, timeout)

      this.connectionTimeout = timeoutId

      // Listen for connection event
      const onConnected = (connection: WeClawConnection) => {
        clearTimeout(timeoutId)
        this.connectionTimeout = null
        this.eventEmitter.off('connected', onConnected)
        this.eventEmitter.off('error', onError)
        resolve(connection)
      }

      // Listen for error event
      const onError = (error: WeClawError) => {
        clearTimeout(timeoutId)
        this.connectionTimeout = null
        this.eventEmitter.off('connected', onConnected)
        this.eventEmitter.off('error', onError)
        reject(error)
      }

      this.eventEmitter.on('connected', onConnected)
      this.eventEmitter.on('error', onError)

      // Poll for real connection by checking service status and credentials
      this.pollForRealConnection()
    })
  }

  /**
   * Poll for real connection by checking WeClaw service status and credentials
   *
   * This method implements real connection detection by:
   * 1. Polling WeClaw HTTP API /health endpoint for service status
   * 2. Checking ~/.weclaw/accounts/*.json for credential files
   * 3. When credentials appear, reading user info and triggering connection event
   * 4. Implementing timeout mechanism (default 60 seconds)
   *
   * Uses a stopped flag to prevent race conditions with timeout handler.
   *
   * @private
   */
  private pollForRealConnection(): void {
    const apiAddr = this.config.apiAddr || WECLAW_API_DEFAULT_ADDR
    const pollInterval = 2000 // Poll every 2 seconds
    const maxAttempts = 30 // Max 30 attempts (60 seconds)
    let attempts = 0
    let stopped = false

    const poll = async (): Promise<void> => {
      // Check if polling was stopped (e.g., due to timeout or external connection)
      if (stopped) {
        this.logger.debugLog('Polling stopped, exiting')
        return
      }

      attempts++

      try {
        // Check if service is running
        const healthResponse = await fetch(`http://${apiAddr}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })

        if (!healthResponse.ok) {
          this.logger.debugLog(`Health check failed (attempt ${attempts}/${maxAttempts})`)
          if (attempts < maxAttempts && !stopped) {
            setTimeout(poll, pollInterval)
          }
          return
        }

        const healthText = await healthResponse.text()
        if (healthText.trim() !== 'ok') {
          this.logger.debugLog(`Health check returned non-ok (attempt ${attempts}/${maxAttempts})`)
          if (attempts < maxAttempts && !stopped) {
            setTimeout(poll, pollInterval)
          }
          return
        }

        // Service is running, check for credentials
        const credentials = this.loadCredentials()
        if (!credentials) {
          this.logger.debugLog(`No credentials found (attempt ${attempts}/${maxAttempts})`)
          if (attempts < maxAttempts && !stopped) {
            setTimeout(poll, pollInterval)
          }
          return
        }

        // Credentials found! Establish connection
        this.logger.info(`Credentials found for user: ${credentials.ilink_user_id}`)

        const connection: WeClawConnection = {
          userId: credentials.ilink_user_id,
          nickname: 'WeChat User',
          avatarUrl: undefined,
          token: credentials.bot_token,
          connectedAt: Date.now(),
        }

        // Stop polling before handling connection
        stopped = true
        this.handleConnection(connection)
      } catch (error) {
        this.logger.debugLog(`Connection poll error (attempt ${attempts}/${maxAttempts}):`, error)
        if (attempts < maxAttempts && !stopped) {
          setTimeout(poll, pollInterval)
        }
      }
    }

    // Set up listener to stop polling when connection is established externally
    const onConnected = (): void => {
      stopped = true
      this.logger.debugLog('Connection established, stopping poll')
    }
    this.eventEmitter.once('connected', onConnected)

    // Clean up listener after max attempts
    setTimeout(() => {
      if (!stopped) {
        this.eventEmitter.off('connected', onConnected)
      }
    }, maxAttempts * pollInterval)

    // Start polling
    poll()
  }

  /**
   * Handle incoming connection from WeChat
   * @param connection - Connection information from WeChat
   * @private
   */
  private handleConnection(connection: WeClawConnection): void {
    this.status = {
      connected: true,
      connectedAt: connection.connectedAt,
      user: connection,
      sessionId: this.sessionId ?? undefined,
    }

    this.logger.info(`Connected: ${connection.nickname} (${connection.userId})`)
    this.eventEmitter.emit('connected', connection)
  }

  /**
   * Send a message to a WeChat user
   *
   * This method calls the real WeClaw HTTP API to send messages:
   * - Endpoint: POST /api/send
   * - Body: { bot_token, to_user, message }
   * - Uses credentials from ~/.weclaw/accounts/*.json
   *
   * @param to - Recipient user ID
   * @param message - Message content
   * @returns Promise resolving when message is sent
   * @throws WeClawError if not connected or send fails
   */
  async sendMessage(to: string, message: string): Promise<void> {
    if (!this.status.connected || !this.status.user) {
      throw createError('not_connected', 'Not connected. Call waitForConnection() first.')
    }

    this.logger.info(`Sending message to ${to}: ${message.substring(0, 50)}...`)
    this.logger.debugLog('Full message:', message)

    // Load credentials for authentication
    const credentials = this.loadCredentials()
    if (!credentials) {
      throw createError('not_connected', 'No credentials found. Please reconnect.')
    }

    const apiAddr = this.config.apiAddr || WECLAW_API_DEFAULT_ADDR

    try {
      const response = await fetch(`http://${apiAddr}/api/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bot_token: credentials.bot_token,
          to_user: to,
          message: message,
        }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUTS.SEND),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        this.logger.error(`Send message failed: ${response.status} ${errorText}`)
        throw createError('send_failed', `Failed to send message: ${response.status} ${errorText}`)
      }

      this.logger.debugLog('Message sent successfully')
    } catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        this.logger.error('Send message timeout')
        throw createError('send_failed', 'Message send timeout')
      }

      if ((error as WeClawError).type === 'send_failed') {
        throw error
      }

      this.logger.error('Send message error:', error)
      throw createError('send_failed', `Failed to send message: ${(error as Error).message}`)
    }
  }

  /**
   * Register a callback for incoming messages
   *
   * @param callback - Function to call when a message is received
   */
  onMessage(callback: (message: WeClawMessage) => void): void {
    this.logger.info('Message listener registered')
    this.eventEmitter.on('message', callback)
  }

  /**
   * Remove message listener
   *
   * @param callback - The callback to remove
   */
  offMessage(callback: (message: WeClawMessage) => void): void {
    this.eventEmitter.off('message', callback)
  }

  /**
   * Simulate receiving a message (for testing)
   *
   * @param from - Sender user ID
   * @param content - Message content
   * @param type - Message type
   */
  simulateReceiveMessage(from: string, content: string, type: 'text' | 'image' | 'voice' = 'text'): void {
    const message: WeClawMessage = {
      id: generateMessageId(),
      from,
      content,
      type,
      timestamp: Date.now(),
    }

    this.logger.info(`Received message from ${from}: ${content.substring(0, 50)}...`)
    this.eventEmitter.emit('message', message)
  }

  /**
   * Disconnect from WeChat
   *
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting...')

    // Clear any pending timeouts
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout)
      this.connectionTimeout = null
    }

    // Update status
    const previousUser = this.status.user
    this.status = { connected: false }
    this.sessionId = null

    this.logger.info('Disconnected')
    this.eventEmitter.emit('disconnected', { userId: previousUser?.userId })
  }

  /**
   * Get current connection status
   *
   * @returns Current status object
   */
  getStatus(): WeClawStatus {
    return { ...this.status }
  }

  /**
   * Subscribe to SDK events
   *
   * @param event - Event type
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  on<T = unknown>(event: WeClawEvent, handler: (data: T) => void): () => void {
    this.eventEmitter.on(event, handler)
    return () => this.eventEmitter.off(event, handler)
  }

  /**
   * Unsubscribe from SDK events
   *
   * @param event - Event type
   * @param handler - Event handler to remove
   */
  off<T = unknown>(event: WeClawEvent, handler: (data: T) => void): void {
    this.eventEmitter.off(event, handler)
  }

  /**
   * Emit an error event
   *
   * @param error - Error to emit
   * @private
   */
  private emitError(error: WeClawError): void {
    this.logger.error(error.message)
    this.eventEmitter.emit('error', error)
  }

  /**
   * Get SDK version
   *
   * @returns SDK version string
   */
  getVersion(): string {
    return SDK_VERSION
  }

  /**
   * Check if SDK is connected
   *
   * @returns True if connected
   */
  isConnected(): boolean {
    return this.status.connected
  }

  /**
   * Get current session ID
   *
   * @returns Session ID or null if no active session
   */
  getSessionId(): string | null {
    return this.sessionId
  }
}

// ============ SDK Interface ============

/**
 * WeClaw SDK Interface
 *
 * Defines the contract for WeClaw SDK implementations.
 * This interface allows for different implementations
 * (local, remote, mock) to be used interchangeably.
 */
export interface WeClawSDK {
  /**
   * Initialize SDK with configuration
   * @param config - SDK configuration
   */
  init(config: WeClawConfig): void

  /**
   * Generate QR code for WeChat scanning
   * @returns Promise resolving to QR code data
   */
  getQRCode(): Promise<string>

  /**
   * Wait for QR code scan and connection
   * @param timeout - Timeout in milliseconds
   * @returns Promise resolving to connection info
   */
  waitForConnection(timeout: number): Promise<WeClawConnection>

  /**
   * Send message to WeChat user
   * @param to - Recipient user ID
   * @param message - Message content
   * @returns Promise resolving when sent
   */
  sendMessage(to: string, message: string): Promise<void>

  /**
   * Register message callback
   * @param callback - Message handler
   */
  onMessage(callback: (message: WeClawMessage) => void): void

  /**
   * Disconnect from WeChat
   * @returns Promise resolving when disconnected
   */
  disconnect(): Promise<void>

  /**
   * Get connection status
   * @returns Current status
   */
  getStatus(): WeClawStatus
}

// ============ Factory Function ============

/**
 * Create a new WeClaw SDK instance
 *
 * @param config - Optional initial configuration
 * @returns Configured SDK instance
 *
 * @example
 * ```typescript
 * const sdk = createWeClawSDK({ debug: true })
 * const qrCode = await sdk.getQRCode()
 * ```
 */
export function createWeClawSDK(config?: WeClawConfig): WeClawSDK {
  const sdk = new WeClawSDKImpl()
  if (config) {
    sdk.init(config)
  }
  return sdk
}

// ============ Default Export ============

export default WeClawSDKImpl
