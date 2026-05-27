/**
 * IPC Channel Definitions for Remote Control Feature
 *
 * Defines all IPC channels and their request/response types for
 * communication between renderer and main process.
 *
 * @module shared/ipc/remote-control-channels
 * @see Product-Spec.md Section 6.1
 */

import type {
  Channel,
  ChannelType,
  RemoteControlStatus,
} from '../types/remote-control'

// ============ IPC Channel Names ============

/**
 * IPC channel name constants for remote control communication
 * Used for renderer-main process communication via Electron IPC
 */
export const IPC_CHANNELS = {
  /** Get remote control status - renderer -> main */
  GET_STATUS: 'remote-control:get-status',
  /** Connect a new channel - renderer -> main */
  CONNECT: 'remote-control:connect',
  /** Disconnect a channel - renderer -> main */
  DISCONNECT: 'remote-control:disconnect',
  /** List connected channels - renderer -> main */
  LIST_CHANNELS: 'remote-control:list-channels',
  /** Update remote control settings - renderer -> main */
  UPDATE_SETTINGS: 'remote-control:update-settings',
} as const

// ============ IPC Push Event Types ============

/**
 * Event data for channel status change events
 * Emitted when a channel connects or disconnects
 */
export interface ChannelStatusChangeEvent {
  /** Channel ID */
  channelId: string
  /** New status: 'connected' or 'disconnected' */
  status: 'connected' | 'disconnected' | 'pending'
  /** User ID (only present when status is 'connected') */
  userId?: string
  /** User nickname (only present when status is 'connected') */
  nickname?: string
}

/**
 * Event data for message received events
 * Emitted when a message is received from a remote channel
 */
export interface MessageReceivedEvent {
  /** Channel ID */
  channelId: string
  /** Message data */
  message: {
    /** Message ID */
    messageId: string
    /** Message content */
    content: string
    /** Sender user ID */
    userId: string
    /** Timestamp (ISO string) */
    timestamp: string
    /** Message type */
    type?: 'text' | 'image' | 'voice'
  }
}

/**
 * Event data for confirmation request events
 * Emitted when a sensitive operation requires user confirmation
 */
export interface ConfirmRequestEvent {
  /** Confirmation ID for tracking */
  confirmId: string
  /** Confirmation message to display */
  message: string
  /** Channel ID where the request originated */
  channelId: string
  /** Timestamp (ISO string) */
  timestamp: string
}

/**
 * Event data for confirmation response events
 * Emitted when a user responds to a confirmation request
 */
export interface ConfirmResponseEvent {
  /** Confirmation ID */
  confirmId: string
  /** Whether the user confirmed */
  confirmed: boolean
  /** Channel ID where the response came from */
  channelId: string
}

/**
 * Type for IPC channel names
 */
export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

// ============ Get Status Channel ============

/**
 * Request type for get-status channel
 * No parameters required
 */
export interface GetStatusRequest {
  // No parameters
}

/**
 * Response type for get-status channel
 * Returns current remote control status
 */
export interface GetStatusResponse {
  /** Current remote control status */
  status: RemoteControlStatus
}

// ============ Connect Channel ============

/**
 * Request type for connect channel
 * Initiates connection to a new remote control channel
 */
export interface ConnectRequest {
  /** Type of channel to connect (wechat, wecom, feishu) */
  channelType: ChannelType
}

/**
 * Response type for connect channel
 * Returns QR code for user to scan
 */
export interface ConnectResponse {
  /** QR code data URL for scanning */
  qrCode: string
  /** Unique channel ID assigned to this connection attempt */
  channelId: string
}

// ============ Disconnect Channel ============

/**
 * Request type for disconnect channel
 * Disconnects an existing remote control channel
 */
export interface DisconnectRequest {
  /** ID of the channel to disconnect */
  channelId: string
}

/**
 * Response type for disconnect channel
 * Returns success status
 */
export interface DisconnectResponse {
  /** Whether the disconnect operation succeeded */
  success: boolean
}

// ============ List Channels ============

/**
 * Request type for list-channels channel
 * No parameters required
 */
export interface ListChannelsRequest {
  // No parameters
}

/**
 * Response type for list-channels channel
 * Returns list of connected channels
 */
export interface ListChannelsResponse {
  /** List of all connected channels */
  channels: Channel[]
}

// ============ Update Settings ============

/**
 * Request type for update-settings channel
 * Updates remote control security settings
 */
export interface UpdateSettingsRequest {
  /** Whether important operations require confirmation on mobile */
  requireConfirm: boolean
}

/**
 * Response type for update-settings channel
 * Returns success status
 */
export interface UpdateSettingsResponse {
  /** Whether the update operation succeeded */
  success: boolean
}

// ============ Type-safe IPC Handler Types ============

/**
 * Generic IPC handler function type
 */
export type IpcHandler<TRequest, TResponse> = (
  request: TRequest
) => Promise<TResponse> | TResponse

/**
 * Handler type for get-status channel
 */
export type GetStatusHandler = IpcHandler<GetStatusRequest, GetStatusResponse>

/**
 * Handler type for connect channel
 */
export type ConnectHandler = IpcHandler<ConnectRequest, ConnectResponse>

/**
 * Handler type for disconnect channel
 */
export type DisconnectHandler = IpcHandler<DisconnectRequest, DisconnectResponse>

/**
 * Handler type for list-channels channel
 */
export type ListChannelsHandler = IpcHandler<
  ListChannelsRequest,
  ListChannelsResponse
>

/**
 * Handler type for update-settings channel
 */
export type UpdateSettingsHandler = IpcHandler<
  UpdateSettingsRequest,
  UpdateSettingsResponse
>

// ============ Channel Map Type ============

/**
 * Map of all IPC channels to their request/response types
 * Provides type safety for IPC communication
 */
export interface IpcChannelMap {
  [IPC_CHANNELS.GET_STATUS]: {
    request: GetStatusRequest
    response: GetStatusResponse
  }
  [IPC_CHANNELS.CONNECT]: {
    request: ConnectRequest
    response: ConnectResponse
  }
  [IPC_CHANNELS.DISCONNECT]: {
    request: DisconnectRequest
    response: DisconnectResponse
  }
  [IPC_CHANNELS.LIST_CHANNELS]: {
    request: ListChannelsRequest
    response: ListChannelsResponse
  }
  [IPC_CHANNELS.UPDATE_SETTINGS]: {
    request: UpdateSettingsRequest
    response: UpdateSettingsResponse
  }
}

// ============ Re-export Types from remote-control.ts ============

// Re-export commonly used types for convenience
export type {
  Channel,
  ChannelType,
  ChannelStatus,
  RemoteControlStatus,
  RemoteControlSettings,
} from '../types/remote-control'
