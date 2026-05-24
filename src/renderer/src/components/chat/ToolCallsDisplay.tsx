/**
 * Tool Calls Display Component
 * Renders a collapsible list of tool calls with details
 * @module components/chat/ToolCallsDisplay
 */

import { useState, useCallback } from 'react';
import type { ToolCall } from '@/types';

interface ToolCallsDisplayProps {
  /** List of tool calls to display */
  toolCalls: ToolCall[];
  /** Whether the panel is expanded by default */
  defaultExpanded?: boolean;
}

/**
 * Format duration in milliseconds to readable string
 * @param ms Duration in milliseconds
 * @returns Formatted duration string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Get status icon and color
 * @param status Tool call status
 * @returns Icon element and color class
 */
function getStatusInfo(status: ToolCall['status']): { icon: JSX.Element; colorClass: string } {
  switch (status) {
    case 'pending':
      return {
        icon: (
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ),
        colorClass: 'text-accent-yellow',
      };
    case 'running':
      return {
        icon: (
          <svg className="w-4 h-4 animate-pulse" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" />
          </svg>
        ),
        colorClass: 'text-accent-blue',
      };
    case 'completed':
      return {
        icon: (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ),
        colorClass: 'text-accent-green',
      };
    case 'error':
      return {
        icon: (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ),
        colorClass: 'text-accent-red',
      };
    default:
      return {
        icon: <span className="w-4 h-4" />,
        colorClass: 'text-text-muted',
      };
  }
}

/**
 * Render JSON value with syntax highlighting
 * @param value JSON value to render
 * @param depth Current nesting depth
 * @returns HTML string
 */
function renderJsonValue(value: unknown, depth = 0): string {
  if (value === null) {
    return '<span class="text-text-muted">null</span>';
  }
  if (value === undefined) {
    return '<span class="text-text-muted">undefined</span>';
  }
  if (typeof value === 'boolean') {
    return `<span class="text-accent-purple">${value}</span>`;
  }
  if (typeof value === 'number') {
    return `<span class="text-accent-blue">${value}</span>`;
  }
  if (typeof value === 'string') {
    // Truncate long strings
    const displayValue = value.length > 100 ? value.slice(0, 100) + '...' : value;
    // Escape HTML special characters: & first, then quotes
    const escapedValue = displayValue.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<span class="text-accent-green">"${escapedValue}"</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span class="text-text-muted">[]</span>';
    }
    const items = value.slice(0, 5).map(item => renderJsonValue(item, depth + 1));
    const more = value.length > 5 ? `<span class="text-text-muted">... ${value.length - 5} more</span>` : '';
    return `<span class="text-text-muted">[</span>${items.join('<span class="text-text-muted">,</span> ')}${more}<span class="text-text-muted">]</span>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 5);
    if (entries.length === 0) {
      return '<span class="text-text-muted">{}</span>';
    }
    const items = entries.map(
      ([key, val]) =>
        `<span class="text-accent-yellow">"${key}"</span>: ${renderJsonValue(val, depth + 1)}`
    );
    const more =
      Object.keys(value).length > 5
        ? `<span class="text-text-muted">... ${Object.keys(value).length - 5} more</span>`
        : '';
    return `<span class="text-text-muted">{</span>${items.join('<span class="text-text-muted">,</span> ')}${more}<span class="text-text-muted">}</span>`;
  }
  return String(value);
}

/**
 * Tool call item component
 */
function ToolCallItem({ toolCall, isExpanded, onToggle }: {
  toolCall: ToolCall;
  isExpanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const statusInfo = getStatusInfo(toolCall.status);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left bg-bg-secondary hover:bg-bg-hover transition-colors"
      >
        {/* Status icon */}
        <span className={statusInfo.colorClass}>{statusInfo.icon}</span>

        {/* Tool name */}
        <span className="flex-1 text-sm font-mono text-text-primary truncate">
          {toolCall.name}
        </span>

        {/* Duration */}
        {toolCall.duration !== undefined && (
          <span className="text-xs text-text-muted flex-shrink-0">
            {formatDuration(toolCall.duration)}
          </span>
        )}

        {/* Expand/collapse icon */}
        <svg
          className={`w-4 h-4 text-text-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Details */}
      {isExpanded && (
        <div className="px-3 py-2 bg-bg-primary border-t border-border space-y-2">
          {/* Input */}
          {Object.keys(toolCall.input).length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-muted mb-1">参数</div>
              <pre className="text-xs bg-bg-secondary p-2 rounded overflow-x-auto">
                <code dangerouslySetInnerHTML={{ __html: renderJsonValue(toolCall.input) }} />
              </pre>
            </div>
          )}

          {/* Output */}
          {toolCall.output && (
            <div>
              <div className="text-xs font-medium text-text-muted mb-1">输出</div>
              <pre className="text-xs bg-bg-secondary p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {toolCall.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ToolCallsDisplay component
 * Shows a collapsible list of tool calls with summary and details
 */
export function ToolCallsDisplay({ toolCalls, defaultExpanded = false }: ToolCallsDisplayProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Calculate totals
  const totalDuration = toolCalls.reduce((sum, tc) => sum + (tc.duration || 0), 0);
  const pendingCount = toolCalls.filter(tc => tc.status === 'pending' || tc.status === 'running').length;
  const errorCount = toolCalls.filter(tc => tc.status === 'error').length;

  const toggleItem = useCallback((id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div className="mt-2">
      {/* Header button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`
          w-full flex items-center gap-2 px-3 py-2 rounded-lg
          bg-bg-tertiary hover:bg-bg-hover transition-colors
          ${errorCount > 0 ? 'border border-accent-red/30 bg-bg-secondary' : ''}
        `}
      >
        {/* Expand/collapse icon */}
        <svg
          className={`w-4 h-4 text-text-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>

        {/* Summary */}
        <span className="flex-1 text-sm text-text-primary text-left">
          ▶ 工具调用
          <span className="ml-1 font-medium">({toolCalls.length})</span>
        </span>

        {/* Duration */}
        {totalDuration > 0 && (
          <span className="text-xs text-text-muted flex-shrink-0">
            耗时: {formatDuration(totalDuration)}
          </span>
        )}

        {/* Status indicators */}
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-bg-tertiary text-accent-yellow rounded">
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {pendingCount}
          </span>
        )}
        {errorCount > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-bg-secondary text-accent-red rounded border border-accent-red/30">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            {errorCount}
          </span>
        )}
      </button>

      {/* Tool call list */}
      {isExpanded && (
        <div className="mt-2 space-y-2 pl-2">
          {toolCalls.map(toolCall => (
            <ToolCallItem
              key={toolCall.id}
              toolCall={toolCall}
              isExpanded={expandedItems.has(toolCall.id)}
              onToggle={() => toggleItem(toolCall.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
