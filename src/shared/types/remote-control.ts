/**
 * Remote Control type definitions for DevFlow IDE
 * Allows users to remotely control the IDE via WeChat ClawBot, WeCom, Feishu, etc.
 * @module shared/types/remote-control
 */

// ============ Channel Types ============

/**
 * Supported channel types for remote control
 */
export type ChannelType = 'wechat' | 'wecom' | 'feishu'

/**
 * Channel connection status
 */
export type ChannelStatus = 'connected' | 'disconnected' | 'pending'

/**
 * Channel represents a connected remote control channel
 * Each channel allows remote access to the IDE
 */
export interface Channel {
  /** Channel unique identifier (UUID) */
  id: string
  /** Channel type (wechat, wecom, feishu) */
  type: ChannelType
  /** Connection status */
  status: ChannelStatus
  /** Connection timestamp (ISO8601), null if not connected */
  connectedAt: string | null
  /** User authorization token (encrypted storage) */
  authToken: string
}

/**
 * Remote control settings configuration
 */
export interface RemoteControlSettings {
  /** Whether remote control is enabled */
  enabled: boolean
  /** Whether important operations require confirmation */
  requireConfirm: boolean
  /** List of connected channels */
  channels: Channel[]
}

/**
 * Remote control status for IPC communication
 */
export interface RemoteControlStatus {
  /** Whether remote control is enabled */
  enabled: boolean
  /** Number of connected channels */
  connectedChannels: number
  /**
   * List of channels with their status
   * @note authToken is NOT included for security reasons; use dedicated token APIs instead
   */
  channels: Array<{
    id: string
    type: ChannelType
    status: ChannelStatus
    connectedAt: string | null
  }>
}

// ============ Channel Adapter Types ============

/**
 * Channel adapter interface for different remote control channels
 * Each channel type implements this interface
 */
export interface ChannelAdapter {
  /** Channel type identifier */
  readonly type: ChannelType

  /**
   * Initialize connection and return QR code for scanning
   * @returns Promise resolving to QR code data
   */
  connect(): Promise<{ qrCode: string }>

  /**
   * Disconnect the channel
   * @returns Promise resolving when disconnected
   */
  disconnect(): Promise<void>

  /**
   * Send a message to the remote user
   * @param message - Message content to send
   */
  sendMessage(message: string): Promise<void>

  /**
   * Register callback for incoming messages
   * @param callback - Function to call when message is received
   */
  onMessage(callback: (message: string) => void): void

  /**
   * Request confirmation from the remote user
   * @param message - Confirmation prompt message
   * @returns Promise resolving to user's response (true = confirmed)
   */
  requestConfirm(message: string): Promise<boolean>
}

// ============ Master Agent Types ============

/**
 * Agent context for operation execution
 * Provides session and user information
 */
export interface AgentContext {
  /** Session identifier */
  sessionId: string
  /** Project name */
  projectName: string
  /** User identifier */
  userId: string
}

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
}

/**
 * Master agent interface for handling remote control commands
 * Routes commands to appropriate handlers and enforces permissions
 */
export interface MasterAgent {
  /**
   * Handle an incoming message from remote channel
   * @param message - User message content
   * @param context - Agent context with session/user info
   * @returns Promise resolving to response message
   */
  handleMessage(message: string, context: AgentContext): Promise<string>

  /**
   * Check if an operation is permitted
   * @param operation - Operation identifier
   * @returns Whether the operation is allowed
   */
  checkPermission(operation: string): boolean

  /**
   * Execute an operation with given parameters
   * @param operation - Operation identifier
   * @param params - Operation parameters
   * @returns Promise resolving to operation result
   */
  executeOperation(operation: string, params: unknown): Promise<OperationResult>
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
  ],
  deny: [
    'delete_project',
    'reset_session',
  ]
} as const

// ============ Command Types ============

/**
 * Command type identifiers for remote control
 */
export type CommandType =
  | 'status'
  | 'switch'
  | 'restart'
  | 'mcp_status'
  | 'mcp_start'
  | 'mcp_stop'
  | 'skillgroup_list'
  | 'skillgroup_switch'
  | 'help'

/**
 * Parsed command from user message
 */
export interface ParsedCommand {
  /** Command type */
  type: CommandType
  /** Command parameters */
  params: Record<string, string>
  /** Original message text */
  raw: string
}

/**
 * Command handler function type
 */
export type CommandHandler = (
  params: Record<string, string>,
  context: AgentContext
) => Promise<OperationResult>

// ============ IPC Request/Response Types ============

/**
 * IPC request for connecting a channel
 */
export interface ConnectChannelRequest {
  /** Type of channel to connect */
  channelType: ChannelType
}

/**
 * IPC response for connecting a channel
 */
export interface ConnectChannelResponse {
  /** QR code for scanning */
  qrCode: string
  /** Channel ID for tracking */
  channelId: string
}

/**
 * IPC request for disconnecting a channel
 */
export interface DisconnectChannelRequest {
  /** Channel ID to disconnect */
  channelId: string
}

/**
 * IPC response for disconnecting a channel
 */
export interface DisconnectChannelResponse {
  /** Whether disconnect succeeded */
  success: boolean
}

/**
 * IPC request for updating settings
 */
export interface UpdateSettingsRequest {
  /** Whether to require confirmation for important operations */
  requireConfirm?: boolean
  /** Whether to enable remote control */
  enabled?: boolean
}

/**
 * IPC response for updating settings
 */
export interface UpdateSettingsResponse {
  /** Whether update succeeded */
  success: boolean
  /** Updated settings */
  settings?: RemoteControlSettings
}

// ============ IPC Channel Constants ============

/**
 * IPC channel names for remote control communication
 * Used for renderer-main process communication
 */
export const REMOTE_CONTROL_IPC_CHANNELS = {
  /** Get remote control status */
  GET_STATUS: 'remote-control:get-status' as const,
  /** Connect a new channel */
  CONNECT: 'remote-control:connect' as const,
  /** Disconnect a channel */
  DISCONNECT: 'remote-control:disconnect' as const,
  /** List connected channels */
  LIST_CHANNELS: 'remote-control:list-channels' as const,
  /** Update remote control settings */
  UPDATE_SETTINGS: 'remote-control:update-settings' as const,
  /** Incoming message from remote channel */
  INCOMING_MESSAGE: 'remote-control:incoming-message' as const,
  /** Confirmation response from remote channel */
  CONFIRMATION_RESPONSE: 'remote-control:confirmation-response' as const,
} as const

/**
 * Type for remote control IPC channel names
 */
export type RemoteControlIpcChannelType = typeof REMOTE_CONTROL_IPC_CHANNELS[keyof typeof REMOTE_CONTROL_IPC_CHANNELS]

// ============ Message Types ============

/**
 * Incoming message from remote channel
 */
export interface IncomingRemoteMessage {
  /** Channel ID that received the message */
  channelId: string
  /** User ID who sent the message */
  userId: string
  /** Message content */
  content: string
  /** Message timestamp */
  timestamp: string
}

/**
 * Outgoing message to remote channel
 */
export interface OutgoingRemoteMessage {
  /** Channel ID to send to */
  channelId: string
  /** Message content */
  content: string
  /** Message type */
  type: 'text' | 'confirm_request'
  /** Confirmation ID if type is confirm_request */
  confirmId?: string
}

/**
 * Confirmation request sent to remote channel
 */
export interface ConfirmationRequest {
  /** Confirmation request ID */
  confirmId: string
  /** Channel ID */
  channelId: string
  /** Confirmation prompt message */
  message: string
  /** Operation to execute if confirmed */
  operation: string
  /** Operation parameters */
  params: unknown
  /** Request timestamp */
  timestamp: string
  /** Timeout in milliseconds */
  timeout: number
}

/**
 * Confirmation response from remote channel
 */
export interface ConfirmationResponse {
  /** Confirmation request ID */
  confirmId: string
  /** Whether confirmed */
  confirmed: boolean
  /** Response timestamp */
  timestamp: string
}

// ============ Renderer API Types ============

/**
 * Remote control API interface for renderer process
 * Provides type-safe access to IPC remote control APIs
 */
export interface RemoteControlApi {
  /** Get current remote control status */
  getStatus(): Promise<RemoteControlStatus>
  /** Connect a new channel */
  connect(channelType: ChannelType): Promise<{ qrCode: string; channelId: string }>
  /** Disconnect a channel */
  disconnect(channelId: string): Promise<{ success: boolean }>
  /** Update remote control settings */
  updateSettings(partial: Partial<RemoteControlSettings>): Promise<{ success: boolean }>
  /** Subscribe to status changes (optional) */
  onStatusChange?(callback: (status: RemoteControlStatus) => void): () => void
  /** Subscribe to channel status changes (optional) */
  onChannelStatusChange?(callback: (event: { channelId: string; status: ChannelStatus }) => void): () => void
}

// ============ Constraints ============

/**
 * Remote control constraints and limits
 */
export const REMOTE_CONTROL_CONSTRAINTS = {
  /** Maximum number of simultaneous channel connections */
  MAX_CHANNELS: 3,
  /** Maximum message response delay in milliseconds */
  MAX_RESPONSE_DELAY_MS: 3000,
  /** QR code scan timeout in milliseconds */
  SCAN_TIMEOUT_MS: 60000,
  /** Confirmation timeout in milliseconds */
  CONFIRM_TIMEOUT_MS: 30000,
} as const
