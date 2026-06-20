/**
 * Message File Changes Component
 * 显示单条 AI 消息关联的文件修改
 * 样式与 ToolOperationGroup 一致
 */
import { useMemo, useState } from 'react';
import { useCodePreviewStore } from '@/stores/code-preview-store';
import { useFileTreeStore } from '@/stores/filetree-store';
import { useGitStore } from '@/stores/git-store';
import type { FileChange } from '@/types/session.types';

interface MessageFileChangesProps {
  /** 该消息关联的文件修改列表 */
  fileChanges: FileChange[];
  /** 切换到文件 Tab 的回调 */
  onSwitchToFileTab?: () => void;
}

/**
 * 获取文件修改类型的图标
 */
function getFileChangeIcon(type: FileChange['type']): string {
  switch (type) {
    case 'created':
      return '📄';
    case 'modified':
      return '✏️';
    case 'deleted':
      return '🗑️';
    default:
      return '📁';
  }
}

/**
 * 获取文件名（从路径中提取）
 */
function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Message File Changes Component
 * 显示在消息下方，样式类似 ToolOperationGroup
 */
export function MessageFileChanges({ fileChanges, onSwitchToFileTab }: MessageFileChangesProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const openFile = useCodePreviewStore(s => s.openFile);
  const selectFile = useFileTreeStore(s => s.selectFile);
  const loadFileDiff = useGitStore(s => s.loadFileDiff);

  // 去重文件修改
  const uniqueChanges = useMemo(() => {
    const fileMap = new Map<string, FileChange>();
    for (const change of fileChanges) {
      // 后面的修改可能更新文件状态
      fileMap.set(change.path, change);
    }
    return Array.from(fileMap.values());
  }, [fileChanges]);

  // 没有文件修改时不显示
  if (uniqueChanges.length === 0) {
    return null;
  }

  /**
   * 处理文件点击
   */
  const handleFileClick = async (change: FileChange) => {
    // 不处理已删除的文件
    if (change.type === 'deleted') {
      return;
    }

    // 先选中文件（触发文件树选中状态）
    selectFile(change.path);

    // 加载 Git diff（显示修改行）
    await loadFileDiff(change.path);

    // 打开文件
    await openFile(change.path);

    // 切换到文件 Tab
    if (onSwitchToFileTab) {
      onSwitchToFileTab();
    }
  };

  return (
    <div className="my-2 mx-2 rounded-lg overflow-hidden border-l-2 border-accent-green/60 bg-bg-secondary/30">
      {/* Summary header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-hover/50 transition-colors"
      >
        {/* Expand/collapse indicator */}
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {expanded ? '▼' : '▶'}
        </span>

        {/* File icon */}
        <span className="text-xs flex-shrink-0">📁</span>

        {/* Summary */}
        <span className="text-xs font-medium text-text-primary">
          修改了 {uniqueChanges.length} 个文件
        </span>
      </button>

      {/* Expanded file list */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {uniqueChanges.map(change => (
            <div
              key={change.path}
              className={`
                flex items-center gap-2 py-1 px-2 rounded
                ${change.type === 'deleted'
                  ? 'opacity-50'
                  : 'hover:bg-bg-hover cursor-pointer'
                }
              `}
              onClick={() => handleFileClick(change)}
            >
              <span className="text-xs flex-shrink-0">
                {getFileChangeIcon(change.type)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary truncate">
                  {getFileName(change.path)}
                </div>
                <div className="text-[10px] text-text-muted truncate">
                  {change.path}
                </div>
              </div>
              {change.type !== 'deleted' && (
                <button
                  className="text-[10px] text-accent-primary hover:underline flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleFileClick(change);
                  }}
                >
                  查看
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
