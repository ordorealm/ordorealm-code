/**
 * Chat related type definitions
 * Refactored to follow SpectrAI architecture pattern
 * @module types/chat
 */

// Import shared types from SpectrAI architecture
import type {
  ConversationMessage,
  UserMessage,
  AssistantMessage,
  ToolUseMessage,
  ToolResultMessage,
  SystemMessage,
} from '@shared/index'

import type {
  ContentBlock,
  ContentBlockType,
  FileChange,
  ToolCall,
  ExtendedToolCall,
} from './session.types';

// Re-export shared types for convenience
export type {
  ConversationMessage,
  UserMessage,
  AssistantMessage,
  ToolUseMessage,
  ToolResultMessage,
  SystemMessage,
  ContentBlock,
  ContentBlockType,
  FileChange,
}

/**
 * Chat message in the conversation
 * Following SpectrAI architecture: tool_use and tool_result are independent messages
 *
 * The `toolCalls` field is DEPRECATED and kept only for backward compatibility
 * during migration. New code should use independent tool_use and tool_result messages.
 */
export interface ChatMessage {
  /** Unique identifier */
  id: string;
  /** Message sender role */
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  /** Message content (markdown supported) */
  content: string;
  /** Message timestamp (ISO8601) */
  timestamp: string;
  /** Associated session identifier (SpectrAI architecture) */
  sessionId?: string;
  /** Whether the message is still streaming */
  isStreaming?: boolean;
  /**
   * @deprecated Use independent tool_use messages instead
   * Tool calls associated with this message (legacy, for backward compatibility)
   */
  toolCalls?: ToolCall[];
  /**
   * @deprecated Use independent tool_use/tool_result messages instead
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
 * Chat state managed by Zustand store
 */
export interface ChatState {
  /** List of chat messages */
  messages: ChatMessage[];
  /** Current input value */
  inputValue: string;
  /** Whether a request is loading */
  isLoading: boolean;
  /** Whether a response is streaming */
  isStreaming: boolean;
}

// Re-export legacy types for backward compatibility
export type { ToolCall, ExtendedToolCall } from './session.types'
