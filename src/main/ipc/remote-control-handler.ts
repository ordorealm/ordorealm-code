/**
 * Remote Control IPC Handler
 *
 * 简化为单账号模式的 IPC 处理器。
 *
 * 处理的 IPC 通道：
 * - remote-control:get-status: 获取状态
 * - remote-control:connect: 连接（获取二维码或恢复连接）
 * - remote-control:disconnect: 断开连接
 * - remote-control:update-settings: 更新设置
 *
 * 推送事件：
 * - remote-control:connection-change: 连接状态变化
 * - remote-control:message-received: 收到消息
 * - remote-control:confirm-request: 确认请求
 * - remote-control:confirm-response: 确认响应
 *
 * @module main/ipc/remote-control-handler
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import {
  IPC_CHANNELS,
  IPC_PUSH_CHANNELS,
  ConnectionStatus,
  ConnectionChangeEvent,
  MessageReceivedEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
} from '../../shared/types/remote-control'
import { RemoteControlManager, getRemoteControlManager } from '../services/remote-control-manager'
import { Logger } from '../utils/logger'

// ============ Types ============

export enum IpcErrorCode {
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  NOT_CONNECTED = 'NOT_CONNECTED',
  ALREADY_CONNECTED = 'ALREADY_CONNECTED',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  INVALID_REQUEST = 'INVALID_REQUEST',
  OPERATION_FAILED = 'OPERATION_FAILED',
}

export interface IpcErrorResponse {
  code: IpcErrorCode
  message: string
  details?: unknown
}

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: IpcErrorResponse }

// ============ Handler Interface ============

export interface RemoteControlHandler {
  setManager(manager: RemoteControlManager): void
  register(): void
  unregister(): void
  setupManagerEvents(): void
}

// ============ Main Class ============

export class RemoteControlHandlerImpl implements RemoteControlHandler {
  private manager: RemoteControlManager | null = null
  private logger: Logger
  private registeredChannels: string[] = []
  private managerUnsubscribers: Array<() => void> = []

  constructor() {
    this.logger = new Logger('RemoteControlHandler')
  }

  /**
   * Set the manager instance
   */
  setManager(manager: RemoteControlManager): void {
    this.manager = manager
    this.logger.info('Manager set')
  }

  /**
   * Register all IPC handlers
   */
  register(): void {
    this.logger.info('Registering IPC handlers...')

    // Get Status
    this.registerHandler(IPC_CHANNELS.GET_STATUS, this.handleGetStatus.bind(this))

    // Connect
    this.registerHandler(IPC_CHANNELS.CONNECT, this.handleConnect.bind(this))

    // Disconnect
    this.registerHandler(IPC_CHANNELS.DISCONNECT, this.handleDisconnect.bind(this))

    // Update Settings
    this.registerHandler(IPC_CHANNELS.UPDATE_SETTINGS, this.handleUpdateSettings.bind(this))

    this.logger.info(`Registered ${this.registeredChannels.length} handlers`)
  }

  /**
   * Unregister all handlers
   */
  unregister(): void {
    this.logger.info('Unregistering IPC handlers...')

    for (const channel of this.registeredChannels) {
      try {
        ipcMain.removeHandler(channel)
      } catch (error) {
        this.logger.warn(`Failed to unregister ${channel}:`, error)
      }
    }

    this.registeredChannels.length = 0

    // Clean up manager event listeners
    this.managerUnsubscribers.forEach((unsub) => unsub())
    this.managerUnsubscribers.length = 0

    this.logger.info('Unregistered all handlers')
  }

  /**
   * Set up manager event listeners for real-time updates
   */
  setupManagerEvents(): void {
    if (!this.manager) {
      this.logger.warn('Cannot setup events: manager not set')
      return
    }

    this.logger.info('Setting up manager event listeners...')

    // Clean up existing
    this.managerUnsubscribers.forEach((unsub) => unsub())
    this.managerUnsubscribers.length = 0

    // Connection change
    this.managerUnsubscribers.push(
      this.manager.on('connection_changed', (data: ConnectionChangeEvent) => {
        this.broadcastEvent(IPC_PUSH_CHANNELS.CONNECTION_CHANGE, data)
      })
    )

    // Message received
    this.managerUnsubscribers.push(
      this.manager.on('message', (data: MessageReceivedEvent) => {
        this.broadcastEvent(IPC_PUSH_CHANNELS.MESSAGE_RECEIVED, data)
      })
    )

    // Confirm request
    this.managerUnsubscribers.push(
      this.manager.on('confirm_request', (data: ConfirmRequestEvent) => {
        this.broadcastEvent(IPC_PUSH_CHANNELS.CONFIRM_REQUEST, data)
      })
    )

    // Confirm response
    this.managerUnsubscribers.push(
      this.manager.on('confirm_response', (data: ConfirmResponseEvent) => {
        this.broadcastEvent(IPC_PUSH_CHANNELS.CONFIRM_RESPONSE, data)
      })
    )

    this.logger.info('Manager event listeners configured')
  }

  /**
   * Broadcast event to all windows
   */
  private broadcastEvent<T>(channel: string, data: T): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send(channel, data)
    }
    this.logger.debug(`Broadcast "${channel}" to ${windows.length} windows`)
  }

  // ============ Handlers ============

  /**
   * Handle get-status request
   */
  private async handleGetStatus(): Promise<IpcResult<any>> {
    this.logger.debug('Handling get-status')

    try {
      if (!this.manager) {
        return this.createError(IpcErrorCode.NOT_INITIALIZED, 'Manager not initialized')
      }

      const status = await this.manager.getStatus()
      return this.createSuccess(status)
    } catch (error) {
      this.logger.error('Get status failed:', error)
      return this.createErrorFromUnknown(IpcErrorCode.OPERATION_FAILED, 'Failed to get status', error)
    }
  }

  /**
   * Handle connect request
   */
  private async handleConnect(): Promise<IpcResult<any>> {
    this.logger.debug('Handling connect')

    try {
      if (!this.manager) {
        return this.createError(IpcErrorCode.NOT_INITIALIZED, 'Manager not initialized')
      }

      const result = await this.manager.connect()
      return this.createSuccess(result)
    } catch (error) {
      this.logger.error('Connect failed:', error)
      return this.createErrorFromUnknown(IpcErrorCode.CONNECTION_FAILED, 'Connection failed', error)
    }
  }

  /**
   * Handle disconnect request
   */
  private async handleDisconnect(): Promise<IpcResult<any>> {
    this.logger.debug('Handling disconnect')

    try {
      if (!this.manager) {
        return this.createError(IpcErrorCode.NOT_INITIALIZED, 'Manager not initialized')
      }

      await this.manager.disconnect()
      return this.createSuccess({ success: true })
    } catch (error) {
      this.logger.error('Disconnect failed:', error)
      return this.createErrorFromUnknown(IpcErrorCode.OPERATION_FAILED, 'Disconnect failed', error)
    }
  }

  /**
   * Handle update-settings request
   */
  private async handleUpdateSettings(
    _event: IpcMainInvokeEvent,
    request: { enabled?: boolean; requireConfirm?: boolean }
  ): Promise<IpcResult<any>> {
    this.logger.debug('Handling update-settings:', request)

    try {
      if (!this.manager) {
        return this.createError(IpcErrorCode.NOT_INITIALIZED, 'Manager not initialized')
      }

      if (!request || (request.enabled === undefined && request.requireConfirm === undefined)) {
        return this.createError(IpcErrorCode.INVALID_REQUEST, 'No settings provided')
      }

      await this.manager.updateSettings(request)
      return this.createSuccess({ success: true })
    } catch (error) {
      this.logger.error('Update settings failed:', error)
      return this.createErrorFromUnknown(IpcErrorCode.OPERATION_FAILED, 'Update failed', error)
    }
  }

  // ============ Helpers ============

  private registerHandler<TRequest, TResponse>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, request: TRequest) => Promise<IpcResult<TResponse>>
  ): void {
    const wrappedHandler = async (event: IpcMainInvokeEvent, request: TRequest) => {
      try {
        return await handler(event, request)
      } catch (error) {
        this.logger.error(`Unhandled error in ${channel}:`, error)
        return this.createErrorFromUnknown(IpcErrorCode.OPERATION_FAILED, 'Unexpected error', error)
      }
    }

    ipcMain.handle(channel, wrappedHandler)
    this.registeredChannels.push(channel)
    this.logger.debug(`Registered handler: ${channel}`)
  }

  private createSuccess<T>(data: T): IpcResult<T> {
    return { success: true, data }
  }

  private createError<T>(code: IpcErrorCode, message: string, details?: unknown): IpcResult<T> {
    return { success: false, error: { code, message, details } }
  }

  private createErrorFromUnknown<T>(
    code: IpcErrorCode,
    defaultMessage: string,
    error: unknown
  ): IpcResult<T> {
    const message = error instanceof Error ? error.message : defaultMessage
    const details = error instanceof Error ? error.stack : undefined
    return this.createError(code, message, details)
  }
}

// ============ Factory ============

export function createRemoteControlHandler(): RemoteControlHandler {
  return new RemoteControlHandlerImpl()
}

export default RemoteControlHandlerImpl
