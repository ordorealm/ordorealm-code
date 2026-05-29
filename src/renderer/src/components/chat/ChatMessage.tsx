/**
 * Chat Message Component
 * Renders a single chat message with markdown support
 * Supports thinking content display with collapsible block
 * Refactored to follow SpectrAI architecture pattern
 * @module components/chat/ChatMessage
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Message } from '@/types';

interface ChatMessageProps {
  /** Message data */
  message: Message;
  /** Whether to show the copy button */
  showCopyButton?: boolean;
}

/**
 * Format timestamp to readable time
 * @param timestamp ISO8601 timestamp
 * @returns Formatted time string (HH:MM)
 */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Copy text to clipboard
 * @param text Text to copy
 * @returns Promise that resolves when copy is complete
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    // Fallback for older browsers
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }
}

/**
 * Escape HTML special characters for safe rendering
 * @param text Text to escape
 * @returns Escaped text safe for HTML insertion
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate and sanitize URL for safe link rendering
 * Only allows http, https, and mailto protocols
 * @param url URL to validate
 * @returns Sanitized URL or empty string if invalid
 */
function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  // Only allow safe protocols
  const safeProtocols = ['http://', 'https://', 'mailto:', '/', '#'];
  const hasSafeProtocol = safeProtocols.some(p => trimmed.toLowerCase().startsWith(p));

  if (!hasSafeProtocol) {
    // Default to https for protocol-less URLs
    if (/^[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+/.test(trimmed)) {
      return `https://${trimmed}`;
    }
    return '';
  }

  // Additional safety: no javascript in URL
  if (/javascript:/i.test(trimmed)) {
    return '';
  }

  return trimmed;
}

/**
 * Simple markdown renderer with enhanced security
 * Supports: bold, italic, code, code blocks, links, lists
 *
 * Security measures:
 * 1. HTML entities are escaped before processing
 * 2. URLs are validated and sanitized
 * 3. Code blocks use placeholder tokens to prevent regex interference
 *
 * @param content Markdown content
 * @returns HTML string
 */
function renderMarkdown(content: string): string {
  // Step 1: Extract and protect code blocks first to prevent interference
  const codeBlockPlaceholders: { placeholder: string; html: string }[] = [];
  let html = content;

  // Extract code blocks and replace with placeholders
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langClass = lang ? `language-${lang}` : '';
    const escapedCode = escapeHtml(code.trim());
    const placeholder = `__CODE_BLOCK_${codeBlockPlaceholders.length}__`;
    const codeHtml = `<pre class="bg-bg-tertiary text-text-primary p-3 rounded-lg my-2 overflow-x-auto text-sm border border-border"><code class="${langClass}">${escapedCode}</code></pre>`;
    codeBlockPlaceholders.push({ placeholder, html: codeHtml });
    return placeholder;
  });

  // Extract inline code and replace with placeholders
  const inlineCodePlaceholders: { placeholder: string; html: string }[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `__INLINE_CODE_${inlineCodePlaceholders.length}__`;
    const escapedCode = escapeHtml(code);
    const codeHtml = `<code class="bg-bg-tertiary text-accent-purple px-1.5 py-0.5 rounded text-sm font-mono border border-border">${escapedCode}</code>`;
    inlineCodePlaceholders.push({ placeholder, html: codeHtml });
    return placeholder;
  });

  // Step 2: Escape HTML entities for remaining content
  html = escapeHtml(html);

  // Step 3: Process markdown syntax (order matters!)

  // Bold (**text**) - must come before italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>');

  // Italic (*text*)
  html = html.replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>');

  // Links [text](url) - with URL sanitization
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) {
      // Invalid URL, render as plain text
      return `[${text}]`;
    }
    const safeText = escapeHtml(text);
    // Escape HTML attribute special characters to prevent attribute injection
    const escapedUrl = safeUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<a href="${escapedUrl}" class="text-accent-indigo hover:underline" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
  });

  // Unordered lists (- item) - only at line start, not inside code
  // Wrap consecutive list items in <ul> tags
  html = html.replace(/^- (.+)$/gm, '<li class="ml-4" style="list-style-type: disc">$1</li>');

  // Ordered lists (1. item) - only at line start
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="ml-4" style="list-style-type: decimal">$1</li>');

  // Wrap consecutive <li> elements in <ul> tags
  // This handles both ordered and unordered lists
  html = html.replace(/(<li[^>]*>.*?<\/li>\n?)+/g, (match) => {
    return `<ul class="list-outside">${match}</ul>`;
  });

  // Note: Don't convert \n to <br /> here because:
  // 1. whitespace-pre-wrap CSS class will preserve line breaks
  // 2. This prevents double line breaks from occurring

  // Step 4: Restore code blocks (in reverse order of specificity)
  inlineCodePlaceholders.forEach(({ placeholder, html: codeHtml }) => {
    html = html.replace(placeholder, codeHtml);
  });
  codeBlockPlaceholders.forEach(({ placeholder, html: codeHtml }) => {
    html = html.replace(placeholder, codeHtml);
  });

  return html;
}

/**
 * Format tool input for display
 * @param input Tool input parameters
 * @returns Formatted string
 */
function formatToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) {
    return '';
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Thinking Block Component
 * Collapsible block to display AI thinking content
 */
function ThinkingBlock({
  thinkingText,
  isThinking,
}: {
  thinkingText: string;
  isThinking: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Calculate thinking duration hint
  const lineCount = useMemo(() => {
    return thinkingText.split('\n').length;
  }, [thinkingText]);

  // Truncate for summary
  const summary = useMemo(() => {
    const firstLine = thinkingText.split('\n')[0];
    if (firstLine.length > 50) {
      return firstLine.slice(0, 50) + '...';
    }
    return firstLine + (lineCount > 1 ? '...' : '');
  }, [thinkingText, lineCount]);

  return (
    <div className="mb-3">
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`
          w-full flex items-center gap-2 px-3 py-2 rounded-lg
          bg-gradient-to-r from-accent-indigo/10 to-accent-purple/10
          border border-accent-indigo/20
          hover:border-accent-indigo/40 transition-colors
          text-left group
        `}
      >
        {/* Brain icon */}
        <span className="text-lg">🧠</span>

        {/* Status text */}
        <span className="text-sm text-accent-indigo font-medium">
          {isThinking ? '思考中...' : `已思考`}
        </span>

        {/* Summary preview */}
        <span className="text-sm text-text-muted truncate flex-1">
          {summary}
        </span>

        {/* Line count badge */}
        {!isThinking && (
          <span className="text-xs text-text-muted bg-bg-secondary px-2 py-0.5 rounded">
            {lineCount} 行
          </span>
        )}

        {/* Expand/collapse icon */}
        <svg
          className={`w-4 h-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2 p-3 rounded-lg bg-bg-secondary border border-border text-sm text-text-secondary whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
          {thinkingText}
        </div>
      )}
    </div>
  );
}

/**
 * ChatMessage component
 * Displays a single message with role indicator, content, and actions
 * Supports SpectrAI architecture: user, assistant, system, tool_use, tool_result roles
 */
export function ChatMessage({ message, showCopyButton = true }: ChatMessageProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);

  /**
   * Handle copy button click
   */
  const handleCopy = useCallback(async () => {
    const textToCopy = message.role === 'tool_use'
      ? JSON.stringify(message.toolInput, null, 2)
      : message.role === 'tool_result'
        ? message.toolResult || message.content
        : message.content;
    await copyToClipboard(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message]);

  // Note: Auto-scroll during streaming is handled by ChatPanel's scrollToBottom
  // We don't auto-scroll here to avoid flickering from frequent content updates

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isSystem = message.role === 'system';
  const isToolUse = message.role === 'tool_use';
  const isToolResult = message.role === 'tool_result';

  // Check if message has thinking content
  const hasThinking = isAssistant && message.thinkingText && message.thinkingText.length > 0;

  // For tool_use and tool_result, we don't show the normal message UI
  // They are handled by ToolOperationGroup component in the message grouping
  // But we still need to render something for standalone display
  if (isToolUse) {
    return (
      <div
        ref={messageRef}
        className="group flex gap-3 p-3 rounded-lg bg-bg-secondary border border-accent-blue/30 ml-12"
      >
        {/* Tool Icon */}
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium bg-accent-blue text-white">
          🔧
        </div>

        {/* Tool Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-accent-blue">
              {message.toolName || 'Tool'}
            </span>
            <span className="text-xs text-text-muted">{formatTime(message.timestamp)}</span>
            <span className="inline-flex items-center gap-1 text-xs text-accent-blue">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              执行中...
            </span>
          </div>

          {/* Tool Input */}
          {message.toolInput && Object.keys(message.toolInput).length > 0 && (
            <pre className="text-xs text-text-secondary bg-bg-primary p-2 rounded border border-border overflow-x-auto">
              {formatToolInput(message.toolInput)}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (isToolResult) {
    const hasError = message.isError;
    return (
      <div
        ref={messageRef}
        className={`group flex gap-3 p-3 rounded-lg ml-12 ${
          hasError
            ? 'bg-bg-secondary border border-accent-red/30'
            : 'bg-bg-secondary border border-accent-green/30'
        }`}
      >
        {/* Result Icon */}
        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
          hasError ? 'bg-accent-red text-white' : 'bg-accent-green text-white'
        }`}>
          {hasError ? '❌' : '✅'}
        </div>

        {/* Result Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-sm font-medium ${hasError ? 'text-accent-red' : 'text-accent-green'}`}>
              {message.toolName || 'Tool'} Result
            </span>
            <span className="text-xs text-text-muted">{formatTime(message.timestamp)}</span>
          </div>

          {/* Tool Result */}
          <pre className={`text-xs p-2 rounded border border-border overflow-x-auto max-h-60 ${
            hasError
              ? 'text-accent-red bg-bg-primary'
              : 'text-text-secondary bg-bg-primary'
          }`}>
            {message.toolResult || message.content || '(empty result)'}
          </pre>
        </div>

        {/* Copy button */}
        {showCopyButton && (
          <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
              title={copied ? '已复制' : '复制'}
            >
              {copied ? (
                <svg className="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Standard user/assistant/system message rendering
  return (
    <div
      ref={messageRef}
      className={`
        group flex gap-3 p-4 rounded-xl
        ${isUser ? 'bg-gradient-to-br from-accent-indigo/5 to-accent-purple/5 ml-8' : ''}
        ${isAssistant ? 'bg-bg-secondary' : ''}
        ${isSystem ? 'bg-bg-secondary border border-accent-yellow/30' : ''}
      `}
    >
      {/* Role Avatar */}
      <div
        className={`
          flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-base
          ${isUser ? 'bg-gradient-to-br from-accent-indigo to-accent-purple text-white shadow-lg shadow-accent-indigo/20' : ''}
          ${isAssistant ? 'bg-gradient-to-br from-accent-blue to-accent-indigo text-white shadow-lg shadow-accent-blue/20' : ''}
          ${isSystem ? 'bg-accent-yellow text-white' : ''}
        `}
      >
        {isUser && '👤'}
        {isAssistant && '🤖'}
        {isSystem && '⚠️'}
      </div>

      {/* Message Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-semibold text-text-primary">
            {isUser && '用户'}
            {isAssistant && 'Agent'}
            {isSystem && '系统'}
          </span>
          <span className="text-xs text-text-muted">{formatTime(message.timestamp)}</span>
          {message.isStreaming && (
            <span className="inline-flex items-center gap-1.5 text-xs text-accent-indigo bg-accent-indigo/10 px-2 py-0.5 rounded-full">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              生成中
            </span>
          )}
        </div>

        {/* Thinking Block - show before content */}
        {hasThinking && (
          <ThinkingBlock
            thinkingText={message.thinkingText!}
            isThinking={message.isThinking || false}
          />
        )}

        {/* Content - Streaming vs Formatted Rendering */}
        {message.content && (
          message.isStreaming ? (
            // 流式期间：原始文本 + 等宽字体，保留换行
            // 不进行 Markdown 解析，避免不完整结构导致格式错乱
            <pre className="text-sm text-text-primary font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
              {message.content}
            </pre>
          ) : (
            // 完成后：Markdown 格式化渲染
            <div
              className="text-sm text-text-primary leading-relaxed max-w-none prose prose-sm prose-invert"
              style={{ whiteSpace: 'pre-wrap' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
            />
          )
        )}

        {/* Streaming cursor animation */}
        {message.isStreaming && (
          <span className="inline-block w-2 h-4 bg-accent-indigo animate-pulse ml-1 rounded-sm" />
        )}
      </div>

      {/* Actions */}
      {showCopyButton && !message.isStreaming && (message.content || message.thinkingText) && (
        <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            title={copied ? '已复制' : '复制'}
          >
            {copied ? (
              <svg className="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
