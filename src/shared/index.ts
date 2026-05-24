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
