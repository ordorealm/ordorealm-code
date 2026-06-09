/**
 * New Project Dialog Component
 * Modal dialog for creating a new project
 * @module components/project/NewProjectDialog
 */

import { useState, useCallback } from 'react';
import { useProjectStore } from '@/stores/project-store';

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * NewProjectDialog component
 * Provides a form for creating a new project with:
 * - Project name input
 * - Directory selection via system dialog
 * - Validation for duplicate names
 */
export function NewProjectDialog({
  isOpen,
  onClose,
}: NewProjectDialogProps): JSX.Element | null {
  const { projects, createProject } = useProjectStore();

  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Handle browse button click
   * Opens system directory picker dialog
   */
  const handleBrowse = useCallback(async () => {
    try {
      const selectedPath = await window.api.dialog.openDirectory();
      if (selectedPath) {
        setProjectPath(selectedPath);
        // Auto-fill project name from directory name if not already set
        if (!projectName.trim()) {
          const dirName = selectedPath.split('/').pop() || selectedPath.split('\\').pop() || '';
          setProjectName(dirName);
        }
      }
    } catch (err) {
      console.error('[NewProjectDialog] 目录选择失败:', err);
      setError('无法打开目录选择器');
    }
  }, [projectName]);

  /**
   * Handle form submission
   */
  const handleCreate = useCallback(async () => {
    setError(null);

    // Validation: project name is required
    const trimmedName = projectName.trim();
    if (!trimmedName) {
      setError('请输入项目名称');
      return;
    }

    // Validation: project path is required
    if (!projectPath.trim()) {
      setError('请选择项目路径');
      return;
    }

    // Validation: check for duplicate name
    const duplicateName = projects.find(
      (p) => p.name.toLowerCase() === trimmedName.toLowerCase()
    );
    if (duplicateName) {
      setError(`已存在同名项目 "${duplicateName.name}"`);
      return;
    }

    // Validation: check for duplicate path
    const duplicatePath = projects.find((p) => p.path === projectPath);
    if (duplicatePath) {
      setError(`该路径已被项目 "${duplicatePath.name}" 使用`);
      return;
    }

    setIsCreating(true);

    try {
      const result = await createProject(projectPath, trimmedName);

      if (result.success) {
        // Reset form and close dialog
        setProjectName('');
        setProjectPath('');
        setError(null);
        onClose();
      } else {
        setError(result.error || '创建项目失败');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '创建项目时发生错误';
      setError(errorMessage);
      console.error('[NewProjectDialog] 创建项目失败:', err);
    } finally {
      setIsCreating(false);
    }
  }, [projectName, projectPath, projects, createProject, onClose]);

  /**
   * Handle dialog close
   */
  const handleClose = useCallback(() => {
    if (!isCreating) {
      setProjectName('');
      setProjectPath('');
      setError(null);
      onClose();
    }
  }, [isCreating, onClose]);

  /**
   * Handle key press
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      } else if (e.key === 'Enter' && !isCreating) {
        handleCreate();
      }
    },
    [handleClose, handleCreate, isCreating]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center" style={{ top: 'var(--title-bar-height, 0)' }} onKeyDown={handleKeyDown}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative bg-bg-primary rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        {/* Header */}
        <h2 className="text-xl font-semibold text-text-primary mb-6">新建项目</h2>

        {/* Form */}
        <div className="space-y-4">
          {/* Project Name */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              项目名称
            </label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="输入项目名称"
              disabled={isCreating}
              className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none transition-shadow disabled:bg-bg-tertiary disabled:cursor-not-allowed bg-bg-primary text-text-primary"
              autoFocus
            />
          </div>

          {/* Project Path */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              项目路径
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="选择目录..."
                disabled={isCreating}
                readOnly
                className="flex-1 px-3 py-2 border border-border rounded-lg bg-bg-tertiary text-text-secondary cursor-pointer"
                onClick={handleBrowse}
              />
              <button
                onClick={handleBrowse}
                disabled={isCreating}
                className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                浏览
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-lg text-sm bg-accent-red/10 text-accent-red border border-accent-red/30">
              <span className="font-medium">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
          <button
            onClick={handleClose}
            disabled={isCreating}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-indigo hover:bg-accent-indigo/80 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
