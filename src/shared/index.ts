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

// IPC constants (from types.ts - general channels)
export {
  IPC_CHANNELS,
  type IpcChannelType
} from './types'

// Remote Control types
export type {
  ConnectionStatus,
  ConnectionInfo,
  RemoteControlSettings,
  RemoteControlStatus,
  OperationResult,
  PermissionConfig,
  ConnectionChangeEvent,
  MessageReceivedEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
  SwitchProjectEvent,
} from './types/remote-control'

// Remote Control constants (rename to avoid conflict)
export {
  PERMISSIONS,
  IPC_CHANNELS as REMOTE_CONTROL_IPC_CHANNELS,
  IPC_PUSH_CHANNELS as REMOTE_CONTROL_IPC_PUSH_CHANNELS,
  REMOTE_CONTROL_CONSTRAINTS
} from './types/remote-control'

// IPC Channel definitions for Remote Control
export {
  type IpcChannelName as RemoteControlIpcChannelName,
  type GetStatusRequest,
  type GetStatusResponse,
  type ConnectRequest,
  type ConnectResponse,
  type DisconnectRequest,
  type DisconnectResponse,
  type UpdateSettingsRequest,
  type UpdateSettingsResponse,
} from './ipc/remote-control-channels'
