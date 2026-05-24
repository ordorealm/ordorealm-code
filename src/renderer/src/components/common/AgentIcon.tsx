/**
 * Agent Icon Component
 * Displays the icon for different Agent types
 * @module components/common/AgentIcon
 */

import type { AgentType } from '@/types';

interface AgentIconProps {
  /** Agent type */
  agentType: AgentType;
  /** Icon size */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS classes */
  className?: string;
}

/**
 * Agent configuration for display
 */
const AGENT_CONFIG: Record<
  AgentType,
  {
    icon: string;
    label: string;
    bgColor: string;
    textColor: string;
  }
> = {
  'claude-code': {
    icon: '🟣',
    label: 'Claude Code',
    bgColor: 'bg-purple-500/20',
    textColor: 'text-purple-400',
  },
  codex: {
    icon: '🔵',
    label: 'Codex',
    bgColor: 'bg-blue-500/20',
    textColor: 'text-blue-400',
  },
  opencode: {
    icon: '🟢',
    label: 'OpenCode',
    bgColor: 'bg-green-500/20',
    textColor: 'text-green-400',
  },
};

/**
 * Size classes for the icon container
 */
const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'w-5 h-5 text-xs',
  md: 'w-6 h-6 text-sm',
  lg: 'w-8 h-8 text-base',
};

/**
 * Icon size multipliers
 */
const ICON_SIZES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-[10px]',
  md: 'text-xs',
  lg: 'text-sm',
};

/**
 * AgentIcon component
 * Renders a colored icon representing the Agent type
 */
export function AgentIcon({
  agentType,
  size = 'md',
  className = '',
}: AgentIconProps): JSX.Element {
  const config = AGENT_CONFIG[agentType];
  const sizeClass = SIZE_CLASSES[size];
  const iconSize = ICON_SIZES[size];

  return (
    <div
      className={`
        inline-flex items-center justify-center rounded-md
        ${sizeClass} ${config.bgColor}
        ${className}
      `}
      title={config.label}
    >
      <span className={iconSize}>{config.icon}</span>
    </div>
  );
}

/**
 * Get agent display configuration
 * @param agentType Agent type
 * @returns Agent configuration for display
 */
export function getAgentConfig(agentType: AgentType) {
  return AGENT_CONFIG[agentType];
}

/**
 * Agent Badge Component
 * Displays the Agent type with label
 */
interface AgentBadgeProps {
  /** Agent type */
  agentType: AgentType;
  /** Badge size */
  size?: 'sm' | 'md' | 'lg';
  /** Show icon */
  showIcon?: boolean;
  /** Additional CSS classes */
  className?: string;
}

export function AgentBadge({
  agentType,
  size = 'md',
  showIcon = true,
  className = '',
}: AgentBadgeProps): JSX.Element {
  const config = AGENT_CONFIG[agentType];

  const paddingClasses: Record<'sm' | 'md' | 'lg', string> = {
    sm: 'px-1.5 py-0.5 text-xs',
    md: 'px-2 py-1 text-xs',
    lg: 'px-2.5 py-1 text-sm',
  };

  return (
    <span
      className={`
        inline-flex items-center gap-1 rounded-md
        ${paddingClasses[size]}
        ${config.bgColor} ${config.textColor}
        ${className}
      `}
    >
      {showIcon && <AgentIcon agentType={agentType} size={size} />}
      <span>{config.label}</span>
    </span>
  );
}
