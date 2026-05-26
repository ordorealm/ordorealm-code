/**
 * Channel Manager for Remote Control
 *
 * Manages multiple channel adapters (up to 3) for remote control functionality.
 * Handles channel lifecycle, message routing, and state persistence.
 *
 * @module main/services/channel-manager
 */

import { EventEmitter } from 'events'
import {
  Channel,
  ChannelType,
  ChannelStatus,
  RemoteControlStatus,
  REMOTE_CONTROL_CONSTRAINTS,
} from '../../shared/types/remote-control'
import {
  ChannelAdapterWithEvents,
  ChannelAdapterConfig,
  ChannelMessage,
  AdapterConnectionState,
} from '../adapters/channel-adapter'
import { WeChatAdapter, WeChatAdapterConfig, createWeChatAdapter } from '../adapters/wechat-adapter'
import { RemoteControlStorage } from './remote-control-storage'
import { generateId } from '../utils/encryption'
import { Logger } from '../utils/logger'

// ============ Type Definitions ============

/**
 * Message handler function type
 */
export type MessageHandler = (channelId: string, message: ChannelMessage) => void

/**
 * Channel with its associated adapter
 */
interface ChannelEntry {
  /** Channel metadata */
  channel: Channel
  /** Adapter instance */
  adapter: ChannelAdapterWithEvents | null
  /** Unsubscribe functions for adapter events */
  unsubscribers: Array<() => void>
}

/**
 * Channel manager configuration
 */
export interface ChannelManagerConfig {
  /** Custom storage path (for testing) */
  customStoragePath?: string
  /** Auto-connect on initialize */
  autoConnect?: boolean
  /** Logging enabled */
  enableLogging?: boolean
}

/**
 * Channel manager events
 */
export type ChannelManagerEvent =
  | 'channel_added'
  | 'channel_removed'
  | 'channel_connected'
  | 'channel_disconnected'
  | 'message'
  | 'error'

/**
 * Channel manager event handler
 */
export type ChannelManagerEventHandler<T = unknown> = (data: T) => void

// ============ Errors ============

/**
 * Base error for channel manager operations
 */
export class ChannelManagerError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message)
    this.name = 'ChannelManagerError'
  }
}

/**
 * Error thrown when channel limit is exceeded
 */
export class ChannelLimitError extends ChannelManagerError {
  constructor(maxChannels: number) {
    super(`Maximum channel limit reached (${maxChannels})`, 'CHANNEL_LIMIT_EXCEEDED')
    this.name = 'ChannelLimitError'
  }
}

/**
 * Error thrown when channel is not found
 */
export class ChannelNotFoundError extends ChannelManagerError {
  constructor(channelId: string) {
    super(`Channel not found: ${channelId}`, 'CHANNEL_NOT_FOUND')
    this.name = 'ChannelNotFoundError'
  }
}

/**
 * Error thrown when adapter creation fails
 */
export class AdapterCreationError extends ChannelManagerError {
  constructor(type: ChannelType, reason: string) {
    super(`Failed to create adapter for ${type}: ${reason}`, 'ADAPTER_CREATION_FAILED')
    this.name = 'AdapterCreationError'
  }
}

// ============ Main Class ============

/**
 * Channel Manager
 *
 * Manages multiple channel adapters for remote control.
 * Supports up to 3 simultaneous channel connections.
 *
 * @example
 * ```typescript
 * const manager = new ChannelManager();
 * await manager.initialize();
 *
 * // Add a WeChat channel
 * const channel = await manager.addChannel('wechat');
 *
 * // Send a message
 * await manager.sendMessage(channel.id, 'Hello from IDE!');
 *
 * // Broadcast to all channels
 * await manager.broadcast('System notification');
 *
 * // Cleanup
 * await manager.cleanup();
 * ```
 */
export class ChannelManager {
  /** Storage instance for persistence */
  private readonly storage: RemoteControlStorage

  /** Map of channel ID to channel entry */
  private readonly channels: Map<string, ChannelEntry> = new Map()

  /** Event emitter for manager events */
  private readonly eventEmitter: EventEmitter = new EventEmitter()

  /** Message handler callback */
  private messageHandler: MessageHandler | null = null

  /** Whether the manager is initialized */
  private initialized: boolean = false

  /** Logger instance */
  private readonly logger: Logger

  /** Configuration */
  private readonly config: Required<Pick<ChannelManagerConfig, 'autoConnect' | 'enableLogging'>>

  /**
   * Create a new ChannelManager instance
   *
   * @param config - Optional configuration
   */
  constructor(config?: ChannelManagerConfig) {
    this.config = {
      autoConnect: config?.autoConnect ?? false,
      enableLogging: config?.enableLogging ?? true,
    }

    this.logger = new Logger('ChannelManager', { enabled: this.config.enableLogging })

    // Initialize storage
    this.storage = new RemoteControlStorage(config?.customStoragePath)

    this.logger.info('ChannelManager instance created')
  }

  // ============ Public API ============

  /**
   * Initialize the channel manager
   *
   * Initializes storage and loads existing channels from persistence.
   * If autoConnect is enabled, attempts to reconnect to stored channels.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('ChannelManager already initialized')
      return
    }

    this.logger.info('Initializing ChannelManager...')

    // Initialize storage
    await this.storage.initialize()

    // Load existing channels from storage
    const settings = await this.storage.getSettings()

    this.logger.info(`Loaded ${settings.channels.length} channels from storage`)

    // Add channels to memory (without adapters initially)
    for (const channel of settings.channels) {
      this.channels.set(channel.id, {
        channel,
        adapter: null,
        unsubscribers: [],
      })

      this.logger.debug(`Loaded channel: ${channel.id} (${channel.type})`)
    }

    this.initialized = true
    this.logger.info('ChannelManager initialized successfully')
  }

  /**
   * Add a new channel
   *
   * Creates a new channel of the specified type and returns it.
   * The channel starts in 'pending' status until connected.
   *
   * @param type - Channel type to add
   * @returns The newly created channel
   * @throws ChannelLimitError if max channels reached
   */
  async addChannel(type: ChannelType): Promise<Channel> {
    this.ensureInitialized()

    // Check channel limit
    if (this.channels.size >= REMOTE_CONTROL_CONSTRAINTS.MAX_CHANNELS) {
      throw new ChannelLimitError(REMOTE_CONTROL_CONSTRAINTS.MAX_CHANNELS)
    }

    this.logger.info(`Adding new channel of type: ${type}`)

    // Create channel metadata
    const channel: Channel = {
      id: generateId(),
      type,
      status: 'pending',
      connectedAt: null,
      authToken: '', // Will be set after connection
    }

    // Create adapter
    const adapter = this.createAdapter(type, channel.id)

    // Set up event handlers for the adapter
    const unsubscribers = this.setupAdapterEvents(channel.id, adapter)

    // Store channel entry
    this.channels.set(channel.id, {
      channel,
      adapter,
      unsubscribers,
    })

    // Persist to storage
    await this.storage.addChannel(channel)

    this.logger.info(`Channel added: ${channel.id}`)

    // Emit event
    this.eventEmitter.emit('channel_added', { channelId: channel.id, type })

    return { ...channel }
  }

  /**
   * Remove a channel
   *
   * Disconnects and removes the specified channel.
   *
   * @param channelId - ID of the channel to remove
   * @throws ChannelNotFoundError if channel doesn't exist
   */
  async removeChannel(channelId: string): Promise<void> {
    this.ensureInitialized()

    const entry = this.channels.get(channelId)
    if (!entry) {
      throw new ChannelNotFoundError(channelId)
    }

    this.logger.info(`Removing channel: ${channelId}`)

    // Disconnect adapter if connected
    if (entry.adapter) {
      try {
        await entry.adapter.disconnect()
      } catch (error) {
        this.logger.warn(`Error disconnecting adapter: ${error}`)
      }
    }

    // Unsubscribe from events
    entry.unsubscribers.forEach((unsub) => unsub())

    // Remove from memory
    this.channels.delete(channelId)

    // Remove from storage
    await this.storage.removeChannel(channelId)

    this.logger.info(`Channel removed: ${channelId}`)

    // Emit event
    this.eventEmitter.emit('channel_removed', { channelId })
  }

  /**
   * Get all channels
   *
   * Returns a copy of all channel metadata.
   *
   * @returns Array of channels
   */
  getChannels(): Channel[] {
    const result: Channel[] = []
    this.channels.forEach((entry) => {
      result.push({ ...entry.channel })
    })
    return result
  }

  /**
   * Get channel by ID
   *
   * @param channelId - Channel ID
   * @returns Channel or undefined if not found
   */
  getChannel(channelId: string): Channel | undefined {
    const entry = this.channels.get(channelId)
    return entry ? { ...entry.channel } : undefined
  }

  /**
   * Get adapter for a channel
   *
   * @param channelId - Channel ID
   * @returns Adapter instance or undefined if not found
   */
  getAdapter(channelId: string): ChannelAdapterWithEvents | undefined {
    const entry = this.channels.get(channelId)
    return entry?.adapter ?? undefined
  }

  /**
   * Get all adapters
   *
   * Returns a map of channel IDs to adapters.
   *
   * @returns Map of channel ID to adapter
   */
  getAdapters(): Map<string, ChannelAdapterWithEvents> {
    const result = new Map<string, ChannelAdapterWithEvents>()
    this.channels.forEach((entry, channelId) => {
      if (entry.adapter) {
        result.set(channelId, entry.adapter)
      }
    })
    return result
  }

  /**
   * Connect a channel
   *
   * Initiates connection for the specified channel and returns QR code.
   *
   * @param channelId - Channel ID to connect
   * @returns QR code data for scanning
   * @throws ChannelNotFoundError if channel doesn't exist
   */
  async connectChannel(channelId: string): Promise<{ qrCode: string }> {
    this.ensureInitialized()

    const entry = this.channels.get(channelId)
    if (!entry) {
      throw new ChannelNotFoundError(channelId)
    }

    if (!entry.adapter) {
      throw new AdapterCreationError(entry.channel.type, 'Adapter not available')
    }

    this.logger.info(`Connecting channel: ${channelId}`)

    const { qrCode } = await entry.adapter.connect()

    return { qrCode }
  }

  /**
   * Disconnect a channel
   *
   * Disconnects the specified channel but keeps it in the list.
   *
   * @param channelId - Channel ID to disconnect
   * @throws ChannelNotFoundError if channel doesn't exist
   */
  async disconnectChannel(channelId: string): Promise<void> {
    this.ensureInitialized()

    const entry = this.channels.get(channelId)
    if (!entry) {
      throw new ChannelNotFoundError(channelId)
    }

    if (!entry.adapter) {
      return
    }

    this.logger.info(`Disconnecting channel: ${channelId}`)

    await entry.adapter.disconnect()

    // Update status
    entry.channel.status = 'disconnected'
    entry.channel.connectedAt = null

    // Persist
    await this.storage.updateChannelStatus(channelId, 'disconnected')
  }

  /**
   * Send a message to a specific channel
   *
   * @param channelId - Target channel ID
   * @param message - Message content
   * @throws ChannelNotFoundError if channel doesn't exist
   */
  async sendMessage(channelId: string, message: string): Promise<void> {
    this.ensureInitialized()

    const entry = this.channels.get(channelId)
    if (!entry) {
      throw new ChannelNotFoundError(channelId)
    }

    if (!entry.adapter) {
      throw new ChannelManagerError(
        `No adapter available for channel: ${channelId}`,
        'NO_ADAPTER'
      )
    }

    const state = entry.adapter.getState()
    if (!state.isConnected) {
      throw new ChannelManagerError(
        `Channel is not connected: ${channelId}`,
        'NOT_CONNECTED'
      )
    }

    this.logger.debug(`Sending message to ${channelId}: ${message.substring(0, 50)}...`)

    await entry.adapter.sendMessage(message)
  }

  /**
   * Broadcast a message to all connected channels
   *
   * @param message - Message content
   */
  async broadcast(message: string): Promise<void> {
    this.ensureInitialized()

    this.logger.info(`Broadcasting message to ${this.channels.size} channels`)

    const promises: Promise<void>[] = []

    this.channels.forEach((entry, channelId) => {
      if (entry.adapter) {
        const state = entry.adapter.getState()
        if (state.isConnected) {
          promises.push(
            entry.adapter!.sendMessage(message).catch((error) => {
              this.logger.error(`Failed to send to ${channelId}:`, error)
            })
          )
        }
      }
    })

    await Promise.all(promises)
  }

  /**
   * Request confirmation from a specific channel
   *
   * @param channelId - Target channel ID
   * @param message - Confirmation prompt
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise resolving to user's response
   */
  async requestConfirm(
    channelId: string,
    message: string,
    timeout?: number
  ): Promise<boolean> {
    this.ensureInitialized()

    const entry = this.channels.get(channelId)
    if (!entry) {
      throw new ChannelNotFoundError(channelId)
    }

    if (!entry.adapter) {
      throw new ChannelManagerError(
        `No adapter available for channel: ${channelId}`,
        'NO_ADAPTER'
      )
    }

    return entry.adapter.requestConfirm(message, timeout)
  }

  /**
   * Set message handler
   *
   * The handler will be called for all incoming messages from all channels.
   *
   * @param handler - Message handler function
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
    this.logger.debug('Message handler set')
  }

  /**
   * Subscribe to channel manager events
   *
   * @param event - Event type
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  on<T = unknown>(
    event: ChannelManagerEvent,
    handler: ChannelManagerEventHandler<T>
  ): () => void {
    this.eventEmitter.on(event, handler)
    return () => this.eventEmitter.off(event, handler)
  }

  /**
   * Get current status
   *
   * @returns Remote control status summary
   */
  async getStatus(): Promise<RemoteControlStatus> {
    this.ensureInitialized()

    const settings = await this.storage.getSettings()
    const connectedChannels = Array.from(this.channels.values()).filter(
      (e) => e.channel.status === 'connected'
    ).length

    return {
      enabled: settings.enabled,
      requireConfirm: settings.requireConfirm,
      connectedChannels,
      channels: this.getChannels().map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        connectedAt: c.connectedAt,
      })),
    }
  }

  /**
   * Get channel count
   *
   * @returns Number of channels
   */
  getChannelCount(): number {
    return this.channels.size
  }

  /**
   * Check if a channel type is supported
   *
   * @param type - Channel type
   * @returns Whether the type is supported
   */
  isChannelTypeSupported(type: string): type is ChannelType {
    return ['wechat', 'wecom', 'feishu'].includes(type)
  }

  /**
   * Cleanup and release resources
   *
   * Disconnects all channels and releases resources.
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up ChannelManager...')

    // Disconnect all adapters
    const disconnectPromises: Promise<void>[] = []

    this.channels.forEach((entry, channelId) => {
      if (entry.adapter) {
        disconnectPromises.push(
          entry.adapter.disconnect().catch((error) => {
            this.logger.warn(`Error disconnecting ${channelId}:`, error)
          })
        )
      }

      // Unsubscribe from events
      entry.unsubscribers.forEach((unsub) => unsub())
    })

    await Promise.all(disconnectPromises)

    // Clear channels
    this.channels.clear()

    // Clear message handler
    this.messageHandler = null

    // Remove all event listeners
    this.eventEmitter.removeAllListeners()

    this.initialized = false
    this.logger.info('ChannelManager cleanup complete')
  }

  // ============ Private Methods ============

  /**
   * Ensure the manager is initialized
   *
   * @throws Error if not initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ChannelManager not initialized. Call initialize() first.')
    }
  }

  /**
   * Create an adapter for a channel type
   *
   * @param type - Channel type
   * @param instanceId - Instance ID for the adapter
   * @returns Created adapter
   * @throws AdapterCreationError if type is not supported
   */
  private createAdapter(type: ChannelType, instanceId: string): ChannelAdapterWithEvents {
    const baseConfig = {
      instanceId,
      logging: {
        enabled: this.config.enableLogging,
        level: 'info' as const,
      },
    }

    switch (type) {
      case 'wechat': {
        const wechatConfig: WeChatAdapterConfig = {
          type: 'wechat',
          ...baseConfig,
        }
        return createWeChatAdapter(wechatConfig)
      }

      case 'wecom':
        // TODO: Implement WeCom adapter
        throw new AdapterCreationError(type, 'WeCom adapter not yet implemented')

      case 'feishu':
        // TODO: Implement Feishu adapter
        throw new AdapterCreationError(type, 'Feishu adapter not yet implemented')

      default:
        throw new AdapterCreationError(type, 'Unknown channel type')
    }
  }

  /**
   * Set up event handlers for an adapter
   *
   * @param channelId - Channel ID
   * @param adapter - Adapter instance
   * @returns Array of unsubscribe functions
   */
  private setupAdapterEvents(
    channelId: string,
    adapter: ChannelAdapterWithEvents
  ): Array<() => void> {
    const unsubscribers: Array<() => void> = []

    // Connected event
    unsubscribers.push(
      adapter.on('connected', (data: any) => {
        this.handleAdapterConnected(channelId, data)
      })
    )

    // Disconnected event
    unsubscribers.push(
      adapter.on('disconnected', () => {
        this.handleAdapterDisconnected(channelId)
      })
    )

    // Message event
    unsubscribers.push(
      adapter.on('message', (message: ChannelMessage) => {
        this.handleAdapterMessage(channelId, message)
      })
    )

    // Error event
    unsubscribers.push(
      adapter.on('error', (error: Error) => {
        this.handleAdapterError(channelId, error)
      })
    )

    return unsubscribers
  }

  /**
   * Handle adapter connected event
   */
  private async handleAdapterConnected(
    channelId: string,
    data: { userId?: string; nickname?: string }
  ): Promise<void> {
    const entry = this.channels.get(channelId)
    if (!entry) return

    this.logger.info(`Channel connected: ${channelId}`)

    // Update channel status
    entry.channel.status = 'connected'
    entry.channel.connectedAt = new Date().toISOString()

    // Persist
    await this.storage.updateChannelStatus(channelId, 'connected')

    // Emit event
    this.eventEmitter.emit('channel_connected', {
      channelId,
      userId: data.userId,
      nickname: data.nickname,
    })
  }

  /**
   * Handle adapter disconnected event
   */
  private async handleAdapterDisconnected(channelId: string): Promise<void> {
    const entry = this.channels.get(channelId)
    if (!entry) return

    this.logger.info(`Channel disconnected: ${channelId}`)

    // Update channel status
    entry.channel.status = 'disconnected'
    entry.channel.connectedAt = null

    // Persist
    await this.storage.updateChannelStatus(channelId, 'disconnected')

    // Emit event
    this.eventEmitter.emit('channel_disconnected', { channelId })
  }

  /**
   * Handle adapter message event
   */
  private handleAdapterMessage(channelId: string, message: ChannelMessage): void {
    this.logger.debug(`Message from ${channelId}: ${message.content.substring(0, 50)}...`)

    // Call message handler if set
    if (this.messageHandler) {
      try {
        this.messageHandler(channelId, message)
      } catch (error) {
        this.logger.error('Error in message handler:', error)
      }
    }

    // Emit event
    this.eventEmitter.emit('message', { channelId, message })
  }

  /**
   * Handle adapter error event
   */
  private handleAdapterError(channelId: string, error: Error): void {
    this.logger.error(`Error on channel ${channelId}:`, error)

    // Emit event
    this.eventEmitter.emit('error', { channelId, error })
  }
}

// ============ Factory Function ============

/**
 * Create and initialize a ChannelManager instance
 *
 * @param config - Optional configuration
 * @returns Initialized ChannelManager
 *
 * @example
 * ```typescript
 * const manager = await createChannelManager();
 * const channel = await manager.addChannel('wechat');
 * ```
 */
export async function createChannelManager(
  config?: ChannelManagerConfig
): Promise<ChannelManager> {
  const manager = new ChannelManager(config)
  await manager.initialize()
  return manager
}

// ============ Default Export ============

export default ChannelManager
