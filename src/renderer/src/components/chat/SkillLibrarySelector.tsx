/**
 * Skill Library Selector Component
 *
 * Dropdown selector for activating skill libraries in the current project.
 * Displays skill libraries grouped by Agent type with visual indicators.
 * Shows confirmation dialog before switching libraries to warn about configuration clearing.
 *
 * @module components/chat/SkillLibrarySelector
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useSkillLibraryStore } from '@/stores/skill-library-store';
import { AgentIcon, getAgentConfig } from '@/components/common/AgentIcon';
import { usePopoverClose } from '@/hooks/usePopoverClose';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { SkillLibrary, AgentType } from '@/types';

/**
 * Agent group configuration for display
 * Note: codex and opencode are currently disabled
 */
const AGENT_GROUPS: { type: AgentType; label: string; order: number }[] = [
  { type: 'claude-code', label: 'Claude Code', order: 1 },
  // { type: 'codex', label: 'Codex', order: 2 },
  // { type: 'opencode', label: 'OpenCode', order: 3 },
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
  const [error, setError] = useState<string | null>(null);

  // Extract dialog state
  const [showExtractDialog, setShowExtractDialog] = useState(false);
  const [extractName, setExtractName] = useState('');
  const [extractDescription, setExtractDescription] = useState('');
  const [extractError, setExtractError] = useState<string | null>(null);

  // Delete confirm state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingDeleteName, setPendingDeleteName] = useState('');

  // Hover state for delete button
  const [hoveredLibraryId, setHoveredLibraryId] = useState<string | null>(null);

  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Get store state and actions
  const libraries = useSkillLibraryStore(state => state.libraries);
  const activeLibraryId = useSkillLibraryStore(state => state.activeLibraryId);
  const activateLibrary = useSkillLibraryStore(state => state.activateLibrary);
  const loadLibraries = useSkillLibraryStore(state => state.loadLibraries);
  const deleteLibrary = useSkillLibraryStore(state => state.deleteLibrary);
  const extractFromProject = useSkillLibraryStore(state => state.extractFromProject);
  const isLoading = useSkillLibraryStore(state => state.isLoading);

  // Load libraries on mount if not already loaded
  useEffect(() => {
    if (libraries.length === 0) {
      loadLibraries();
    }
  }, [libraries.length, loadLibraries]);

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

    setError(null);
    const success = await activateLibrary(pendingLibrary.id, projectPath);

    if (success) {
      console.log(`[SkillLibrarySelector] Activated library: ${pendingLibrary.name}`);
      // Call the callback for session restart
      await onLibraryActivated?.();
      setShowConfirmDialog(false);
      setPendingLibrary(null);
    } else {
      // Show error in dialog
      setError(`激活技能库「${pendingLibrary.name}」失败，请查看控制台日志`);
    }
  }, [pendingLibrary, projectPath, activateLibrary, onLibraryActivated]);

  // Handle deactivate (select "None")
  const handleDeactivate = useCallback(async () => {
    setError(null);
    const success = await activateLibrary(null, projectPath);

    if (success) {
      console.log('[SkillLibrarySelector] Deactivated library');
      await onLibraryActivated?.();
      setShowConfirmDialog(false);
      setPendingLibrary(null);
    } else {
      // Show error in dialog
      setError('停用技能库失败，请查看控制台日志');
    }
  }, [projectPath, activateLibrary, onLibraryActivated]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setShowConfirmDialog(false);
    setPendingLibrary(null);
    setError(null);
  }, []);

  // Handle extract click - open extract dialog
  const handleExtractClick = useCallback(() => {
    setExtractName('');
    setExtractDescription('');
    setExtractError(null);
    setShowExtractDialog(true);
    setPopoverOpen(false);
  }, []);

  // Handle extract confirm
  const handleExtractConfirm = useCallback(async () => {
    if (!projectPath) {
      setExtractError('项目路径不存在');
      return;
    }
    if (!extractName.trim()) {
      setExtractError('请输入技能库名称');
      return;
    }
    if (!extractDescription.trim()) {
      setExtractError('请输入技能库说明');
      return;
    }

    setExtractError(null);
    const result = await extractFromProject(projectPath, extractName.trim(), extractDescription.trim(), 'claude-code');

    if (result) {
      setShowExtractDialog(false);
      console.log('[SkillLibrarySelector] Extracted library:', result.name);
    } else {
      setExtractError('提取失败，请检查项目目录中是否存在 .claude 文件夹');
    }
  }, [projectPath, extractName, extractDescription, extractFromProject]);

  // Handle delete click - show confirm dialog
  const handleDeleteClick = useCallback((library: SkillLibrary) => {
    setPendingDeleteId(library.id);
    setPendingDeleteName(library.name);
    setShowDeleteDialog(true);
  }, []);

  // Handle delete confirm
  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDeleteId) return;

    const success = await deleteLibrary(pendingDeleteId);
    if (success) {
      setShowDeleteDialog(false);
      setPendingDeleteId(null);
      setPendingDeleteName('');
    }
  }, [pendingDeleteId, deleteLibrary]);

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
            inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
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
                      <div
                        key={lib.id}
                        className={`
                          w-full px-3 py-1.5 flex items-center gap-2 text-left
                          hover:bg-bg-hover transition-colors cursor-pointer
                          ${activeLibraryId === lib.id ? 'bg-bg-hover' : ''}
                        `}
                        onClick={() => handleLibraryClick(lib)}
                        onMouseEnter={() => setHoveredLibraryId(lib.id)}
                        onMouseLeave={() => setHoveredLibraryId(null)}
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
                        {/* Delete button - show on hover */}
                        {hoveredLibraryId === lib.id && (
                          <button
                            onClick={e => { e.stopPropagation(); handleDeleteClick(lib); }}
                            className="p-0.5 text-text-muted hover:text-accent-red text-[10px] cursor-pointer flex-shrink-0"
                            title="删除"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}

              {/* Empty state */}
              {libraries.length === 0 && (
                <div className="px-3 py-4 text-xs text-text-muted text-center">
                  暂无技能库<br />
                  <span className="text-[10px]">从当前项目提取或导入技能库</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-3 pt-1 mt-0.5 border-t border-border flex items-center justify-between">
              <span className="text-[10px] text-text-muted">
                共 {libraries.length} 个技能库
              </span>
              <button
                onClick={handleExtractClick}
                disabled={isLoading || !projectPath}
                className={`
                  text-[10px] text-accent-indigo hover:text-accent-indigo/80 cursor-pointer
                  ${isLoading || !projectPath ? 'opacity-50 cursor-not-allowed' : ''}
                `}
                title="从当前项目的 .claude 目录提取技能库"
              >
                📦 提取当前项目
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Dialog for switching */}
      {showConfirmDialog && (
        <div className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center bg-black/50" style={{ top: 'var(--title-bar-height, 0)' }}>
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

            {/* Error message */}
            {error && (
              <div className="mb-4 p-2.5 bg-accent-red/10 border border-accent-red/30 rounded-md">
                <p className="text-xs text-accent-red flex items-start gap-1.5">
                  <span>❌</span>
                  <span>{error}</span>
                </p>
              </div>
            )}

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

      {/* Extract Dialog */}
      {showExtractDialog && (
        <div className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center bg-black/50" style={{ top: 'var(--title-bar-height, 0)' }}>
          <div className="bg-bg-primary border border-border rounded-lg shadow-xl p-4 max-w-sm mx-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">📦</span>
              <h3 className="text-base font-medium text-text-primary">提取技能库</h3>
            </div>

            {/* Content */}
            <div className="text-sm text-text-secondary mb-4 space-y-3">
              <p className="text-xs">
                将当前项目的 <code className="px-1 py-0.5 bg-bg-secondary rounded">.claude</code> 目录打包为技能库
              </p>

              {/* Name input */}
              <div>
                <label className="block text-xs text-text-muted mb-1">技能库名称 *</label>
                <input
                  type="text"
                  value={extractName}
                  onChange={e => setExtractName(e.target.value)}
                  placeholder="例如: My Skills"
                  className="w-full px-2.5 py-1.5 text-xs border border-border rounded-md bg-bg-secondary text-text-primary focus:outline-none focus:border-accent-indigo"
                />
              </div>

              {/* Description input */}
              <div>
                <label className="block text-xs text-text-muted mb-1">技能库说明 *</label>
                <textarea
                  value={extractDescription}
                  onChange={e => setExtractDescription(e.target.value)}
                  placeholder="简要描述这个技能库的功能"
                  rows={2}
                  className="w-full px-2.5 py-1.5 text-xs border border-border rounded-md bg-bg-secondary text-text-primary focus:outline-none focus:border-accent-indigo resize-none"
                />
              </div>

              {/* Error message */}
              {extractError && (
                <div className="p-2 bg-accent-red/10 border border-accent-red/30 rounded-md">
                  <p className="text-xs text-accent-red">{extractError}</p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowExtractDialog(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-md transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleExtractConfirm}
                disabled={isLoading}
                className={`
                  px-3 py-1.5 text-sm rounded-md transition-colors
                  bg-accent-indigo text-white hover:bg-accent-indigo/80
                  ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                `}
              >
                {isLoading ? '提取中...' : '确认提取'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Dialog */}
      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="删除技能库"
        message={`确定要删除技能库"${pendingDeleteName}"吗？此操作不可撤销。`}
        confirmText="删除"
        cancelText="取消"
        isDestructive={true}
        onConfirm={handleDeleteConfirm}
        onCancel={() => { setShowDeleteDialog(false); setPendingDeleteId(null); }}
      />
    </>
  );
}
