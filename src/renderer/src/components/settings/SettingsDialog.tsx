/**
 * Settings Dialog Component
 * Modal dialog for application settings
 * @module components/settings/SettingsDialog
 */

import { useState } from 'react';
import { ProviderSettings } from './ProviderSettings';
import { SkillLibrarySettings } from './SkillLibrarySettings';
import { MCPSettings } from './MCPSettings';
import { useAppearanceStore, type Theme } from '@/stores/appearance-store';

interface SettingsDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback to close the dialog */
  onClose: () => void;
}

/** Available settings tabs */
type SettingsTab = 'provider' | 'appearance' | 'skill-library' | 'mcp';

/**
 * SettingsDialog component
 * Modal dialog with tabs for different settings categories
 */
export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<SettingsTab>('provider');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-[600px] max-w-[90vw] h-[500px] max-h-[80vh] bg-bg-primary rounded-lg shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium text-text-primary">设置</h2>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content with tabs */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar tabs */}
          <div className="w-40 border-r border-border bg-bg-secondary py-2">
            <button
              onClick={() => setActiveTab('provider')}
              className={`
                w-full px-3 py-2 text-left text-sm transition-colors
                ${activeTab === 'provider'
                  ? 'bg-bg-primary text-text-primary border-r-2 border-accent-indigo'
                  : 'text-text-secondary hover:bg-bg-hover'}
              `}
            >
              AI Provider
            </button>
            <button
              onClick={() => setActiveTab('appearance')}
              className={`
                w-full px-3 py-2 text-left text-sm transition-colors
                ${activeTab === 'appearance'
                  ? 'bg-bg-primary text-text-primary border-r-2 border-accent-indigo'
                  : 'text-text-secondary hover:bg-bg-hover'}
              `}
            >
              外观
            </button>
            <button
              onClick={() => setActiveTab('skill-library')}
              className={`
                w-full px-3 py-2 text-left text-sm transition-colors
                ${activeTab === 'skill-library'
                  ? 'bg-bg-primary text-text-primary border-r-2 border-accent-indigo'
                  : 'text-text-secondary hover:bg-bg-hover'}
              `}
            >
              专家技能库
            </button>
            <button
              onClick={() => setActiveTab('mcp')}
              className={`
                w-full px-3 py-2 text-left text-sm transition-colors
                ${activeTab === 'mcp'
                  ? 'bg-bg-primary text-text-primary border-r-2 border-accent-indigo'
                  : 'text-text-secondary hover:bg-bg-hover'}
              `}
            >
              MCP 工具
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto p-4 bg-bg-primary">
            {activeTab === 'provider' && (
              <ProviderSettings />
            )}
            {activeTab === 'appearance' && (
              <AppearanceSettings />
            )}
            {activeTab === 'skill-library' && (
              <SkillLibrarySettings />
            )}
            {activeTab === 'mcp' && (
              <MCPSettings />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Appearance Settings Component
 * Theme and UI preferences
 */
function AppearanceSettings(): JSX.Element {
  const { theme, setTheme } = useAppearanceStore();

  const themes: { value: Theme; label: string; icon: JSX.Element }[] = [
    {
      value: 'light',
      label: '浅色',
      icon: <div className="w-12 h-8 rounded bg-bg-primary border border-border" />,
    },
    {
      value: 'dark',
      label: '深色',
      icon: <div className="w-12 h-8 rounded bg-bg-tertiary border border-border" />,
    },
    {
      value: 'system',
      label: '跟随系统',
      icon: <div className="w-12 h-8 rounded bg-gradient-to-r from-bg-primary to-bg-tertiary border border-border" />,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-text-primary mb-3">主题</h3>
        <div className="flex gap-3">
          {themes.map((t) => (
            <button
              key={t.value}
              onClick={() => setTheme(t.value)}
              className={`
                flex flex-col items-center p-3 rounded-lg border-2 transition-colors
                ${theme === t.value
                  ? 'border-accent-indigo bg-bg-primary'
                  : 'border-border bg-bg-primary hover:border-border'}
              `}
            >
              {t.icon}
              <span className="text-xs text-text-secondary mt-2">{t.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-muted">
          {theme === 'system' ? '主题将跟随系统设置自动切换' : '选择喜欢的主题外观'}
        </p>
      </div>
    </div>
  );
}
