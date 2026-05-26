/**
 * Shared type definitions for DevFlow IDE
 * These types are shared between main process and renderer process
 * Following SpectrAI architecture pattern
 * @module shared/types
 */

// ============ Message Types ============

/**
 * Message role type following SpectrAI pattern
 * Each role represents a different message type in the conversation
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'

/**
 * Base message interface with common fields
 * All message types extend this interface
 */
export interface BaseMessage {
  /** Unique message identifier (UUID) */
  id: string
  /** Message role determining the message type */
  role: MessageRole
  /** Message timestamp in ISO8601 format */
  timestamp: string
  /** Associated session identifier */
  sessionId: string
}

/**
 * User message in the conversation
 * Represents a message sent by the user
 */
export interface UserMessage extends BaseMessage {
  role: 'user'
  /** User message content (markdown supported) */
  content: string
}

/**
 * Assistant message in the conversation
 * Represents a response from the AI assistant
 */
export interface AssistantMessage extends BaseMessage {
  role: 'assistant'
  /** Assistant message content (markdown supported) */
  content: string
  /** Thinking/reasoning content (for models that support extended thinking) */
  thinking?: string
  /** Whether the message is still being streamed */
  isStreaming?: boolean
  /** Whether thinking is still in progress */
  isThinking?: boolean
}

/**
 * Tool use message in the conversation
 * Represents a tool call request from the assistant
 * This is an independent message, not embedded in assistant message
 */
export interface ToolUseMessage extends BaseMessage {
  role: 'tool_use'
  /** Unique identifier for matching with corresponding tool_result */
  toolUseId: string
  /** Name of the tool being called */
  toolName: string
  /** Input parameters for the tool call */
  toolInput: Record<string, unknown>
}

/**
 * Tool result message in the conversation
 * Represents the result of a tool call
 * Matches with ToolUseMessage via toolUseId
 */
export interface ToolResultMessage extends BaseMessage {
  role: 'tool_result'
  /** ID of the corresponding tool_use message */
  toolUseId: string
  /** Name of the tool that was called */
  toolName: string
  /** Result content from the tool execution */
  toolResult: string
  /** Whether the tool execution resulted in an error */
  isError: boolean
}

/**
 * System message in the conversation
 * Represents system-level messages or instructions
 */
export interface SystemMessage extends BaseMessage {
  role: 'system'
  /** System message content */
  content: string
}

/**
 * Union type for all conversation messages
 * Use type guards to narrow down to specific message types
 */
export type ConversationMessage =
  | UserMessage
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | SystemMessage

// ============ Type Guards ============

/**
 * Type guard for UserMessage
 */
export function isUserMessage(message: ConversationMessage): message is UserMessage {
  return message.role === 'user'
}

/**
 * Type guard for AssistantMessage
 */
export function isAssistantMessage(message: ConversationMessage): message is AssistantMessage {
  return message.role === 'assistant'
}

/**
 * Type guard for ToolUseMessage
 */
export function isToolUseMessage(message: ConversationMessage): message is ToolUseMessage {
  return message.role === 'tool_use'
}

/**
 * Type guard for ToolResultMessage
 */
export function isToolResultMessage(message: ConversationMessage): message is ToolResultMessage {
  return message.role === 'tool_result'
}

/**
 * Type guard for SystemMessage
 */
export function isSystemMessage(message: ConversationMessage): message is SystemMessage {
  return message.role === 'system'
}

// ============ Message Group Types ============

/**
 * Group of related messages for display purposes
 * Groups tool_use and corresponding tool_result messages together
 */
export interface MessageGroup {
  /** Unique group identifier */
  id: string
  /** Messages in this group */
  messages: ConversationMessage[]
  /** Group type for display */
  type: 'conversation' | 'tool-operation'
  /** Whether this group is currently active (streaming or waiting for tool result) */
  isActive?: boolean
}

// ============ File Change Types ============

/**
 * File change record for displaying file modifications
 */
export interface FileChange {
  /** File path relative to project root */
  path: string
  /** Type of change */
  type: 'created' | 'modified' | 'deleted'
  /** Diff content (optional, for large files) */
  diff?: string
  /** Whether this is a new file */
  isNew?: boolean
}

// ============ Adapter Types ============

/**
 * Adapter type identifiers
 * Each adapter type corresponds to a specific AI agent SDK
 */
export type AdapterType = 'claude-sdk' | 'codex-appserver' | 'opencode-sdk'

/**
 * Provider event types for unified event flow
 * Following SpectrAI's ProviderEvent pattern
 */
export type ProviderEventType =
  | 'text_delta'          // AI text stream (incremental)
  | 'thinking'            // Thinking/reasoning content
  | 'tool_use_start'      // Tool call started
  | 'tool_use_end'        // Tool call completed (with result)
  | 'permission_request'  // Needs user confirmation
  | 'ask_user_question'   // AskUserQuestion tool, waiting for user answer
  | 'exit_plan_mode'      // ExitPlanMode tool, waiting for plan approval
  | 'turn_complete'       // One turn ended (AI stopped, waiting for user input)
  | 'session_complete'    // Session ended (process exited)
  | 'error'               // Error occurred

/**
 * Provider event for unified event flow
 * Maps directly to SpectrAI's ProviderEvent structure
 */
export interface ProviderEvent {
  type: ProviderEventType
  sessionId: string
  timestamp: string
  data: {
    /** Text content (text_delta / thinking / error) */
    text?: string
    /** Tool name (tool_use_start / tool_use_end) */
    toolName?: string
    /** Tool input parameters (tool_use_start / ask_user_question / exit_plan_mode) */
    toolInput?: Record<string, unknown>
    /** Tool execution result (tool_use_end) */
    toolResult?: string
    /** Whether tool execution failed (tool_use_end) */
    isError?: boolean
    /** Token usage (turn_complete) */
    usage?: { inputTokens: number; outputTokens: number }
    /** Exit code (session_complete) */
    exitCode?: number
    /** Permission prompt description (permission_request) */
    permissionPrompt?: string
    /** Tool call ID (links start/end) */
    toolUseId?: string
  }
}

/**
 * Adapter session configuration
 * Following SpectrAI's AdapterSessionConfig structure
 */
export interface AdapterSessionConfig {
  /** CLI command (supports absolute path) */
  command: string
  /** Working directory */
  workingDirectory: string
  /** Initial prompt (sent after session creation) */
  initialPrompt?: string
  /** Whether initial prompt is shown as user message */
  initialPromptVisibility?: 'visible' | 'hidden'
  /** Auto-accept all tool calls */
  autoAccept: boolean
  /** System prompt injection */
  systemPrompt?: string | { type: string; preset: string; append: string }
  /** Model name override */
  model?: string
  /** Maximum turns (0 = unlimited) */
  maxTurns?: number
  /** Allowed tools list (empty = all) */
  allowedTools?: string[]
  /** MCP config path */
  mcpConfigPath?: string
  /** Provider-specific arguments */
  providerArgs?: string[]
  /** Environment variable overrides */
  envOverrides?: Record<string, string>
  /** Extra MCP servers */
  extraMcpServers?: Record<string, unknown>
  /** Node.js version (for Gemini CLI needing Node 24+) */
  nodeVersion?: string
  /** Claude Code executable path */
  executablePath?: string
  /** git-bash path (Windows only) */
  gitBashPath?: string
  /** Additional directories for SDK */
  additionalDirectories?: string[]
}

/**
 * Adapter session state
 */
export interface AdapterSession {
  /** Internal session ID (SpectrAI managed) */
  sessionId: string
  /** Provider-side session ID (for resume) */
  providerSessionId?: string
  /** Current status */
  status: SessionState
  /** Conversation message history */
  messages: ConversationMessage[]
  /** Creation time */
  createdAt: string
  /** Cumulative token usage */
  totalUsage: { inputTokens: number; outputTokens: number }
}

/**
 * Adapter event types for multi-channel event system
 * Following SpectrAI's multi-channel event architecture
 */
export type AdapterEventType = 'message' | 'activity' | 'state-change' | 'error'

/**
 * Session state for state-change events
 */
export type SessionState = 'idle' | 'connecting' | 'connected' | 'streaming' | 'waiting-for-input' | 'error' | 'disconnected'

/**
 * Activity state for activity events
 * Describes what the agent is currently doing
 */
export interface ActivityState {
  /** Current activity type */
  type: 'thinking' | 'tool-use' | 'reading' | 'writing' | 'waiting' | 'idle'
  /** Human-readable description */
  description: string
  /** Timestamp of the activity */
  timestamp: string
  /** Associated tool name if applicable */
  toolName?: string
  /** Associated tool use ID if applicable */
  toolUseId?: string
}

/**
 * Error information for error events
 */
export interface ErrorInfo {
  /** Error code */
  code?: string
  /** Error message */
  message: string
  /** Error details */
  details?: unknown
  /** Whether the error is recoverable */
  recoverable?: boolean
}

/**
 * Adapter event for event-based communication
 */
export interface AdapterEvent {
  /** Event type determining the payload structure */
  type: AdapterEventType
  /** Associated session identifier */
  sessionId: string
  /** Event payload */
  payload: ConversationMessage | ActivityState | SessionState | ErrorInfo
  /** Event timestamp */
  timestamp: string
}

/**
 * Session options for starting a new session
 */
export interface SessionOptions {
  /** Working directory for the session */
  workingDirectory: string
  /** Model to use (optional, adapter-specific default if not provided) */
  model?: string
  /** Additional adapter-specific options */
  options?: Record<string, unknown>
}

/**
 * Adapter configuration for creating an adapter instance
 */
export interface AdapterConfig {
  /** API key for authentication */
  apiKey: string
  /** Base URL for API requests (optional) */
  baseUrl?: string
  /** Model identifier (optional, uses adapter default if not provided) */
  model?: string
  /** Request timeout in milliseconds (optional) */
  timeout?: number
}

/**
 * Agent adapter interface
 * Abstract interface for different AI agent implementations
 * Following SpectrAI's adapter pattern for multi-agent support
 */
export interface AgentAdapter {
  /** Provider unique identifier (e.g., 'claude-code', 'codex', 'opencode') */
  readonly providerId: string
  /** Friendly display name */
  readonly displayName: string

  /**
   * Start a new session
   * @param sessionId - Unique session identifier
   * @param config - Session configuration
   */
  startSession(sessionId: string, config: AdapterSessionConfig): Promise<void>

  /**
   * Send a user message (triggers a new turn)
   * @param sessionId - Session identifier
   * @param message - User message text
   */
  sendMessage(sessionId: string, message: string): Promise<void>

  /**
   * Respond to permission confirmation request
   * @param sessionId - Session identifier
   * @param accept - true=allow, false=deny
   */
  sendConfirmation(sessionId: string, accept: boolean): Promise<void>

  /**
   * Abort current turn (soft interrupt)
   * Session remains active, user can send new messages.
   * @param sessionId - Session identifier
   */
  abortCurrentTurn(sessionId: string): Promise<void>

  /**
   * Terminate session
   * @param sessionId - Session identifier
   */
  terminateSession(sessionId: string): Promise<void>

  /**
   * Resume a previous session
   * @param sessionId - SpectrAI internal session ID
   * @param providerSessionId - Provider-side session ID
   * @param config - Session configuration
   */
  resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void>

  /**
   * Get conversation history for a session
   * @param sessionId - Session identifier
   */
  getConversation(sessionId: string): ConversationMessage[]

  /**
   * Check if session exists and is active
   * @param sessionId - Session identifier
   */
  hasSession(sessionId: string): boolean

  /**
   * Get provider-side session ID (for resume)
   * @param sessionId - Session identifier
   */
  getProviderSessionId(sessionId: string): string | undefined

  /**
   * Subscribe to provider events
   * @param callback - Event callback function
   * @returns Unsubscribe function
   */
  onEvent(callback: (event: ProviderEvent) => void): () => void

  /**
   * Cleanup all resources (called on app exit)
   */
  cleanup(): void
}

/**
 * Adapter factory function type
 */
export type AdapterFactory = () => AgentAdapter

/**
 * Adapter metadata for registration
 */
export interface AdapterMetadata {
  /** Adapter unique identifier (matches AdapterType) */
  id: AdapterType
  /** Display name */
  name: string
  /** Description */
  description: string
  /** Supported models */
  supportedModels: string[]
  /** Default model */
  defaultModel?: string
  /** Whether API key is required */
  requiresApiKey: boolean
  /** Default base URL */
  defaultBaseUrl?: string
  /** Factory function to create adapter instance */
  factory: AdapterFactory
}

/**
 * Tool event mapping for activity display
 */
export interface ToolEventMapping {
  /** SDK tool name */
  toolName: string
  /** Activity event type */
  activityType: ActivityState['type']
  /** Extract detail from tool input */
  extractDetail?: (toolInput: Record<string, unknown>) => string
}

// ============ IPC Event Types ============

/**
 * IPC event channel names
 * Following SpectrAI's multi-channel event architecture
 */
export type IpcChannel =
  | 'conversation-message'
  | 'activity'
  | 'state-change'
  | 'error'
  | 'session-event'

/**
 * IPC event payload for conversation-message channel
 */
export interface ConversationMessagePayload {
  /** Session identifier */
  sessionId: string
  /** Conversation message */
  message: ConversationMessage
}

/**
 * IPC event payload for activity channel
 */
export interface ActivityPayload {
  /** Session identifier */
  sessionId: string
  /** Activity state */
  activity: ActivityState
}

/**
 * IPC event payload for state-change channel
 */
export interface StateChangePayload {
  /** Session identifier */
  sessionId: string
  /** Previous state */
  previousState: SessionState
  /** New state */
  newState: SessionState
}

/**
 * IPC event payload for error channel
 */
export interface ErrorPayload {
  /** Session identifier */
  sessionId: string
  /** Error information */
  error: ErrorInfo
}

/**
 * IPC event payload for session-event channel
 */
export interface SessionEventPayload {
  /** Session identifier */
  sessionId: string
  /** Event type */
  event: 'started' | 'closed' | 'reset' | 'timeout'
  /** Event data */
  data?: Record<string, unknown>
}

/**
 * Union type for all IPC event payloads
 */
export type IpcEventPayload =
  | { channel: 'conversation-message'; payload: ConversationMessagePayload }
  | { channel: 'activity'; payload: ActivityPayload }
  | { channel: 'state-change'; payload: StateChangePayload }
  | { channel: 'error'; payload: ErrorPayload }
  | { channel: 'session-event'; payload: SessionEventPayload }

/**
 * IPC event map for type-safe event handling
 */
export interface IpcEventMap {
  'conversation-message': ConversationMessagePayload
  'activity': ActivityPayload
  'state-change': StateChangePayload
  'error': ErrorPayload
  'session-event': SessionEventPayload
}

/**
 * Type-safe IPC event listener
 * Note: Electron types are only available in Electron context
 */
export type IpcEventListener<T extends IpcChannel> = (
  event: { sender: unknown; preventDefault: () => void },
  payload: IpcEventMap[T]
) => void

// ============ Message Factory Functions ============

/**
 * Generate a unique ID for messages
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Generate ISO8601 timestamp
 */
function generateTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Create a user message
 */
export function createUserMessage(
  sessionId: string,
  content: string
): UserMessage {
  return {
    id: generateId(),
    role: 'user',
    timestamp: generateTimestamp(),
    sessionId,
    content
  }
}

/**
 * Create an assistant message
 */
export function createAssistantMessage(
  sessionId: string,
  content: string,
  options?: { thinking?: string; isStreaming?: boolean }
): AssistantMessage {
  return {
    id: generateId(),
    role: 'assistant',
    timestamp: generateTimestamp(),
    sessionId,
    content,
    ...options
  }
}

/**
 * Create a tool use message
 */
export function createToolUseMessage(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ToolUseMessage {
  return {
    id: generateId(),
    role: 'tool_use',
    timestamp: generateTimestamp(),
    sessionId,
    toolUseId,
    toolName,
    toolInput
  }
}

/**
 * Create a tool result message
 */
export function createToolResultMessage(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  toolResult: string,
  isError: boolean = false
): ToolResultMessage {
  return {
    id: generateId(),
    role: 'tool_result',
    timestamp: generateTimestamp(),
    sessionId,
    toolUseId,
    toolName,
    toolResult,
    isError
  }
}

/**
 * Create an activity state
 */
export function createActivityState(
  type: ActivityState['type'],
  description: string,
  options?: { toolName?: string; toolUseId?: string }
): ActivityState {
  return {
    type,
    description,
    timestamp: generateTimestamp(),
    ...options
  }
}

// ============ Runtime Validation ============

/**
 * Validate that an object is a valid message
 * Useful for runtime type checking when parsing from JSON
 */
export function isValidMessage(obj: unknown): obj is ConversationMessage {
  if (typeof obj !== 'object' || obj === null) return false

  const msg = obj as Record<string, unknown>

  // Check required fields
  if (typeof msg['id'] !== 'string') return false
  if (typeof msg['role'] !== 'string') return false
  if (typeof msg['timestamp'] !== 'string') return false
  if (typeof msg['sessionId'] !== 'string') return false

  // Validate role
  const validRoles: MessageRole[] = ['user', 'assistant', 'system', 'tool_use', 'tool_result']
  if (!validRoles.includes(msg['role'] as MessageRole)) return false

  // Role-specific validation
  switch (msg['role']) {
    case 'user':
    case 'system':
      return typeof msg['content'] === 'string'
    case 'assistant':
      return typeof msg['content'] === 'string'
    case 'tool_use':
      return typeof msg['toolUseId'] === 'string' &&
             typeof msg['toolName'] === 'string' &&
             typeof msg['toolInput'] === 'object'
    case 'tool_result':
      return typeof msg['toolUseId'] === 'string' &&
             typeof msg['toolName'] === 'string' &&
             typeof msg['toolResult'] === 'string' &&
             typeof msg['isError'] === 'boolean'
    default:
      return false
  }
}

/**
 * Validate that an object is a valid adapter event
 */
export function isValidAdapterEvent(obj: unknown): obj is AdapterEvent {
  if (typeof obj !== 'object' || obj === null) return false

  const evt = obj as Record<string, unknown>

  const validTypes: AdapterEventType[] = ['message', 'activity', 'state-change', 'error']
  if (!validTypes.includes(evt['type'] as AdapterEventType)) return false
  if (typeof evt['sessionId'] !== 'string') return false
  if (typeof evt['timestamp'] !== 'string') return false

  return true
}

// ============ Tool Types ============

/**
 * Tool permission request
 */
export interface PermissionRequest {
  /** Tool use ID */
  toolUseId: string
  /** Tool name */
  toolName: string
  /** Permission message */
  message: string
  /** Tool input (for context) */
  input?: Record<string, unknown>
  /** Timestamp */
  timestamp: string
}

/**
 * Tool permission response
 */
export interface PermissionResponse {
  /** Tool use ID */
  toolUseId: string
  /** Whether permission was granted */
  granted: boolean
  /** Optional reason for denial */
  reason?: string
}

/**
 * Interactive question for AskUserQuestion tool
 */
export interface InteractiveQuestion {
  /** Question ID */
  questionId: string
  /** Question text */
  question: string
  /** Optional header */
  header?: string
  /** Available options */
  options?: Array<{
    label: string
    description?: string
  }>
  /** Whether multiple selection is allowed */
  multiSelect?: boolean
}

/**
 * Interactive question response
 */
export interface InteractiveQuestionResponse {
  /** Question ID */
  questionId: string
  /** Selected option(s) or text input */
  answer: string | string[]
}

/**
 * Plan for approval
 */
export interface PlanForApproval {
  /** Plan ID */
  planId: string
  /** Plan content (markdown) */
  content: string
  /** Timestamp */
  timestamp: string
}

/**
 * Plan approval response
 */
export interface PlanApprovalResponse {
  /** Plan ID */
  planId: string
  /** Whether approved */
  approved: boolean
  /** Optional feedback */
  feedback?: string
}

// ============ Session Init Types ============

/**
 * MCP server info from SDK init
 */
export interface McpServerInfo {
  /** Server name */
  name: string
  /** Connection status */
  status: string
}

/**
 * Plugin info from SDK init
 */
export interface PluginInfo {
  /** Plugin name */
  name: string
  /** Plugin path */
  path: string
}

/**
 * Session initialization data from SDK
 */
export interface SessionInitData {
  /** Model name */
  model?: string
  /** Available tools (built-in + MCP tools prefixed with mcp__) */
  tools?: string[]
  /** Connected MCP servers with status */
  mcpServers?: McpServerInfo[]
  /** Available slash commands (CLI native) */
  slashCommands?: string[]
  /** Available skills */
  skills?: string[]
  /** Loaded plugins with paths */
  plugins?: PluginInfo[]
  /** Available agents */
  agents?: string[]
  /** Project working directory */
  cwd?: string
  /** Project skill names (from .claude/skills/ directory) */
  projectSkillNames?: string[]
}

/**
 * Complete session info for IPC communication
 */
export interface SessionInfo {
  /** Session ID */
  sessionId: string
  /** Project ID */
  projectId: string
  /** Working directory */
  workingDirectory: string
  /** Session state */
  state: SessionState
  /** Init data */
  initData?: SessionInitData
  /** Created timestamp */
  createdAt: string
  /** Last active timestamp */
  lastActiveAt: string
}

// ============ IPC Channel Constants ============

/**
 * IPC channel names for type-safe communication
 * Shared between main process and preload
 */
export const IPC_CHANNELS = {
  /** Conversation message channel */
  CONVERSATION_MESSAGE: 'conversation-message' as const,
  /** Activity state channel */
  ACTIVITY: 'activity' as const,
  /** Session state change channel */
  STATE_CHANGE: 'state-change' as const,
  /** Error channel */
  ERROR: 'error' as const,
  /** Session event channel */
  SESSION_EVENT: 'session-event' as const,
  /** Legacy progress channel for backward compatibility */
  LEGACY_PROGRESS: 'claude:progress' as const,

  // MCP Manager channels
  /** MCP list request/response */
  MCP_LIST: 'mcp:list' as const,
  /** MCP instances request/response */
  MCP_INSTANCES: 'mcp:instances' as const,
  /** MCP enable request */
  MCP_ENABLE: 'mcp:enable' as const,
  /** MCP disable request */
  MCP_DISABLE: 'mcp:disable' as const,
  /** MCP start request */
  MCP_START: 'mcp:start' as const,
  /** MCP stop request */
  MCP_STOP: 'mcp:stop' as const,
  /** MCP restart request */
  MCP_RESTART: 'mcp:restart' as const,
  /** MCP stats request */
  MCP_STATS: 'mcp:stats' as const,
  /** MCP download request */
  MCP_DOWNLOAD: 'mcp:download' as const,
  /** MCP download progress event */
  MCP_DOWNLOAD_PROGRESS: 'mcp:download-progress' as const,
  /** MCP status change event */
  MCP_STATUS_CHANGE: 'mcp:status-change' as const,
  /** MCP output event */
  MCP_OUTPUT: 'mcp:output' as const,
} as const

/**
 * Type for IPC channel names
 */
export type IpcChannelType = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]
