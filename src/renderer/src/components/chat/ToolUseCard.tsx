/**
 * Tool Use Card Component
 *
 * Displays AI tool calls (file read/write, command execution, etc.) and their results.
 * Collapsible to view detailed input and output.
 * Supports right-click menu for quick copy or opening related files.
 *
 * @module components/chat/ToolUseCard
 */

import { useState, useMemo, useCallback } from 'react';
import type { ToolCall } from '@/types';
import { useCodePreviewStore } from '@/stores/code-preview-store';

/** Tool name to style mapping */
const TOOL_STYLES: Record<string, { icon: string; color: string; label: string }> = {
  // Claude Code tools
  Read: { icon: '📄', color: 'text-accent-blue', label: 'Read' },
  Write: { icon: '✏️', color: 'text-accent-green', label: 'Write' },
  Edit: { icon: '📝', color: 'text-accent-yellow', label: 'Edit' },
  Bash: { icon: '⚡', color: 'text-accent-purple', label: 'Bash' },
  Glob: { icon: '🔍', color: 'text-accent-blue', label: 'Glob' },
  Grep: { icon: '🔎', color: 'text-accent-blue', label: 'Grep' },
  WebSearch: { icon: '🌐', color: 'text-accent-blue', label: 'WebSearch' },
  Task: { icon: '🤖', color: 'text-accent-purple', label: 'Task' },
  // Codex CLI tools
  shell: { icon: '⚡', color: 'text-accent-purple', label: 'Shell' },
  localShellCall: { icon: '⚡', color: 'text-accent-purple', label: 'Shell' },
  local_shell_call: { icon: '⚡', color: 'text-accent-purple', label: 'Shell' },
  functionCall: { icon: '🔧', color: 'text-accent-yellow', label: 'Function' },
  function_call: { icon: '🔧', color: 'text-accent-yellow', label: 'Function' },
};

const DEFAULT_STYLE = { icon: '🔧', color: 'text-text-muted', label: 'Tool' };

/** File-related tools that may have file_path in input */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'read_file', 'write_file']);

interface ToolUseCardProps {
  /** Tool call data */
  toolCall: ToolCall;
  /** Compact mode (used inside ToolOperationGroup, removes outer margin) */
  compact?: boolean;
}

/**
 * Format tool input for display
 */
function formatToolInput(input: Record<string, unknown>): string {
  // Special handling for common tool inputs
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return `pattern: ${input.pattern}`;
  return JSON.stringify(input, null, 2);
}

/**
 * Render JSON value with syntax highlighting
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
    const displayValue = value.length > 100 ? value.slice(0, 100) + '...' : value;
    const escapedValue = displayValue
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
 * Get status icon and color
 */
function getStatusInfo(status: ToolCall['status']): { icon: JSX.Element; colorClass: string } {
  switch (status) {
    case 'pending':
      return {
        icon: (
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ),
        colorClass: 'text-accent-yellow',
      };
    case 'running':
      return {
        icon: (
          <svg className="w-3 h-3 animate-pulse" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" />
          </svg>
        ),
        colorClass: 'text-accent-blue',
      };
    case 'completed':
      return {
        icon: (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ),
        colorClass: 'text-accent-green',
      };
    case 'error':
      return {
        icon: (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ),
        colorClass: 'text-accent-red',
      };
    default:
      return {
        icon: <span className="w-3 h-3" />,
        colorClass: 'text-text-muted',
      };
  }
}

/**
 * Tool Use Card Component
 */
export function ToolUseCard({ toolCall, compact = false }: ToolUseCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ visible: boolean; x: number; y: number }>({
    visible: false,
    x: 0,
    y: 0,
  });

  const openFile = useCodePreviewStore(state => state.openFile);

  const style = TOOL_STYLES[toolCall.name] || DEFAULT_STYLE;
  const statusInfo = getStatusInfo(toolCall.status);
  const isError = toolCall.status === 'error';

  // Extract file path from input
  const filePath = FILE_TOOLS.has(toolCall.name)
    ? (toolCall.input.file_path as string | undefined)
    : undefined;

  // Extract command string
  const command = toolCall.input.command as string | undefined;

  // Summary text for collapsed view
  const summaryText = useMemo(() => {
    if (filePath) return filePath;
    if (command) return String(command).slice(0, 60);
    if (toolCall.output) return toolCall.output.slice(0, 60);
    return '';
  }, [filePath, command, toolCall.output]);

  // Context menu items
  const menuItems = useMemo(() => {
    const items = [
      {
        label: expanded ? '折叠详情' : '展开详情',
        onClick: () => setExpanded(v => !v),
      },
      { type: 'divider' as const },
      {
        label: '复制工具名称',
        onClick: () => navigator.clipboard.writeText(toolCall.name),
      },
      {
        label: '复制输入参数',
        onClick: () => navigator.clipboard.writeText(JSON.stringify(toolCall.input, null, 2)),
        disabled: Object.keys(toolCall.input).length === 0,
      },
      {
        label: '复制执行结果',
        onClick: () => navigator.clipboard.writeText(toolCall.output || ''),
        disabled: !toolCall.output,
      },
    ];

    if (filePath) {
      items.push({ type: 'divider' as const });
      items.push({
        label: '打开文件',
        onClick: () => openFile(filePath),
      });
      items.push({
        label: '复制文件路径',
        onClick: () => navigator.clipboard.writeText(filePath),
      });
    }

    if (command) {
      items.push({ type: 'divider' as const });
      items.push({
        label: '复制命令',
        onClick: () => navigator.clipboard.writeText(command),
      });
    }

    return items;
  }, [expanded, toolCall, filePath, command, openFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  const toggleExpand = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  return (
    <div className={compact ? 'my-0.5 mx-1' : 'my-1 mx-2'}>
      {/* Header button */}
      <button
        onClick={toggleExpand}
        onContextMenu={handleContextMenu}
        className={`
          w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono
          ${isError
            ? 'bg-bg-secondary text-accent-red'
            : 'bg-bg-tertiary text-text-primary hover:bg-bg-hover'
          } transition-colors
        `}
      >
        {/* Expand/collapse indicator */}
        <span className="text-[10px] text-text-muted">{expanded ? '▼' : '▶'}</span>

        {/* Tool icon */}
        <span>{style.icon}</span>

        {/* Tool name */}
        <span className={`font-semibold ${style.color}`}>{toolCall.name}</span>

        {/* Summary text */}
        {summaryText && (
          <span className="text-text-muted truncate flex-1">{summaryText}</span>
        )}

        {/* Status icon */}
        <span className={statusInfo.colorClass}>{statusInfo.icon}</span>

        {/* Duration */}
        {toolCall.duration !== undefined && toolCall.duration > 0 && (
          <span className="text-text-muted text-[10px]">
            {toolCall.duration < 1000 ? `${toolCall.duration}ms` : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}

        {/* Error indicator */}
        {isError && (
          <span className="text-accent-red text-[10px] font-bold">ERROR</span>
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-1 mx-1 p-2 rounded bg-bg-secondary text-xs font-mono border border-border overflow-auto max-h-[300px]">
          {/* Tool input */}
          {Object.keys(toolCall.input).length > 0 && (
            <div className="mb-2">
              <div className="text-text-muted mb-1">Input:</div>
              <pre className="text-text-primary whitespace-pre-wrap break-all">
                <code dangerouslySetInnerHTML={{ __html: renderJsonValue(toolCall.input) }} />
              </pre>
            </div>
          )}

          {/* Tool output */}
          {toolCall.output && (
            <div>
              <div className="text-text-muted mb-1">Output:</div>
              <pre className={`whitespace-pre-wrap break-all ${isError ? 'text-accent-red' : 'text-text-primary'}`}>
                {toolCall.output.length > 2000
                  ? toolCall.output.slice(0, 2000) + '\n... (truncated)'
                  : toolCall.output
                }
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu.visible && (
        <div
          className="fixed z-50 bg-bg-primary border border-border rounded-lg shadow-lg py-1 min-w-[150px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {menuItems.map((item, idx) => {
            if (item.type === 'divider') {
              return <div key={idx} className="border-t border-border my-1" />;
            }
            return (
              <button
                key={idx}
                onClick={() => {
                  item.onClick();
                  closeContextMenu();
                }}
                disabled={item.disabled}
                className={`
                  w-full text-left px-3 py-1.5 text-xs text-text-primary
                  ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-bg-hover'}
                `}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Click outside to close context menu */}
      {contextMenu.visible && (
        <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
      )}
    </div>
  );
}
