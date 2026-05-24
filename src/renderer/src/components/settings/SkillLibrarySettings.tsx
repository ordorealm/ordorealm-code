/**
 * Skill Library Settings Panel Component
 * Main settings panel for managing skill libraries
 * @module components/settings/SkillLibrarySettings
 */

import { useState, useEffect } from 'react';
import type { SkillLibrary } from '@/types';
import { useSkillLibraryStore } from '@/stores/skill-library-store';
import { SkillLibraryCard } from './SkillLibraryCard';
import { AddSkillLibraryDialog } from './AddSkillLibraryDialog';
import { EditSkillLibraryDialog } from './EditSkillLibraryDialog';

export function SkillLibrarySettings(): JSX.Element {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<SkillLibrary | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const { libraries, loadLibraries } = useSkillLibraryStore();

  // Load libraries on mount
  useEffect(() => {
    const init = async (): Promise<void> => {
      await loadLibraries();
      setIsLoading(false);
    };
    init();
  }, [loadLibraries]);

  const handleEditLibrary = (library: SkillLibrary): void => {
    setEditingLibrary(library);
  };

  const handleCloseEditDialog = (): void => {
    setEditingLibrary(null);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">专家技能库</h3>
          <p className="text-xs text-text-muted mt-0.5">管理您的专家技能库，切换后将在当前项目中激活</p>
        </div>
        <button
          onClick={() => setIsAddDialogOpen(true)}
          className="text-xs text-accent-indigo hover:text-accent-indigo/80 font-medium"
        >
          + 添加
        </button>
      </div>

      {/* Library List */}
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
      ) : libraries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 px-4 bg-bg-secondary border border-border rounded-lg">
          <div className="w-12 h-12 mb-3 flex items-center justify-center bg-bg-tertiary rounded-full">
            <span className="text-2xl">📚</span>
          </div>
          <p className="text-sm text-text-secondary mb-1">暂无技能库</p>
          <p className="text-xs text-text-muted mb-3">添加一个技能库以增强 Agent 能力</p>
          <button
            onClick={() => setIsAddDialogOpen(true)}
            className="text-xs text-accent-indigo hover:text-accent-indigo/80 font-medium"
          >
            + 添加技能库
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {libraries.map((library) => (
            <SkillLibraryCard
              key={library.id}
              library={library}
              onEdit={handleEditLibrary}
            />
          ))}
        </div>
      )}

      {/* Add Dialog */}
      <AddSkillLibraryDialog
        isOpen={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
      />

      {/* Edit Dialog */}
      <EditSkillLibraryDialog
        isOpen={editingLibrary !== null}
        onClose={handleCloseEditDialog}
        library={editingLibrary}
      />
    </div>
  );
}
