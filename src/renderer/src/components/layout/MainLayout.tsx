/**
 * Main Layout Component
 * Two-column layout: Sidebar | Main Content (Chat/Code with tabs)
 * @module components/layout/MainLayout
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Sidebar } from './Sidebar';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { CodePreview } from '@/components/editor/CodePreview';
import { NewProjectDialog } from '@/components/project/NewProjectDialog';
import { TabBar, type MainTabType } from '@/components/tabs/TabBar';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { AppIcon } from '@/components/common';

/**
 * Check if running on macOS
 * Used for platform-specific UI adjustments like traffic light spacing
 * Note: navigator.platform is deprecated but userAgentData.platform is not widely supported yet
 */
function isMacOS(): boolean {
  // Try modern API first (not widely supported yet)
  if ('userAgentData' in navigator && navigator.userAgentData) {
    const platform = (navigator.userAgentData as { platform?: string }).platform;
    if (platform) {
      return platform === 'macOS';
    }
  }
  // Fallback to deprecated but widely supported API
  return navigator.platform.toLowerCase().includes('mac');
}

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  if ('userAgentData' in navigator && navigator.userAgentData) {
    const platform = (navigator.userAgentData as { platform?: string }).platform;
    if (platform) {
      return platform === 'Windows';
    }
  }
  return navigator.platform.toLowerCase().includes('win');
}

/**
 * MainLayout component
 * Root layout with two-column design:
 * - Left: Sidebar (project list + file tree)
 * - Right: Main content with TabBar (会话/文件)
 *
 * Title bar: app icon + name (left), drag region, settings icon (right)
 */
export function MainLayout(): JSX.Element {
  const isMac = useMemo(() => isMacOS(), []);
  const isWin = useMemo(() => isWindows(), []);
  const [activeTab, setActiveTab] = useState<MainTabType>('chat');
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);

  // 窗口最大化状态
  const [isMaximized, setIsMaximized] = useState(false);

  // 监听窗口最大化状态
  useEffect(() => {
    // 获取初始状态
    window.electron.ipcRenderer.invoke('window:isMaximized').then((maximized) => {
      setIsMaximized(maximized);
    }).catch(() => {
      // IPC 可能还未注册，忽略错误
    });

    // 监听最大化事件
    const handleMaximized = (_event: unknown, maximized: boolean) => {
      setIsMaximized(maximized);
    };

    window.electron.ipcRenderer.on('window:maximized', handleMaximized);

    return () => {
      window.electron.ipcRenderer.removeListener('window:maximized', handleMaximized);
    };
  }, []);

  /**
   * Open new project dialog
   */
  const handleOpenNewProject = useCallback(() => {
    setIsNewProjectDialogOpen(true);
  }, []);

  /**
   * Close new project dialog
   */
  const handleCloseNewProject = useCallback(() => {
    setIsNewProjectDialogOpen(false);
  }, []);

  /**
   * Handle tab change
   */
  const handleTabChange = useCallback((tab: MainTabType) => {
    setActiveTab(tab);
  }, []);

  /**
   * Switch to file tab (called when file is clicked in file tree)
   */
  const handleSwitchToFileTab = useCallback(() => {
    setActiveTab('file');
  }, []);

  /**
   * Open settings dialog
   */
  const handleOpenSettings = useCallback(() => {
    setIsSettingsDialogOpen(true);
  }, []);

  /**
   * Close settings dialog
   */
  const handleCloseSettings = useCallback(() => {
    setIsSettingsDialogOpen(false);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-bg-primary overflow-hidden">
      {/* Title bar area */}
      <div className="flex items-center border-b border-border h-[38px]">
        {/* macOS traffic light spacer - 最大化时收缩为 0 */}
        {isMac && (
          <div
            className={`flex-shrink-0 h-full drag-region transition-all duration-200 ${
              isMaximized ? 'w-0' : 'w-[80px]'
            }`}
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
        )}

        {/* App icon + name (left aligned, after traffic lights on macOS) */}
        <div className="flex items-center gap-1.5 px-2 no-drag">
          <AppIcon size={16} />
          <span className="text-text-secondary text-xs font-medium tracking-wide whitespace-nowrap">
            OrdoRealm Code - 序境智码
          </span>
        </div>

        {/* Drag region (flexible space) */}
        <div
          className="flex-1 h-full drag-region"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />

        {/* Settings icon */}
        <button
          onClick={handleOpenSettings}
          className="flex-shrink-0 p-2 mr-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors no-drag"
          title="设置"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* Windows: 右侧留空给 titleBarOverlay 的窗口控制按钮 */}
        {isWin && (
          <div className="flex-shrink-0 w-[138px] h-full" />
        )}
      </div>

      {/* Main content area - two column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Sidebar */}
        <Sidebar
          onOpenNewProject={handleOpenNewProject}
          onSwitchToFileTab={handleSwitchToFileTab}
        />

        {/* Right: Main content with tabs */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Tab bar */}
          <TabBar activeTab={activeTab} onTabChange={handleTabChange} />

          {/* Content area - must have flex flex-col for children flex-1 to work */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {activeTab === 'chat' ? (
              <ChatPanel />
            ) : (
              <CodePreview />
            )}
          </div>
        </div>
      </div>

      {/* New Project Dialog */}
      <NewProjectDialog
        isOpen={isNewProjectDialogOpen}
        onClose={handleCloseNewProject}
      />

      {/* Settings Dialog */}
      <SettingsDialog
        isOpen={isSettingsDialogOpen}
        onClose={handleCloseSettings}
      />
    </div>
  );
}
