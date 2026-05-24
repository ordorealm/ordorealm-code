/**
 * Provider Settings Panel Component
 * Main settings panel for managing API providers
 * @module components/settings/ProviderSettings
 */

import { useState, useEffect } from 'react';
import type { Provider } from '@/types';
import { useProviderStore } from '@/stores/provider-store';
import { ProviderCard } from './ProviderCard';
import { AddProviderDialog } from './AddProviderDialog';

export function ProviderSettings(): JSX.Element {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const { providers, loadProviders, addProvider, updateProvider, deleteProvider, setDefault } =
    useProviderStore();

  // Load providers on mount
  useEffect(() => {
    const init = async (): Promise<void> => {
      await loadProviders();
      setIsLoading(false);
    };
    init();
  }, [loadProviders]);

  const handleAddProvider = async (
    provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<void> => {
    await addProvider(provider);
  };

  const handleEditProvider = (provider: Provider): void => {
    setEditingProvider(provider);
    setIsDialogOpen(true);
  };

  const handleUpdateProvider = async (
    provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<void> => {
    if (!editingProvider) return;

    const updates: Partial<Provider> = {
      name: provider.name,
      agentType: provider.agentType,
      apiType: provider.apiType,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      contextWindow: provider.contextWindow,
      command: provider.command,
      executablePath: provider.executablePath,
      nodeVersion: provider.nodeVersion,
      envOverrides: provider.envOverrides,
      isDefault: provider.isDefault,
    };

    await updateProvider(editingProvider.id, updates);
    setEditingProvider(null);
  };

  const handleDeleteProvider = async (id: string): Promise<void> => {
    await deleteProvider(id);
  };

  const handleSetDefault = async (id: string): Promise<void> => {
    await setDefault(id);
  };

  const handleCloseDialog = (): void => {
    setIsDialogOpen(false);
    setEditingProvider(null);
  };

  return (
    <div className="space-y-4">
      {/* Section: AI Provider */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">AI Provider</h3>
          <button
            onClick={() => {
              setEditingProvider(null);
              setIsDialogOpen(true);
            }}
            className="text-xs text-accent-indigo hover:text-accent-indigo/80 font-medium"
          >
            + 添加
          </button>
        </div>

        {/* Provider List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2 text-text-muted">
              <svg
                className="animate-spin h-4 w-4 text-accent-indigo"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-xs">加载中...</span>
            </div>
          </div>
        ) : providers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 bg-bg-secondary border border-border rounded-lg">
            <div className="w-12 h-12 mb-3 flex items-center justify-center bg-bg-tertiary rounded-full">
              <span className="text-2xl">🔌</span>
            </div>
            <p className="text-sm text-text-secondary mb-1">暂无 Provider</p>
            <p className="text-xs text-text-muted mb-3">添加一个 API Provider 开始使用</p>
            <button
              onClick={() => {
                setEditingProvider(null);
                setIsDialogOpen(true);
              }}
              className="text-xs text-accent-indigo hover:text-accent-indigo/80 font-medium"
            >
              + 添加
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                onEdit={handleEditProvider}
                onDelete={handleDeleteProvider}
                onSetDefault={handleSetDefault}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Dialog */}
      <AddProviderDialog
        isOpen={isDialogOpen}
        onClose={handleCloseDialog}
        onSave={editingProvider ? handleUpdateProvider : handleAddProvider}
        editProvider={editingProvider}
      />
    </div>
  );
}
