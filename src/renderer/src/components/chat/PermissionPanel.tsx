/**
 * Permission Panel Component
 *
 * Displays when Claude requests permission to perform an action.
 * Shows a confirmation dialog with "Allow" and "Deny" buttons.
 *
 * @module components/chat/PermissionPanel
 */

import { useState, useCallback } from 'react';

/** Shield icon (SVG) */
const ShieldIcon = () => (
  <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

/** Check icon (SVG) */
const CheckIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** X icon (SVG) */
const XIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

interface PermissionPanelProps {
  /** The permission request message to display */
  message: string;
  /** Callback when user allows the action */
  onAllow: () => void;
  /** Callback when user denies the action */
  onDeny: () => void;
  /** Whether the panel is disabled */
  disabled?: boolean;
}

/**
 * Permission Panel Component
 *
 * Renders a yellow/amber themed confirmation dialog for permission requests.
 */
export function PermissionPanel({
  message,
  onAllow,
  onDeny,
  disabled = false,
}: PermissionPanelProps): JSX.Element | null {
  const [decided, setDecided] = useState(false);

  const handleAllow = useCallback(() => {
    if (disabled || decided) return;
    setDecided(true);
    onAllow();
  }, [disabled, decided, onAllow]);

  const handleDeny = useCallback(() => {
    if (disabled || decided) return;
    setDecided(true);
    onDeny();
  }, [disabled, decided, onDeny]);

  // Don't render after decision
  if (decided) return null;

  return (
    <div className="flex justify-center my-3 px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="w-full max-w-2xl rounded-xl border border-accent-yellow/30 bg-bg-secondary overflow-hidden shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-tertiary border-b border-border">
          <ShieldIcon />
          <span className="text-xs font-medium text-accent-yellow">需要权限确认</span>
        </div>

        {/* Message */}
        <div className="px-4 py-3">
          <p className="text-sm text-text-primary">{message || 'Claude 请求执行此操作，是否允许？'}</p>
        </div>

        {/* Action buttons */}
        <div className="px-4 pb-4 pt-1 flex items-center justify-end gap-3">
          <button
            onClick={handleDeny}
            disabled={disabled}
            className={`
              flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
              border border-accent-red/30 text-accent-red bg-bg-primary
              hover:bg-bg-hover hover:border-accent-red/50 active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            `}
          >
            <XIcon />
            拒绝
          </button>
          <button
            onClick={handleAllow}
            disabled={disabled}
            className={`
              flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
              bg-accent-green text-white
              hover:bg-accent-green/80 active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            `}
          >
            <CheckIcon />
            允许
          </button>
        </div>
      </div>
    </div>
  );
}

PermissionPanel.displayName = 'PermissionPanel';

export default PermissionPanel;
