/**
 * Skill Library Selector Component
 *
 * Dropdown selector for activating skill libraries in the current project.
 * Displays skill libraries grouped by Agent type with visual indicators.
 * Shows confirmation dialog before switching libraries to warn about configuration clearing.
 *
 * @module components/chat/SkillLibrarySelector
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useSkillLibraryStore } from '@/stores/skill-library-store';
import { AgentIcon, getAgentConfig } from '@/components/common/AgentIcon';
import type { SkillLibrary, AgentType } from '@/types';

/**
 * Agent group configuration for display
 */
const AGENT_GROUPS: { type: AgentType; label: string; order: number }[] = [
  { type: 'claude-code', label: 'Claude Code', order: 1 },
  { type: 'codex', label: 'Codex', order: 2 },
  { type: 'opencode', label: 'OpenCode', order: 3 },
];

/**
 * Props for SkillLibrarySelector component
 */
export interface SkillLibrarySelectorProps {
  /** Session ID for reference */
  sessionId: string;
  /** Project path for library activation */
  projectPath: string;
  /** Callback when library is successfully activated (for session restart) */
  onLibraryActivated?: () => void | Promise<void>;
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
 * Skill Library Selector Component
 *
 * Provides a dropdown interface for selecting and activating skill libraries.
 * Libraries are grouped by Agent type with color-coded indicators.
 */
export function SkillLibrarySelector({
  sessionId,
  projectPath,
  onLibraryActivated,
}: SkillLibrarySelectorProps): JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingLibrary, setPendingLibrary] = useState<SkillLibrary | null>(null);

  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Get store state and actions
  const libraries = useSkillLibraryStore(state => state.libraries);
  const activeLibraryId = useSkillLibraryStore(state => state.activeLibraryId);
  const activateLibrary = useSkillLibraryStore(state => state.activateLibrary);
  const isLoading = useSkillLibraryStore(state => state.isLoading);

  // Popover close hook
  usePopoverClose(popoverOpen, setPopoverOpen, btnRef, popoverRef);

  // Get active library
  const activeLibrary = useMemo(() => {
    if (!activeLibraryId) return null;
    return libraries.find(lib => lib.id === activeLibraryId) || null;
  }, [libraries, activeLibraryId]);

  // Group libraries by Agent type
  const groupedLibraries = useMemo(() => {
    const groups: Record<AgentType, SkillLibrary[]> = {
      'claude-code': [],
      'codex': [],
      'opencode': [],
    };

    for (const lib of libraries) {
      groups[lib.agentType].push(lib);
    }

    return groups;
  }, [libraries]);

  // Handle library selection
  const handleLibraryClick = useCallback((library: SkillLibrary | null) => {
    // If clicking the same library, do nothing
    if (library?.id === activeLibraryId) {
      setPopoverOpen(false);
      return;
    }

    // Show confirmation dialog
    setPendingLibrary(library);
    setShowConfirmDialog(true);
    setPopoverOpen(false);
  }, [activeLibraryId]);

  // Handle confirmation
  const handleConfirmSwitch = useCallback(async () => {
    if (!pendingLibrary) return;

    const success = await activateLibrary(pendingLibrary.id, projectPath);

    if (success) {
      console.log(`[SkillLibrarySelector] Activated library: ${pendingLibrary.name}`);
      // Call the callback for session restart
      await onLibraryActivated?.();
    }

    setShowConfirmDialog(false);
    setPendingLibrary(null);
  }, [pendingLibrary, projectPath, activateLibrary, onLibraryActivated]);

  // Handle deactivate (select "None")
  const handleDeactivate = useCallback(async () => {
    const success = await activateLibrary(null, projectPath);

    if (success) {
      console.log('[SkillLibrarySelector] Deactivated library');
      await onLibraryActivated?.();
    }

    setShowConfirmDialog(false);
    setPendingLibrary(null);
  }, [projectPath, activateLibrary, onLibraryActivated]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setShowConfirmDialog(false);
    setPendingLibrary(null);
  }, []);

  // Get button display text
  const buttonText = activeLibrary ? activeLibrary.name : '选择技能库...';

  return (
    <>
      {/* Selector Button */}
      <div className="relative flex-shrink-0">
        <button
          ref={btnRef}
          onClick={() => setPopoverOpen(o => !o)}
          disabled={isLoading}
          className={`
            inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs
            bg-bg-tertiary border text-text-secondary
            hover:text-text-primary hover:bg-bg-hover
            transition-colors cursor-pointer select-none
            ${popoverOpen ? 'border-accent-indigo text-text-primary' : 'border-border'}
            ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
          `}
          title={activeLibrary?.description || '选择要激活的技能库'}
        >
          {activeLibrary && (
            <AgentIcon agentType={activeLibrary.agentType} size="sm" />
          )}
          <span className="truncate max-w-32">{buttonText}</span>
          <span className="text-text-muted text-[10px]">▼</span>
        </button>

        {/* Dropdown Popover */}
        {popoverOpen && (
          <div
            ref={popoverRef}
            className="absolute bottom-full left-0 mb-1.5 w-72 bg-bg-primary border border-border rounded-lg shadow-lg py-1.5 z-50"
          >
            {/* Title */}
            <div className="px-3 pb-1.5 border-b border-border">
              <span className="text-[11px] text-text-muted font-medium uppercase tracking-wide">
                技能库
              </span>
            </div>

            {/* Library List */}
            <div className="max-h-64 overflow-y-auto">
              {/* "None" option */}
              <button
                onClick={() => handleLibraryClick(null)}
                className={`
                  w-full px-3 py-1.5 flex items-center gap-2 text-left
                  hover:bg-bg-hover transition-colors
                  ${!activeLibraryId ? 'bg-bg-hover' : ''}
                `}
              >
                <span className="w-5 h-5 flex items-center justify-center text-text-muted">
                  ○
                </span>
                <span className={`text-xs ${!activeLibraryId ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                  无
                </span>
                {!activeLibraryId && (
                  <span className="ml-auto text-[10px] text-accent-indigo">✓</span>
                )}
              </button>

              {/* Separator */}
              <div className="my-1 border-t border-border" />

              {/* Grouped libraries */}
              {AGENT_GROUPS.map(group => {
                const libs = groupedLibraries[group.type];
                if (libs.length === 0) return null;

                const config = getAgentConfig(group.type);

                return (
                  <div key={group.type}>
                    {/* Group header */}
                    <div className="px-3 py-1 flex items-center gap-1.5 bg-bg-secondary border-y border-border mt-1">
                      <AgentIcon agentType={group.type} size="sm" />
                      <span className={`text-[10px] font-medium ${config.textColor}`}>
                        {group.label}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        ({libs.length})
                      </span>
                    </div>

                    {/* Group items */}
                    {libs.map(lib => (
                      <button
                        key={lib.id}
                        onClick={() => handleLibraryClick(lib)}
                        className={`
                          w-full px-3 py-1.5 flex items-center gap-2 text-left
                          hover:bg-bg-hover transition-colors
                          ${activeLibraryId === lib.id ? 'bg-bg-hover' : ''}
                        `}
                      >
                        <AgentIcon agentType={lib.agentType} size="sm" />
                        <span className="flex-1 min-w-0">
                          <span className={`text-xs block truncate ${activeLibraryId === lib.id ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                            {lib.name}
                          </span>
                          {lib.description && (
                            <span className="text-[10px] text-text-muted block truncate">
                              {lib.description}
                            </span>
                          )}
                        </span>
                        {activeLibraryId === lib.id && (
                          <span className="text-[10px] text-accent-indigo flex-shrink-0">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}

              {/* Empty state */}
              {libraries.length === 0 && (
                <div className="px-3 py-4 text-xs text-text-muted text-center">
                  暂无技能库<br />
                  <span className="text-[10px]">请在设置中添加技能库</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-3 pt-1 mt-0.5 border-t border-border">
              <span className="text-[10px] text-text-muted">
                共 {libraries.length} 个技能库
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Dialog */}
      {showConfirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-primary border border-border rounded-lg shadow-xl p-4 max-w-sm mx-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">⚠️</span>
              <h3 className="text-base font-medium text-text-primary">切换技能库</h3>
            </div>

            {/* Content */}
            <div className="text-sm text-text-secondary mb-4 space-y-2">
              <p className="text-accent-yellow">
                切换技能库将清空当前项目的技能配置
              </p>
              <div className="bg-bg-secondary rounded-md p-2.5 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-text-muted text-xs">当前技能库：</span>
                  <span className="text-xs text-text-primary">
                    {activeLibrary ? activeLibrary.name : '无'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted text-xs">新技能库：</span>
                  <span className="text-xs text-text-primary">
                    {pendingLibrary ? pendingLibrary.name : '无'}
                  </span>
                </div>
              </div>
              <p className="text-text-muted text-xs">
                此操作不可撤销，是否继续？
              </p>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-md transition-colors"
              >
                取消
              </button>
              <button
                onClick={pendingLibrary ? handleConfirmSwitch : handleDeactivate}
                disabled={isLoading}
                className={`
                  px-3 py-1.5 text-sm rounded-md transition-colors
                  bg-accent-yellow text-bg-primary
                  hover:bg-accent-yellow/80
                  ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                `}
              >
                {isLoading ? '切换中...' : '确认切换'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
