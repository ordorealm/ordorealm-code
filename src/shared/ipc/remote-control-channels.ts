/**
 * IPC Channel Definitions for Remote Control Feature
 *
 * 简化为单账号模式的 IPC 请求/响应类型定义。
 * 通道常量和事件类型统一从 ../types/remote-control 导入。
 *
 * @module shared/ipc/remote-control-channels
 */

import type {
  ConnectionStatus,
  ConnectionInfo,
  RemoteControlStatus,
  ConnectionChangeEvent,
  MessageReceivedEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
} from '../types/remote-control'

import {
  IPC_CHANNELS,
  IPC_PUSH_CHANNELS,
} from '../types/remote-control'

// Re-export for convenience
export {
  IPC_CHANNELS,
  IPC_PUSH_CHANNELS,
}

export type {
  ConnectionStatus,
  ConnectionInfo,
  RemoteControlStatus,
  ConnectionChangeEvent,
  MessageReceivedEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
}

// ============ Get Status ============

export interface GetStatusRequest {
  // No parameters
}

export interface GetStatusResponse {
  /** Current status */
  status: RemoteControlStatus
}

// ============ Connect ============

export interface ConnectRequest {
  // No parameters (single account mode)
}

export interface ConnectResponse {
  /** QR code URL (empty if already logged in) */
  qrCode: string
  /** Whether already logged in */
  alreadyLoggedIn: boolean
  /** User ID if already logged in */
  userId?: string
}

// ============ Disconnect ============

export interface DisconnectRequest {
  // No parameters
}

export interface DisconnectResponse {
  success: boolean
}

// ============ Update Settings ============

export interface UpdateSettingsRequest {
  enabled?: boolean
  requireConfirm?: boolean
}

export interface UpdateSettingsResponse {
  success: boolean
}

// ============ Type Exports ============

export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
