/**
 * Streaming Indicator Component
 * Displays thinking timer, progress text, and stop button during streaming
 * @module components/chat/StreamingIndicator
 */

import { useState, useEffect } from 'react';
import { useActivityStore, formatThinkingTime } from '@/stores/activity-store';
import { useSessionStore } from '@/stores/session-store';

interface StreamingIndicatorProps {
  /** Session ID for activity tracking */
  sessionId: string;
  /** Whether streaming is in progress */
  isStreaming: boolean;
  /** Callback to abort streaming */
  onAbort?: () => void;
}

/**
 * Streaming Indicator Component
 * Shows thinking timer, live progress text, and stop button
 * Also displays connection notice (e.g., "响应缓慢...", "连接已断开")
 */
export function StreamingIndicator({
  sessionId,
  isStreaming,
  onAbort,
}: StreamingIndicatorProps): JSX.Element | null {
  // Thinking timer state
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingStartTime = useActivityStore(
    state => state.sessions[sessionId]?.thinkingStartTime
  );

  // Current activity detail
  const currentActivity = useActivityStore(
    state => state.sessions[sessionId]?.current
  );

  // ★ Connection notice from session (for streaming activity check)
  const connectionNotice = useSessionStore(
    state => state.sessions[sessionId]?.connectionNotice
  );

  // Update thinking timer every second
  useEffect(() => {
    if (!isStreaming || !thinkingStartTime) {
      setThinkingSeconds(0);
      return;
    }

    const updateTimer = () => {
      setThinkingSeconds(Math.floor((Date.now() - thinkingStartTime) / 1000));
    };

    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [isStreaming, thinkingStartTime]);

  // Don't render if not streaming
  if (!isStreaming) {
    return null;
  }

  // Get progress text: prefer connection notice, then activity detail
  const progressText = connectionNotice || currentActivity?.detail || '正在思考...';

  // ★ Determine text color based on notice type
  const isWarning = connectionNotice?.includes('缓慢') || connectionNotice?.includes('断开');
  const textColorClass = isWarning ? 'text-amber-500' : 'text-accent-indigo';

  return (
    <div className="flex items-center justify-center gap-3 py-2 px-4 bg-bg-secondary border-t border-border animate-in fade-in slide-in-from-bottom-2 duration-200 ease-out">
      {/* Spinner */}
      <svg
        className={`w-4 h-4 animate-spin ${isWarning ? 'text-amber-500' : 'text-accent-indigo'}`}
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>

      {/* Progress text (includes connection notice) */}
      <span className={`text-sm flex-1 text-center ${textColorClass}`}>
        {progressText}
      </span>

      {/* Thinking timer */}
      {thinkingSeconds > 0 && (
        <span className={`text-xs font-mono animate-pulse ${isWarning ? 'text-amber-500/70' : 'text-accent-indigo/70'}`}>
          {formatThinkingTime(thinkingSeconds)}
        </span>
      )}

      {/* Stop button */}
      {onAbort && (
        <button
          onClick={onAbort}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-accent-red hover:bg-bg-hover rounded transition-colors"
          title="停止生成（软中断，会话保持可用）"
        >
          <span className="inline-block w-2 h-2 rounded-sm bg-current opacity-80" />
          停止
        </button>
      )}
    </div>
  );
}

/**
 * Compact stop button for inline use
 * @internal Internal component, not exported for external use
 */
function StopButton({ onAbort }: { onAbort?: () => void }): JSX.Element | null {
  if (!onAbort) return null;

  return (
    <button
      onClick={onAbort}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-tertiary border border-border rounded-full text-xs text-text-secondary hover:text-accent-red hover:border-accent-red/50 hover:bg-bg-hover transition-all shadow-sm"
      title="停止生成（软中断，会话保持可用）"
    >
      <span className="inline-block w-2 h-2 rounded-sm bg-current opacity-80" />
      停止生成
    </button>
  );
}

/**
 * Thinking timer display component
 * @internal Internal component, not exported for external use
 */
function ThinkingTimer({
  sessionId,
  isStreaming,
}: {
  sessionId: string;
  isStreaming: boolean;
}): JSX.Element | null {
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingStartTime = useActivityStore(
    state => state.sessions[sessionId]?.thinkingStartTime
  );

  useEffect(() => {
    if (!isStreaming || !thinkingStartTime) {
      setThinkingSeconds(0);
      return;
    }

    const updateTimer = () => {
      setThinkingSeconds(Math.floor((Date.now() - thinkingStartTime) / 1000));
    };

    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [isStreaming, thinkingStartTime]);

  if (!isStreaming || thinkingSeconds === 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs text-accent-indigo">
      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      {formatThinkingTime(thinkingSeconds)}
    </span>
  );
}
