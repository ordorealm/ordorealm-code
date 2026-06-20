/**
 * Type definitions entry point
 * Export all types from this file for convenient imports
 * Refactored to follow SpectrAI architecture pattern
 * @module types
 */

// Common shared types (ToolCall is deprecated, defined here)
export * from './common.types';

// Project management types
export * from './project.types';

// Session management types (re-exports ToolCall from common.types for backward compat)
export {
  type SessionStatus,
  type ExtendedToolCall,
  type ContentBlockType,
  type ContentBlock,
  type FileChange,
  type SessionInitData,
  type QuestionOption,
  type Question,
  type InteractivePanelState,
  type Session,
  type Message,
  type SessionState,
  type SessionListItem,
  type McpServerInfo,
  type PluginInfo,
  type TokenUsage,
} from './session.types';

// API Provider types
export * from './provider.types';

// Agent integration types
export * from './agent.types';

// File tree types
export * from './filetree.types';

// Chat interface types (ToolCall/ExtendedToolCall already exported from common/session)
export {
  type ChatMessage,
  type ChatState,
} from './chat.types';

// Status display types
export * from './status.types';

// Git types
export * from './git.types';

// Skill library types
export * from './skill-library.types';
