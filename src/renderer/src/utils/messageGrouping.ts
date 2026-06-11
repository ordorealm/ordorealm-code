/**
 * Message grouping utilities
 * Refactored to follow SpectrAI architecture pattern
 * Groups consecutive tool_use + tool_result messages into ToolOperationGroup
 * @module utils/messageGrouping
 */

import type { ChatMessage } from '@/types';

/**
 * Tool call representation for display in groups
 * Derived from independent tool_use and tool_result messages
 */
export interface GroupedToolCall {
  /** Unique identifier (toolUseId from tool_use message) */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Tool output/result (from corresponding tool_result message) */
  output?: string;
  /** Tool call status (derived from presence of tool_result) */
  status: 'pending' | 'running' | 'completed' | 'error';
  /** Execution duration in milliseconds */
  duration?: number;
  /** Whether the tool result is an error */
  isError?: boolean;
}

/**
 * Tool operation group representing a sequence of related tool calls
 * Following SpectrAI architecture: groups independent tool_use and tool_result messages
 */
export interface ToolOperationGroup {
  /** Unique identifier for the group */
  id: string;
  /** Group type identifier */
  type: 'tool_operation_group';
  /** List of tool calls in this group */
  toolCalls: GroupedToolCall[];
  /** Whether the group is expanded in UI */
  isExpanded?: boolean;
  /** Whether any tool in the group has error */
  hasError: boolean;
  /** Whether the group is still running (any tool without result) */
  isRunning: boolean;
  /** Total duration of all tool calls */
  totalDuration: number;
  /** Start timestamp of the group */
  timestamp: string;
  /** Summary text for collapsed view */
  summary: string;
}

/**
 * Message that can be either a regular message or a tool operation group
 */
export type GroupedMessage = ChatMessage | ToolOperationGroup;

/**
 * Check if a message is a tool operation group
 */
export function isToolOperationGroup(message: GroupedMessage): message is ToolOperationGroup {
  return 'type' in message && message.type === 'tool_operation_group';
}

/**
 * Tool category mapping for summary display
 */
const TOOL_CATEGORIES: Record<string, string> = {
  // File operations
  'read': '文件读取',
  'write': '文件写入',
  'edit': '文件编辑',
  'glob': '文件搜索',
  'grep': '内容搜索',
  'bash': '命令执行',

  // Agent operations
  'agent': 'Agent调用',
  'task': '任务执行',

  // MCP tools
  'mcp': 'MCP工具',

  // Default
  'default': '工具',
};

/**
 * Get category for a tool name
 */
function getToolCategory(toolName: string): string {
  const lowerName = toolName.toLowerCase();

  // Check for exact match first
  if (TOOL_CATEGORIES[lowerName]) {
    return TOOL_CATEGORIES[lowerName];
  }

  // Check for prefix match
  for (const [key, category] of Object.entries(TOOL_CATEGORIES)) {
    if (lowerName.startsWith(key) || lowerName.includes(key)) {
      return category;
    }
  }

  // Check for MCP pattern (mcp__server__tool)
  if (lowerName.startsWith('mcp__')) {
    return TOOL_CATEGORIES['mcp'];
  }

  return TOOL_CATEGORIES['default'];
}

/**
 * Generate summary for a tool operation group
 */
function generateGroupSummary(toolCalls: GroupedToolCall[]): string {
  if (toolCalls.length === 0) {
    return '无工具调用';
  }

  if (toolCalls.length === 1) {
    const tc = toolCalls[0];
    const category = getToolCategory(tc.name);
    return `${category}: ${tc.name}`;
  }

  // Count by category
  const categoryCounts = new Map<string, number>();
  for (const tc of toolCalls) {
    const category = getToolCategory(tc.name);
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  }

  // Build summary
  const parts: string[] = [];
  for (const [category, count] of categoryCounts) {
    parts.push(`${category}(${count})`);
  }

  return `${toolCalls.length}个工具: ${parts.join(', ')}`;
}

/**
 * Check if a message is a tool_use message (SpectrAI architecture)
 */
function isToolUseMessage(message: ChatMessage): boolean {
  return message.role === 'tool_use';
}

/**
 * Check if a message is a tool_result message (SpectrAI architecture)
 */
function isToolResultMessage(message: ChatMessage): boolean {
  return message.role === 'tool_result';
}

/**
 * Group messages following SpectrAI architecture
 *
 * Algorithm:
 * 1. Iterate through messages
 * 2. When encountering tool_use messages, collect them and their corresponding tool_result messages
 * 3. Group consecutive tool operations together
 * 4. When encountering a different message, close the group and add it to result
 *
 * @param messages List of chat messages (with independent tool_use/tool_result messages)
 * @returns List of grouped messages (regular messages or ToolOperationGroup)
 */
export function groupMessages(messages: ChatMessage[]): GroupedMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const result: GroupedMessage[] = [];
  const processedIds = new Set<string>(); // Track processed message IDs
  const seenToolUseIds = new Set<string>(); // Track seen toolUseIds for deduplication
  let currentToolCalls: GroupedToolCall[] = [];
  let groupStartTime: string | null = null;
  let groupIndex = 0;

  // Build a map of toolUseId -> tool_result for quick lookup
  const toolResultMap = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (isToolResultMessage(message) && message.toolUseId) {
      toolResultMap.set(message.toolUseId, message);
    }
  }

  // Track orphan tool_result messages for warning
  const orphanToolResults: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Skip already processed messages (e.g., tool_result matched to tool_use)
    if (processedIds.has(message.id)) {
      continue;
    }

    if (isToolUseMessage(message)) {
      // ★ Deduplication: Skip if we've already seen this toolUseId
      const toolUseId = message.toolUseId || message.id;
      if (seenToolUseIds.has(toolUseId)) {
        console.warn('[messageGrouping] Skipping duplicate tool_use with toolUseId:', toolUseId);
        continue;
      }
      seenToolUseIds.add(toolUseId);

      // Start or continue a tool operation group
      if (groupStartTime === null) {
        groupStartTime = message.timestamp;
      }

      // Create GroupedToolCall from tool_use message
      const toolCall: GroupedToolCall = {
        id: toolUseId,
        name: message.toolName || 'unknown',
        input: message.toolInput || {},
        status: 'pending',
      };

      // Check for corresponding tool_result
      if (message.toolUseId) {
        const toolResult = toolResultMap.get(message.toolUseId);
        if (toolResult) {
          toolCall.output = toolResult.toolResult || toolResult.content;

          // ★ 特殊处理：AskUserQuestion 的 "deny" 实际上是用户回答，不是错误
          // SDK 的 canUseTool 返回 { behavior: 'deny', message: '用户答案' } 时
          // 会标记为 isError，但这对于 AskUserQuestion 来说不是真正的错误
          if (toolResult.isError) {
            if (toolCall.name === 'AskUserQuestion' &&
                (toolCall.output?.includes('用户已回答') ||
                 toolCall.output?.includes('User answered'))) {
              // 用户回答了问题，这是成功状态
              toolCall.status = 'completed';
              toolCall.isError = false;
            } else {
              toolCall.status = 'error';
              toolCall.isError = true;
            }
          } else {
            toolCall.status = 'completed';
          }
          processedIds.add(toolResult.id); // Mark tool_result as processed
        }
      } else {
        // No toolUseId means we can't match the result, mark as error status
        console.warn('[messageGrouping] tool_use message missing toolUseId:', message.id);
        toolCall.status = 'error';
        toolCall.isError = true;
      }

      currentToolCalls.push(toolCall);
    } else if (isToolResultMessage(message)) {
      // Standalone tool_result (no matching tool_use found)
      // This can happen if tool_result comes before tool_use or if there's orphan data
      orphanToolResults.push(message);
      console.warn('[messageGrouping] Orphan tool_result message found:', {
        id: message.id,
        toolUseId: message.toolUseId,
        toolName: message.toolName,
      });
      continue;
    } else {
      // Non-tool message (user, assistant, system)
      // Close any open tool group first
      if (currentToolCalls.length > 0) {
        const group: ToolOperationGroup = {
          id: `tool-group-${groupIndex}`,
          type: 'tool_operation_group',
          toolCalls: currentToolCalls,
          hasError: currentToolCalls.some(tc => tc.isError),
          isRunning: currentToolCalls.some(tc => tc.status === 'pending'),
          totalDuration: currentToolCalls.reduce((sum, tc) => sum + (tc.duration || 0), 0),
          timestamp: groupStartTime || new Date().toISOString(),
          summary: generateGroupSummary(currentToolCalls),
        };
        result.push(group);
        groupIndex++;
        currentToolCalls = [];
        groupStartTime = null;
      }

      // Add the non-tool message
      result.push(message);
    }
  }

  // Close any remaining tool group
  if (currentToolCalls.length > 0) {
    const group: ToolOperationGroup = {
      id: `tool-group-${groupIndex}`,
      type: 'tool_operation_group',
      toolCalls: currentToolCalls,
      hasError: currentToolCalls.some(tc => tc.isError),
      isRunning: currentToolCalls.some(tc => tc.status === 'pending'),
      totalDuration: currentToolCalls.reduce((sum, tc) => sum + (tc.duration || 0), 0),
      timestamp: groupStartTime || new Date().toISOString(),
      summary: generateGroupSummary(currentToolCalls),
    };
    result.push(group);
  }

  return result;
}

/**
 * Ungroup messages back to original format
 * Useful for operations that need the original message structure
 *
 * @param groupedMessages List of grouped messages
 * @returns List of original chat messages
 */
export function ungroupMessages(groupedMessages: GroupedMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const item of groupedMessages) {
    if (isToolOperationGroup(item)) {
      // Convert tool operation group back to independent tool_use and tool_result messages
      for (const tc of item.toolCalls) {
        // Add tool_use message
        result.push({
          id: `tool_use_${tc.id}`,
          role: 'tool_use',
          content: '',
          timestamp: item.timestamp,
          toolUseId: tc.id,
          toolName: tc.name,
          toolInput: tc.input,
        });

        // Add tool_result message if available
        if (tc.output !== undefined) {
          result.push({
            id: `tool_result_${tc.id}`,
            role: 'tool_result',
            content: tc.output,
            timestamp: item.timestamp,
            toolUseId: tc.id,
            toolName: tc.name,
            toolResult: tc.output,
            isError: tc.isError,
          });
        }
      }
    } else {
      result.push(item);
    }
  }

  return result;
}

/**
 * Get tool call statistics from a group
 */
export function getGroupStats(group: ToolOperationGroup): {
  total: number;
  completed: number;
  pending: number;
  running: number;
  error: number;
} {
  return {
    total: group.toolCalls.length,
    completed: group.toolCalls.filter(tc => tc.status === 'completed').length,
    pending: group.toolCalls.filter(tc => tc.status === 'pending').length,
    running: group.toolCalls.filter(tc => tc.status === 'running').length,
    error: group.toolCalls.filter(tc => tc.status === 'error').length,
  };
}
