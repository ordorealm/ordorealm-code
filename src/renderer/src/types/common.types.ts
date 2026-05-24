/**
 * Common shared type definitions
 * @module types/common
 */

/**
 * Tool call record/display information
 * Used in both session messages and chat messages
 *
 * @deprecated Use ToolUseMessage and ToolResultMessage from @shared/index instead
 * This type is kept for backward compatibility during migration to SpectrAI architecture
 */
export interface ToolCall {
  /** Tool call identifier */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Tool output result */
  output?: string;
  /** Tool call status */
  status: 'pending' | 'running' | 'completed' | 'error';
  /** Execution duration in milliseconds */
  duration?: number;
}
