/**
 * Status display related type definitions
 * @module types/status
 */

/**
 * Connection status enum
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

/**
 * Task progress information
 */
export interface TaskProgress {
  /** Current step number */
  current: number;
  /** Total number of steps */
  total: number;
}

/**
 * Status state managed by Zustand store
 */
export interface StatusState {
  /** Current connection status */
  connectionStatus: ConnectionStatus;
  /** Current task description */
  currentTask: string | null;
  /** Task progress information */
  taskProgress: TaskProgress | null;
  /** Last error message */
  lastError: string | null;
}
