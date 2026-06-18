/**
 * Sidebar Component
 * Left panel with project list and file tree
 * @module components/layout/Sidebar
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { useSessionStore } from '@/stores/session-store';
import { useActivityStore } from '@/stores/activity-store';
import { useGitStore } from '@/stores/git-store';
import { useFileTreeStore } from '@/stores/filetree-store';
import { FileTree } from '@/components/sidebar';
import { BranchSelector } from '@/components/sidebar/BranchSelector';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

/** Props for Sidebar component */
interface SidebarProps {
  /** Callback when new project dialog should open */
  onOpenNewProject?: () => void;
  /** Callback to switch to file tab (when file is clicked) */
  onSwitchToFileTab?: () => void;
}

/**
 * Session status type for project indicator
 */
type ProjectSessionStatus = 'idle' | 'running' | 'waiting' | 'none';

/**
 * Get session status for a project
 * ★ 修复：改为使用预计算的 sessionStatusMap，避免在渲染时遍历所有会话
 * @param projectId Project ID
 * @param sessionStatusMap Pre-computed session status map
 * @returns Project session status
 */
function getProjectSessionStatus(
  projectId: string,
  sessionStatusMap: Record<string, ProjectSessionStatus>
): ProjectSessionStatus {
  return sessionStatusMap[projectId] || 'none';
}

/**
 * Sidebar component
 * Displays project list and file tree in a collapsible left panel
 */
export function Sidebar({ onOpenNewProject, onSwitchToFileTab }: SidebarProps): JSX.Element {
  const { projects, activeProjectId, openProject, deleteProject } = useProjectStore();
  const { restartSession, resetSession } = useSessionStore();
  const gitInitialize = useGitStore(state => state.initialize);
  const gitClear = useGitStore(state => state.clear);
  const fileTreeRefresh = useFileTreeStore(state => state.refresh);

  // ★ 修复：使用直接选择器订阅，确保状态更新能正确触发组件重渲染
  // 之前使用 useShallow 导致 activity store 更新不及时，状态指示器不显示绿色
  const sessions = useSessionStore(state => state.sessions);
  const projectSessionIndex = useSessionStore(state => state.projectSessionIndex);
  const activitySessions = useActivityStore(state => state.sessions);

  // ★ 在 useMemo 中计算状态映射，只有依赖变化时才重新计算
  const finalStatusMap = useMemo(() => {
    const statusMap: Record<string, ProjectSessionStatus> = {};

    // 遍历所有会话，计算每个项目的状态
    for (const [sessionId, session] of Object.entries(sessions)) {
      const projectId = session.projectId;
      const messages = session.messages || [];
      const interactivePanel = session.interactivePanel;

      // 确定状态
      let status: ProjectSessionStatus = 'idle';

      if (messages.length === 0) {
        status = 'none';
      } else if (interactivePanel?.pendingPermission || interactivePanel?.pendingQuestion || interactivePanel?.pendingApproval) {
        status = 'waiting';
      } else if (messages.some(m => m.isStreaming)) {
        status = 'running';
      }

      // 检查活动状态
      const activity = activitySessions[sessionId];
      const hasActivity = activity?.current !== null && activity?.current !== undefined;
      const hasThinking = activity?.thinkingStartTime !== null && activity?.thinkingStartTime !== undefined;

      // 如果有活动状态，标记为 running（不覆盖已有的 running 状态）
      if (status === 'running' || hasActivity || hasThinking) {
        statusMap[projectId] = 'running';
      } else if (statusMap[projectId] !== 'running') {
        statusMap[projectId] = status;
      }
    }

    return statusMap;
  }, [sessions, activitySessions]);

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFileTreeRefreshing, setIsFileTreeRefreshing] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    projectId: string;
    projectName: string;
  }>({ isOpen: false, projectId: '', projectName: '' });

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    isVisible: boolean;
    x: number;
    y: number;
    projectId: string;
    projectName: string;
  }>({
    isVisible: false,
    x: 0,
    y: 0,
    projectId: '',
    projectName: '',
  });

  // Session action confirmation dialog state
  const [sessionActionDialog, setSessionActionDialog] = useState<{
    isOpen: boolean;
    action: 'restart' | 'reset' | null;
    projectId: string;
    projectName: string;
    sessionId: string | null;
  }>({
    isOpen: false,
    action: null,
    projectId: '',
    projectName: '',
    sessionId: null,
  });

  const contextMenuRef = useRef<HTMLDivElement>(null);

  /**
   * Handle project selection
   */
  const handleProjectSelect = useCallback(
    (projectId: string) => {
      openProject(projectId);
    },
    [openProject]
  );

  /**
   * Handle toggle collapse
   */
  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  /**
   * Handle new project button click
   */
  const handleNewProject = useCallback(() => {
    onOpenNewProject?.();
  }, [onOpenNewProject]);

  /**
   * Handle file tree refresh
   */
  const handleFileTreeRefresh = useCallback(async () => {
    setIsFileTreeRefreshing(true);
    await fileTreeRefresh();
    setIsFileTreeRefreshing(false);
  }, [fileTreeRefresh]);

  /**
   * Handle delete project button click - show confirmation
   */
  const handleDeleteProjectClick = useCallback((projectId: string, projectName: string) => {
    setConfirmDialog({ isOpen: true, projectId, projectName });
  }, []);

  /**
   * Confirm delete project
   */
  const handleConfirmDelete = useCallback(async () => {
    try {
      await deleteProject(confirmDialog.projectId);
    } catch (err) {
      console.error('[Sidebar] Failed to delete project:', err);
    }
    setConfirmDialog({ isOpen: false, projectId: '', projectName: '' });
  }, [deleteProject, confirmDialog.projectId]);

  /**
   * Cancel delete project
   */
  const handleCancelDelete = useCallback(() => {
    setConfirmDialog({ isOpen: false, projectId: '', projectName: '' });
  }, []);

  /**
   * Handle right-click context menu on project item
   */
  const handleContextMenu = useCallback((e: React.MouseEvent, projectId: string, projectName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      isVisible: true,
      x: e.clientX,
      y: e.clientY,
      projectId,
      projectName,
    });
  }, []);

  /**
   * Close context menu
   */
  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, isVisible: false }));
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };

    if (contextMenu.isVisible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu.isVisible, closeContextMenu]);

  // Initialize git store when active project changes (with delay to avoid blocking)
  useEffect(() => {
    if (activeProjectId) {
      const project = projects.find(p => p.id === activeProjectId);
      if (project?.path) {
        gitClear();
        const timer = setTimeout(() => {
          gitInitialize(project.path).catch(err => {
            console.warn('[Sidebar] Git init failed:', err);
          });
        }, 300);
        return () => clearTimeout(timer);
      }
    } else {
      gitClear();
    }
  }, [activeProjectId, projects, gitInitialize, gitClear]);

  /**
   * Get session ID for a project
   * ★ 修复：使用 projectSessionIndex 而非遍历 sessions
   */
  const getSessionIdForProject = useCallback((projectId: string): string | null => {
    return useSessionStore.getState().projectSessionIndex.get(projectId) || null;
  }, []);

  /**
   * Handle session restart menu click
   */
  const handleRestartSession = useCallback(() => {
    const sessionId = getSessionIdForProject(contextMenu.projectId);
    if (sessionId) {
      setSessionActionDialog({
        isOpen: true,
        action: 'restart',
        projectId: contextMenu.projectId,
        projectName: contextMenu.projectName,
        sessionId,
      });
    }
    closeContextMenu();
  }, [contextMenu, getSessionIdForProject, closeContextMenu]);

  /**
   * Handle session reset menu click
   */
  const handleResetSession = useCallback(() => {
    const sessionId = getSessionIdForProject(contextMenu.projectId);
    if (sessionId) {
      setSessionActionDialog({
        isOpen: true,
        action: 'reset',
        projectId: contextMenu.projectId,
        projectName: contextMenu.projectName,
        sessionId,
      });
    }
    closeContextMenu();
  }, [contextMenu, getSessionIdForProject, closeContextMenu]);

  /**
   * Confirm session action
   */
  const handleConfirmSessionAction = useCallback(async () => {
    if (!sessionActionDialog.sessionId || !sessionActionDialog.action) return;

    if (sessionActionDialog.action === 'restart') {
      await restartSession(sessionActionDialog.sessionId);
    } else if (sessionActionDialog.action === 'reset') {
      await resetSession(sessionActionDialog.sessionId);
    }

    setSessionActionDialog({
      isOpen: false,
      action: null,
      projectId: '',
      projectName: '',
      sessionId: null,
    });
  }, [sessionActionDialog, restartSession, resetSession]);

  /**
   * Cancel session action
   */
  const handleCancelSessionAction = useCallback(() => {
    setSessionActionDialog({
      isOpen: false,
      action: null,
      projectId: '',
      projectName: '',
      sessionId: null,
    });
  }, []);

  // 显示所有项目，点击选择激活
  // 当前激活的项目会高亮显示

  // Collapsed state (desktop only)
  if (isCollapsed) {
    return (
      <div className="hidden md:flex w-12 h-full bg-bg-secondary border-r border-border flex-col items-center py-2">
        {/* Expand button */}
        <button
          onClick={handleToggleCollapse}
          className="p-2 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors"
          title="展开侧边栏"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Sidebar container */}
      <div
        className={`
          w-64 h-full bg-bg-secondary border-r border-border flex flex-col
          relative z-auto
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-medium text-text-primary">项目</span>
          <div className="flex items-center gap-1">
            {/* New project button */}
            <button
              onClick={handleNewProject}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
              title="新建项目"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
            {/* Collapse button */}
            <button
              onClick={handleToggleCollapse}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
              title="收起侧边栏"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Project list - 1/3 height */}
        <div className="h-1/3 overflow-auto border-b border-border">
          {projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <div className="w-12 h-12 mb-3 flex items-center justify-center bg-bg-tertiary rounded-full">
                <span className="text-2xl">📁</span>
              </div>
              <p className="text-sm text-text-secondary mb-1">暂无项目</p>
              <p className="text-xs text-text-muted mb-3">点击上方按钮新建项目</p>
              <button
                onClick={handleNewProject}
                className="px-3 py-1.5 text-sm bg-accent-indigo text-white rounded-lg hover:bg-accent-indigo/80 transition-colors"
              >
                新建项目
              </button>
            </div>
          ) : (
            <div className="py-1">
              {projects.map((project) => {
                  // ★ 修复：使用预计算的 finalStatusMap，避免每次渲染时遍历所有会话
                  const status = getProjectSessionStatus(project.id, finalStatusMap);
                  return (
                    <div
                      key={project.id}
                      className={`
                        group flex items-center gap-2 px-3 py-2 cursor-pointer
                        transition-colors duration-150
                        ${project.id === activeProjectId
                          ? 'bg-bg-tertiary text-accent-indigo'
                          : 'hover:bg-bg-hover text-text-primary'}
                      `}
                      onClick={() => {
                        handleProjectSelect(project.id);
                      }}
                      onContextMenu={(e) => handleContextMenu(e, project.id, project.name)}
                    >
                      {/* Session status indicator */}
                      <div
                        className={`
                          w-2 h-2 rounded-full flex-shrink-0
                          ${status === 'running' ? 'bg-accent-green animate-pulse' : ''}
                          ${status === 'waiting' ? 'bg-accent-yellow' : ''}
                          ${status === 'idle' || status === 'none' ? 'bg-text-muted' : ''}
                        `}
                        title={
                          status === 'running' ? 'Agent 运行中' :
                          status === 'waiting' ? '等待用户输入' :
                          status === 'idle' ? '会话空闲' :
                          '无会话或未启动'
                        }
                      />
                      <span className="text-lg">📂</span>
                      <span className="flex-1 text-sm truncate">{project.name}</span>
                      {/* Delete button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProjectClick(project.id, project.name);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-accent-red rounded transition-all"
                        title="删除项目"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* File tree section - 2/3 height */}
        <div className="h-2/3 flex flex-col overflow-hidden">
          {activeProjectId ? (
            <>
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-bg-secondary">
                <span className="text-sm font-medium text-text-primary">文件</span>
                {/* Refresh button */}
                <button
                  onClick={handleFileTreeRefresh}
                  disabled={isFileTreeRefreshing}
                  className="p-1 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
                  title="刷新文件树"
                >
                  <svg
                    className={`w-4 h-4 ${isFileTreeRefreshing ? 'animate-spin' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    {isFileTreeRefreshing ? (
                      // Loading spinner
                      <>
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </>
                    ) : (
                      // Refresh icon
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 00 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    )}
                  </svg>
                </button>
              </div>
              {/* Branch selector - only shows for git repos */}
              <BranchSelector />
              <div className="flex-1 overflow-auto">
                <FileTree onFileSelect={onSwitchToFileTab} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
              请选择一个项目
            </div>
          )}
        </div>
      </div>

      {/* Confirm dialog for deleting project */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title="删除项目"
        message={`确定要删除项目 "${confirmDialog.projectName}" 吗？此操作将从列表中移除该项目。`}
        confirmText="删除"
        cancelText="取消"
        isDestructive={true}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      {/* Context menu for session actions */}
      {contextMenu.isVisible && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-bg-primary border border-border rounded-lg shadow-lg py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleRestartSession}
            role="menuitem"
          >
            <span>🔄</span>
            <div className="flex flex-col">
              <span>会话重启</span>
              <span className="text-xs text-text-muted">重连Agent，保留历史</span>
            </div>
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-accent-red/10 flex items-center gap-2 text-accent-red"
            onClick={handleResetSession}
            role="menuitem"
          >
            <span>🗑️</span>
            <div className="flex flex-col">
              <span>会话重置</span>
              <span className="text-xs text-accent-red/70">保留前5轮会话，新建会话</span>
            </div>
          </button>
        </div>
      )}

      {/* Session action confirmation dialog */}
      <ConfirmDialog
        isOpen={sessionActionDialog.isOpen}
        title={sessionActionDialog.action === 'restart' ? '重启会话' : '重置会话'}
        message={
          sessionActionDialog.action === 'restart'
            ? `确定要重启会话吗？这将断开当前 Agent 连接并重新建立连接，历史消息将保留。`
            : `确定要重置会话吗？这将保留前5轮对话历史并创建新的会话，此操作不可撤销。`
        }
        confirmText={sessionActionDialog.action === 'restart' ? '确认重启' : '确认重置'}
        cancelText="取消"
        isDestructive={sessionActionDialog.action === 'reset'}
        onConfirm={handleConfirmSessionAction}
        onCancel={handleCancelSessionAction}
      />
    </>
  );
}
