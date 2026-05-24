/**
 * Agent related type definitions
 * @module types/agent
 */

/**
 * Agent type enum
 * Supported agents: Claude Code, Codex (OpenAI), OpenCode (Open Source)
 */
export type AgentType = 'claude-code' | 'codex' | 'opencode';

/**
 * Agent connection/working status
 */
export type AgentStatus = 'idle' | 'connecting' | 'connected' | 'working' | 'error' | 'disconnected';

/**
 * Permission configuration for agent
 */
export interface Permission {
  /** Permission name */
  name: string;
  /** Whether this permission is allowed */
  allowed: boolean;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Agent type */
  type: AgentType;
  /** Associated provider ID */
  providerId: string;
  /** List of permissions */
  permissions: Permission[];
}

/**
 * Agent state managed by Zustand store
 */
export interface AgentState {
  /** Current agent status */
  status: AgentStatus;
  /** Current task description */
  currentTask: string | null;
  /** Task progress information */
  taskProgress: { current: number; total: number } | null;
  /** Last error message */
  lastError: string | null;
  /** Agent configuration */
  config: AgentConfig | null;
}
