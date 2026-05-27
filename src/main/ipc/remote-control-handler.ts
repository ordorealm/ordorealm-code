/**
 * Remote Control IPC Handler
 *
 * Handles IPC communication between renderer and main process for
 * remote control functionality. Implements all 5 IPC handlers:
 * - getStatus: Get remote control status
 * - connect: Initiate connection and return QR code
 * - disconnect: Disconnect a channel
 * - listChannels: Get connected channels list
 * - updateSettings: Update security settings
 *
 * @module main/ipc/remote-control-handler
 * @see Product-Spec.md Section 6.1
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import {
  IPC_CHANNELS,
  GetStatusRequest,
  GetStatusResponse,
  ConnectRequest,
  ConnectResponse,
  DisconnectRequest,
  DisconnectResponse,
  ListChannelsRequest,
  ListChannelsResponse,
  UpdateSettingsRequest,
  UpdateSettingsResponse,
  ChannelStatusChangeEvent,
  MessageReceivedEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
} from '../../shared/ipc/remote-control-channels'
import { ChannelManager } from '../services/channel-manager'
import { RemoteControlStorage } from '../services/remote-control-storage'
import { Logger } from '../utils/logger'

// ============ IPC Push Channels ============

/**
 * IPC push event channels for real-time updates to renderer
 *
 * These channels are used to push events from main process to renderer
 * without the renderer having to poll.
 */
export const IPC_PUSH_CHANNELS = {
  /** Remote control overall status changed */
  STATUS_CHANGE: 'remote-control:status-change',
  /** Individual channel status changed (connected/disconnected) */
  CHANNEL_STATUS_CHANGE: 'remote-control:channel-status-change',
  /** Message received from remote channel */
  MESSAGE_RECEIVED: 'remote-control:message-received',
  /** Confirmation request received (requires user action) */
  CONFIRM_REQUEST: 'remote-control:confirm-request',
  /** Confirmation response processed */
  CONFIRM_RESPONSE: 'remote-control:confirm-response',
} as const

// ============ Type Definitions ============

/**
 * Error codes for IPC responses
 */
export enum IpcErrorCode {
  /** Channel limit exceeded */
  CHANNEL_LIMIT_EXCEEDED = 'CHANNEL_LIMIT_EXCEEDED',
  /** Channel not found */
  CHANNEL_NOT_FOUND = 'CHANNEL_NOT_FOUND',
  /** Invalid request parameters */
  INVALID_REQUEST = 'INVALID_REQUEST',
  /** Operation failed */
  OPERATION_FAILED = 'OPERATION_FAILED',
  /** Not initialized */
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  /** Adapter creation failed */
  ADAPTER_CREATION_FAILED = 'ADAPTER_CREATION_FAILED',
}

/**
 * IPC error response structure
 */
export interface IpcErrorResponse {
  /** Error code */
  code: IpcErrorCode
  /** Human-readable error message */
  message: string
  /** Additional error details */
  details?: unknown
}

/**
 * Result type for IPC handlers
 */
export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: IpcErrorResponse }

// ============ Handler Interface ============

/**
 * Remote Control IPC Handler interface
 */
export interface RemoteControlHandler {
  /** Register all IPC handlers */
  register(): void

  /** Unregister all IPC handlers */
  unregister(): void

  /** Set channel manager */
  setChannelManager(manager: ChannelManager): void

  /** Set storage service */
  setStorage(storage: RemoteControlStorage): void
}

// ============ Main Class ============

/**
 * Remote Control IPC Handler Implementation
 *
 * Manages IPC communication for remote control feature.
 * All handlers use async/await and return typed responses.
 *
 * @example
 * ```typescript
 * const handler = new RemoteControlHandlerImpl();
 * handler.setChannelManager(manager);
 * handler.setStorage(storage);
 * handler.register();
 *
 * // When shutting down
 * handler.unregister();
 * ```
 */
export class RemoteControlHandlerImpl implements RemoteControlHandler {
  /** Channel manager instance */
  private channelManager: ChannelManager | null = null

  /** Storage service instance */
  private storage: RemoteControlStorage | null = null

  /** Logger instance */
  private readonly logger: Logger

  /** List of registered channel names for cleanup */
  private readonly registeredChannels: string[] = []

  /** Channel manager event unsubscribers for cleanup */
  private readonly channelManagerUnsubscribers: Array<() => void> = []

  /**
   * Create a new RemoteControlHandlerImpl instance
   */
  constructor() {
    this.logger = new Logger('RemoteControlHandler', { enabled: true })
    this.logger.info('RemoteControlHandler instance created')
  }

  // ============ Public API ============

  /**
   * Set channel manager
   *
   * @param manager - Channel manager instance
   */
  setChannelManager(manager: ChannelManager): void {
    this.channelManager = manager
    this.logger.info('ChannelManager set')
  }

  /**
   * Set storage service
   *
   * @param storage - Storage service instance
   */
  setStorage(storage: RemoteControlStorage): void {
    this.storage = storage
    this.logger.info('Storage service set')
  }

  /**
   * Set up channel manager event listeners
   *
   * This method should be called after setChannelManager() to enable
   * real-time event push to renderer process.
   *
   * Listens for:
   * - channel_connected: Pushes channel status change to renderer
   * - channel_disconnected: Pushes channel status change to renderer
   * - message: Pushes received message to renderer
   * - error: Pushes error status to renderer
   * - confirm_request: Pushes confirmation request to renderer for UI display
   * - confirm_response: Pushes confirmation response to renderer
   */
  setupChannelManagerEvents(): void {
    if (!this.channelManager) {
      this.logger.warn('Cannot setup channel manager events: channel manager not set')
      return
    }

    this.logger.info('Setting up channel manager event listeners...')

    // Clean up any existing listeners
    this.channelManagerUnsubscribers.forEach((unsub) => unsub())
    this.channelManagerUnsubscribers.length = 0

    // Listen for channel connected event
    this.channelManagerUnsubscribers.push(
      this.channelManager.on('channel_connected', (data: { channelId: string; userId?: string; nickname?: string }) => {
        const event: ChannelStatusChangeEvent = {
          channelId: data.channelId,
          status: 'connected',
          userId: data.userId,
          nickname: data.nickname,
        }
        this.broadcastEvent(IPC_PUSH_CHANNELS.CHANNEL_STATUS_CHANGE, event)
      })
    )

    // Listen for channel disconnected event
    this.channelManagerUnsubscribers.push(
      this.channelManager.on('channel_disconnected', (data: { channelId: string }) => {
        const event: ChannelStatusChangeEvent = {
          channelId: data.channelId,
          status: 'disconnected',
        }
        this.broadcastEvent(IPC_PUSH_CHANNELS.CHANNEL_STATUS_CHANGE, event)
      })
    )

    // Listen for message event
    this.channelManagerUnsubscribers.push(
      this.channelManager.on('message', (data: { channelId: string; message: unknown }) => {
        const event: MessageReceivedEvent = {
          channelId: data.channelId,
          message: data.message as MessageReceivedEvent['message'],
        }
        this.broadcastEvent(IPC_PUSH_CHANNELS.MESSAGE_RECEIVED, event)
      })
    )

    // Listen for error event
    this.channelManagerUnsubscribers.push(
      this.channelManager.on('error', (data: { channelId: string; error: Error }) => {
        this.broadcastEvent(IPC_PUSH_CHANNELS.STATUS_CHANGE, {
          type: 'error',
          channelId: data.channelId,
          message: data.error.message,
        })
      })
    )

    // Listen for confirm_request events from adapters
    this.channelManagerUnsubscribers.push(
      this.channelManager.on('confirm_request', (data: { channelId: string; confirmId: string; message: string; timestamp: string }) => {
        this.logger.info(`Confirmation request received: ${data.confirmId}`)
        const event: ConfirmRequestEvent = {
          confirmId: data.confirmId,
          message: data.message,
          channelId: data.channelId,
          timestamp: data.timestamp,
        }
        this.broadcastEvent(IPC_PUSH_CHANNELS.CONFIRM_REQUEST, event)
      })
    )

    // Listen for confirm_response events from adapters
    this.channelManagerUnsubscribers.push(
      this.channelManager.on('confirm_response', (data: { channelId: string; confirmId: string; confirmed: boolean; timestamp: string }) => {
        this.logger.info(`Confirmation response processed: ${data.confirmId} -> ${data.confirmed ? 'confirmed' : 'cancelled'}`)
        const event: ConfirmResponseEvent = {
          confirmId: data.confirmId,
          confirmed: data.confirmed,
          channelId: data.channelId,
        }
        this.broadcastEvent(IPC_PUSH_CHANNELS.CONFIRM_RESPONSE, event)
      })
    )

    this.logger.info('Channel manager event listeners configured')
  }

  /**
   * Broadcast an event to all renderer processes
   *
   * @param channel - IPC channel name
   * @param data - Event data to send
   */
  private broadcastEvent<T>(channel: string, data: T): void {
    const allWindows = BrowserWindow.getAllWindows()
    for (const win of allWindows) {
      win.webContents.send(channel, data)
    }
    this.logger.debug(`Broadcast event "${channel}" to ${allWindows.length} windows`)
  }

  /**
   * Register all IPC handlers
   *
   * Registers all 5 IPC handlers with Electron's ipcMain.
   * Must call setChannelManager() and setStorage() before registering.
   */
  register(): void {
    this.logger.info('Registering IPC handlers...')

    // Register getStatus handler
    this.registerHandler(
      IPC_CHANNELS.GET_STATUS,
      this.handleGetStatus.bind(this)
    )

    // Register connect handler
    this.registerHandler(
      IPC_CHANNELS.CONNECT,
      this.handleConnect.bind(this)
    )

    // Register disconnect handler
    this.registerHandler(
      IPC_CHANNELS.DISCONNECT,
      this.handleDisconnect.bind(this)
    )

    // Register listChannels handler
    this.registerHandler(
      IPC_CHANNELS.LIST_CHANNELS,
      this.handleListChannels.bind(this)
    )

    // Register updateSettings handler
    this.registerHandler(
      IPC_CHANNELS.UPDATE_SETTINGS,
      this.handleUpdateSettings.bind(this)
    )

    this.logger.info(`Registered ${this.registeredChannels.length} IPC handlers`)
  }

  /**
   * Unregister all IPC handlers
   *
   * Removes all registered handlers from ipcMain.
   * Should be called during cleanup.
   */
  unregister(): void {
    this.logger.info('Unregistering IPC handlers...')

    for (const channel of this.registeredChannels) {
      try {
        ipcMain.removeHandler(channel)
        this.logger.debug(`Unregistered handler: ${channel}`)
      } catch (error) {
        this.logger.warn(`Failed to unregister handler ${channel}:`, error)
      }
    }

    this.registeredChannels.length = 0

    // Clean up channel manager event listeners
    this.channelManagerUnsubscribers.forEach((unsub) => unsub())
    this.channelManagerUnsubscribers.length = 0

    this.logger.info('All IPC handlers unregistered')
  }

  // ============ Handler Implementations ============

  /**
   * Handle get-status request
   *
   * Returns current remote control status including enabled state,
   * confirmation requirement, and connected channels.
   *
   * @param _event - IPC event (unused)
   * @param _request - Request payload (unused)
   * @returns Status response
   */
  private async handleGetStatus(
    _event: IpcMainInvokeEvent,
    _request: GetStatusRequest
  ): Promise<IpcResult<GetStatusResponse>> {
    this.logger.debug('Handling get-status request')

    try {
      // Ensure dependencies are set
      if (!this.channelManager || !this.storage) {
        return this.createError(
          IpcErrorCode.NOT_INITIALIZED,
          'Remote control handler not initialized'
        )
      }

      // Get status from channel manager
      const status = await this.channelManager.getStatus()

      return this.createSuccess<GetStatusResponse>({
        status,
      })
    } catch (error) {
      this.logger.error('Failed to get status:', error)
      return this.createErrorFromUnknown(
        IpcErrorCode.OPERATION_FAILED,
        'Failed to get remote control status',
        error
      )
    }
  }

  /**
   * Handle connect request
   *
   * Creates a new channel and initiates connection, returning QR code.
   *
   * @param _event - IPC event (unused)
   * @param request - Connect request with channel type
   * @returns Connect response with QR code and channel ID
   */
  private async handleConnect(
    _event: IpcMainInvokeEvent,
    request: ConnectRequest
  ): Promise<IpcResult<ConnectResponse>> {
    this.logger.debug('Handling connect request:', request?.channelType)

    try {
      // Validate request
      if (!request || !request.channelType) {
        return this.createError(
          IpcErrorCode.INVALID_REQUEST,
          'Channel type is required'
        )
      }

      // Ensure dependencies are set
      if (!this.channelManager) {
        return this.createError(
          IpcErrorCode.NOT_INITIALIZED,
          'Remote control handler not initialized'
        )
      }

      // Check if channel type is supported
      if (!this.channelManager.isChannelTypeSupported(request.channelType)) {
        return this.createError(
          IpcErrorCode.INVALID_REQUEST,
          `Unsupported channel type: ${request.channelType}`
        )
      }

      // Add new channel
      const channel = await this.channelManager.addChannel(request.channelType)
      this.logger.info(`Created channel: ${channel.id} (${channel.type})`)

      // Connect and get QR code
      const { qrCode } = await this.channelManager.connectChannel(channel.id)
      this.logger.info(`Generated QR code for channel: ${channel.id}`)

      return this.createSuccess<ConnectResponse>({
        qrCode,
        channelId: channel.id,
      })
    } catch (error) {
      this.logger.error('Failed to connect:', error)

      // Map specific errors
      if (this.isChannelLimitError(error)) {
        return this.createError(
          IpcErrorCode.CHANNEL_LIMIT_EXCEEDED,
          'Maximum number of channels (3) reached. Please disconnect a channel first.'
        )
      }

      if (this.isAdapterCreationError(error)) {
        return this.createError(
          IpcErrorCode.ADAPTER_CREATION_FAILED,
          error.message
        )
      }

      return this.createErrorFromUnknown(
        IpcErrorCode.OPERATION_FAILED,
        'Failed to initiate connection',
        error
      )
    }
  }

  /**
   * Handle disconnect request
   *
   * Disconnects and removes the specified channel.
   *
   * @param _event - IPC event (unused)
   * @param request - Disconnect request with channel ID
   * @returns Disconnect response with success status
   */
  private async handleDisconnect(
    _event: IpcMainInvokeEvent,
    request: DisconnectRequest
  ): Promise<IpcResult<DisconnectResponse>> {
    this.logger.debug('Handling disconnect request:', request?.channelId)

    try {
      // Validate request
      if (!request || !request.channelId) {
        return this.createError(
          IpcErrorCode.INVALID_REQUEST,
          'Channel ID is required'
        )
      }

      // Ensure dependencies are set
      if (!this.channelManager) {
        return this.createError(
          IpcErrorCode.NOT_INITIALIZED,
          'Remote control handler not initialized'
        )
      }

      // Check if channel exists
      const channel = this.channelManager.getChannel(request.channelId)
      if (!channel) {
        return this.createError(
          IpcErrorCode.CHANNEL_NOT_FOUND,
          `Channel not found: ${request.channelId}`
        )
      }

      // Remove channel (this also disconnects it)
      await this.channelManager.removeChannel(request.channelId)
      this.logger.info(`Removed channel: ${request.channelId}`)

      return this.createSuccess<DisconnectResponse>({
        success: true,
      })
    } catch (error) {
      this.logger.error('Failed to disconnect:', error)

      if (this.isChannelNotFoundError(error)) {
        return this.createError(
          IpcErrorCode.CHANNEL_NOT_FOUND,
          `Channel not found: ${request?.channelId}`
        )
      }

      return this.createErrorFromUnknown(
        IpcErrorCode.OPERATION_FAILED,
        'Failed to disconnect channel',
        error
      )
    }
  }

  /**
   * Handle list-channels request
   *
   * Returns list of all connected channels.
   *
   * @param _event - IPC event (unused)
   * @param _request - Request payload (unused)
   * @returns List channels response with channel array
   */
  private async handleListChannels(
    _event: IpcMainInvokeEvent,
    _request: ListChannelsRequest
  ): Promise<IpcResult<ListChannelsResponse>> {
    this.logger.debug('Handling list-channels request')

    try {
      // Ensure dependencies are set
      if (!this.channelManager) {
        return this.createError(
          IpcErrorCode.NOT_INITIALIZED,
          'Remote control handler not initialized'
        )
      }

      // Get all channels
      const channels = this.channelManager.getChannels()
      this.logger.debug(`Found ${channels.length} channels`)

      return this.createSuccess<ListChannelsResponse>({
        channels,
      })
    } catch (error) {
      this.logger.error('Failed to list channels:', error)
      return this.createErrorFromUnknown(
        IpcErrorCode.OPERATION_FAILED,
        'Failed to list channels',
        error
      )
    }
  }

  /**
   * Handle update-settings request
   *
   * Updates remote control security settings.
   *
   * @param _event - IPC event (unused)
   * @param request - Update settings request
   * @returns Update settings response with success status
   */
  private async handleUpdateSettings(
    _event: IpcMainInvokeEvent,
    request: UpdateSettingsRequest
  ): Promise<IpcResult<UpdateSettingsResponse>> {
    this.logger.debug('Handling update-settings request:', request)

    try {
      // Validate request
      if (request === undefined || request === null) {
        return this.createError(
          IpcErrorCode.INVALID_REQUEST,
          'Request body is required'
        )
      }

      if (typeof request.requireConfirm !== 'boolean') {
        return this.createError(
          IpcErrorCode.INVALID_REQUEST,
          'requireConfirm must be a boolean'
        )
      }

      // Ensure dependencies are set
      if (!this.storage) {
        return this.createError(
          IpcErrorCode.NOT_INITIALIZED,
          'Remote control handler not initialized'
        )
      }

      // Update settings
      await this.storage.updateSettings({
        requireConfirm: request.requireConfirm,
      })
      this.logger.info(`Updated settings: requireConfirm=${request.requireConfirm}`)

      return this.createSuccess<UpdateSettingsResponse>({
        success: true,
      })
    } catch (error) {
      this.logger.error('Failed to update settings:', error)
      return this.createErrorFromUnknown(
        IpcErrorCode.OPERATION_FAILED,
        'Failed to update settings',
        error
      )
    }
  }

  // ============ Helper Methods ============

  /**
   * Register a handler with ipcMain
   *
   * @param channel - Channel name
   * @param handler - Handler function
   */
  private registerHandler<TRequest, TResponse>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, request: TRequest) => Promise<IpcResult<TResponse>>
  ): void {
    // Wrap handler to return error response on exception
    const wrappedHandler = async (
      event: IpcMainInvokeEvent,
      request: TRequest
    ): Promise<IpcResult<TResponse>> => {
      try {
        return await handler(event, request)
      } catch (error) {
        this.logger.error(`Unhandled error in ${channel}:`, error)
        return this.createErrorFromUnknown(
          IpcErrorCode.OPERATION_FAILED,
          'An unexpected error occurred',
          error
        )
      }
    }

    ipcMain.handle(channel, wrappedHandler)
    this.registeredChannels.push(channel)
    this.logger.debug(`Registered handler: ${channel}`)
  }

  /**
   * Create a success response
   *
   * @param data - Response data
   * @returns Success result
   */
  private createSuccess<T>(data: T): IpcResult<T> {
    return { success: true, data }
  }

  /**
   * Create an error response
   *
   * @param code - Error code
   * @param message - Error message
   * @param details - Optional details
   * @returns Error result
   */
  private createError<T>(
    code: IpcErrorCode,
    message: string,
    details?: unknown
  ): IpcResult<T> {
    return {
      success: false,
      error: {
        code,
        message,
        details,
      },
    }
  }

  /**
   * Create an error response from unknown error
   *
   * @param code - Error code
   * @param defaultMessage - Default message if error is not an Error
   * @param error - Unknown error
   * @returns Error result
   */
  private createErrorFromUnknown<T>(
    code: IpcErrorCode,
    defaultMessage: string,
    error: unknown
  ): IpcResult<T> {
    const message = error instanceof Error ? error.message : defaultMessage
    const details = error instanceof Error ? error.stack : undefined
    return this.createError(code, message, details)
  }

  /**
   * Check if error is a channel limit error
   *
   * @param error - Error to check
   * @returns Whether error is a channel limit error
   */
  private isChannelLimitError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Maximum channel limit')
  }

  /**
   * Check if error is a channel not found error
   *
   * @param error - Error to check
   * @returns Whether error is a channel not found error
   */
  private isChannelNotFoundError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Channel not found')
  }

  /**
   * Check if error is an adapter creation error
   *
   * @param error - Error to check
   * @returns Whether error is an adapter creation error
   */
  private isAdapterCreationError(error: unknown): error is Error {
    return (
      error instanceof Error &&
      (error.message.includes('Failed to create adapter') ||
        error.message.includes('adapter not yet implemented'))
    )
  }
}

// ============ Factory Function ============

/**
 * Create a RemoteControlHandler instance
 *
 * @returns New RemoteControlHandler instance
 *
 * @example
 * ```typescript
 * const handler = createRemoteControlHandler();
 * handler.setChannelManager(manager);
 * handler.setStorage(storage);
 * handler.register();
 * ```
 */
export function createRemoteControlHandler(): RemoteControlHandler {
  return new RemoteControlHandlerImpl()
}

// ============ Default Export ============

export default RemoteControlHandlerImpl
