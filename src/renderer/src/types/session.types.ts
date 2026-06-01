/**
 * Session related type definitions
 * Refactored to follow SpectrAI architecture pattern
 * @module types/session
 */

// Import shared types from SpectrAI architecture
import type {
  ConversationMessage,
  UserMessage,
  AssistantMessage,
  ToolUseMessage,
  ToolResultMessage,
  SystemMessage,
  FileChange as SharedFileChange,
  SessionInitData as SharedSessionInitData,
} from '@shared/index'

// Import legacy types from common.types for backward compatibility
import type { ToolCall as CommonToolCall } from './common.types'

/**
 * Session connection status
 */
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Legacy tool call type for backward compatibility during migration
 * Re-exported from common.types to avoid duplication
 * @deprecated Use ToolUseMessage and ToolResultMessage instead
 */
export type ToolCall = CommonToolCall;

/**
 * Extended tool call with additional display information
 * @deprecated Use ToolUseMessage and ToolResultMessage instead
 */
export interface ExtendedToolCall extends ToolCall {
  /** Tool name for display (extracted from tool_use name) */
  toolName?: string;
  /** Tool input parameters (from tool_use) */
  toolInput?: Record<string, unknown>;
  /** Tool result content (from tool_result) */
  toolResult?: string;
  /** Whether this tool call resulted in an error */
  isError?: boolean;
  /** Error message if tool call failed */
  errorMessage?: string;
  /** Start time of tool execution */
  startTime?: number;
  /** End time of tool execution */
  endTime?: number;
}

/**
 * Message content block types for streaming messages
 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'thinking';

/**
 * Content block for structured message content
 */
export interface ContentBlock {
  /** Block type */
  type: ContentBlockType;
  /** Text content (for text blocks) */
  text?: string;
  /** Tool use ID (for tool_use and tool_result blocks) */
  toolUseId?: string;
  /** Tool name (for tool_use blocks) */
  name?: string;
  /** Tool input (for tool_use blocks) */
  input?: Record<string, unknown>;
  /** Tool result content (for tool_result blocks) */
  content?: string;
  /** Whether the tool result is an error */
  isError?: boolean;
}

/**
 * File change record for displaying file modifications
 */
export interface FileChange {
  /** File path relative to project root */
  path: string;
  /** Type of change */
  type: 'created' | 'modified' | 'deleted';
  /** Diff content (optional, for large files) */
  diff?: string;
  /** Whether this is a new file */
  isNew?: boolean;
}

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
 * Session init data from SDK
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
 * Question option for AskUserQuestion tool
 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * Question definition for AskUserQuestion tool
 */
export interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

/**
 * Interactive panel state for user interactions
 */
export interface InteractivePanelState {
  /** Pending permission request */
  pendingPermission: { message: string; toolUseId: string } | null;
  /** Pending question from AskUserQuestion tool */
  pendingQuestion: { questions: Question[]; toolUseId: string } | null;
  /** Pending plan approval from ExitPlanMode tool */
  pendingApproval: { planContent: unknown; toolUseId: string } | null;
}

/**
 * Token usage tracking for context window monitoring
 */
export interface TokenUsage {
  /** Accumulated input tokens */
  inputTokens: number;
  /** Accumulated output tokens */
  outputTokens: number;
  /** Total context window size for current model */
  contextWindow: number;
}

/**
 * Session entity representing a project session
 */
export interface Session {
  /** Unique identifier (UUID) */
  id: string;
  /** Associated project ID */
  projectId: string;
  /** List of messages in the session (SpectrAI architecture: independent messages) */
  messages: Message[];
  /** Creation timestamp (ISO8601) */
  createdAt: string;
  /** Last activity timestamp (ISO8601) */
  lastActiveAt: string;
  /** Current session status */
  status: SessionStatus;
  /** Session init data from SDK (tools, mcpServers, etc.) */
  initData?: SessionInitData;
  /** Interactive panel state */
  interactivePanel?: InteractivePanelState;
  /** Token usage tracking for context window monitoring */
  tokenUsage?: TokenUsage;
  /** Transient connection notice (e.g. "连接已恢复"), cleared after display timeout */
  connectionNotice?: string | null;
  /** Input draft - unsent text saved when switching sessions/tabs */
  inputDraft?: string;
  /** Auto-compact triggered flag - prevents repeated auto-compact within same session */
  autoCompacted?: boolean;
}

/**
 * Message in a session
 * Following SpectrAI architecture: tool_use and tool_result are independent messages
 *
 * The `toolCalls` field is DEPRECATED and kept only for backward compatibility
 * during migration. New code should use independent ToolUseMessage and ToolResultMessage.
 */
export interface Message {
  /** Unique identifier (UUID) */
  id: string;
  /** Message sender role */
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  /** Message content */
  content: string;
  /** Message timestamp (ISO8601) */
  timestamp: string;
  /** Associated session identifier (SpectrAI architecture) */
  sessionId?: string;
  /** Whether the message is still streaming */
  isStreaming?: boolean;
  /** Whether the message was sent from remote control (WeChat) */
  isRemote?: boolean;
  /**
   * @deprecated Use independent ToolUseMessage instead
   * Tool calls associated with this message (legacy, for backward compatibility)
   */
  toolCalls?: ToolCall[];
  /**
   * @deprecated Use independent ToolUseMessage/ToolResultMessage instead
   * Extended tool calls with display information (legacy)
   */
  extendedToolCalls?: ExtendedToolCall[];
  /** Structured content blocks for streaming messages */
  contentBlocks?: ContentBlock[];
  /** Thinking text (for assistant messages with thinking) */
  thinkingText?: string;
  /** Whether thinking is still in progress */
  isThinking?: boolean;
  /** File changes associated with this message */
  fileChanges?: FileChange[];
  /** Tool use ID (for tool_use and tool_result messages) */
  toolUseId?: string;
  /** Tool name (for tool_use and tool_result messages) */
  toolName?: string;
  /** Tool input (for tool_use messages) */
  toolInput?: Record<string, unknown>;
  /** Tool result (for tool_result messages) */
  toolResult?: string;
  /** Whether the tool result is an error (for tool_result messages) */
  isError?: boolean;
}

/**
 * Session state managed by Zustand store
 */
export interface SessionState {
  /** Map of session ID to Session */
  sessions: Record<string, Session>;
  /** Currently active session ID */
  activeSessionId: string | null;
  /** Index: projectId → sessionId for O(1) lookup */
  projectSessionIndex: Map<string, string>;
}

// Re-export shared types for convenience
export type {
  ConversationMessage,
  UserMessage,
  AssistantMessage,
  ToolUseMessage,
  ToolResultMessage,
  SystemMessage,
} from '@shared/index'
