/**
 * Active State Detection Utility
 * Following SpectrAI architecture pattern
 * Detects active state based on position instead of status field traversal
 * @module utils/isGroupActive
 */

import type { GroupedMessage, ToolOperationGroup } from './messageGrouping';

/**
 * Check if a tool operation group is currently active
 *
 * SpectrAI Architecture Principle:
 * A group is considered active ONLY when BOTH conditions are met:
 * 1. Position condition: The group is at the end of the messages list
 *    (or followed only by streaming assistant messages)
 * 2. Pending condition: The group has at least one tool call with 'pending' status
 *
 * This position-based detection is more efficient than traversing status fields
 * and naturally matches the UI's need to highlight the currently-executing group.
 *
 * @param group The tool operation group to check
 * @param messages The full list of grouped messages
 * @param index The index of the group in the messages list (optional, will be calculated if not provided)
 * @returns Whether the group is currently active
 */
export function isGroupActive(
  group: ToolOperationGroup,
  messages: GroupedMessage[],
  index?: number
): boolean {
  // Find the group's position if index not provided
  const groupIndex = index ?? messages.findIndex(m =>
    'type' in m && m.type === 'tool_operation_group' && m.id === group.id
  );

  // Group not found in messages
  if (groupIndex === -1) {
    return false;
  }

  // Check if there are any non-streaming messages after this group
  for (let i = groupIndex + 1; i < messages.length; i++) {
    const nextMessage = messages[i];

    // If next message is a tool operation group, this group is not active
    if ('type' in nextMessage && nextMessage.type === 'tool_operation_group') {
      return false;
    }

    // If next message is a regular message
    if ('role' in nextMessage) {
      // Streaming assistant messages don't count as "after"
      // (the AI is still responding, so the tool group could be waiting for more)
      if (nextMessage.role === 'assistant' && nextMessage.isStreaming) {
        continue;
      }

      // Any other non-streaming message means this group is not active
      return false;
    }
  }

  // No messages after this group (or only streaming assistant messages)
  // Check if any tool calls are still pending
  return group.toolCalls.some(tc => tc.status === 'pending');
}

/**
 * Check if any tool operation group in the messages is currently active
 *
 * @param messages The full list of grouped messages
 * @returns Whether any group is active
 */
export function hasActiveGroup(messages: GroupedMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if ('type' in message && message.type === 'tool_operation_group') {
      if (isGroupActive(message, messages, i)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get the active tool operation group from messages
 *
 * @param messages The full list of grouped messages
 * @returns The active group, or undefined if none
 */
export function getActiveGroup(messages: GroupedMessage[]): ToolOperationGroup | undefined {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if ('type' in message && message.type === 'tool_operation_group') {
      const group = message as ToolOperationGroup;
      if (isGroupActive(group, messages, i)) {
        return group;
      }
    }
  }
  return undefined;
}

/**
 * Get the last tool operation group from messages
 * The last group is the one closest to the end that contains tool operations
 *
 * @param messages The full list of grouped messages
 * @returns The last group, or undefined if none
 */
export function getLastGroup(messages: GroupedMessage[]): ToolOperationGroup | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ('type' in message && message.type === 'tool_operation_group') {
      return message as ToolOperationGroup;
    }
  }
  return undefined;
}

/**
 * Check if a specific message is the last content-producing message
 * This is useful for determining if an assistant message should show streaming indicators
 *
 * @param messageIndex The index of the message to check
 * @param messages The full list of grouped messages
 * @returns Whether the message is the last content-producing message
 */
export function isLastContentMessage(
  messageIndex: number,
  messages: GroupedMessage[]
): boolean {
  const message = messages[messageIndex];

  // Tool operation groups are not content-producing messages
  if ('type' in message && message.type === 'tool_operation_group') {
    return false;
  }

  // Check if there are any content messages after this one
  for (let i = messageIndex + 1; i < messages.length; i++) {
    const nextMessage = messages[i];

    // Skip tool operation groups
    if ('type' in nextMessage && nextMessage.type === 'tool_operation_group') {
      continue;
    }

    // Found another content message after this one
    return false;
  }

  // This is the last content message
  return true;
}
