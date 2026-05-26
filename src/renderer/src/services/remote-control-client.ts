/**
 * Remote Control IPC Client
 *
 * Provides type-safe IPC client for renderer process to communicate
 * with main process for remote control functionality.
 *
 * Implements all 5 IPC methods:
 * - getStatus: Get remote control status
 * - connect: Initiate connection and return QR code
 * - disconnect: Disconnect a channel
 * - listChannels: Get connected channels list
 * - updateSettings: Update security settings
 *
 * @module renderer/services/remote-control-client
 * @see Product-Spec.md Section 6.1
 */

import { ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  GetStatusResponse,
  ConnectResponse,
  Channel,
  ChannelType,
} from '../../../shared/ipc/remote-control-channels'

// ============ Error Types ============

/**
 * Error codes for IPC client errors
 */
export enum IpcClientErrorCode {
  /** IPC call failed */
  IPC_FAILED = 'IPC_FAILED',
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
 * IPC client error class
 */
export class IpcClientError extends Error {
  constructor(
    public readonly code: IpcClientErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'IpcClientError'
  }
}

// ============ IPC Response Types ============

/**
 * IPC result type from main process
 */
type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: unknown } }

// ============ Client Interface ============

/**
 * Remote Control IPC Client interface
 */
export interface RemoteControlClient {
  /** Get remote control status */
  getStatus(): Promise<GetStatusResponse>

  /** Initiate connection and return QR code */
  connect(channelType: ChannelType): Promise<ConnectResponse>

  /** Disconnect a channel */
  disconnect(channelId: string): Promise<boolean>

  /** Get connected channels list */
  listChannels(): Promise<Channel[]>

  /** Update security settings */
  updateSettings(requireConfirm: boolean): Promise<boolean>
}

// ============ Implementation ============

/**
 * Remote Control IPC Client Implementation
 *
 * Provides type-safe IPC communication for remote control feature.
 * Uses Electron's ipcRenderer.invoke() for async communication.
 *
 * @example
 * ```typescript
 * const client = RemoteControlClientImpl.getInstance();
 *
 * // Get status
 * const { status } = await client.getStatus();
 *
 * // Connect new channel
 * const { qrCode, channelId } = await client.connect('wechat');
 *
 * // Disconnect
 * await client.disconnect(channelId);
 * ```
 */
class RemoteControlClientImpl implements RemoteControlClient {
  /** Singleton instance */
  private static instance: RemoteControlClientImpl | null = null

  /** Private constructor for singleton pattern */
  private constructor() {}

  /**
   * Get singleton instance
   *
   * @returns RemoteControlClient instance
   */
  static getInstance(): RemoteControlClientImpl {
    if (!RemoteControlClientImpl.instance) {
      RemoteControlClientImpl.instance = new RemoteControlClientImpl()
    }
    return RemoteControlClientImpl.instance
  }

  /**
   * Get remote control status
   *
   * Returns current remote control status including enabled state,
   * confirmation requirement, and connected channels.
   *
   * @returns Promise resolving to status response
   * @throws IpcClientError if IPC call fails
   */
  async getStatus(): Promise<GetStatusResponse> {
    const result = await this.invoke<GetStatusResponse>(
      IPC_CHANNELS.GET_STATUS,
      {}
    )
    return result
  }

  /**
   * Initiate connection to a new channel
   *
   * Creates a new channel and initiates connection, returning QR code
   * for user to scan with their mobile app.
   *
   * @param channelType - Type of channel to connect (wechat, wecom, feishu)
   * @returns Promise resolving to connect response with QR code and channel ID
   * @throws IpcClientError if IPC call fails or channel limit exceeded
   */
  async connect(channelType: ChannelType): Promise<ConnectResponse> {
    const result = await this.invoke<ConnectResponse>(
      IPC_CHANNELS.CONNECT,
      { channelType }
    )
    return result
  }

  /**
   * Disconnect a channel
   *
   * Disconnects and removes the specified channel.
   *
   * @param channelId - ID of the channel to disconnect
   * @returns Promise resolving to true if successful
   * @throws IpcClientError if IPC call fails or channel not found
   */
  async disconnect(channelId: string): Promise<boolean> {
    await this.invoke<{ success: boolean }>(
      IPC_CHANNELS.DISCONNECT,
      { channelId }
    )
    return true
  }

  /**
   * Get list of connected channels
   *
   * Returns all currently connected channels.
   *
   * @returns Promise resolving to array of channels
   * @throws IpcClientError if IPC call fails
   */
  async listChannels(): Promise<Channel[]> {
    const result = await this.invoke<{ channels: Channel[] }>(
      IPC_CHANNELS.LIST_CHANNELS,
      {}
    )
    return result.channels
  }

  /**
   * Update remote control settings
   *
   * Updates security settings for remote control.
   *
   * @param requireConfirm - Whether important operations require confirmation
   * @returns Promise resolving to true if successful
   * @throws IpcClientError if IPC call fails
   */
  async updateSettings(requireConfirm: boolean): Promise<boolean> {
    await this.invoke<{ success: boolean }>(
      IPC_CHANNELS.UPDATE_SETTINGS,
      { requireConfirm }
    )
    return true
  }

  // ============ Private Helper Methods ============

  /**
   * Invoke IPC channel with type safety
   *
   * @param channel - IPC channel name
   * @param request - Request payload
   * @returns Promise resolving to response data
   * @throws IpcClientError if IPC call fails
   */
  private async invoke<T>(channel: string, request: unknown): Promise<T> {
    try {
      const result: IpcResult<T> = await ipcRenderer.invoke(channel, request)

      if (result.success) {
        return result.data
      }

      // Handle error response
      throw this.createErrorFromResponse(result.error)
    } catch (error) {
      // Re-throw IpcClientError
      if (error instanceof IpcClientError) {
        throw error
      }

      // Handle unexpected errors
      throw new IpcClientError(
        IpcClientErrorCode.IPC_FAILED,
        error instanceof Error ? error.message : 'IPC call failed',
        error
      )
    }
  }

  /**
   * Create IpcClientError from error response
   *
   * @param error - Error response from main process
   * @returns IpcClientError instance
   */
  private createErrorFromResponse(error: {
    code: string
    message: string
    details?: unknown
  }): IpcClientError {
    // Map main process error codes to client error codes
    const errorCode = this.mapErrorCode(error.code)
    return new IpcClientError(errorCode, error.message, error.details)
  }

  /**
   * Map main process error code to client error code
   *
   * @param code - Main process error code
   * @returns Client error code
   */
  private mapErrorCode(code: string): IpcClientErrorCode {
    switch (code) {
      case 'CHANNEL_LIMIT_EXCEEDED':
        return IpcClientErrorCode.CHANNEL_LIMIT_EXCEEDED
      case 'CHANNEL_NOT_FOUND':
        return IpcClientErrorCode.CHANNEL_NOT_FOUND
      case 'INVALID_REQUEST':
        return IpcClientErrorCode.INVALID_REQUEST
      case 'NOT_INITIALIZED':
        return IpcClientErrorCode.NOT_INITIALIZED
      case 'ADAPTER_CREATION_FAILED':
        return IpcClientErrorCode.ADAPTER_CREATION_FAILED
      case 'OPERATION_FAILED':
      default:
        return IpcClientErrorCode.OPERATION_FAILED
    }
  }
}

// ============ Factory Function ============

/**
 * Get the singleton RemoteControlClient instance
 *
 * @returns RemoteControlClient instance
 *
 * @example
 * ```typescript
 * const client = getRemoteControlClient();
 *
 * // Get status
 * const { status } = await client.getStatus();
 * console.log('Remote control enabled:', status.enabled);
 * console.log('Connected channels:', status.connectedChannels);
 *
 * // Connect new WeChat channel
 * try {
 *   const { qrCode, channelId } = await client.connect('wechat');
 *   // Display QR code for user to scan
 *   displayQRCode(qrCode);
 * } catch (error) {
 *   if (error.code === 'CHANNEL_LIMIT_EXCEEDED') {
 *     showToast('Maximum 3 channels allowed');
 *   }
 * }
 *
 * // List all channels
 * const channels = await client.listChannels();
 * channels.forEach(ch => console.log(`${ch.type}: ${ch.status}`));
 *
 * // Disconnect a channel
 * await client.disconnect(channelId);
 *
 * // Update settings
 * await client.updateSettings(true); // Require confirmation
 * ```
 */
export function getRemoteControlClient(): RemoteControlClient {
  return RemoteControlClientImpl.getInstance()
}

// ============ Default Export ============

export default RemoteControlClientImpl
