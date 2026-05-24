/**
 * Status Bar Component
 * Displays connection status, current task, and progress
 * @module components/status/StatusBar
 */

import { useCallback } from 'react';
import { useStatusStore } from '@/stores/status-store';
import type { ConnectionStatus } from '@/types';

interface StatusBarProps {
  /** Callback when settings button is clicked */
  onToggleSettings?: () => void;
  /** Whether settings panel is currently visible */
  isSettingsVisible?: boolean;
}

/**
 * Get status icon based on connection status
 * @param status Connection status
 * @returns SVG icon element
 */
function getStatusIcon(status: ConnectionStatus): JSX.Element {
  switch (status) {
    case 'connecting':
    case 'reconnecting':
      return (
        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      );
    case 'connected':
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="6" />
        </svg>
      );
    case 'disconnected':
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <circle cx="12" cy="12" r="6" />
        </svg>
      );
    case 'error':
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    default:
      return <span className="w-4 h-4" />;
  }
}

/**
 * Get status text based on connection status
 * @param status Connection status
 * @returns Status text
 */
function getStatusText(status: ConnectionStatus): string {
  switch (status) {
    case 'connecting':
      return '连接中...';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '未连接';
    case 'reconnecting':
      return '重连中...';
    case 'error':
      return '连接错误';
    default:
      return '未知';
  }
}

/**
 * Get status color class based on connection status
 * @param status Connection status
 * @returns Tailwind color classes
 */
function getStatusColorClass(status: ConnectionStatus): string {
  switch (status) {
    case 'connecting':
      return 'text-accent-blue';
    case 'connected':
      return 'text-accent-green';
    case 'disconnected':
      return 'text-text-muted';
    case 'reconnecting':
      return 'text-accent-yellow';
    case 'error':
      return 'text-accent-red';
    default:
      return 'text-text-muted';
  }
}

/**
 * StatusBar component
 * Displays connection status, current task, and progress at the top of chat interface
 * Settings button is displayed on the right side
 */
export function StatusBar({ onToggleSettings, isSettingsVisible }: StatusBarProps): JSX.Element {
  const { connectionStatus, currentTask, taskProgress, lastError, clearError } = useStatusStore();

  /**
   * Handle clear error button click
   */
  const handleClearError = useCallback(() => {
    clearError();
  }, [clearError]);

  const statusColorClass = getStatusColorClass(connectionStatus);

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-bg-secondary border-b border-border text-sm">
      {/* Connection status */}
      <div className={`flex items-center gap-1.5 ${statusColorClass}`}>
        {getStatusIcon(connectionStatus)}
        <span className="font-medium">{getStatusText(connectionStatus)}</span>
      </div>

      {/* Separator */}
      <span className="text-border">|</span>

      {/* Current task */}
      {currentTask ? (
        <div className="flex items-center gap-2 text-text-primary">
          <span className="font-medium">当前任务:</span>
          <span>{currentTask}</span>
          {taskProgress && (
            <span className="text-text-muted text-xs">
              (步骤 {taskProgress.current}/{taskProgress.total})
            </span>
          )}
        </div>
      ) : (
        <span className="text-text-muted">等待输入</span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Error message */}
      {lastError && (
        <div
          className="flex items-center gap-2 px-2 py-1 bg-accent-red/10 text-accent-red rounded max-w-[50%] min-w-0"
          title={lastError}
        >
          <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="truncate text-xs sm:text-sm">{lastError}</span>
          <button
            onClick={handleClearError}
            className="flex-shrink-0 p-0.5 hover:bg-accent-red/20 rounded transition-colors"
            title="关闭"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Settings button - on the right side of status bar */}
      {onToggleSettings && (
        <button
          onClick={onToggleSettings}
          className={`
            flex items-center gap-1 px-2 py-1 rounded transition-colors
            ${isSettingsVisible
              ? 'text-accent-indigo bg-accent-indigo/10'
              : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}
          `}
          title="设置"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-xs hidden sm:inline">设置</span>
        </button>
      )}
    </div>
  );
}
