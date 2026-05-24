/**
 * Provider Card Component
 * Displays a single provider configuration as a card
 * @module components/settings/ProviderCard
 */

import { useState, useRef, useEffect } from 'react';
import type { Provider, AgentType } from '@/types';
import { AGENT_DISPLAY_NAMES } from '@/types/provider.types';
import { validateProviderConnection } from '@/services/provider-validator';

interface ProviderCardProps {
  provider: Provider;
  onEdit: (provider: Provider) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
}

export function ProviderCard({ provider, onEdit, onDelete, onSetDefault }: ProviderCardProps): JSX.Element {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const deleteRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭弹窗
  useEffect(() => {
    if (!showConfirmDelete) return;
    const handleClickOutside = (e: MouseEvent): void => {
      if (deleteRef.current && !deleteRef.current.contains(e.target as Node)) {
        setShowConfirmDelete(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showConfirmDelete]);

  const handleDelete = async (): Promise<void> => {
    setIsDeleting(true);
    try {
      await onDelete(provider.id);
    } finally {
      setIsDeleting(false);
      setShowConfirmDelete(false);
    }
  };

  const handleSetDefault = (): void => {
    if (!provider.isDefault) {
      onSetDefault(provider.id);
    }
  };

  const handleTest = async (): Promise<void> => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await validateProviderConnection(provider);
      if (result.valid) {
        setTestResult({ success: true, message: '连接成功' });
      } else {
        setTestResult({ success: false, message: result.error || '连接失败' });
      }
    } catch (error) {
      setTestResult({ success: false, message: error instanceof Error ? error.message : '测试失败' });
    } finally {
      setIsTesting(false);
      // 3秒后清除结果
      setTimeout(() => setTestResult(null), 3000);
    }
  };

  const getAgentIcon = (agentType: AgentType): string => {
    switch (agentType) {
      case 'claude-code':
        return '🤖';
      case 'codex':
        return '🧠';
      case 'opencode':
        return '✨';
      default:
        return '🔌';
    }
  };

  const getAgentBadgeColor = (agentType: AgentType): string => {
    switch (agentType) {
      case 'claude-code':
        return 'bg-orange-200 text-orange-900 dark:bg-orange-900/50 dark:text-orange-200 border border-orange-400 dark:border-orange-700';
      case 'codex':
        return 'bg-green-200 text-green-900 dark:bg-green-900/50 dark:text-green-200 border border-green-400 dark:border-green-700';
      case 'opencode':
        return 'bg-purple-200 text-purple-900 dark:bg-purple-900/50 dark:text-purple-200 border border-purple-400 dark:border-purple-700';
      default:
        return 'bg-bg-tertiary text-text-primary border border-border';
    }
  };

  return (
    <div className="bg-bg-secondary border border-border rounded-lg p-3 hover:shadow-md transition-shadow duration-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-base">{getAgentIcon(provider.agentType)}</span>
          <h3 className="text-sm font-medium text-text-primary">{provider.name}</h3>
        </div>
        <div className="flex items-center gap-1">
          {/* Test Button */}
          <button
            onClick={handleTest}
            disabled={isTesting}
            className="px-1.5 py-0.5 text-xs text-text-secondary hover:text-accent-indigo hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
          >
            {isTesting ? '测试中...' : '测试'}
          </button>
          {/* Edit Button */}
          <button
            onClick={() => onEdit(provider)}
            className="px-1.5 py-0.5 text-xs text-text-secondary hover:text-accent-indigo hover:bg-bg-hover rounded transition-colors"
          >
            编辑
          </button>
          {/* Delete Button + Popover */}
          <div className="relative flex items-center" ref={deleteRef}>
            <button
              onClick={() => setShowConfirmDelete(!showConfirmDelete)}
              className="px-1.5 py-0.5 text-xs text-text-secondary hover:text-accent-red hover:bg-bg-hover rounded transition-colors"
            >
              删除
            </button>
            {showConfirmDelete && (
              <div className="absolute right-0 top-full mt-1 z-10 bg-bg-primary border border-border rounded-lg shadow-lg p-3 w-40">
                <p className="text-xs text-text-primary mb-2">确认删除此 Provider？</p>
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => setShowConfirmDelete(false)}
                    className="px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover rounded transition-colors"
                    disabled={isDeleting}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleDelete}
                    className="px-2 py-1 text-xs text-white bg-accent-red hover:bg-accent-red/80 rounded transition-colors disabled:opacity-50"
                    disabled={isDeleting}
                  >
                    {isDeleting ? '删除中...' : '删除'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Agent Type Badge */}
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded ${getAgentBadgeColor(provider.agentType)}`}>
          {AGENT_DISPLAY_NAMES[provider.agentType]}
        </span>
        {/* Default Badge / Set Default Button */}
        {provider.isDefault ? (
          <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-bg-tertiary text-accent-indigo rounded">
            默认 ✓
          </span>
        ) : (
          <button
            onClick={handleSetDefault}
            className="text-xs text-text-muted hover:text-accent-indigo transition-colors"
          >
            设为默认
          </button>
        )}
      </div>

      {/* Test Result */}
      {testResult && (
        <div className={`mt-2 p-2 rounded text-xs ${
          testResult.success
            ? 'bg-bg-secondary text-accent-green border border-accent-green/30'
            : 'bg-bg-secondary text-accent-red border border-accent-red/30'
        }`}>
          {testResult.success ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}

    </div>
  );
}
