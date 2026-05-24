/**
 * Add Skill Library Dialog Component
 * Modal dialog for adding a new skill library from zip file
 * @module components/settings/AddSkillLibraryDialog
 */

import { useState, useRef, useCallback } from 'react';
import type { AgentType } from '@/types';
import { AGENT_DISPLAY_NAMES } from '@/types/provider.types';
import { useSkillLibraryStore } from '@/stores/skill-library-store';

interface AddSkillLibraryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddSkillLibraryDialog({
  isOpen,
  onClose,
}: AddSkillLibraryDialogProps): JSX.Element | null {
  // Form state
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');

  // Validation state
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const { addLibrary } = useSkillLibraryStore();

  const resetForm = (): void => {
    setZipPath(null);
    setFileName('');
    setFileSize(0);
    setName('');
    setDescription('');
    setAgentType('claude-code');
    setValidationResult(null);
    setError(null);
  };

  const handleClose = (): void => {
    resetForm();
    onClose();
  };

  /**
   * Handle file selection via button
   */
  const handleSelectFile = async (): Promise<void> => {
    try {
      const result = await window.api.dialog.openFile({
        filters: [{ name: 'Zip Files', extensions: ['zip'] }],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        await handleFileSelection(result.filePaths[0]);
      }
    } catch (err) {
      console.error('[AddSkillLibraryDialog] File selection failed:', err);
      setError('文件选择失败');
    }
  };

  /**
   * Handle file selection (from dialog or drag)
   */
  const handleFileSelection = async (filePath: string): Promise<void> => {
    setError(null);
    setValidationResult(null);

    // Get file info
    try {
      const statsResult = await window.api.fs.stat(filePath);
      if (!statsResult.success || !statsResult.content) {
        throw new Error('无法读取文件信息');
      }
      setZipPath(filePath);
      setFileName(filePath.split('/').pop() || filePath);
      setFileSize(statsResult.content.size);

      // Auto-fill name from filename
      const baseName = filePath.split('/').pop()?.replace('.zip', '') || '';
      if (!name) {
        setName(baseName);
      }

      // Validate zip structure
      setIsValidating(true);
      const validateResult = await window.api.skillLibrary.validate({ zipPath: filePath });
      setValidationResult({ valid: validateResult.valid ?? false, error: validateResult.error });
      setIsValidating(false);
    } catch (err) {
      console.error('[AddSkillLibraryDialog] File info failed:', err);
      setError('无法读取文件信息');
      setIsValidating(false);
    }
  };

  /**
   * Handle drag over
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  /**
   * Handle drag leave
   */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  /**
   * Handle drop
   */
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.zip')) {
        // In Electron renderer, we need to get the file path differently
        // For now, we'll prompt user to use the button instead
        setError('请使用"点击上传"按钮选择文件');
      } else {
        setError('请上传 .zip 格式的文件');
      }
    }
  }, []);

  /**
   * Format file size
   */
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  /**
   * Handle save
   */
  const handleSave = async (): Promise<void> => {
    setError(null);

    // Validation
    if (!zipPath) {
      setError('请选择 zip 文件');
      return;
    }

    if (!name.trim()) {
      setError('请输入技能库名称');
      return;
    }

    if (!description.trim()) {
      setError('请输入技能库说明');
      return;
    }

    if (!validationResult?.valid) {
      setError('技能库文件验证未通过');
      return;
    }

    setIsSaving(true);

    try {
      const result = await addLibrary(zipPath, name.trim(), description.trim(), agentType);
      if (result) {
        handleClose();
      } else {
        setError('添加失败，请重试');
      }
    } catch (err) {
      console.error('[AddSkillLibraryDialog] Save failed:', err);
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

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
        <h2 className="text-xl font-semibold text-text-primary mb-6">添加技能库</h2>

        {/* Form */}
        <div className="space-y-5">
          {/* Upload Area */}
          <div
            ref={dropRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`
              border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer
              ${isDragging
                ? 'border-accent-indigo bg-accent-indigo/5'
                : 'border-border hover:border-accent-indigo/50'}
              ${zipPath && validationResult?.valid ? 'border-accent-green' : ''}
            `}
            onClick={handleSelectFile}
          >
            {!zipPath ? (
              <div>
                <div className="text-3xl mb-2">📁</div>
                <p className="text-sm text-text-secondary">
                  拖拽 zip 文件到这里，或<span className="text-accent-indigo">点击上传</span>
                </p>
                <p className="text-xs text-text-muted mt-1">支持最大 100MB 的 zip 文件</p>
              </div>
            ) : (
              <div>
                <div className="text-2xl mb-2">📦</div>
                <p className="text-sm text-text-primary font-medium">{fileName}</p>
                <p className="text-xs text-text-muted">{formatFileSize(fileSize)}</p>
              </div>
            )}
          </div>

          {/* Validation Status */}
          {isValidating && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
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
              <span>验证中...</span>
            </div>
          )}

          {validationResult && (
            <div
              className={`p-3 rounded-lg text-sm ${
                validationResult.valid
                  ? 'bg-accent-green/10 text-accent-green border border-accent-green/30'
                  : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
              }`}
            >
              {validationResult.valid ? (
                <span>✓ 技能库结构符合规范</span>
              ) : (
                <span>✗ {validationResult.error || '验证失败'}</span>
              )}
            </div>
          )}

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

          {/* Agent Type */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              Agent 类型 <span className="text-accent-red">*</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(AGENT_DISPLAY_NAMES) as AgentType[]).map((agent) => (
                <button
                  key={agent}
                  type="button"
                  onClick={() => setAgentType(agent)}
                  className={`
                    px-3 py-2 text-sm font-medium rounded-lg border transition-all
                    ${agentType === agent
                      ? 'border-accent-indigo bg-bg-tertiary text-accent-indigo'
                      : 'border-border bg-bg-primary text-text-secondary hover:border-border'}
                  `}
                >
                  {AGENT_DISPLAY_NAMES[agent]}
                </button>
              ))}
            </div>
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
            disabled={isSaving || !validationResult?.valid}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-indigo hover:bg-accent-indigo/80 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
