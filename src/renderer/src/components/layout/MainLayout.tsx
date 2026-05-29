/**
 * Main Layout Component
 * Two-column layout: Sidebar | Main Content (Chat/Code with tabs)
 * @module components/layout/MainLayout
 */

import { useState, useCallback, useMemo } from 'react';
import { Sidebar } from './Sidebar';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { CodePreview } from '@/components/editor/CodePreview';
import { NewProjectDialog } from '@/components/project/NewProjectDialog';
import { TabBar, type MainTabType } from '@/components/tabs/TabBar';
import { SettingsDialog } from '@/components/settings/SettingsDialog';

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
 * MainLayout component
 * Root layout with two-column design:
 * - Left: Sidebar (project list + file tree)
 * - Right: Main content with TabBar (会话/文件)
 *
 * Title bar has settings icon on the right
 */
export function MainLayout(): JSX.Element {
  const isMac = useMemo(() => isMacOS(), []);
  const [activeTab, setActiveTab] = useState<MainTabType>('chat');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);

  /**
   * Toggle mobile sidebar
   */
  const handleToggleMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen((prev) => !prev);
  }, []);

  /**
   * Close mobile sidebar
   */
  const handleCloseMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(false);
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
        {/* macOS traffic light spacer */}
        {isMac && (
          <div
            className="flex-shrink-0 w-[52px] h-full drag-region"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
        )}

        {/* Mobile sidebar toggle */}
        <button
          onClick={handleToggleMobileSidebar}
          className="md:hidden p-2 ml-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors"
          title="菜单"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Drag region with centered app title */}
        <div
          className="flex-1 h-full drag-region flex items-center justify-center select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <span className="text-text-secondary text-xs font-medium tracking-wide">
            DevFlow IDE
          </span>
        </div>

        {/* Settings icon */}
        <button
          onClick={handleOpenSettings}
          className="flex-shrink-0 p-2 mr-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg transition-colors"
          title="设置"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* Main content area - two column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Sidebar */}
        <Sidebar
          isMobileOpen={isMobileSidebarOpen}
          onMobileClose={handleCloseMobileSidebar}
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
