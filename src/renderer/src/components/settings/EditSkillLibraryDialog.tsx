/**
 * Edit Skill Library Dialog Component
 * Modal dialog for editing skill library metadata
 * @module components/settings/EditSkillLibraryDialog
 */

import { useState, useEffect } from 'react';
import type { SkillLibrary } from '@/types';
import { useSkillLibraryStore } from '@/stores/skill-library-store';
import { AgentBadge } from '@/components/common/AgentIcon';

interface EditSkillLibraryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  library: SkillLibrary | null;
}

export function EditSkillLibraryDialog({
  isOpen,
  onClose,
  library,
}: EditSkillLibraryDialogProps): JSX.Element | null {
  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // State
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { updateLibrary } = useSkillLibraryStore();

  // Initialize form when library changes
  useEffect(() => {
    if (library) {
      setName(library.name);
      setDescription(library.description);
    }
    setError(null);
  }, [library]);

  const handleClose = (): void => {
    onClose();
  };

  /**
   * Handle save
   */
  const handleSave = async (): Promise<void> => {
    if (!library) return;

    setError(null);

    // Validation
    if (!name.trim()) {
      setError('请输入技能库名称');
      return;
    }

    if (!description.trim()) {
      setError('请输入技能库说明');
      return;
    }

    setIsSaving(true);

    try {
      const success = await updateLibrary(library.id, name.trim(), description.trim());
      if (success) {
        handleClose();
      } else {
        setError('更新失败，请重试');
      }
    } catch (err) {
      console.error('[EditSkillLibraryDialog] Save failed:', err);
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !library) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative bg-bg-primary rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <h2 className="text-xl font-semibold text-text-primary mb-6">编辑技能库</h2>

        {/* Form */}
        <div className="space-y-5">
          {/* Agent Type (readonly) */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              Agent 类型
            </label>
            <div className="flex items-center gap-2">
              <AgentBadge agentType={library.agentType} size="sm" showIcon={true} />
              <span className="text-xs text-text-muted">（不可修改）</span>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              技能库名称 <span className="text-accent-red">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: Superspec 全流程"
              className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none transition-shadow bg-bg-primary text-text-primary"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              技能库说明 <span className="text-accent-red">*</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述这个技能库的功能和用途"
              rows={3}
              className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none transition-shadow bg-bg-primary text-text-primary resize-none"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg text-sm bg-accent-red/10 text-accent-red border border-accent-red/30">
              <span className="font-medium">✗ </span>
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover rounded-lg transition-colors"
            disabled={isSaving}
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-indigo hover:bg-accent-indigo/80 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
