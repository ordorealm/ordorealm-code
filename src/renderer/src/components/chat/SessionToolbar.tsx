/**
 * Session Toolbar Component
 *
 * Displays skill count, MCP status buttons, and context usage above the chat input.
 * Provides quick access to slash commands and MCP server status.
 * Skills and MCP are dynamically discovered from SDK init data.
 *
 * @module components/chat/SessionToolbar
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useProjectStore } from '@/stores/project-store';
import { SkillLibrarySelector } from './SkillLibrarySelector';
import type { SessionInitData, McpServerInfo, PluginInfo, TokenUsage } from '@/types';

/**
 * Skill item for display in popover
 */
export interface SkillItem {
  /** Slash command (without /) */
  slashCommand: string;
  /** Display name */
  name: string;
  /** Description (optional) */
  description?: string;
  /** Source type */
  source: 'builtin' | 'project';
  /** Source category label */
  category: string;
}

/** Source group configuration */
interface SourceGroup {
  key: 'builtin' | 'project';
  label: string;
  dotColor: string;
  order: number;
}

/** Skill source group definitions */
const SKILL_SOURCE_GROUPS: SourceGroup[] = [
  { key: 'builtin', label: '内置技能', dotColor: 'bg-text-muted', order: 1 },
  { key: 'project', label: '项目技能', dotColor: 'bg-accent-purple', order: 2 },
];

/** MCP source group definitions */
const MCP_SOURCE_GROUPS: SourceGroup[] = [
  { key: 'builtin', label: '内置MCP', dotColor: 'bg-text-muted', order: 1 },
  { key: 'project', label: '项目MCP', dotColor: 'bg-accent-green', order: 2 },
];

/**
 * Known built-in slash commands (CLI native)
 */
const KNOWN_BUILTIN_SLASH_COMMANDS = [
  'compact',
  'memory',
  'config',
  'cost',
  'doctor',
  'help',
  'clear',
  'init',
  'terminal-setup',
  'mcp',
  'review',
  'security-review',
  'context',
  'heapdump',
  'usage',
  'insights',
  'goal',
  'team-onboarding',
];

/**
 * Known built-in skill names (come with Claude Code by default)
 */
const KNOWN_BUILTIN_SKILLS = [
  'update-config',
  'keybindings-help',
  'simplify',
  'less-permission-prompts',
  'loop',
  'claude-api',
  'debug',
  'batch',
  'fewer-permission-prompts',
];

/**
 * Known built-in MCP server names
 */
const KNOWN_BUILTIN_MCP_SERVERS = [
  'pencil',
  'spectrai-agent',
];

interface SessionToolbarProps {
  /** Session ID */
  sessionId: string;
  /** Callback when skill is clicked - inserts command to input */
  onSkillClick?: (command: string) => void;
}

/**
 * Hook for popover close logic (click outside + Esc)
 */
function usePopoverClose(
  open: boolean,
  setOpen: (v: boolean) => void,
  btnRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>
) {
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open, setOpen, btnRef, panelRef]);
}

/**
 * Categorize a skill/command as built-in or project-level
 */
function categorizeSkill(
  slashCommand: string,
  cwd?: string,
  plugins?: PluginInfo[]
): 'builtin' | 'project' {
  // Known built-in slash commands
  if (KNOWN_BUILTIN_SLASH_COMMANDS.includes(slashCommand)) {
    return 'builtin';
  }

  // Known built-in skills
  if (KNOWN_BUILTIN_SKILLS.includes(slashCommand)) {
    return 'builtin';
  }

  // Check if the skill comes from a project-level plugin
  if (cwd && plugins && plugins.length > 0) {
    const matchingPlugin = plugins.find(p =>
      p.name === slashCommand ||
      p.name.includes(slashCommand) ||
      slashCommand.includes(p.name)
    );
    if (matchingPlugin && matchingPlugin.path.startsWith(cwd)) {
      return 'project';
    }
  }

  // If we have plugins info and this skill doesn't match any plugin, it's likely built-in
  // If we don't have plugins info, default to built-in
  return 'builtin';
}

/**
 * Categorize an MCP server as built-in or project-level
 */
function categorizeMcpServer(
  serverName: string,
  cwd?: string,
  plugins?: PluginInfo[]
): 'builtin' | 'project' {
  // Known built-in MCP servers
  if (KNOWN_BUILTIN_MCP_SERVERS.includes(serverName)) {
    return 'builtin';
  }

  // Check if the MCP server comes from a project-level plugin
  if (cwd && plugins) {
    const matchingPlugin = plugins.find(p =>
      p.name === serverName ||
      p.name.includes(serverName) ||
      serverName.includes(p.name)
    );
    if (matchingPlugin && matchingPlugin.path.startsWith(cwd)) {
      return 'project';
    }
  }

  // Default to project for unknown MCP servers
  return 'project';
}

/**
 * Session Toolbar Component
 */
export function SessionToolbar({ sessionId, onSkillClick }: SessionToolbarProps): JSX.Element {
  const [skillPopoverOpen, setSkillPopoverOpen] = useState(false);
  const [mcpPopoverOpen, setMcpPopoverOpen] = useState(false);
  const [skillFilter, setSkillFilter] = useState('');
  const [expandedMcp, setExpandedMcp] = useState<string | null>(null);

  const skillBtnRef = useRef<HTMLButtonElement>(null);
  const skillPopoverRef = useRef<HTMLDivElement>(null);
  const skillFilterRef = useRef<HTMLInputElement>(null);
  const mcpBtnRef = useRef<HTMLButtonElement>(null);
  const mcpPopoverRef = useRef<HTMLDivElement>(null);

  // Get session init data from store
  const session = useSessionStore(state => state.sessions[sessionId]);
  const initData = session?.initData as SessionInitData | undefined;
  const restartSession = useSessionStore(state => state.restartSession);

  // Get project for path lookup (same pattern as ContextUsage)
  const project = useProjectStore(state => {
    const p = state.projects.find(p => p.id === session?.projectId);
    return p;
  });

  // Handle skill library activation → restart session to reload skills
  const handleLibraryActivated = useCallback(async () => {
    console.log('[SessionToolbar] Skill library activated, restarting session:', sessionId);
    try {
      await restartSession(sessionId);
      console.log('[SessionToolbar] Session restarted successfully after library activation');
    } catch (err) {
      console.error('[SessionToolbar] Failed to restart session after library activation:', err);
    }
  }, [sessionId, restartSession]);

  // Popover close hooks
  usePopoverClose(skillPopoverOpen, setSkillPopoverOpen, skillBtnRef, skillPopoverRef);
  usePopoverClose(mcpPopoverOpen, setMcpPopoverOpen, mcpBtnRef, mcpPopoverRef);

  // Focus filter on popover open
  useEffect(() => {
    if (skillPopoverOpen) {
      setTimeout(() => skillFilterRef.current?.focus(), 50);
    } else {
      setSkillFilter('');
    }
  }, [skillPopoverOpen]);

  // Build skill list from SDK init data
  // Falls back to known built-in commands when initData is not yet available
  const skillList = useMemo(() => {
    const skills: SkillItem[] = [];
    const cwd = initData?.cwd;
    const plugins = initData?.plugins;
    const projectSkillNames = initData?.projectSkillNames || [];

    // If initData is not yet available, show known built-in commands as fallback
    if (!initData) {
      for (const cmd of KNOWN_BUILTIN_SLASH_COMMANDS) {
        skills.push({
          slashCommand: cmd,
          name: cmd,
          description: 'CLI 原生命令',
          source: 'builtin',
          category: '内置技能',
        });
      }
      return skills;
    }

    // Add slash commands (includes both CLI native commands and project skills)
    // SDK returns project skills as slashCommands
    const slashCommands = initData.slashCommands || [];
    for (const cmd of slashCommands) {
      // 优先判断是否为项目技能（项目目录下存在同名技能）
      const isProject = projectSkillNames.includes(cmd);
      // 如果不是项目技能，再判断是否为已知内置技能
      const isBuiltin = !isProject && (KNOWN_BUILTIN_SLASH_COMMANDS.includes(cmd) || KNOWN_BUILTIN_SKILLS.includes(cmd));
      // 其他情况默认为项目技能
      const source = isProject ? 'project' : (isBuiltin ? 'builtin' : 'project');

      skills.push({
        slashCommand: cmd,
        name: cmd,
        description: source === 'builtin' ? '内置技能' : '项目技能',
        source,
        category: source === 'builtin' ? '内置技能' : '项目技能',
      });
    }

    // Add skills from skills list (these are built-in skills)
    const skillNames = initData.skills || [];
    for (const skillName of skillNames) {
      // Skip if already added as slash command
      if (skills.some(s => s.slashCommand === skillName)) continue;

      skills.push({
        slashCommand: skillName,
        name: skillName,
        description: '内置技能',
        source: 'builtin',
        category: '内置技能',
      });
    }

    return skills;
  }, [initData]);

  // Grouped skill list for display
  const groupedSkillList = useMemo(() => {
    const groups: Record<'builtin' | 'project', SkillItem[]> = {
      builtin: [],
      project: [],
    };
    for (const skill of skillList) {
      groups[skill.source].push(skill);
    }
    return groups;
  }, [skillList]);

  // Filtered and grouped skill list
  const filteredGroupedSkillList = useMemo(() => {
    const q = skillFilter.trim().toLowerCase();
    if (!q) return groupedSkillList;

    const filtered: Record<'builtin' | 'project', SkillItem[]> = {
      builtin: [],
      project: [],
    };
    for (const skill of skillList) {
      if (
        skill.slashCommand.toLowerCase().includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        (skill.description && skill.description.toLowerCase().includes(q))
      ) {
        filtered[skill.source].push(skill);
      }
    }
    return filtered;
  }, [skillList, skillFilter, groupedSkillList]);

  // MCP list from session init data with categorization
  const mcpList = useMemo(() => {
    const cwd = initData?.cwd;
    const plugins = initData?.plugins;
    const mcpServers = initData?.mcpServers || [];

    // Parse tools to get tool count per MCP server
    const toolsByServer: Record<string, number> = {};
    const tools = initData?.tools || [];
    for (const tool of tools) {
      const toolStr = String(tool);
      if (toolStr.startsWith('mcp__')) {
        const withoutPrefix = toolStr.slice('mcp__'.length);
        const secondSep = withoutPrefix.indexOf('__');
        if (secondSep > 0) {
          const serverKey = withoutPrefix.slice(0, secondSep);
          toolsByServer[serverKey] = (toolsByServer[serverKey] || 0) + 1;
        }
      }
    }

    // Build MCP server list with categorization
    return mcpServers.map((mcp: McpServerInfo) => {
      const name = typeof mcp === 'string' ? mcp : mcp.name;
      const status = typeof mcp === 'string' ? 'connected' : mcp.status;
      const source = categorizeMcpServer(name, cwd, plugins);
      return {
        name,
        key: name,
        status,
        source,
        category: source === 'builtin' ? '内置MCP' : '项目MCP',
        toolCount: toolsByServer[name] || 0,
      };
    });
  }, [initData]);

  // Grouped MCP list for display
  const groupedMcpList = useMemo(() => {
    const groups: Record<'builtin' | 'project', typeof mcpList> = {
      builtin: [],
      project: [],
    };
    for (const mcp of mcpList) {
      groups[mcp.source].push(mcp);
    }
    return groups;
  }, [mcpList]);

  // Handle skill selection
  const handleSkillSelect = useCallback(
    (skill: SkillItem) => {
      setSkillPopoverOpen(false);
      if (onSkillClick) {
        onSkillClick(`/${skill.slashCommand} `);
      }
    },
    [onSkillClick]
  );

  // Count total filtered skills
  const totalFilteredSkills = Object.values(filteredGroupedSkillList).reduce(
    (sum, skills) => sum + skills.length,
    0
  );

  return (
    <div className="px-4 pt-2 pb-1.5 flex items-center gap-1.5 bg-bg-secondary border-t border-border">
      {/* Skill button */}
      <div className="relative flex-shrink-0">
        <button
          ref={skillBtnRef}
          onClick={() => setSkillPopoverOpen(o => !o)}
          disabled={skillList.length === 0}
          className={`
            inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
            bg-bg-tertiary border text-text-secondary
            hover:text-text-primary hover:bg-bg-hover
            transition-colors cursor-pointer select-none
            ${skillPopoverOpen ? 'border-accent-indigo text-text-primary' : 'border-border'}
            ${skillList.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          <span>⚡</span>
          <span>{skillList.length} 个 Skill</span>
        </button>

        {/* Skill Popover */}
        {skillPopoverOpen && skillList.length > 0 && (
          <div
            ref={skillPopoverRef}
            className="absolute bottom-full left-0 mb-1.5 w-80 bg-bg-primary border border-border rounded-lg shadow-lg py-1.5 z-50"
          >
            {/* Title */}
            <div className="px-3 pb-1.5 flex items-center justify-between border-b border-border">
              <span className="text-[11px] text-text-muted font-medium uppercase tracking-wide">
                可用 Skill
              </span>
            </div>

            {/* Search input */}
            <div className="px-2 pt-1.5 pb-1">
              <input
                ref={skillFilterRef}
                type="text"
                value={skillFilter}
                onChange={e => setSkillFilter(e.target.value)}
                placeholder="搜索 Skill..."
                className="w-full px-2.5 py-1 text-xs rounded-md bg-bg-secondary border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-indigo transition-colors"
              />
            </div>

            {/* Skill list - grouped by source */}
            <div className="max-h-72 overflow-y-auto">
              {totalFilteredSkills === 0 ? (
                <div className="px-3 py-4 text-xs text-text-muted text-center">
                  未找到「{skillFilter}」相关 Skill
                </div>
              ) : (
                SKILL_SOURCE_GROUPS.map(group => {
                  const skills = filteredGroupedSkillList[group.key];
                  if (skills.length === 0) return null;

                  return (
                    <div key={group.key}>
                      {/* Group header */}
                      <div className="px-3 py-1 flex items-center gap-1.5 bg-bg-secondary border-y border-border mt-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${group.dotColor}`} />
                        <span className="text-[10px] text-text-muted font-medium">
                          {group.label}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          ({skills.length})
                        </span>
                      </div>
                      {/* Group items */}
                      {skills.map(skill => (
                        <button
                          key={skill.slashCommand}
                          onClick={() => handleSkillSelect(skill)}
                          className="w-full px-3 py-1.5 flex items-start gap-2 text-left hover:bg-bg-hover transition-colors"
                        >
                          <span className="flex flex-col gap-0.5 min-w-0">
                            <span className="font-mono text-xs text-accent-indigo leading-none">
                                /{skill.slashCommand}
                              </span>
                              {skill.description && (
                                <span className="text-[11px] text-text-muted leading-snug break-words whitespace-normal">
                                  {skill.description}
                                </span>
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="px-3 pt-1 mt-0.5 border-t border-border">
                <span className="text-[10px] text-text-muted">
                  共 {skillList.length} 个 Skill
                </span>
              </div>
            </div>
          )}
        </div>

      {/* MCP status button */}
      <div className="relative flex-shrink-0">
        <button
          ref={mcpBtnRef}
          onClick={() => setMcpPopoverOpen(o => !o)}
          disabled={mcpList.length === 0}
          className={`
            inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
            bg-bg-tertiary border text-text-secondary
            hover:text-text-primary hover:bg-bg-hover
            transition-colors cursor-pointer select-none
            ${mcpPopoverOpen ? 'border-accent-indigo text-text-primary' : 'border-border'}
            ${mcpList.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          <span>🔌</span>
          <span>{mcpList.length} 个 MCP</span>
        </button>

        {/* MCP Popover */}
        {mcpPopoverOpen && mcpList.length > 0 && (
          <div
            ref={mcpPopoverRef}
            className="absolute bottom-full left-0 mb-1.5 w-64 bg-bg-primary border border-border rounded-lg shadow-lg py-1.5 z-50"
          >
            <div className="px-3 pb-1.5 text-[11px] text-text-muted font-medium uppercase tracking-wide border-b border-border mb-1">
              当前会话已启用 MCP
            </div>
            <div className="max-h-56 overflow-y-auto">
              {MCP_SOURCE_GROUPS.map(group => {
                const mcps = groupedMcpList[group.key];
                if (mcps.length === 0) return null;

                return (
                  <div key={group.key}>
                    {/* Group header */}
                    <div className="px-3 py-1 flex items-center gap-1.5 bg-bg-secondary border-y border-border mt-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${group.dotColor}`} />
                        <span className="text-[10px] text-text-muted font-medium">
                          {group.label}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          ({mcps.length})
                        </span>
                      </div>
                      {/* Group items */}
                      {mcps.map(mcp => (
                        <div key={mcp.key}>
                          {/* MCP Server Header */}
                          <button
                            onClick={() => setExpandedMcp(expandedMcp === mcp.key ? null : mcp.key)}
                            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-bg-hover transition-colors"
                          >
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${mcp.status === 'connected' ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
                            <span className="flex-1 text-xs text-text-secondary truncate text-left">
                              {mcp.name}
                            </span>
                            {mcp.toolCount > 0 && (
                              <span className="text-[10px] text-text-muted">
                                {mcp.toolCount} 工具
                              </span>
                            )}
                            {mcp.toolCount > 0 && (
                              <span className={`text-[10px] text-text-muted transition-transform ${expandedMcp === mcp.key ? 'rotate-180' : ''}`}>
                                ▼
                              </span>
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

      {/* Skill Library Selector */}
      <SkillLibrarySelector
        sessionId={sessionId}
        projectPath={project?.path || ''}
        onLibraryActivated={handleLibraryActivated}
      />

      {/* Context usage display */}
      <ContextUsage sessionId={sessionId} />
    </div>
  );
}

/**
 * Context Usage Display Component
 * Shows token usage with color-coded percentage
 * Clicking triggers compact + Claude.md reload
 */
function ContextUsage({ sessionId }: { sessionId: string }): JSX.Element | null {
  const session = useSessionStore(state => state.sessions[sessionId]);
  const triggerCompact = useSessionStore(state => state.triggerCompact);
  const project = useProjectStore(state => {
    const p = state.projects.find(p => p.id === session?.projectId);
    return p;
  });

  // Confirmation dialog state
  const [showConfirm, setShowConfirm] = useState(false);

  // Calculate usage percentage and format display
  const { usedK, totalK, percentage, colorClass } = useMemo(() => {
    const usage = session?.tokenUsage;
    if (!usage) {
      return {
        usedK: 0,
        totalK: 200,
        percentage: 0,
        colorClass: 'text-accent-green',
      };
    }

    const total = usage.contextWindow || 200000;
    const used = usage.inputTokens + usage.outputTokens;
    const pct = (used / total) * 100;

    // Determine color based on percentage
    let color: string;
    if (pct < 50) {
      color = 'text-accent-green';
    } else if (pct < 80) {
      color = 'text-accent-yellow';
    } else {
      color = 'text-accent-red';
    }

    return {
      usedK: Math.round(used / 1000 * 10) / 10, // One decimal place
      totalK: Math.round(total / 1000),
      percentage: Math.round(pct * 10) / 10,
      colorClass: color,
    };
  }, [session?.tokenUsage]);

  // Auto-compact when > 80%
  useEffect(() => {
    if (percentage > 80 && session?.tokenUsage) {
      console.log('[ContextUsage] Auto-compact triggered, percentage:', percentage);
      triggerCompact(sessionId);
    }
  }, [percentage, sessionId, session?.tokenUsage, triggerCompact]);

  // Handle click to show confirmation
  const handleClick = useCallback(() => {
    setShowConfirm(true);
  }, []);

  // Handle confirm
  const handleConfirm = useCallback(async () => {
    console.log('[ContextUsage] Manual compact confirmed');
    setShowConfirm(false);
    await triggerCompact(sessionId);
  }, [sessionId, triggerCompact]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setShowConfirm(false);
  }, []);

  // Don't render if no usage data yet
  if (!session?.tokenUsage) {
    return null;
  }

  return (
    <>
      <button
        onClick={handleClick}
        className={`
          ml-auto flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5
          rounded-md text-xs bg-bg-tertiary border border-border
          hover:bg-bg-hover transition-colors cursor-pointer select-none
          ${colorClass}
        `}
        title="点击压缩上下文并重新加载 Claude.md"
      >
        <span>📊</span>
        <span>{usedK}K/{totalK}K</span>
        <span className="text-[10px]">({percentage}%)</span>
      </button>

      {/* Confirm Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-primary border border-border rounded-lg shadow-xl p-4 max-w-sm mx-4">
            <h3 className="text-lg font-medium text-text-primary mb-2">压缩会话</h3>
            <p className="text-sm text-text-secondary mb-4">
              确定要压缩当前会话吗？<br />
              压缩后会自动重新加载项目的 Claude.md 文件。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-md transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirm}
                className="px-3 py-1.5 text-sm bg-accent-indigo text-white rounded-md hover:bg-accent-indigo/80 transition-colors"
              >
                确认压缩
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
