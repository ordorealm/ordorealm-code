/**
 * Remote Control type definitions for DevFlow IDE
 *
 * 简化为单账号模式：一个应用只支持一个微信账号连接
 *
 * @module shared/types/remote-control
 */

// ============ Connection Status ============

/**
 * Connection status for the single account
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'pending' | 'error'

/**
 * Connection information for the logged-in account
 */
export interface ConnectionInfo {
  /** Whether there is an active connection */
  status: ConnectionStatus
  /** User ID (WeChat openId or unionId) */
  userId: string | null
  /** User nickname */
  nickname: string | null
  /** Connection timestamp (ISO8601), null if not connected */
  connectedAt: string | null
  /** Last error message if status is 'error' */
  error: string | null
}

/**
 * Remote control settings configuration
 * Simplified for single account mode
 */
export interface RemoteControlSettings {
  /** Whether remote control is enabled */
  enabled: boolean
  /** Whether important operations require confirmation */
  requireConfirm: boolean
  /** Connection information (null if never connected) */
  connection: ConnectionInfo | null
}

/**
 * Remote control status for IPC communication
 */
export interface RemoteControlStatus {
  /** Whether remote control is enabled */
  enabled: boolean
  /** Whether important operations require confirmation */
  requireConfirm: boolean
  /** Connection status */
  connected: boolean
  /** Connection information */
  connection: ConnectionInfo | null
}

// ============ Operation Result ============

/**
 * Result of an operation execution
 */
export interface OperationResult {
  /** Whether the operation succeeded */
  success: boolean
  /** Human-readable result message */
  message: string
  /** Optional operation data */
  data?: unknown
  /** Whether this operation requires user confirmation */
  requiresConfirm?: boolean
  /** Confirmation request ID (if requiresConfirm is true) */
  confirmId?: string
}

// ============ Permission Types ============

/**
 * Permission configuration for remote control operations
 * Defines which operations are allowed or denied
 */
export interface PermissionConfig {
  /** List of allowed operations */
  allow: string[]
  /** List of denied operations */
  deny: string[]
}

/**
 * Default permission configuration
 * Controls what remote users can do
 */
export const PERMISSIONS: PermissionConfig = {
  allow: [
    'view_status',
    'switch_project',
    'restart_session',
    'mcp_status',
    'mcp_start',
    'mcp_stop',
    'skillgroup_list',
    'skillgroup_switch',
    'chat',
  ],
  deny: [
    'delete_project',
    'reset_session',
  ]
} as const

// ============ IPC Channel Constants ============

/**
 * IPC channel names for remote control communication
 * Used for renderer-main process communication
 */
export const IPC_CHANNELS = {
  /** Get remote control status */
  GET_STATUS: 'remote-control:get-status',
  /** Connect (get QR code or restore connection) */
  CONNECT: 'remote-control:connect',
  /** Disconnect */
  DISCONNECT: 'remote-control:disconnect',
  /** Update remote control settings */
  UPDATE_SETTINGS: 'remote-control:update-settings',
} as const

// ============ Push Event Channels ============

/**
 * IPC push event channels for real-time updates to renderer
 */
export const IPC_PUSH_CHANNELS = {
  /** Connection status changed */
  CONNECTION_CHANGE: 'remote-control:connection-change',
  /** Message received from remote */
  MESSAGE_RECEIVED: 'remote-control:message-received',
  /** Confirmation request received */
  CONFIRM_REQUEST: 'remote-control:confirm-request',
  /** Confirmation response processed */
  CONFIRM_RESPONSE: 'remote-control:confirm-response',
  /** Request to switch project in the UI */
  SWITCH_PROJECT: 'remote-control:switch-project',
} as const

// ============ Event Types ============

/**
 * Connection status change event
 */
export interface ConnectionChangeEvent {
  /** New connection status */
  status: ConnectionStatus
  /** User ID if connected */
  userId?: string
  /** User nickname if connected */
  nickname?: string
  /** Error message if status is 'error' */
  error?: string
}

/**
 * Message received event
 */
export interface MessageReceivedEvent {
  /** User ID who sent the message */
  userId: string
  /** Message content */
  content: string
  /** Message timestamp */
  timestamp: string
}

/**
 * Confirmation request event
 */
export interface ConfirmRequestEvent {
  /** Confirmation ID */
  confirmId: string
  /** Confirmation prompt message */
  message: string
  /** Timestamp */
  timestamp: string
}

/**
 * Confirmation response event
 */
export interface ConfirmResponseEvent {
  /** Confirmation ID */
  confirmId: string
  /** Whether confirmed */
  confirmed: boolean
}

/**
 * Switch project event from remote control
 */
export interface SwitchProjectEvent {
  /** Project ID to switch to */
  projectId: string
  /** Project name for display */
  projectName: string
}

// ============ Constraints ============

/**
 * Remote control constraints and limits
 */
export const REMOTE_CONTROL_CONSTRAINTS = {
  /** QR code scan timeout in milliseconds */
  SCAN_TIMEOUT_MS: 60000,
  /** Confirmation timeout in milliseconds */
  CONFIRM_TIMEOUT_MS: 30000,
  /** Maximum message response delay in milliseconds */
  MAX_RESPONSE_DELAY_MS: 3000,
  /** Health check timeout in milliseconds */
  HEALTH_CHECK_TIMEOUT_MS: 5000,
  /** Connection poll interval in milliseconds */
  POLL_INTERVAL_MS: 2000,
  /** Maximum poll attempts */
  MAX_POLL_ATTEMPTS: 30,
} as const
