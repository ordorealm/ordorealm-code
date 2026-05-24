/**
 * Tab Bar Component
 * Switches between "会话" (Chat) and "文件" (File) views
 * Flat underline style for better integration with the tab bar
 * @module components/tabs/TabBar
 */

import { useCallback } from 'react';

/** Tab type */
export type MainTabType = 'chat' | 'file';

interface TabBarProps {
  /** Currently active tab, defaults to 'chat' */
  activeTab: MainTabType;
  /** Callback when tab is changed */
  onTabChange: (tab: MainTabType) => void;
}

/**
 * TabBar component
 * Flat underline-style tab switcher for Chat and File views
 * Default active tab is 'chat' (会话)
 */
export function TabBar({ activeTab = 'chat', onTabChange }: TabBarProps): JSX.Element {
  const handleTabClick = useCallback((tab: MainTabType) => {
    onTabChange(tab);
  }, [onTabChange]);

  return (
    <div className="flex items-center bg-bg-primary border-b border-border">
      {/* Chat tab - default active */}
      <button
        onClick={() => handleTabClick('chat')}
        className={`
          flex items-center gap-1.5 px-4 py-2 text-sm font-medium
          transition-colors duration-150 border-b-2
          ${activeTab === 'chat'
            ? 'text-text-primary border-accent-indigo'
            : 'text-text-muted border-transparent hover:text-text-primary hover:bg-bg-hover'}
        `}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <span>会话</span>
      </button>

      {/* File tab */}
      <button
        onClick={() => handleTabClick('file')}
        className={`
          flex items-center gap-1.5 px-4 py-2 text-sm font-medium
          transition-colors duration-150 border-b-2
          ${activeTab === 'file'
            ? 'text-text-primary border-accent-indigo'
            : 'text-text-muted border-transparent hover:text-text-primary hover:bg-bg-hover'}
        `}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span>文件</span>
      </button>
    </div>
  );
}
