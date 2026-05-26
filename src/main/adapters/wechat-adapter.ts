/**
 * WeChat Channel Adapter Implementation
 *
 * This module implements the ChannelAdapterWithEvents interface for WeChat
 * remote control using the WeClaw SDK. It provides QR code scanning,
 * message sending/receiving, and confirmation request functionality.
 *
 * @module main/adapters/wechat-adapter
 * @see {@link ./channel-adapter.ts} Channel adapter interface
 * @see {@link ./weclaw-sdk.ts} WeClaw SDK implementation
 */

import { EventEmitter } from 'events'
import {
  WeClawSDKImpl,
  WeClawConfig,
  WeClawConnection,
  WeClawMessage,
  WeClawError,
  createWeClawSDK,
} from './weclaw-sdk'
import {
  ChannelAdapterWithEvents,
  ChannelAdapterEvent,
  ChannelAdapterEventHandler,
  AdapterConnectionState,
  ChannelMessage,
  ChannelConnectionOptions,
  ChannelAdapterConfig,
  createMessageId,
  createConfirmId,
  getCurrentTimestamp,
  DEFAULT_CONNECTION_OPTIONS,
} from './channel-adapter'
import { REMOTE_CONTROL_CONSTRAINTS } from '../../shared/types/remote-control'

// ============ Type Definitions ============

/**
 * WeChat adapter specific configuration
 */
export interface WeChatAdapterConfig extends ChannelAdapterConfig {
  /** WeChat specific options */
  wechat?: {
    /** Whether to enable message acknowledgment */
    enableAck?: boolean
    /** Message retry count */
    retryCount?: number
  }
}

/**
 * Pending confirmation request
 */
interface PendingConfirmation {
  /** Confirmation ID */
  confirmId: string
  /** Original message */
  message: string
  /** Resolve function */
  resolve: (confirmed: boolean) => void
  /** Reject function */
  reject: (error: Error) => void
  /** Timeout handle */
  timeout: NodeJS.Timeout
  /** Timestamp when created */
  createdAt: number
}

// ============ Constants ============

/**
 * Adapter version
 */
const ADAPTER_VERSION = '1.0.0'

/**
 * Default WeChat adapter configuration
 */
const DEFAULT_WECHAT_CONFIG: Required<NonNullable<WeChatAdapterConfig['wechat']>> = {
  enableAck: true,
  retryCount: 3,
}

// ============ Logger ============

/**
 * Simple logger for adapter operations
 */
class Logger {
  private prefix: string
  private level: 'debug' | 'info' | 'warn' | 'error'

  constructor(prefix: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
    this.prefix = prefix
    this.level = level
  }

  private shouldLog(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    const levels = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.level)
  }

  private format(level: string, message: string): string {
    const timestamp = new Date().toISOString()
    return `[${timestamp}] [${this.prefix}] [${level}] ${message}`
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.log(this.format('DEBUG', message), ...args)
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.log(this.format('INFO', message), ...args)
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('WARN', message), ...args)
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(this.format('ERROR', message), ...args)
    }
  }
}

// ============ Main Adapter Class ============

/**
 * WeChat Channel Adapter
 *
 * Implements the ChannelAdapterWithEvents interface for WeChat remote control.
 * Uses the WeClaw SDK for underlying WeChat communication.
 *
 * @example
 * ```typescript
 * const adapter = new WeChatAdapter({
 *   type: 'wechat',
 *   instanceId: 'wechat-1',
 *   logging: { enabled: true, level: 'info' }
 * })
 *
 * // Connect via QR code
 * const { qrCode, channelId } = await adapter.connect()
 *
 * // Subscribe to messages
 * adapter.onMessage((message) => {
 *   console.log('Received:', message.content)
 * })
 *
 * // Send a message
 * await adapter.sendMessage('Hello from IDE!')
 *
 * // Request confirmation
 * const confirmed = await adapter.requestConfirm('Are you sure?')
 * ```
 */
export class WeChatAdapter implements ChannelAdapterWithEvents {
  /** Channel type identifier */
  readonly type = 'wechat' as const

  /** Adapter instance ID */
  private readonly instanceId: string

  /** WeClaw SDK instance */
  private readonly sdk: WeClawSDKImpl

  /** Event emitter for adapter events */
  private readonly eventEmitter: EventEmitter = new EventEmitter()

  /** Current connection state */
  private connectionState: AdapterConnectionState = {
    isConnected: false,
    connectedAt: null,
    lastError: null,
    reconnectAttempts: 0,
  }

  /** Channel ID (set after successful connection) */
  private channelId: string | null = null

  /** Connected user ID */
  private userId: string | null = null

  /** Connection information */
  private connection: WeClawConnection | null = null

  /** Pending confirmation requests */
  private pendingConfirmations: Map<string, PendingConfirmation> = new Map()

  /** Logger instance */
  private readonly logger: Logger

  /** Configuration */
  private readonly config: Required<Pick<ChannelAdapterConfig, 'connection' | 'logging'>> & {
    wechat: Required<NonNullable<WeChatAdapterConfig['wechat']>>
  }

  /** Message callbacks */
  private messageCallbacks: Set<(message: ChannelMessage) => void> = new Set()

  /**
   * Create a new WeChat adapter instance
   *
   * @param config - Adapter configuration
   */
  constructor(config: WeChatAdapterConfig) {
    this.instanceId = config.instanceId

    // Initialize configuration with defaults
    this.config = {
      connection: { ...DEFAULT_CONNECTION_OPTIONS, ...config.connection },
      logging: config.logging ?? { enabled: true, level: 'info' },
      wechat: { ...DEFAULT_WECHAT_CONFIG, ...config.wechat },
    }

    // Initialize logger
    this.logger = new Logger(
      `WeChatAdapter[${this.instanceId}]`,
      this.config.logging.enabled ? this.config.logging.level : 'error'
    )

    // Initialize WeClaw SDK
    const sdkConfig: WeClawConfig = {
      apiKey: config.credentials?.apiKey,
      apiSecret: config.credentials?.apiSecret,
      endpoint: config.credentials?.endpoint,
      debug: this.config.logging.level === 'debug',
    }

    this.sdk = createWeClawSDK(sdkConfig) as WeClawSDKImpl

    this.logger.info(`Adapter initialized (v${ADAPTER_VERSION})`)
  }

  /**
   * Connect to WeChat via QR code scanning
   *
   * Generates a QR code for the user to scan with their WeChat app.
   * Returns the QR code data and a channel ID for tracking.
   *
   * @param options - Optional connection configuration
   * @returns Promise resolving to QR code and channel ID
   * @throws Error if connection fails or times out
   */
  async connect(
    options?: ChannelConnectionOptions
  ): Promise<{ qrCode: string; channelId: string }> {
    const timeout = options?.timeout ?? this.config.connection.timeout

    this.logger.info(`Starting connection (timeout: ${timeout}ms)`)

    // Reset state
    this.connectionState = {
      isConnected: false,
      connectedAt: null,
      lastError: null,
      reconnectAttempts: 0,
    }

    try {
      // Generate QR code
      const qrCode = await this.sdk.getQRCode()
      this.channelId = `wechat_${this.instanceId}_${Date.now().toString(36)}`

      this.logger.info(`QR code generated: ${qrCode}`)
      this.logger.debug(`Channel ID: ${this.channelId}`)

      // Wait for user to scan and connect
      this.connection = await this.sdk.waitForConnection(timeout)
      this.userId = this.connection.userId

      // Update connection state
      this.connectionState = {
        isConnected: true,
        connectedAt: new Date(this.connection.connectedAt).toISOString(),
        lastError: null,
        reconnectAttempts: 0,
      }

      this.logger.info(`Connected: ${this.connection.nickname} (${this.userId})`)

      // Set up message forwarding from SDK
      this.setupMessageForwarding()

      // Emit connected event
      this.eventEmitter.emit('connected', {
        channelId: this.channelId,
        userId: this.userId,
        nickname: this.connection.nickname,
      })

      return {
        qrCode,
        channelId: this.channelId,
      }
    } catch (error) {
      const err = error as WeClawError
      this.connectionState.lastError = err.message

      this.logger.error(`Connection failed: ${err.message}`)

      // Emit error event
      this.eventEmitter.emit('error', err)

      throw err
    }
  }

  /**
   * Disconnect from WeChat
   *
   * Closes the WeChat connection and cleans up resources.
   *
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting...')

    // Clear pending confirmations gracefully
    this.pendingConfirmations.forEach(({ resolve, timeout }) => {
      clearTimeout(timeout)
      // Resolve with false to indicate cancellation due to disconnect
      resolve(false)
    })
    this.pendingConfirmations.clear()

    // Clear message callbacks
    this.messageCallbacks.clear()

    // Disconnect SDK
    await this.sdk.disconnect()

    // Update state
    const previousChannelId = this.channelId
    this.connectionState = {
      isConnected: false,
      connectedAt: null,
      lastError: null,
      reconnectAttempts: 0,
    }
    this.channelId = null
    this.userId = null
    this.connection = null

    this.logger.info('Disconnected')

    // Emit disconnected event
    this.eventEmitter.emit('disconnected', { channelId: previousChannelId })
  }

  /**
   * Send a message to the connected WeChat user
   *
   * @param message - Message content to send
   * @param metadata - Optional message metadata
   * @throws Error if not connected
   */
  async sendMessage(
    message: string,
    metadata?: Partial<import('./channel-adapter').MessageMetadata>
  ): Promise<void> {
    if (!this.connectionState.isConnected || !this.userId) {
      throw new Error('Not connected. Call connect() first.')
    }

    this.logger.info(`Sending message: ${message.substring(0, 50)}...`)
    this.logger.debug('Full message:', message)

    try {
      await this.sdk.sendMessage(this.userId, message)
      this.logger.debug('Message sent successfully')
    } catch (error) {
      const err = error as Error
      this.logger.error(`Failed to send message: ${err.message}`)
      this.eventEmitter.emit('error', err)
      throw err
    }
  }

  /**
   * Register callback for incoming messages
   *
   * Multiple callbacks can be registered. They will be called
   * in the order they were registered.
   *
   * @param callback - Function to call when a message is received
   */
  onMessage(callback: (message: ChannelMessage) => void): void {
    this.messageCallbacks.add(callback)
    this.logger.debug('Message callback registered')
  }

  /**
   * Remove a message callback
   *
   * @param callback - The callback to remove
   */
  offMessage(callback: (message: ChannelMessage) => void): void {
    this.messageCallbacks.delete(callback)
    this.logger.debug('Message callback removed')
  }

  /**
   * Request confirmation from the WeChat user
   *
   * Sends a confirmation request message and waits for the user's response.
   * The user can respond with "confirm" or "cancel" (or similar).
   *
   * @param message - Confirmation prompt message
   * @param timeout - Optional timeout in milliseconds (default: 30 seconds)
   * @returns Promise resolving to true if confirmed, false if cancelled
   * @throws Error if not connected or timeout
   */
  async requestConfirm(message: string, timeout?: number): Promise<boolean> {
    if (!this.connectionState.isConnected || !this.userId || !this.channelId) {
      throw new Error('Not connected. Call connect() first.')
    }

    const confirmId = createConfirmId()
    const actualTimeout =
      timeout ?? REMOTE_CONTROL_CONSTRAINTS.CONFIRM_TIMEOUT_MS

    this.logger.info(`Requesting confirmation: ${message} (timeout: ${actualTimeout}ms)`)
    this.logger.debug(`Confirmation ID: ${confirmId}`)

    // Send confirmation request message
    const confirmMessage = `[确认请求] ${message}\n\n请回复 "确认 ${confirmId}" 或 "取消 ${confirmId}"`

    // Emit confirm_request event before sending
    this.eventEmitter.emit('confirm_request', {
      confirmId,
      message,
      timestamp: getCurrentTimestamp(),
    })

    await this.sendMessage(confirmMessage)

    return new Promise<boolean>((resolve, reject) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.pendingConfirmations.delete(confirmId)
        this.logger.warn(`Confirmation timeout: ${confirmId}`)
        reject(new Error(`Confirmation timeout after ${actualTimeout}ms`))
      }, actualTimeout)

      // Store pending confirmation
      this.pendingConfirmations.set(confirmId, {
        confirmId,
        message,
        resolve,
        reject,
        timeout: timeoutHandle,
        createdAt: Date.now(),
      })
    })
  }

  /**
   * Subscribe to adapter events
   *
   * Available events:
   * - 'connected': Emitted when connection is established
   * - 'disconnected': Emitted when connection is closed
   * - 'message': Emitted when a message is received
   * - 'error': Emitted when an error occurs
   * - 'confirm_request': Emitted when a confirmation request is made
   * - 'confirm_response': Emitted when a confirmation response is received
   *
   * @param event - Event type to subscribe to
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  on<T = unknown>(
    event: ChannelAdapterEvent,
    handler: ChannelAdapterEventHandler<T>
  ): () => void {
    this.eventEmitter.on(event, handler)
    this.logger.debug(`Event listener registered: ${event}`)
    return () => {
      this.eventEmitter.off(event, handler)
      this.logger.debug(`Event listener removed: ${event}`)
    }
  }

  /**
   * Get current connection state
   *
   * @returns Current adapter connection state
   */
  getState(): AdapterConnectionState {
    return { ...this.connectionState }
  }

  /**
   * Get channel ID
   *
   * @returns Channel ID or null if not connected
   */
  getChannelId(): string | null {
    return this.channelId
  }

  /**
   * Get connected user ID
   *
   * @returns User ID or null if not connected
   */
  getUserId(): string | null {
    return this.userId
  }

  /**
   * Get connection information
   *
   * @returns Connection info or null if not connected
   */
  getConnection(): WeClawConnection | null {
    return this.connection
  }

  // ============ Private Methods ============

  /**
   * Set up message forwarding from SDK to adapter
   * @private
   */
  private setupMessageForwarding(): void {
    this.sdk.onMessage((sdkMessage: WeClawMessage) => {
      this.handleIncomingMessage(sdkMessage)
    })

    // Also listen for SDK events
    this.sdk.on('disconnected', () => {
      this.logger.info('SDK disconnected')
      this.connectionState.isConnected = false
      this.eventEmitter.emit('disconnected', { channelId: this.channelId })
    })

    this.sdk.on('error', (error: WeClawError) => {
      this.logger.error(`SDK error: ${error.message}`)
      this.connectionState.lastError = error.message
      this.eventEmitter.emit('error', error)
    })
  }

  /**
   * Handle incoming message from SDK
   * @param sdkMessage - Message from WeClaw SDK
   * @private
   */
  private handleIncomingMessage(sdkMessage: WeClawMessage): void {
    this.logger.info(`Received message: ${sdkMessage.content.substring(0, 50)}...`)
    this.logger.debug('Full message:', sdkMessage)

    // Check if this is a confirmation response
    const confirmResponse = this.parseConfirmResponse(sdkMessage.content)
    if (confirmResponse) {
      this.handleConfirmResponse(confirmResponse)
      return
    }

    // Create channel message
    const channelMessage: ChannelMessage = {
      messageId: sdkMessage.id,
      timestamp: new Date(sdkMessage.timestamp).toISOString(),
      userId: sdkMessage.from,
      channelId: this.channelId ?? '',
      content: sdkMessage.content,
      type: 'text',
    }

    // Emit message event
    this.eventEmitter.emit('message', channelMessage)

    // Call all registered message callbacks
    this.messageCallbacks.forEach((callback) => {
      try {
        callback(channelMessage)
      } catch (error) {
        this.logger.error('Error in message callback:', error)
      }
    })
  }

  /**
   * Parse confirmation response from message content
   * @param content - Message content
   * @returns Parsed response or null if not a confirmation response
   * @private
   */
  private parseConfirmResponse(
    content: string
  ): { confirmId: string; confirmed: boolean } | null {
    // Support both Chinese and English responses
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
   * Handle confirmation response
   * @param response - Parsed confirmation response
   * @private
   */
  private handleConfirmResponse(response: { confirmId: string; confirmed: boolean }): void {
    const pending = this.pendingConfirmations.get(response.confirmId)
    if (!pending) {
      this.logger.warn(`No pending confirmation found: ${response.confirmId}`)
      return
    }

    this.logger.info(
      `Confirmation response: ${response.confirmId} -> ${response.confirmed ? 'confirmed' : 'cancelled'}`
    )

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout)
    this.pendingConfirmations.delete(response.confirmId)

    // Resolve the promise
    pending.resolve(response.confirmed)

    // Emit confirm_response event
    this.eventEmitter.emit('confirm_response', {
      confirmId: response.confirmId,
      confirmed: response.confirmed,
      timestamp: getCurrentTimestamp(),
    })
  }

  /**
   * Simulate receiving a message (for testing)
   *
   * @param content - Message content
   * @param from - Sender user ID (defaults to connected user)
   */
  simulateReceiveMessage(content: string, from?: string): void {
    if (!this.sdk.simulateReceiveMessage) {
      this.logger.warn('SDK does not support message simulation')
      return
    }

    this.sdk.simulateReceiveMessage(from ?? this.userId ?? 'test_user', content)
  }
}

// ============ Factory Function ============

/**
 * Create a new WeChat adapter instance
 *
 * @param config - Adapter configuration
 * @returns Configured WeChat adapter
 *
 * @example
 * ```typescript
 * const adapter = createWeChatAdapter({
 *   type: 'wechat',
 *   instanceId: 'wechat-main',
 *   logging: { enabled: true, level: 'debug' }
 * })
 * ```
 */
export function createWeChatAdapter(config: WeChatAdapterConfig): WeChatAdapter {
  return new WeChatAdapter(config)
}

// ============ Default Export ============

export default WeChatAdapter
