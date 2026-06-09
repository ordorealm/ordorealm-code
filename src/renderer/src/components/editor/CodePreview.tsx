/**
 * Code Preview Component
 * Displays code with syntax highlighting using Monaco Editor
 * Supports editing, saving, and large file handling
 * @module components/editor/CodePreview
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useCodePreviewStore, type ViewMode, type SafetyMode } from '@/stores/code-preview-store';
import { useAppearanceStore } from '@/stores/appearance-store';
import { useGitStore } from '@/stores/git-store';
import { normalizePath } from '@/utils/path';
import { FilePreview } from './FilePreview';

/** 删除内容详情 */
interface DeletedContentDetail {
  type: 'deleted' | 'replaced';
  lineNumber: number;
  deletedLines: { oldLine: number; content: string }[];
  newContent?: string;
}

/**
 * 删除内容详情弹窗
 */
function DeletedContentDialog({
  detail,
  onClose,
}: {
  detail: DeletedContentDetail;
  onClose: () => void;
}): JSX.Element {
  const totalChars = detail.deletedLines.reduce((sum, l) => sum + l.content.length, 0);

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      style={{ top: 'var(--title-bar-height, 0)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-bg-primary rounded-2xl shadow-2xl w-[700px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-red-500/10 to-transparent border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">
                {detail.type === 'replaced' ? '代码替换详情' : '删除内容详情'}
              </h3>
              <p className="text-xs text-text-muted mt-0.5">
                共 {detail.deletedLines.length} 行 · {totalChars} 字符
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text-primary rounded-lg hover:bg-bg-hover transition-colors"
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* 删除内容 */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-red-500"></div>
              <span className="text-sm font-medium text-text-secondary">删除的内容</span>
            </div>
            <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                {detail.deletedLines.map((line, index) => (
                  <div
                    key={index}
                    className="flex border-b border-border last:border-b-0 hover:bg-red-500/5 transition-colors"
                  >
                    <div className="px-4 py-2 text-text-muted text-right w-14 font-mono text-xs border-r border-border bg-bg-tertiary/50 flex-shrink-0">
                      {line.oldLine}
                    </div>
                    <div className="px-4 py-2 font-mono text-sm text-text-primary whitespace-pre flex-1 overflow-x-auto">
                      {line.content || <span className="text-text-muted italic">空行</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 新增内容（仅替换时显示） */}
          {detail.type === 'replaced' && detail.newContent && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                <span className="text-sm font-medium text-text-secondary">新增的内容</span>
              </div>
              <div className="bg-bg-secondary rounded-xl border border-border p-4 overflow-x-auto">
                <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap">
                  {detail.newContent}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 py-4 border-t border-border bg-bg-secondary/50">
          <button
            onClick={onClose}
            className="px-5 py-2 text-sm bg-bg-primary text-text-primary rounded-lg hover:bg-bg-hover border border-border transition-colors shadow-sm"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Large file warning dialog component
 */
function LargeFileWarningDialog(): JSX.Element | null {
  const {
    showLargeFileWarning,
    fileSize,
    totalChunks,
    confirmLargeFile,
    cancelLargeFile,
  } = useCodePreviewStore();

  if (!showLargeFileWarning) return null;

  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="large-file-title"
    >
      <div className="bg-bg-primary rounded-lg shadow-xl p-6 w-96 max-w-[90vw]">
        <h3
          id="large-file-title"
          className="text-lg font-semibold text-text-primary mb-3"
        >
          大文件警告
        </h3>
        <p className="text-sm text-text-secondary mb-2">
          此文件大小为 <strong>{fileSizeMB} MB</strong>，超过 1 MB 的阈值。
        </p>
        <p className="text-sm text-text-secondary mb-4">
          将分 <strong>{totalChunks}</strong> 段加载，每段约 256 KB。
          是否继续加载？
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={cancelLargeFile}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-md hover:bg-bg-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={confirmLargeFile}
            className="px-4 py-2 text-sm bg-accent-indigo text-white rounded-md hover:bg-accent-indigo/80 transition-colors"
          >
            加载文件
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Loading progress indicator for large files
 */
function LoadingProgress(): JSX.Element | null {
  const { isLoading, isLargeFile, loadedChunks, totalChunks } = useCodePreviewStore();

  if (!isLoading || !isLargeFile) return null;

  const progress = totalChunks > 0 ? (loadedChunks / totalChunks) * 100 : 0;

  return (
    <div className="absolute top-12 left-0 right-0 z-10 bg-bg-primary/95 border-b border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-indigo transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <span className="text-sm text-text-secondary whitespace-nowrap">
          {loadedChunks} / {totalChunks} 段
        </span>
        <button
          onClick={() => useCodePreviewStore.getState().loadAllChunks()}
          className="px-3 py-1 text-sm text-accent-indigo hover:text-accent-indigo/80"
        >
          全部加载
        </button>
      </div>
    </div>
  );
}

/**
 * Error display component
 */
function ErrorDisplay(): JSX.Element | null {
  const { error, clearError } = useCodePreviewStore();

  if (!error) return null;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-primary">
      <div className="text-center p-6">
        <div className="text-4xl mb-4">⚠️</div>
        <h3 className="text-lg font-medium text-text-primary mb-2">无法打开文件</h3>
        <p className="text-sm text-text-secondary mb-4">{error}</p>
        <button
          onClick={clearError}
          className="px-4 py-2 text-sm bg-bg-tertiary text-text-primary rounded-md hover:bg-bg-hover transition-colors"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

/**
 * Empty state component when no file is open
 */
function EmptyState(): JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-muted">
      <svg
        className="w-16 h-16 mb-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <p className="text-sm">在左侧文件树中选择文件以预览</p>
      <p className="text-xs mt-2 text-text-muted">支持代码编辑和保存</p>
    </div>
  );
}

/**
 * File header component with name and actions
 */
interface FileHeaderProps {
  onClose: () => void;
  onSave: () => void;
}

function FileHeader({ onClose, onSave }: FileHeaderProps): JSX.Element | null {
  const { currentFile, viewMode, toggleViewMode, safetyMode, toggleSafetyMode } = useCodePreviewStore();

  if (!currentFile) return null;

  return (
    <div className="flex items-center h-10 px-4 bg-bg-secondary border-b border-border">
      {/* File name */}
      <span className="text-sm font-medium text-text-primary truncate flex-1">
        {currentFile.name}
        {currentFile.isModified && (
          <span className="ml-1 text-accent-indigo">*</span>
        )}
      </span>

      {/* View mode toggle (only for previewable files) */}
      {currentFile.isPreviewable && (
        <ViewModeToggle viewMode={viewMode} onToggle={toggleViewMode} />
      )}

      {/* Safety mode toggle (only for HTML files) */}
      {currentFile.isHtml && viewMode === 'preview' && (
        <SafetyModeToggle safetyMode={safetyMode} onToggle={toggleSafetyMode} />
      )}

      {/* File status */}
      {currentFile.isModified && (
        <span className="text-xs text-text-muted mr-4">已修改</span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {currentFile.isModified && (
          <button
            onClick={onSave}
            className="px-3 py-1 text-xs bg-accent-indigo text-white rounded hover:bg-accent-indigo/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="保存 (Cmd/Ctrl+S)"
          >
            保存
          </button>
        )}
        <button
          onClick={onClose}
          className="p-1 text-text-muted hover:text-text-primary rounded hover:bg-bg-hover transition-colors"
          title="关闭"
          aria-label="关闭文件"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * View mode toggle button
 */
function ViewModeToggle({
  viewMode,
  onToggle,
}: {
  viewMode: ViewMode;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1 mr-4 bg-bg-tertiary rounded-md p-0.5">
      <button
        onClick={() => viewMode !== 'source' && onToggle()}
        className={`
          px-2 py-1 text-xs rounded transition-colors
          ${viewMode === 'source'
            ? 'bg-bg-primary text-text-primary shadow-sm'
            : 'text-text-muted hover:text-text-secondary'}
        `}
        title="源码"
      >
        源码
      </button>
      <button
        onClick={() => viewMode !== 'preview' && onToggle()}
        className={`
          px-2 py-1 text-xs rounded transition-colors
          ${viewMode === 'preview'
            ? 'bg-bg-primary text-text-primary shadow-sm'
            : 'text-text-muted hover:text-text-secondary'}
        `}
        title="预览"
      >
        预览
      </button>
    </div>
  );
}

/**
 * Safety mode toggle for HTML preview
 */
function SafetyModeToggle({
  safetyMode,
  onToggle,
}: {
  safetyMode: SafetyMode;
  onToggle: () => void;
}): JSX.Element {
  const isSafe = safetyMode === 'safe';
  return (
    <button
      onClick={onToggle}
      className={`
        flex items-center gap-1.5 mr-4 px-2 py-1 rounded-md text-xs transition-colors
        ${isSafe
          ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20'
          : 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20'}
      `}
      title={isSafe ? '安全模式：JS 已禁用，点击启用 JS' : '非安全模式：JS 已启用，点击禁用'}
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {isSafe ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
        )}
      </svg>
      {isSafe ? '安全' : 'JS'}
    </button>
  );
}

/**
 * CodePreview component
 * Monaco Editor based code viewer with editing support
 */
export function CodePreview(): JSX.Element {
  const {
    currentFile,
    isLoading,
    isLargeFile,
    error,
    viewMode,
    updateContent,
    saveFile,
    closeFile,
  } = useCodePreviewStore();

  const effectiveTheme = useAppearanceStore(state => state.effectiveTheme);
  const { currentFileDiff, loadFileDiff, clearFileDiff, diffFiles } = useGitStore();

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const decorationsRef = useRef<string[]>([]);

  // 删除内容详情弹窗状态
  const [deletedDetail, setDeletedDetail] = useState<DeletedContentDetail | null>(null);
  // 存储所有删除内容的映射（行号 -> 删除详情）
  const deletedLinesMapRef = useRef<Map<number, DeletedContentDetail>>(new Map());
  // 追踪 editor 是否准备好
  const [editorReady, setEditorReady] = useState(false);

  /**
   * Configure Monaco editor before mount
   */
  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monacoRef.current = monaco;

    // Define light theme
    monaco.editor.defineTheme('ordorealm-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.lineHighlightBackground': '#f8f9fa',
      },
    });

    // Define dark theme (GitHub Dark)
    monaco.editor.defineTheme('ordorealm-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0d1117',
        'editor.lineHighlightBackground': '#161b22',
        'editor.foreground': '#e6edf3',
        'editorLineNumber.foreground': '#484f58',
        'editorLineNumber.activeForeground': '#8b949e',
        'editor.selectionBackground': '#264f78',
        'editor.inactiveSelectionBackground': '#264f7855',
        'editorCursor.foreground': '#e6edf3',
        'editorWhitespace.foreground': '#484f58',
        'editorIndentGuide.background': '#21262d',
        'editorIndentGuide.activeBackground': '#30363d',
      },
    });
  }, []);

  /**
   * Handle editor mount - register commands and shortcuts
   */
  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // 标记 editor 已准备好
    setEditorReady(true);

    // Register Cmd/Ctrl+S for save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const file = useCodePreviewStore.getState().currentFile;
      if (file?.isModified) {
        saveFile();
      }
    });

    // 点击处理：使用 Monaco onMouseDown
    editor.onMouseDown((e) => {
      // GUTTER_GLYPH_MARGIN = 2
      if (e.target.type === 2 || e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const lineNumber = e.target.position?.lineNumber;
        if (lineNumber) {
          const detail = deletedLinesMapRef.current.get(lineNumber);
          if (detail) {
            setDeletedDetail(detail);
          }
        }
      }
    });

    // Focus editor
    editor.focus();
  }, [saveFile]);

  /**
   * Handle content changes
   */
  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        updateContent(value);
      }
    },
    [updateContent]
  );

  /**
   * Handle keyboard events for the container
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Cmd/Ctrl+S shortcut backup (in case editor doesn't have focus)
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (currentFile?.isModified) {
          saveFile();
        }
      }
    },
    [currentFile?.isModified, saveFile]
  );

  /**
   * Auto-focus editor when file changes
   */
  useEffect(() => {
    // 不再重置 editorReady，因为 Editor 组件不会重新 mount
    // editorReady 在首次 mount 后保持 true
    if (currentFile && editorRef.current) {
      editorRef.current.focus();
    }
  }, [currentFile?.path]);

  /**
   * Update editor theme when effective theme changes
   */
  useEffect(() => {
    if (monacoRef.current && editorRef.current) {
      const theme = effectiveTheme === 'dark' ? 'ordorealm-dark' : 'ordorealm-light';
      monacoRef.current.editor.setTheme(theme);
    }
  }, [effectiveTheme]);

  /**
   * Load file diff when file changes
   */
  useEffect(() => {
    // Normalize path for cross-platform compatibility
    const normalizedPath = currentFile ? normalizePath(currentFile.path) : null;
    if (normalizedPath && diffFiles.has(normalizedPath)) {
      loadFileDiff(currentFile!.path);
    } else {
      clearFileDiff();
    }
  }, [currentFile?.path, diffFiles, loadFileDiff, clearFileDiff]);

  /**
   * Apply diff decorations to editor
   */
  useEffect(() => {
    deletedLinesMapRef.current.clear();

    if (!editorReady || !editorRef.current || !monacoRef.current || !currentFileDiff) {
      if (editorRef.current) {
        decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, []);
      }
      return;
    }

    const monaco = monacoRef.current;
    const editor = editorRef.current;
    const decorations: editor.IModelDeltaDecoration[] = [];

    let lastNewLineNumber = 0;
    let pendingDeletedLines: { oldLine: number; content: string }[] = [];
    // 记录最近一个 deleted 装饰器在 decorations 数组中的索引和行号
    let lastDeletedDecorationIndex: number | null = null;
    let lastDeletedDecorationLine: number | null = null;
    // 记录最近一个 replaced 装饰器的行号（用于合并末尾删除）
    let lastReplacedDecorationLine: number | null = null;
    let lastReplacedDecorationIndex: number | null = null;

    for (let i = 0; i < currentFileDiff.lines.length; i++) {
      const line = currentFileDiff.lines[i];

      if (line.type === 'context' || line.type === 'modified') {
        // 处理累积的删除行 - 创建 deleted 装饰器
        if (pendingDeletedLines.length > 0 && lastNewLineNumber > 0) {
          const totalLines = pendingDeletedLines.length;
          const maxPreview = 3;
          const previewLines = pendingDeletedLines.slice(0, maxPreview);
          const hasMore = totalLines > maxPreview;

          const previewContent = previewLines.map(d => {
            const content = d.content.trim() || '(空行)';
            return `\n- \`${content.substring(0, 50)}${content.length > 50 ? '...' : ''}\``;
          }).join('');

          // 存储到 Map
          deletedLinesMapRef.current.set(lastNewLineNumber, {
            type: 'deleted',
            lineNumber: lastNewLineNumber,
            deletedLines: [...pendingDeletedLines],
          });

          // 记录这个 deleted 装饰器的索引和行号
          lastDeletedDecorationIndex = decorations.length;
          lastDeletedDecorationLine = lastNewLineNumber;
          // 清除 replaced 追踪，因为已经创建了独立的 deleted 装饰器
          lastReplacedDecorationLine = null;
          lastReplacedDecorationIndex = null;

          decorations.push({
            range: new monaco.Range(lastNewLineNumber, 1, lastNewLineNumber, 1),
            options: {
              isWholeLine: true,
              glyphMarginClassName: 'diff-deleted-glyph diff-glyph-clickable',
              glyphMarginHoverMessage: {
                value: `### ❌ 删除的行 (共 ${totalLines} 行)${previewContent}${hasMore ? `\n\n*...还有 ${totalLines - maxPreview} 行*` : ''}\n\n---\n*💡 查看更多点击左侧红色标记*`,
                isTrusted: true,
              },
            },
          });
          pendingDeletedLines = [];
        }

        if (line.newLineNumber !== null) {
          lastNewLineNumber = line.newLineNumber;
        }

        // 处理 modified 行
        if (line.type === 'modified' && line.newLineNumber !== null) {
          // modified 行出现，清除所有装饰器追踪
          lastDeletedDecorationIndex = null;
          lastDeletedDecorationLine = null;
          lastReplacedDecorationLine = null;
          lastReplacedDecorationIndex = null;

          decorations.push({
            range: new monaco.Range(line.newLineNumber, 1, line.newLineNumber, 1),
            options: {
              isWholeLine: true,
              className: 'diff-modified-line',
              glyphMarginClassName: 'diff-modified-glyph',
              glyphMarginHoverMessage: {
                value: `### ✏️ 已修改\n\n原第 ${line.oldLineNumber} 行已变更`,
              },
            },
          });
        }
      } else if (line.type === 'added') {
        // 处理删除后紧跟新增（替换）
        if (pendingDeletedLines.length > 0 && line.newLineNumber !== null) {
          const totalDeleted = pendingDeletedLines.length;
          const newContent = line.content.trim() || '(空行)';
          let merged = false;

          // 方案A改进：检查是否有任何未处理的 deleted 装饰器，如果有就合并
          // 不限制必须是相邻行，因为中间可能有 context 行触发了 deleted 装饰器的创建
          if (lastDeletedDecorationIndex !== null && lastDeletedDecorationLine !== null) {
            // 需要合并：移除上一个 deleted 装饰器，合并数据
            const prevData = deletedLinesMapRef.current.get(lastDeletedDecorationLine);
            if (prevData && prevData.type === 'deleted') {
              merged = true;
              // 合并删除行数据
              const allDeletedLines = [...prevData.deletedLines, ...pendingDeletedLines];
              const allTotalDeleted = allDeletedLines.length;

              // 从 decorations 数组中移除上一个 deleted 装饰器
              decorations.splice(lastDeletedDecorationIndex, 1);

              // 从 Map 中删除旧行的数据
              deletedLinesMapRef.current.delete(lastDeletedDecorationLine);

              // 存储合并后的 replaced 数据到当前行
              deletedLinesMapRef.current.set(line.newLineNumber, {
                type: 'replaced',
                lineNumber: line.newLineNumber,
                deletedLines: allDeletedLines,
                newContent: line.content,
              });

              // 记录这个 replaced 装饰器
              lastReplacedDecorationLine = line.newLineNumber;
              lastReplacedDecorationIndex = decorations.length;

              // 创建合并后的 replaced 装饰器
              const maxPreview = 3;
              const previewLines = allDeletedLines.slice(0, maxPreview);
              const hasMore = allTotalDeleted > maxPreview;
              const previewContent = previewLines.map(d => {
                const content = d.content.trim() || '(空行)';
                return `\n- \`${content.substring(0, 50)}${content.length > 50 ? '...' : ''}\``;
              }).join('');

              decorations.push({
                range: new monaco.Range(line.newLineNumber, 1, line.newLineNumber, 1),
                options: {
                  isWholeLine: true,
                  className: 'diff-added-line',
                  glyphMarginClassName: 'diff-replaced-glyph diff-glyph-clickable',
                  glyphMarginHoverMessage: {
                    value: `### 🔄 代码替换\n\n**❌ 删除** ${allTotalDeleted} 行:${previewContent}${hasMore ? `\n\n*...还有 ${allTotalDeleted - maxPreview} 行*` : ''}\n\n**✅ 新增:**\n\`\`\`\n${newContent.substring(0, 80)}${newContent.length > 80 ? '...' : ''}\n\`\`\`\n\n---\n*💡 查看更多点击左侧标记*`,
                    isTrusted: true,
                  },
                },
              });
            }
          }

          // 如果没有合并，直接创建 replaced 装饰器
          if (!merged) {
            deletedLinesMapRef.current.set(line.newLineNumber, {
              type: 'replaced',
              lineNumber: line.newLineNumber,
              deletedLines: [...pendingDeletedLines],
              newContent: line.content,
            });

            // 记录这个 replaced 装饰器
            lastReplacedDecorationLine = line.newLineNumber;
            lastReplacedDecorationIndex = decorations.length;

            const maxPreview = 3;
            const previewLines = pendingDeletedLines.slice(0, maxPreview);
            const hasMore = totalDeleted > maxPreview;
            const previewContent = previewLines.map(d => {
              const content = d.content.trim() || '(空行)';
              return `\n- \`${content.substring(0, 50)}${content.length > 50 ? '...' : ''}\``;
            }).join('');

            decorations.push({
              range: new monaco.Range(line.newLineNumber, 1, line.newLineNumber, 1),
              options: {
                isWholeLine: true,
                className: 'diff-added-line',
                glyphMarginClassName: 'diff-replaced-glyph diff-glyph-clickable',
                glyphMarginHoverMessage: {
                  value: `### 🔄 代码替换\n\n**❌ 删除** ${totalDeleted} 行:${previewContent}${hasMore ? `\n\n*...还有 ${totalDeleted - maxPreview} 行*` : ''}\n\n**✅ 新增:**\n\`\`\`\n${newContent.substring(0, 80)}${newContent.length > 80 ? '...' : ''}\n\`\`\`\n\n---\n*💡 查看更多点击左侧标记*`,
                  isTrusted: true,
                },
              },
            });
          }

          pendingDeletedLines = [];
          // 清除追踪，因为已经处理了
          lastDeletedDecorationIndex = null;
          lastDeletedDecorationLine = null;
        } else if (line.newLineNumber !== null) {
          // 纯新增行 - 清除所有追踪
          lastDeletedDecorationIndex = null;
          lastDeletedDecorationLine = null;
          lastReplacedDecorationLine = null;
          lastReplacedDecorationIndex = null;

          decorations.push({
            range: new monaco.Range(line.newLineNumber, 1, line.newLineNumber, 1),
            options: {
              isWholeLine: true,
              className: 'diff-added-line',
              glyphMarginClassName: 'diff-added-glyph',
              glyphMarginHoverMessage: {
                value: `### ✅ 新增行`,
              },
            },
          });
        }

        if (line.newLineNumber !== null) {
          lastNewLineNumber = line.newLineNumber;
        }
      } else if (line.type === 'deleted') {
        if (line.oldLineNumber !== null) {
          pendingDeletedLines.push({ oldLine: line.oldLineNumber, content: line.content });
        }
      }
    }

    // 处理末尾的删除行（或文件只有删除行的情况）
    if (pendingDeletedLines.length > 0) {
      // 优先检查是否可以合并到最后一个 replaced 装饰器
      if (lastReplacedDecorationLine !== null && lastReplacedDecorationIndex !== null) {
        const lastReplacedData = deletedLinesMapRef.current.get(lastReplacedDecorationLine);
        if (lastReplacedData && lastReplacedData.type === 'replaced') {
          // 合并删除行数据
          const allDeletedLines = [...lastReplacedData.deletedLines, ...pendingDeletedLines];
          const allTotalDeleted = allDeletedLines.length;

          // 从 Map 中删除旧数据
          deletedLinesMapRef.current.delete(lastReplacedDecorationLine);

          // 存储合并后的数据
          deletedLinesMapRef.current.set(lastReplacedDecorationLine, {
            type: 'replaced',
            lineNumber: lastReplacedDecorationLine,
            deletedLines: allDeletedLines,
            newContent: lastReplacedData.newContent,
          });

          // 移除旧的 replaced 装饰器
          decorations.splice(lastReplacedDecorationIndex, 1);

          // 创建新的合并后的 replaced 装饰器
          const maxPreview = 3;
          const previewLines = allDeletedLines.slice(0, maxPreview);
          const hasMore = allTotalDeleted > maxPreview;
          const previewContent = previewLines.map(d => {
            const content = d.content.trim() || '(空行)';
            return `\n- \`${content.substring(0, 50)}${content.length > 50 ? '...' : ''}\``;
          }).join('');
          const newContent = lastReplacedData.newContent?.trim() || '(空行)';

          decorations.push({
            range: new monaco.Range(lastReplacedDecorationLine, 1, lastReplacedDecorationLine, 1),
            options: {
              isWholeLine: true,
              className: 'diff-added-line',
              glyphMarginClassName: 'diff-replaced-glyph diff-glyph-clickable',
              glyphMarginHoverMessage: {
                value: `### 🔄 代码替换\n\n**❌ 删除** ${allTotalDeleted} 行:${previewContent}${hasMore ? `\n\n*...还有 ${allTotalDeleted - maxPreview} 行*` : ''}\n\n**✅ 新增:**\n\`\`\`\n${newContent.substring(0, 80)}${newContent.length > 80 ? '...' : ''}\n\`\`\`\n\n---\n*💡 查看更多点击左侧标记*`,
                isTrusted: true,
              },
            },
          });
        }
      } else {
        // 没有可以合并的 replaced，创建独立的 deleted 装饰器
        let targetLine: number;

        if (lastNewLineNumber > 0) {
          targetLine = lastNewLineNumber;
        } else {
          // 纯删除文件：计算删除位置
          const minOldLine = Math.min(...pendingDeletedLines.map(d => d.oldLine));

          // 获取编辑器模型的总行数
          const model = editor.getModel();
          const totalLines = model ? model.getLineCount() : 1;

          // 标记位置：删除开始的位置，但不超过文件总行数
          targetLine = Math.min(minOldLine, totalLines);
          targetLine = Math.max(1, targetLine);
        }

        const deletedLinesCount = pendingDeletedLines.length;
        const maxPreview = 3;
        const previewLines = pendingDeletedLines.slice(0, maxPreview);
        const hasMore = deletedLinesCount > maxPreview;

        const previewContent = previewLines.map(d => {
          const content = d.content.trim() || '(空行)';
          return `\n- \`${content.substring(0, 50)}${content.length > 50 ? '...' : ''}\``;
        }).join('');

        deletedLinesMapRef.current.set(targetLine, {
          type: 'deleted',
          lineNumber: targetLine,
          deletedLines: [...pendingDeletedLines],
        });

        decorations.push({
          range: new monaco.Range(targetLine, 1, targetLine, 1),
          options: {
            isWholeLine: true,
            glyphMarginClassName: 'diff-deleted-glyph diff-glyph-clickable',
            glyphMarginHoverMessage: {
              value: `### ❌ 删除的行 (共 ${deletedLinesCount} 行)${previewContent}${hasMore ? `\n\n*...还有 ${deletedLinesCount - maxPreview} 行*` : ''}\n\n---\n*💡 查看更多点击左侧红色标记*`,
              isTrusted: true,
            },
          },
        });
      }
    }

    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }, [currentFileDiff, editorReady]);

  // Show error state
  if (error) {
    return (
      <div className="h-full relative bg-bg-primary">
        <ErrorDisplay />
      </div>
    );
  }

  // Show empty state when no file
  if (!currentFile) {
    return (
      <div className="h-full bg-bg-primary">
        <EmptyState />
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-bg-primary relative"
      onKeyDown={handleKeyDown}
    >
      {/* Large file warning dialog */}
      <LargeFileWarningDialog />

      {/* Loading progress for large files */}
      <LoadingProgress />

      {/* File header */}
      <FileHeader onClose={closeFile} onSave={saveFile} />

      {/* Editor/Preview container */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'preview' && currentFile.isPreviewable ? (
          <FilePreview />
        ) : (
          <Editor
            height="100%"
            language={currentFile.language}
            value={currentFile.content}
            theme={effectiveTheme === 'dark' ? 'ordorealm-dark' : 'ordorealm-light'}
            onChange={handleChange}
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            loading={
              <div className="h-full flex items-center justify-center">
                <div className="flex items-center gap-3">
                  <svg className="animate-spin w-5 h-5 text-accent-indigo" fill="none" viewBox="0 0 24 24">
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
                  <span className="text-sm text-text-muted">加载中...</span>
                </div>
              </div>
            }
            options={{
              // Editor options
              readOnly: isLoading,
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
              fontLigatures: true,
              lineHeight: 1.6,
              minimap: {
                enabled: !isLargeFile,
                scale: 1,
              },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              wordWrapColumn: 120,
              wrappingStrategy: 'advanced',
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              renderWhitespace: 'selection',
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              smoothScrolling: true,
              padding: { top: 8, bottom: 8 },
              scrollbar: {
                vertical: 'visible',
                horizontal: 'visible',
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
                useShadows: false,
              },
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              folding: true,
              foldingStrategy: 'indentation',
              showFoldingControls: 'mouseover',
              bracketPairColorization: {
                enabled: true,
              },
              guides: {
                bracketPairs: true,
                indentation: true,
              },
              suggest: {
                showKeywords: true,
                showSnippets: true,
              },
              quickSuggestions: {
                other: 'inline',
                comments: false,
                strings: false,
              },
              // 启用 glyph margin 以显示 diff 标记
              glyphMargin: true,
            }}
          />
        )}
      </div>

      {/* 删除内容详情弹窗 */}
      {deletedDetail && (
        <DeletedContentDialog
          detail={deletedDetail}
          onClose={() => setDeletedDetail(null)}
        />
      )}
    </div>
  );
}

export default CodePreview;
