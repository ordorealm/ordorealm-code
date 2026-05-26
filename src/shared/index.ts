/**
 * Shared types module entry point
 * Re-exports all types for convenient importing
 * @module shared
 */

// Message types
export type {
  MessageRole,
  BaseMessage,
  UserMessage,
  AssistantMessage,
  ToolUseMessage,
  ToolResultMessage,
  SystemMessage,
  ConversationMessage,
  MessageGroup,
  FileChange
} from './types'

// Type guards
export {
  isUserMessage,
  isAssistantMessage,
  isToolUseMessage,
  isToolResultMessage,
  isSystemMessage
} from './types'

// Message factory functions
export {
  createUserMessage,
  createAssistantMessage,
  createToolUseMessage,
  createToolResultMessage,
  createActivityState
} from './types'

// Runtime validation
export {
  isValidMessage,
  isValidAdapterEvent
} from './types'

// Adapter types
export type {
  AdapterType,
  ProviderEventType,
  ProviderEvent,
  AdapterSessionConfig,
  AdapterSession,
  AdapterEventType,
  SessionState,
  ActivityState,
  ErrorInfo,
  AdapterEvent,
  SessionOptions,
  AdapterConfig,
  AgentAdapter,
  AdapterFactory,
  AdapterMetadata
} from './types'

// IPC event types
export type {
  IpcChannel,
  ConversationMessagePayload,
  ActivityPayload,
  StateChangePayload,
  ErrorPayload,
  SessionEventPayload,
  IpcEventPayload,
  IpcEventMap,
  IpcEventListener
} from './types'

// Tool types
export type {
  PermissionRequest,
  PermissionResponse,
  InteractiveQuestion,
  InteractiveQuestionResponse,
  PlanForApproval,
  PlanApprovalResponse
} from './types'

// Session types
export type {
  SessionInitData,
  SessionInfo
} from './types'

// IPC constants
export {
  IPC_CHANNELS,
  type IpcChannelType
} from './types'

// Remote Control types
export type {
  ChannelType,
  ChannelStatus,
  Channel,
  RemoteControlSettings,
  RemoteControlStatus,
  ChannelAdapter,
  AgentContext,
  OperationResult,
  MasterAgent,
  PermissionConfig,
  CommandType,
  ParsedCommand,
  CommandHandler,
  ConnectChannelRequest,
  ConnectChannelResponse,
  DisconnectChannelRequest,
  DisconnectChannelResponse,
  UpdateSettingsRequest,
  UpdateSettingsResponse,
  RemoteControlIpcChannelType,
  IncomingRemoteMessage,
  OutgoingRemoteMessage,
  ConfirmationRequest,
  ConfirmationResponse
} from './types/remote-control'

// Remote Control constants
export {
  PERMISSIONS,
  REMOTE_CONTROL_IPC_CHANNELS,
  REMOTE_CONTROL_CONSTRAINTS
} from './types/remote-control'
