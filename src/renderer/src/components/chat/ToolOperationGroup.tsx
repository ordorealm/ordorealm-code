/**
 * Tool Operation Group Component
 *
 * Groups consecutive tool_use + tool_result messages into a collapsible block,
 * preventing tool calls from flooding the conversation flow.
 *
 * Collapsed: Shows summary (operation count + tool category count + last operation)
 * Expanded: Shows all tool operations (using ToolUseCard)
 * Active state (running): Shows spinner + real-time timer
 *
 * @module components/chat/ToolOperationGroup
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import type { ToolOperationGroup as ToolOperationGroupType } from '@/utils/messageGrouping';
import { ToolUseCard } from './ToolUseCard';

interface ToolOperationGroupProps {
  /** The tool operation group data */
  group: ToolOperationGroupType;
  /** Whether this is the active (running) group */
  isActive?: boolean;
}

/** Format milliseconds to readable duration */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Tool name to icon mapping */
const TOOL_ICONS: Record<string, string> = {
  // Claude Code tools
  Read: '📄',
  Write: '✏️',
  Edit: '📝',
  Bash: '⚡',
  Glob: '🔍',
  Grep: '🔎',
  WebSearch: '🌐',
  Task: '🤖',
  // iFlow CLI tools
  read_file: '📄',
  image_read: '🖼️',
  read_many_files: '📂',
  write_file: '✏️',
  replace: '📝',
  multi_edit: '📝',
  run_shell_command: '⚡',
  search_file_content: '🔎',
  list_directory: '📁',
  web_search: '🌐',
  web_fetch: '🌐',
  task: '🤖',
  save_memory: '💾',
  todo_read: '📋',
  todo_write: '📋',
  ask_user_questions: '❓',
  exit_plan_mode: '🚪',
};

/**
 * Get icon for a tool name
 */
function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || '🔧';
}

/**
 * Tool Operation Group Component
 */
export function ToolOperationGroup({ group, isActive = false }: ToolOperationGroupProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Calculate tool counts by name
  const toolCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tc of group.toolCalls) {
      counts[tc.name] = (counts[tc.name] || 0) + 1;
    }
    return counts;
  }, [group.toolCalls]);

  const toolCount = group.toolCalls.length;

  // Last tool call for summary
  const lastToolCall = group.toolCalls[group.toolCalls.length - 1];

  // Completed duration
  const completedDuration = useMemo(() => {
    if (isActive || group.totalDuration === 0) return null;
    if (group.totalDuration < 100) return null;
    return formatDuration(group.totalDuration);
  }, [group.totalDuration, isActive]);

  // Active group: real-time timer
  const [activeDurationSecs, setActiveDurationSecs] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const startTime = new Date(group.timestamp).getTime();
    const update = () => setActiveDurationSecs(Math.floor((Date.now() - startTime) / 1000));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isActive, group.timestamp]);

  // Last tool call summary
  const lastSummary = useMemo(() => {
    if (!lastToolCall) return '';
    const name = lastToolCall.name;
    const input = lastToolCall.input;
    if (!input || Object.keys(input).length === 0) return name;

    // Extract relevant info based on common patterns
    const filePath = input.file_path as string | undefined;
    const command = input.command as string | undefined;
    const pattern = input.pattern as string | undefined;

    if (filePath) return `${name} ${filePath}`;
    if (command) return `${name} ${String(command).slice(0, 60)}`;
    if (pattern) return `${name} pattern: ${pattern}`;
    return name;
  }, [lastToolCall]);

  const toggleExpand = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  return (
    <div
      className={`
        my-2 mx-2 rounded-lg overflow-hidden border-l-2 transition-colors
        ${isActive
          ? 'border-accent-indigo bg-bg-secondary/50'
          : group.hasError
            ? 'border-accent-red/60 bg-bg-secondary/30'
            : 'border-accent-indigo/40 bg-bg-secondary/30'
        }
      `}
    >
      {/* Summary header */}
      <button
        onClick={toggleExpand}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-hover/50 transition-colors"
      >
        {/* Expand/collapse indicator */}
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {expanded ? '▼' : '▶'}
        </span>

        {/* Spinner (active state) */}
        {isActive && (
          <svg className="w-3 h-3 animate-spin text-accent-indigo flex-shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}

        {/* Tool icon */}
        <span className="text-xs flex-shrink-0">🔧</span>

        {/* Operation count + duration */}
        <span className="text-xs font-medium text-text-primary flex-shrink-0">
          {isActive ? (
            <>
              正在执行
              <span className="text-text-muted font-normal">
                （{toolCount} 个操作{activeDurationSecs > 0 && <> · {activeDurationSecs}s</>}）
              </span>
            </>
          ) : (
            <>
              执行了 {toolCount} 个操作
              {completedDuration && (
                <span className="text-text-muted font-normal"> · {completedDuration}</span>
              )}
            </>
          )}
        </span>

        {/* Tool category tags */}
        <span className="flex items-center gap-1.5 flex-shrink-0 overflow-hidden">
          {Object.entries(toolCounts).map(([name, count]) => (
            <span
              key={name}
              className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded font-mono"
            >
              {getToolIcon(name)}{name}({count})
            </span>
          ))}
        </span>

        {/* Error indicator */}
        {group.hasError && (
          <span className="text-[10px] text-accent-red font-bold flex-shrink-0">ERROR</span>
        )}
      </button>

      {/* Last operation summary when collapsed */}
      {!expanded && lastToolCall && lastSummary && (
        <div className="px-3 pb-2 -mt-1">
          <span className="text-[11px] text-text-muted font-mono truncate block">
            最近: {lastSummary}
          </span>
        </div>
      )}

      {/* Expanded tool operation list */}
      {expanded && group.toolCalls.length > 0 && (
        <div className="border-t border-border/30">
          {group.toolCalls.map(toolCall => (
            <ToolUseCard
              key={toolCall.id}
              toolCall={toolCall}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}
