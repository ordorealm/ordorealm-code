/**
 * Channel Adapter Interface for Remote Control
 *
 * This module defines the adapter interface for different remote control channels
 * (WeChat ClawBot, WeCom, Feishu). Each channel type implements this interface
 * to provide unified remote control capabilities.
 *
 * @module main/adapters/channel-adapter
 * @see {@link https://github.com/weclaw/sdk} WeClaw SDK
 */

// Re-export types from shared definitions
export type {
  ChannelType,
  ChannelStatus,
  Channel,
  ChannelAdapter,
} from '../../shared/types/remote-control'

// Re-export constraints for adapter implementations
export { REMOTE_CONTROL_CONSTRAINTS } from '../../shared/types/remote-control'

// ============ Adapter-Specific Types ============

/**
 * Connection options for channel adapter initialization
 */
export interface ChannelConnectionOptions {
  /** Timeout in milliseconds for connection attempt */
  timeout?: number
  /** Whether to auto-reconnect on disconnection */
  autoReconnect?: boolean
  /** Maximum retry attempts for reconnection */
  maxRetries?: number
}

/**
 * Adapter connection state for internal tracking
 */
export interface AdapterConnectionState {
  /** Whether the adapter is currently connected */
  isConnected: boolean
  /** Connection timestamp (ISO8601), null if not connected */
  connectedAt: string | null
  /** Last error message if any */
  lastError: string | null
  /** Number of reconnection attempts */
  reconnectAttempts: number
}

/**
 * Message metadata for incoming/outgoing messages
 */
export interface MessageMetadata {
  /** Message unique identifier */
  messageId: string
  /** Timestamp when message was sent/received (ISO8601) */
  timestamp: string
  /** User identifier who sent/received the message */
  userId: string
  /** Channel identifier */
  channelId: string
}

/**
 * Extended message with metadata
 */
export interface ChannelMessage extends MessageMetadata {
  /** Message content */
  content: string
  /** Message type */
  type: 'text' | 'confirm_request' | 'confirm_response'
  /** Confirmation ID if this is a confirmation-related message */
  confirmId?: string
  /** Confirmation result if this is a confirm_response */
  confirmed?: boolean
}

/**
 * Event types emitted by channel adapters
 */
export type ChannelAdapterEvent =
  | 'connected'
  | 'disconnected'
  | 'message'
  | 'error'
  | 'confirm_request'
  | 'confirm_response'

/**
 * Event handler function type
 */
export type ChannelAdapterEventHandler<T = unknown> = (data: T) => void

/**
 * Extended channel adapter interface with event handling
 *
 * This extends the base ChannelAdapter with event subscription capabilities
 * for more flexible integration with the remote control system.
 */
export interface ChannelAdapterWithEvents {
  /** Channel type identifier */
  readonly type: import('../../shared/types/remote-control').ChannelType

  /**
   * Initialize connection and return QR code for scanning
   * @param options - Optional connection configuration
   * @returns Promise resolving to QR code data and channel ID
   */
  connect(options?: ChannelConnectionOptions): Promise<{ qrCode: string; channelId: string }>

  /**
   * Disconnect the channel
   * @returns Promise resolving when disconnected
   */
  disconnect(): Promise<void>

  /**
   * Send a message to the remote user
   * @param message - Message content to send
   * @param metadata - Optional message metadata
   */
  sendMessage(message: string, metadata?: Partial<MessageMetadata>): Promise<void>

  /**
   * Register callback for incoming messages
   * @param callback - Function to call when message is received
   */
  onMessage(callback: (message: ChannelMessage) => void): void

  /**
   * Request confirmation from the remote user
   * @param message - Confirmation prompt message
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise resolving to user's response (true = confirmed)
   */
  requestConfirm(message: string, timeout?: number): Promise<boolean>

  /**
   * Subscribe to adapter events
   * @param event - Event type to subscribe to
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  on<T = unknown>(event: ChannelAdapterEvent, handler: ChannelAdapterEventHandler<T>): () => void

  /**
   * Get current connection state
   * @returns Current adapter connection state
   */
  getState(): AdapterConnectionState
}

/**
 * Factory function type for creating channel adapters
 */
export type ChannelAdapterFactory = (
  config: ChannelAdapterConfig
) => ChannelAdapterWithEvents

/**
 * Configuration for channel adapter initialization
 */
export interface ChannelAdapterConfig {
  /** Channel type to create */
  type: import('../../shared/types/remote-control').ChannelType
  /** Unique identifier for this adapter instance */
  instanceId: string
  /** API credentials (encrypted) */
  credentials?: {
    /** API key or token */
    apiKey?: string
    /** API secret */
    apiSecret?: string
    /** Custom endpoint URL */
    endpoint?: string
  }
  /** Connection options */
  connection?: ChannelConnectionOptions
  /** Logging configuration */
  logging?: {
    /** Whether to enable logging */
    enabled: boolean
    /** Log level */
    level: 'debug' | 'info' | 'warn' | 'error'
  }
}

// ============ Helper Functions ============

/**
 * Validates channel type string
 * @param type - Channel type string to validate
 * @returns True if valid channel type
 */
export function isValidChannelType(type: string): type is import('../../shared/types/remote-control').ChannelType {
  return ['wechat', 'wecom', 'feishu'].includes(type)
}

/**
 * Creates a unique message ID
 * @returns UUID-like message identifier
 */
export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Creates a unique confirmation ID
 * @returns UUID-like confirmation identifier
 */
export function createConfirmId(): string {
  return `confirm_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Gets current timestamp in ISO8601 format
 * @returns ISO8601 timestamp string
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Creates a channel message object
 * @param content - Message content
 * @param channelId - Channel identifier
 * @param userId - User identifier
 * @param type - Message type
 * @returns Complete channel message object
 */
export function createChannelMessage(
  content: string,
  channelId: string,
  userId: string,
  type: ChannelMessage['type'] = 'text'
): ChannelMessage {
  return {
    messageId: createMessageId(),
    timestamp: getCurrentTimestamp(),
    userId,
    channelId,
    content,
    type,
  }
}

/**
 * Default connection options
 */
export const DEFAULT_CONNECTION_OPTIONS: Required<ChannelConnectionOptions> = {
  timeout: 60000, // 60 seconds (from REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS)
  autoReconnect: true,
  maxRetries: 3,
}

/**
 * Default adapter configuration
 */
export const DEFAULT_ADAPTER_CONFIG: Required<Omit<ChannelAdapterConfig, 'type' | 'instanceId' | 'credentials'>> = {
  connection: DEFAULT_CONNECTION_OPTIONS,
  logging: {
    enabled: true,
    level: 'info',
  },
}
