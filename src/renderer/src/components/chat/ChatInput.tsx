/**
 * Chat Input Component
 * Input area with send button and keyboard shortcuts
 * Supports draft saving when switching sessions/tabs
 * @module components/chat/ChatInput
 */

import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle, type KeyboardEvent, type ChangeEvent } from 'react';

/**
 * Ref interface for ChatInput component
 * Exposes methods for external control
 */
export interface ChatInputRef {
  /** Insert text at current position (appends to existing value) */
  insertText: (text: string) => void;
  /** Focus the textarea */
  focus: () => void;
  /** Get current input value */
  getValue: () => string;
  /** Set input value */
  setValue: (value: string) => void;
}

interface ChatInputProps {
  /** Whether a request is currently loading */
  isLoading: boolean;
  /** Whether a response is currently streaming */
  isStreaming: boolean;
  /** Callback when a message is sent */
  onSend: (content: string) => void;
  /** Callback when input value changes */
  onValueChange?: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Current session ID for draft saving/restoring */
  sessionId?: string;
  /** Draft value from parent (to restore when switching sessions) */
  draft?: string;
  /** Callback to save draft to store */
  onDraftChange?: (draft: string) => void;
}

/** Maximum input length */
const MAX_INPUT_LENGTH = 10000;

/**
 * ChatInput component
 * Multi-line text input with send button and Enter-to-send shortcut
 * Exposes insertText/focus methods via ref for external control
 * Supports draft saving when switching sessions/tabs
 */
export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(
  function ChatInput({
    isLoading,
    isStreaming,
    onSend,
    onValueChange,
    placeholder = '输入消息...',
    disabled = false,
    sessionId,
    draft,
    onDraftChange,
  }, ref) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  // Track if we're restoring from draft to avoid saving it back
  const isRestoringRef = useRef(false);

  /**
   * Restore draft when sessionId changes or on mount
   */
  useEffect(() => {
    if (draft !== undefined && draft !== value) {
      isRestoringRef.current = true;
      setValue(draft);
      // Reset the flag after state update
      requestAnimationFrame(() => {
        isRestoringRef.current = false;
      });
    }
  }, [sessionId, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Save draft to store when value changes
   */
  useEffect(() => {
    // Skip if restoring from draft (avoid save-restore loop)
    if (isRestoringRef.current) return;
    // Skip if no callback provided
    if (!onDraftChange) return;

    onDraftChange(value);
  }, [value, onDraftChange]);

  /**
   * Expose imperative methods for parent components
   */
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      setValue(prev => {
        const newValue = prev + text;
        onValueChange?.(newValue);
        return newValue;
      });
      // Use setTimeout to ensure state update has been applied before focusing
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
    },
    focus: () => {
      textareaRef.current?.focus();
    },
    getValue: () => value,
    setValue: (newValue: string) => {
      setValue(newValue);
      onValueChange?.(newValue);
    },
  }), [value, onValueChange]);

  /**
   * Auto-resize textarea based on content
   */
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Set height to content, but cap at 200px
    const maxHeight = 200;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  /**
   * Handle input change
   */
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (newValue.length > MAX_INPUT_LENGTH) return;

      setValue(newValue);
      onValueChange?.(newValue);
      adjustHeight();
    },
    [onValueChange, adjustHeight]
  );

  /**
   * Handle send action
   */
  const handleSend = useCallback(() => {
    const trimmedValue = value.trim();
    if (!trimmedValue || isLoading || isStreaming || disabled) return;

    onSend(trimmedValue);
    setValue('');
    onValueChange?.('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isLoading, isStreaming, disabled, onSend, onValueChange]);

  /**
   * Handle keyboard shortcuts
   * - Enter: send message (when not composing IME)
   * - Shift+Enter: new line
   * - Escape: cancel/clear input
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Ignore during IME composition
      if (isComposingRef.current) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        onValueChange?.('');
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      }
    },
    [handleSend, onValueChange]
  );

  /**
   * Handle IME composition start (for CJK input)
   */
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  /**
   * Handle IME composition end
   */
  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  // Focus textarea when component mounts
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Focus textarea when loading finishes
  useEffect(() => {
    if (!isLoading && !isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isLoading, isStreaming]);

  const canSend = value.trim().length > 0 && !isLoading && !isStreaming && !disabled;

  return (
    <div className="flex items-end gap-2 p-3 bg-bg-primary border-t border-border">
      {/* Text input */}
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={placeholder}
          disabled={disabled || isLoading || isStreaming}
          rows={1}
          className={`
            w-full resize-none rounded-lg border border-border
            px-4 py-2.5 text-sm text-text-primary
            placeholder:text-text-muted
            bg-bg-primary
            focus:outline-none focus:ring-2 focus:ring-accent-indigo focus:border-transparent
            disabled:bg-bg-tertiary disabled:text-text-muted disabled:cursor-not-allowed
            transition-colors
          `}
          style={{ maxHeight: '200px' }}
        />
        {/* Character count */}
        {value.length > MAX_INPUT_LENGTH * 0.8 && (
          <span className={`absolute bottom-1 right-2 text-xs ${value.length >= MAX_INPUT_LENGTH ? 'text-accent-red' : 'text-text-muted'}`}>
            {value.length}/{MAX_INPUT_LENGTH}
          </span>
        )}
      </div>

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={!canSend}
        className={`
          flex-shrink-0 w-10 h-10 flex items-center justify-center
          rounded-lg transition-all duration-150
          ${canSend
            ? 'bg-accent-indigo hover:bg-accent-indigo/80 text-white shadow-sm hover:shadow'
            : 'bg-bg-tertiary text-text-muted cursor-not-allowed'
          }
        `}
        title="发送消息 (Enter)"
      >
        {isLoading || isStreaming ? (
          <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19V5m0 0l-7 7m7-7l7 7"
              transform="rotate(0)"
            />
          </svg>
        )}
      </button>

      {/* Keyboard shortcut hint */}
      <div className="hidden md:flex flex-col items-end gap-0.5 text-xs text-text-muted flex-shrink-0 pb-1">
        <span>
          <kbd className="px-1 py-0.5 bg-bg-tertiary border border-border rounded text-[10px]">Enter</kbd> 发送
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-bg-tertiary border border-border rounded text-[10px]">Shift+Enter</kbd> 换行
        </span>
      </div>
    </div>
  );
});
