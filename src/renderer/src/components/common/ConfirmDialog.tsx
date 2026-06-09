/**
 * Confirm Dialog Component
 * Reusable confirmation dialog for dangerous actions
 * @module components/common/ConfirmDialog
 */

import { useCallback, useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  /** Whether dialog is open */
  isOpen: boolean;
  /** Dialog title */
  title: string;
  /** Dialog message */
  message: string;
  /** Confirm button text */
  confirmText?: string;
  /** Cancel button text */
  cancelText?: string;
  /** Whether action is destructive (red confirm button) */
  isDestructive?: boolean;
  /** Callback when confirmed */
  onConfirm: () => void;
  /** Callback when cancelled */
  onCancel: () => void;
  /** Whether action is in progress */
  isLoading?: boolean;
}

/**
 * ConfirmDialog component
 * Displays a modal confirmation dialog with cancel and confirm buttons
 */
export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  isDestructive = false,
  onConfirm,
  onCancel,
  isLoading = false,
}: ConfirmDialogProps): JSX.Element | null {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Focus confirm button when dialog opens
  useEffect(() => {
    if (isOpen && confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [isOpen]);

  /**
   * Handle keyboard events
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    },
    [onCancel]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center" style={{ top: 'var(--title-bar-height, 0)' }} onKeyDown={handleKeyDown}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-bg-primary rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
        {/* Title */}
        <h3 className="text-lg font-semibold text-text-primary mb-2">{title}</h3>

        {/* Message */}
        <p className="text-sm text-text-secondary mb-6">{message}</p>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            ref={confirmButtonRef}
            onClick={onConfirm}
            disabled={isLoading}
            className={`
              px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed
              ${isDestructive
                ? 'bg-accent-red hover:bg-accent-red/80'
                : 'bg-accent-indigo hover:bg-accent-indigo/80'}
            `}
          >
            {isLoading ? '处理中...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
