/**
 * Session History Selector Component
 *
 * Dropdown selector for viewing and switching between session history.
 * Displays sessions grouped by: current, recent, and archived.
 * Supports: new session, clone, switch, archive/unarchive operations.
 *
 * @module components/chat/SessionHistorySelector
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useProjectStore } from '@/stores/project-store';
import { usePopoverClose } from '@/hooks/usePopoverClose';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { SessionListItem } from '@/types';

/**
 * Props for SessionHistorySelector component
 */
export interface SessionHistorySelectorProps {
  /** Current session ID */
  sessionId: string;
}

/**
 * Format timestamp to relative or absolute time
 */
function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return '昨天';
  } else if (days < 7) {
    return `${days}天前`;
  } else {
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }
}

/**
 * Session History Selector Component
 *
 * Provides a dropdown interface for viewing and managing session history.
 */
export function SessionHistorySelector({
  sessionId,
}: SessionHistorySelectorProps): JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [sessionList, setSessionList] = useState<SessionListItem[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  // Confirm dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    action: 'create' | 'clone' | 'archive' | null;
    targetId: string;
    targetTitle: string;
  }>({
    isOpen: false,
    action: null,
    targetId: '',
    targetTitle: '',
  });

  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Store actions
  const createNewSession = useSessionStore(s => s.createNewSession);
  const switchToSession = useSessionStore(s => s.switchToSession);
  const cloneSession = useSessionStore(s => s.cloneSession);
  const archiveSession = useSessionStore(s => s.archiveSession);
  const unarchiveSession = useSessionStore(s => s.unarchiveSession);

  // Get current project
  const session = useSessionStore(s => s.sessions[sessionId]);
  const project = useProjectStore(s => s.projects.find(p => p.id === session?.projectId));

  // Derive display title: use session.title first, then generate from first user message
  const displayTitle = useMemo(() => {
    if (session?.title) return session.title;
    if (!session?.messages?.length) return '未命名会话';
    const firstUserMsg = session.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return '未命名会话';
    const content = (firstUserMsg.content || '').toString();
    const firstLine = content.split('\n')[0].trim();
    if (!firstLine) return '未命名会话';
    return firstLine.length > 30 ? firstLine.slice(0, 30) + '...' : firstLine;
  }, [session?.title, session?.messages]);

  // Popover close hook
  usePopoverClose(popoverOpen, setPopoverOpen, btnRef, popoverRef);

  // Focus filter on popover open
  useEffect(() => {
    if (popoverOpen) {
      setTimeout(() => filterRef.current?.focus(), 50);
      // Load session list filtered by current project
      setLoading(true);
      const projectId = session?.projectId;
      useSessionStore.getState().getSessionList(projectId)
        .then(setSessionList)
        .catch(err => setError(err.message))
        .finally(() => setLoading(false));
    } else {
      setFilter('');
    }
  }, [popoverOpen, session?.projectId]);

  // Group sessions (already filtered by project)
  const { current, recent, archived } = useMemo(() => {
    const current = sessionList.find(s => s.id === sessionId);
    const recent = sessionList.filter(s => s.id !== sessionId && !s.archived);
    const archived = sessionList.filter(s => s.archived);
    return { current, recent, archived };
  }, [sessionList, sessionId]);

  // Filter recent sessions
  const filteredRecent = useMemo(() => {
    if (!filter) return recent;
    const lowerFilter = filter.toLowerCase();
    return recent.filter(s =>
      s.title?.toLowerCase().includes(lowerFilter)
    );
  }, [recent, filter]);

  // Handle create new session - show confirm dialog
  const handleCreateNewClick = useCallback(() => {
    if (!project?.id) return;
    setConfirmDialog({
      isOpen: true,
      action: 'create',
      targetId: '',
      targetTitle: '',
    });
  }, [project?.id]);

  // Handle switch session
  const handleSwitch = useCallback(async (targetId: string) => {
    setPopoverOpen(false);
    await switchToSession(targetId);
  }, [switchToSession]);

  // Handle clone session click - show confirm dialog
  const handleCloneClick = useCallback((sourceId: string, title: string) => {
    setConfirmDialog({
      isOpen: true,
      action: 'clone',
      targetId: sourceId,
      targetTitle: title,
    });
  }, []);

  // Handle archive click - show confirm dialog
  const handleArchiveClick = useCallback((targetId: string, title: string) => {
    setConfirmDialog({
      isOpen: true,
      action: 'archive',
      targetId: targetId,
      targetTitle: title,
    });
  }, []);

  // Confirm action
  const handleConfirmAction = useCallback(async () => {
    const { action, targetId } = confirmDialog;

    if (action === 'create') {
      if (!project?.id) return;
      setPopoverOpen(false);
      const newId = await createNewSession(project.id);
      console.log('[SessionHistorySelector] Created new session:', newId);
    } else if (action === 'clone' && targetId) {
      const newId = await cloneSession(targetId);
      await switchToSession(newId);
      setPopoverOpen(false);
    } else if (action === 'archive' && targetId) {
      try {
        await archiveSession(targetId);
        const projectId = session?.projectId;
        const list = await useSessionStore.getState().getSessionList(projectId);
        setSessionList(list);
      } catch (err) {
        setError(err instanceof Error ? err.message : '归档失败');
      }
    }

    setConfirmDialog({ isOpen: false, action: null, targetId: '', targetTitle: '' });
  }, [confirmDialog, project?.id, createNewSession, cloneSession, switchToSession, archiveSession, session?.projectId]);

  // Cancel action
  const handleCancelAction = useCallback(() => {
    setConfirmDialog({ isOpen: false, action: null, targetId: '', targetTitle: '' });
  }, []);

  // Handle unarchive
  const handleUnarchive = useCallback(async (targetId: string) => {
    try {
      await unarchiveSession(targetId);
      // Refresh list (filtered by current project)
      const projectId = session?.projectId;
      const list = await useSessionStore.getState().getSessionList(projectId);
      setSessionList(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消归档失败');
    }
  }, [unarchiveSession, session?.projectId]);

  // Get confirm dialog messages
  const confirmDialogConfig = useMemo(() => {
    switch (confirmDialog.action) {
      case 'create':
        return {
          title: '新建会话',
          message: '确定要创建一个空白会话吗？',
          confirmText: '确认创建',
          isDestructive: false,
        };
      case 'clone':
        return {
          title: '克隆会话',
          message: `确定要克隆会话"${confirmDialog.targetTitle}"吗？将创建一个包含相同历史记录的新会话。`,
          confirmText: '确认克隆',
          isDestructive: false,
        };
      case 'archive':
        return {
          title: '归档会话',
          message: `确定要归档会话"${confirmDialog.targetTitle}"吗？归档后可在归档列表中找到或恢复。`,
          confirmText: '确认归档',
          isDestructive: true,
        };
      default:
        return { title: '', message: '', confirmText: '', isDestructive: false };
    }
  }, [confirmDialog.action, confirmDialog.targetTitle]);

  return (
    <div className="relative flex-shrink-0">
      {/* Trigger button */}
      <button
        ref={btnRef}
        onClick={() => setPopoverOpen(o => !o)}
        className={`
          inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
          bg-bg-tertiary border text-text-secondary
          hover:text-text-primary hover:bg-bg-hover
          transition-colors cursor-pointer select-none
          ${popoverOpen ? 'border-accent-indigo text-text-primary' : 'border-border'}
        `}
      >
        <span>📋</span>
        <span className="truncate max-w-[180px]">当前会话：{displayTitle}</span>
        <span className="text-text-muted text-[10px]">▼</span>
      </button>

      {/* Popover */}
      {popoverOpen && (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-0 mb-1.5 w-80 bg-bg-primary border border-border rounded-lg shadow-lg z-50"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-2 border-b border-border">
            <span className="text-xs font-medium text-text-primary">📋 会话历史</span>
            <button
              onClick={handleCreateNewClick}
              className="text-xs text-accent-indigo hover:text-accent-indigo/80 cursor-pointer"
            >
              ＋ 新建会话
            </button>
          </div>

          {/* Search */}
          <div className="p-2 border-b border-border">
            <input
              ref={filterRef}
              type="text"
              placeholder="搜索会话..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="w-full px-2.5 py-1 text-xs rounded-md bg-bg-secondary border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-indigo"
            />
          </div>

          {/* Session list */}
          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-text-muted text-xs">加载中...</div>
            ) : error ? (
              <div className="p-4 text-center text-accent-red text-xs">{error}</div>
            ) : (
              <>
                {/* Current session */}
                {current && (
                  <SessionGroup
                    title="🔵 当前会话"
                    sessions={[current]}
                    isCurrent
                    onSwitch={handleSwitch}
                    onClone={handleCloneClick}
                    onArchive={handleArchiveClick}
                    onUnarchive={handleUnarchive}
                  />
                )}

                {/* Recent sessions */}
                {filteredRecent.length > 0 && (
                  <SessionGroup
                    title="📁 最近会话"
                    sessions={filteredRecent}
                    onSwitch={handleSwitch}
                    onClone={handleCloneClick}
                    onArchive={handleArchiveClick}
                    onUnarchive={handleUnarchive}
                  />
                )}

                {/* Archived sessions */}
                {archived.length > 0 && (
                  <div className="border-t border-border">
                    <button
                      onClick={() => setArchivedExpanded(e => !e)}
                      className="w-full px-3 py-2 flex items-center justify-between text-xs text-text-muted hover:bg-bg-hover cursor-pointer"
                    >
                      <span>📦 已归档 ({archived.length}/30)</span>
                      <span className={`transition-transform ${archivedExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </button>
                    {archivedExpanded && (
                      <SessionGroup
                        sessions={archived}
                        isArchived
                        onSwitch={handleSwitch}
                        onClone={handleCloneClick}
                        onArchive={handleArchiveClick}
                        onUnarchive={handleUnarchive}
                      />
                    )}
                  </div>
                )}

                {/* Empty state */}
                {!current && filteredRecent.length === 0 && archived.length === 0 && (
                  <div className="p-4 text-center text-text-muted text-xs">
                    暂无历史会话
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialogConfig.title}
        message={confirmDialogConfig.message}
        confirmText={confirmDialogConfig.confirmText}
        cancelText="取消"
        isDestructive={confirmDialogConfig.isDestructive}
        onConfirm={handleConfirmAction}
        onCancel={handleCancelAction}
      />
    </div>
  );
}

/**
 * Session Group Component
 */
interface SessionGroupProps {
  title?: string;
  sessions: SessionListItem[];
  isCurrent?: boolean;
  isArchived?: boolean;
  onSwitch: (id: string) => void;
  onClone: (id: string, title: string) => void;
  onArchive: (id: string, title: string) => void;
  onUnarchive: (id: string) => void;
}

function SessionGroup({
  title,
  sessions,
  isCurrent,
  isArchived,
  onSwitch,
  onClone,
  onArchive,
  onUnarchive,
}: SessionGroupProps): JSX.Element {
  return (
    <div className={title ? 'border-b border-border last:border-b-0' : ''}>
      {title && (
        <div className="px-3 py-1.5 text-[10px] text-text-muted bg-bg-secondary/50">
          {title}
        </div>
      )}
      {sessions.map(session => (
        <SessionItem
          key={session.id}
          session={session}
          isCurrent={isCurrent}
          isArchived={isArchived}
          onSwitch={onSwitch}
          onClone={onClone}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
        />
      ))}
    </div>
  );
}

/**
 * Session Item Component
 */
interface SessionItemProps {
  session: SessionListItem;
  isCurrent?: boolean;
  isArchived?: boolean;
  onSwitch: (id: string) => void;
  onClone: (id: string, title: string) => void;
  onArchive: (id: string, title: string) => void;
  onUnarchive: (id: string) => void;
}

function SessionItem({
  session,
  isCurrent,
  isArchived,
  onSwitch,
  onClone,
  onArchive,
  onUnarchive,
}: SessionItemProps): JSX.Element {
  const [showActions, setShowActions] = useState(false);
  const sessionTitle = session.title || '未命名会话';

  return (
    <div
      className="px-3 py-2 hover:bg-bg-hover cursor-pointer group"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onClick={() => !isCurrent && !isArchived && onSwitch(session.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-primary truncate">
            {sessionTitle}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">
            {session.messageCount} 条消息 · {formatTime(session.lastActiveAt)}
          </div>
        </div>

        {/* Action buttons */}
        {showActions && !isCurrent && (
          <div className="flex items-center gap-1">
            {!isArchived ? (
              <>
                <button
                  onClick={e => { e.stopPropagation(); onClone(session.id, sessionTitle); }}
                  className="p-1 text-text-muted hover:text-text-primary text-[10px] cursor-pointer"
                  title="克隆"
                >
                  📋
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onArchive(session.id, sessionTitle); }}
                  className="p-1 text-text-muted hover:text-text-primary text-[10px] cursor-pointer"
                  title="归档"
                >
                  📦
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={e => { e.stopPropagation(); onUnarchive(session.id); }}
                  className="p-1 text-text-muted hover:text-text-primary text-[10px] cursor-pointer"
                  title="取消归档"
                >
                  📤
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onClone(session.id, sessionTitle); }}
                  className="p-1 text-text-muted hover:text-text-primary text-[10px] cursor-pointer"
                  title="克隆"
                >
                  📋
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
