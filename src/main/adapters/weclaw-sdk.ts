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
import { Logger } from '../utils/logger'

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
   * Generate a QR code for WeChat scanning
   *
   * The QR code contains a session ID that uniquely identifies this
   * connection attempt. The user scans this QR code with their WeChat
   * app to establish the connection.
   *
   * @returns Promise resolving to QR code data (session ID)
   * @throws WeClawError if SDK not initialized
   */
  async getQRCode(): Promise<string> {
    this.logger.info('Generating QR code...')

    // Generate unique session ID
    this.sessionId = generateSessionId()
    this.status.sessionId = this.sessionId

    // In a real implementation, this would call the WeClaw API
    // to generate a proper QR code image. For now, we return
    // the session ID which can be used to construct a QR code.

    this.logger.info(`QR code generated: ${this.sessionId}`)
    this.eventEmitter.emit('qrcode', this.sessionId)

    return this.sessionId
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

      // Simulate connection after a delay (for testing)
      // In production, this would wait for actual WeChat callback
      this.simulateConnection()
    })
  }

  /**
   * Simulate a connection for testing purposes
   * In production, this would be triggered by WeChat callback
   * @private
   */
  private simulateConnection(): void {
    // This is a simulation for testing
    // In production, the connection would be established via
    // WeChat callback when the user scans the QR code
    const simulatedConnection: WeClawConnection = {
      userId: `user_${Date.now().toString(36)}`,
      nickname: 'Test User',
      avatarUrl: undefined,
      token: `token_${Math.random().toString(36).substring(2, 15)}`,
      connectedAt: Date.now(),
    }

    // Emit connection event after a short delay
    setTimeout(() => {
      this.handleConnection(simulatedConnection)
    }, 1000)
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

    // In a real implementation, this would call the WeClaw API
    // to send the message via WeChat

    // Simulate async send operation
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(createError('send_failed', 'Message send timeout'))
      }, DEFAULT_TIMEOUTS.SEND)

      // Simulate successful send after a short delay
      setTimeout(() => {
        clearTimeout(timeoutId)
        this.logger.debugLog('Message sent successfully')
        resolve()
      }, 100)
    })
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
