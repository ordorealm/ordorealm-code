/**
 * Skill Library Card Component
 * Displays a single skill library as a card
 * @module components/settings/SkillLibraryCard
 */

import { useState, useRef, useEffect } from 'react';
import type { SkillLibrary } from '@/types';
import { useSkillLibraryStore } from '@/stores/skill-library-store';
import { AgentBadge } from '@/components/common/AgentIcon';

interface SkillLibraryCardProps {
  library: SkillLibrary;
  onEdit: (library: SkillLibrary) => void;
}

/**
 * Format file size to human readable string
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

/**
 * Format date to locale string
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function SkillLibraryCard({ library, onEdit }: SkillLibraryCardProps): JSX.Element {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const deleteRef = useRef<HTMLDivElement>(null);

  const { deleteLibrary } = useSkillLibraryStore();

  // Click outside to close popover
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
      await deleteLibrary(library.id);
    } finally {
      setIsDeleting(false);
      setShowConfirmDelete(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    setIsDownloading(true);
    try {
      // Get the library zip path via IPC
      const result = await window.api.skillLibrary.download({ id: library.id });
      if (result.success && result.path) {
        // Show the file in the file manager since there's no save dialog
        await window.api.shell.openPath(result.path);
      }
    } catch (error) {
      console.error('[SkillLibraryCard] Download failed:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border rounded-lg p-3 hover:shadow-md transition-shadow duration-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <AgentBadge agentType={library.agentType} size="sm" showIcon={true} />
          <h3 className="text-sm font-medium text-text-primary">{library.name}</h3>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-text-muted mr-2">{formatFileSize(library.fileSize)}</span>

          {/* Download Button */}
          <button
            onClick={handleDownload}
            disabled={isDownloading}
            className="px-1.5 py-0.5 text-xs text-text-secondary hover:text-accent-indigo hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
            title="下载技能库"
          >
            {isDownloading ? '下载中...' : '下载'}
          </button>

          {/* Edit Button */}
          <button
            onClick={() => onEdit(library)}
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
              <div className="absolute right-0 top-full mt-1 z-10 bg-bg-primary border border-border rounded-lg shadow-lg p-3 w-44">
                <p className="text-xs text-text-primary mb-2">确认删除此技能库？</p>
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

      {/* Description */}
      <p className="text-xs text-text-secondary mb-2 line-clamp-2">{library.description}</p>

      {/* Footer: Creation time */}
      <div className="text-xs text-text-muted">
        创建于 {formatDate(library.createdAt)}
      </div>
    </div>
  );
}
