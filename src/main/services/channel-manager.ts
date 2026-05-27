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
import { AgentContext } from '../agents/master-agent'

// ============ Type Definitions ============

/**
 * Message handler function type
 * Supports both sync and async handlers
 */
export type MessageHandler = (channelId: string, message: ChannelMessage) => void | Promise<void>

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
  | 'confirm_request'
  | 'confirm_response'

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
   *
   * Auto-reconnect logic:
   * 1. Load channels from storage
   * 2. For each channel that was 'connected', check if WeClaw service is running
   * 3. If WeClaw is running and has credentials, restore channel to 'connected'
   * 4. If WeClaw is not running but has credentials, start WeClaw and restore
   * 5. If no credentials, mark channel as 'disconnected'
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

    // Add channels to memory
    for (const channel of settings.channels) {
      this.channels.set(channel.id, {
        channel,
        adapter: null,
        unsubscribers: [],
      })

      this.logger.debug(`Loaded channel: ${channel.id} (${channel.type}) - status: ${channel.status}`)
    }

    this.initialized = true
    this.logger.info('ChannelManager initialized successfully')

    // Auto-reconnect channels that were previously connected
    if (this.config.autoConnect) {
      await this.restoreConnections()
    }
  }

  /**
   * Restore connections for channels that were previously connected
   *
   * This method is called during initialization to restore connections
   * for channels that were in 'connected' state when the app was closed.
   *
   * For WeChat channels, this checks:
   * 1. If WeClaw service is running (health check)
   * 2. If credentials exist (user is logged in)
   * 3. If both are true, restores channel to 'connected' state
   */
  async restoreConnections(): Promise<void> {
    this.logger.info('Restoring channel connections...')

    for (const [channelId, entry] of this.channels) {
      // Only restore channels that were connected
      if (entry.channel.status !== 'connected') {
        this.logger.debug(`Skipping channel ${channelId} - status is ${entry.channel.status}`)
        continue
      }

      if (entry.channel.type === 'wechat') {
        try {
          // Import WeClaw SDK to check service status
          const { WeClawSDKImpl } = await import('../adapters/weclaw-sdk')
          const sdk = new WeClawSDKImpl()
          sdk.init({ debug: this.config.enableLogging })

          const status = await sdk.checkServiceStatus()

          if (status.running && status.loggedIn) {
            this.logger.info(`WeClaw service is running and logged in, restoring channel ${channelId}`)

            // Create adapter and set up events
            const adapter = this.createAdapter('wechat', channelId)
            const unsubscribers = this.setupAdapterEvents(channelId, adapter)

            // Update channel entry
            this.channels.set(channelId, {
              channel: {
                ...entry.channel,
                status: 'connected',
              },
              adapter,
              unsubscribers,
            })

            // Persist status update
            await this.storage.updateChannelStatus(channelId, 'connected')

            // Emit connected event
            this.eventEmitter.emit('channel_connected', {
              channelId,
              userId: status.userId,
            })

            this.logger.info(`Channel ${channelId} restored successfully`)
          } else {
            this.logger.info(`WeClaw service not ready (running: ${status.running}, loggedIn: ${status.loggedIn}), marking channel ${channelId} as disconnected`)

            // Update status to disconnected
            entry.channel.status = 'disconnected'
            await this.storage.updateChannelStatus(channelId, 'disconnected')
          }
        } catch (error) {
          this.logger.error(`Failed to restore channel ${channelId}:`, error)
          // Mark as disconnected on error
          entry.channel.status = 'disconnected'
          await this.storage.updateChannelStatus(channelId, 'disconnected')
        }
      }
    }

    this.logger.info('Channel connection restoration complete')
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
   * Set up message processing with Master Agent
   *
   * Connects incoming messages to the Master Agent for command processing.
   * This method provides a convenient way to integrate the channel manager
   * with the master agent for automated message handling.
   *
   * Supports confirmation flow:
   * 1. When masterAgent returns requiresConfirm=true, the confirmation request
   *    is sent to the channel for user response
   * 2. When user replies with "确认 {confirmId}" or "取消 {confirmId}",
   *    the response is processed through masterAgent.processConfirmation()
   *
   * @param masterAgent - Master Agent instance for command processing
   * @param getAgentContext - Function to get current agent context for a channel
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```typescript
   * const cleanup = channelManager.setupMasterAgentProcessing(
   *   masterAgent,
   *   async (channelId, userId) => ({
   *     projects: [],
   *     mcpStatus: [],
   *     skillgroups: [],
   *     userId,
   *     channelId,
   *     sessionId: 'session-123',
   *   })
   * );
   *
   * // Later, to clean up:
   * cleanup();
   * ```
   */
  setupMasterAgentProcessing(
    masterAgent: {
      handleMessage: (message: string, context: AgentContext) => Promise<string>
      processConfirmation: (confirmId: string, confirmed: boolean) => Promise<{ success: boolean; message: string }>
    },
    getAgentContext: (channelId: string, userId: string) => Promise<AgentContext>
  ): () => void {
    // Set up message handler that processes messages through masterAgent
    this.setMessageHandler(async (channelId: string, message: ChannelMessage) => {
      try {
        // Check if this is a confirmation response message
        const confirmResponse = this.parseConfirmResponse(message.content)
        if (confirmResponse) {
          // Process confirmation response
          this.logger.info(`Processing confirmation response: ${confirmResponse.confirmId} -> ${confirmResponse.confirmed ? 'confirmed' : 'cancelled'}`)
          const result = await masterAgent.processConfirmation(
            confirmResponse.confirmId,
            confirmResponse.confirmed
          )
          await this.sendMessage(channelId, result.message)
          return
        }

        // Get context for this channel
        const context = await getAgentContext(channelId, message.userId)

        // Process message through master agent
        const response = await masterAgent.handleMessage(message.content, context)

        // Send response back to channel
        await this.sendMessage(channelId, response)
      } catch (error) {
        this.logger.error('Error processing message through master agent:', error)
        // Send error message back
        await this.sendMessage(channelId, '❌ 处理消息时发生错误').catch(() => {})
      }
    })

    this.logger.info('Master Agent message processing configured')

    // Return cleanup function
    return () => {
      this.setMessageHandler(() => {})
      this.logger.info('Master Agent message processing disabled')
    }
  }

  /**
   * Parse confirmation response from message content
   *
   * Supports both Chinese and English responses:
   * - "确认 {confirmId}" / "confirm {confirmId}" / "yes {confirmId}" / "ok {confirmId}"
   * - "取消 {confirmId}" / "cancel {confirmId}" / "no {confirmId}"
   *
   * @param content - Message content to parse
   * @returns Parsed response with confirmId and confirmed status, or null if not a confirmation response
   * @private
   */
  private parseConfirmResponse(content: string): { confirmId: string; confirmed: boolean } | null {
    // Validate input length
    if (content.length > 200) {
      return null
    }

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
      adapter.on('connected', (data: { userId?: string; nickname?: string }) => {
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

    // Confirm request event
    unsubscribers.push(
      adapter.on('confirm_request', (data: { confirmId: string; message: string; timestamp: string }) => {
        this.logger.info(`Confirmation request from ${channelId}: ${data.confirmId}`)
        this.eventEmitter.emit('confirm_request', {
          channelId,
          ...data,
        })
      })
    )

    // Confirm response event
    unsubscribers.push(
      adapter.on('confirm_response', (data: { confirmId: string; confirmed: boolean; timestamp: string }) => {
        this.logger.info(`Confirmation response from ${channelId}: ${data.confirmId} -> ${data.confirmed ? 'confirmed' : 'cancelled'}`)
        this.eventEmitter.emit('confirm_response', {
          channelId,
          ...data,
        })
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
  private async handleAdapterMessage(channelId: string, message: ChannelMessage): Promise<void> {
    this.logger.debug(`Message from ${channelId}: ${message.content.substring(0, 50)}...`)

    // Call message handler if set
    if (this.messageHandler) {
      try {
        await this.messageHandler(channelId, message)
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
