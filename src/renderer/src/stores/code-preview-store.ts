/**
 * Code Preview Store
 * Manages state for code preview component with large file support
 * @module stores/code-preview-store
 */

import { create } from 'zustand';
import { detectLanguage, isTextFile, LARGE_FILE_THRESHOLD } from '@/utils/language-detect';
import { getBasename } from '@/utils/path';

/** Chunk size for large file loading (256KB) */
const CHUNK_SIZE = 256 * 1024;

/** View mode for previewable files */
export type ViewMode = 'source' | 'preview';

/** HTML preview safety mode */
export type SafetyMode = 'safe' | 'unsafe';

/** File extensions that support preview mode */
const PREVIEWABLE_EXTENSIONS = ['.md', '.markdown', '.html', '.htm'];

/**
 * Check if file supports preview mode
 */
function isPreviewable(filePath: string): boolean {
  const ext = filePath.toLowerCase();
  return PREVIEWABLE_EXTENSIONS.some(e => ext.endsWith(e));
}

/**
 * Check if file is HTML (needs safety toggle)
 */
function isHtmlFile(filePath: string): boolean {
  const ext = filePath.toLowerCase();
  return ext.endsWith('.html') || ext.endsWith('.htm');
}

/**
 * Current file information
 */
interface CurrentFile {
  /** File path */
  path: string;
  /** File name */
  name: string;
  /** File content */
  content: string;
  /** Monaco Editor language ID */
  language: string;
  /** Whether content has been modified */
  isModified: boolean;
  /** Original content (for comparison) */
  originalContent: string;
  /** Whether file supports preview mode */
  isPreviewable: boolean;
  /** Whether file is HTML (needs safety toggle) */
  isHtml: boolean;
}

/**
 * Code preview state
 */
interface CodePreviewState {
  /** Currently opened file */
  currentFile: CurrentFile | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Whether the file is large (> 1MB) */
  isLargeFile: boolean;
  /** Number of chunks loaded */
  loadedChunks: number;
  /** Total number of chunks */
  totalChunks: number;
  /** File size in bytes */
  fileSize: number;
  /** Whether to show large file warning */
  showLargeFileWarning: boolean;
  /** Pending file path to load after user confirms */
  pendingFilePath: string | null;
  /** View mode for previewable files */
  viewMode: ViewMode;
  /** Safety mode for HTML preview (resets on file close) */
  safetyMode: SafetyMode;
}

/**
 * Code preview actions
 */
interface CodePreviewActions {
  /**
   * Open a file and load its content
   * @param filePath File path to open
   * @returns Promise resolving to success status
   */
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;

  /**
   * Update file content
   * @param content New content
   */
  updateContent: (content: string) => void;

  /**
   * Save current file
   * @returns Promise resolving to success status
   */
  saveFile: () => Promise<{ success: boolean; error?: string }>;

  /**
   * Close current file
   */
  closeFile: () => void;

  /**
   * Load next chunk for large file
   * @returns Promise resolving to whether more chunks remain
   */
  loadNextChunk: () => Promise<boolean>;

  /**
   * Load all remaining chunks
   * @returns Promise resolving when all chunks are loaded
   */
  loadAllChunks: () => Promise<void>;

  /**
   * Confirm loading large file
   */
  confirmLargeFile: () => void;

  /**
   * Cancel loading large file
   */
  cancelLargeFile: () => void;

  /**
   * Clear error
   */
  clearError: () => void;

  /**
   * Set view mode (source/preview)
   */
  setViewMode: (mode: ViewMode) => void;

  /**
   * Toggle view mode
   */
  toggleViewMode: () => void;

  /**
   * Set safety mode for HTML preview
   */
  setSafetyMode: (mode: SafetyMode) => void;

  /**
   * Toggle safety mode
   */
  toggleSafetyMode: () => void;
}

/** File stat result from IPC */
interface FileStatResult {
  success: boolean;
  error?: string;
  content?: {
    size: number;
    isFile: boolean;
  };
}

/** File read result from IPC */
interface FileReadResult {
  success: boolean;
  error?: string;
  content?: string;
}

/** File write result from IPC */
interface FileWriteResult {
  success: boolean;
  error?: string;
}

/**
 * Get file size via IPC
 */
async function getFileSize(filePath: string): Promise<number | null> {
  try {
    const result = await window.api.fs.stat(filePath) as FileStatResult;
    if (result.success && result.content?.isFile) {
      return result.content.size;
    }
    return null;
  } catch (error) {
    console.error('[CodePreviewStore] Failed to get file size:', error);
    return null;
  }
}

/**
 * Read file content with optional range (for chunked loading)
 */
async function readFileChunk(
  filePath: string,
  start: number = 0,
  end?: number
): Promise<string | null> {
  try {
    // Note: Electron IPC doesn't support range reading directly
    // For now, we read the whole file and slice in renderer
    // In production, this should be enhanced in main process
    const result = await window.api.fs.readFile(filePath) as FileReadResult;
    if (result.success && result.content !== undefined) {
      if (start === 0 && end === undefined) {
        return result.content;
      }
      return result.content.slice(start, end);
    }
    return null;
  } catch (error) {
    console.error('[CodePreviewStore] Failed to read file chunk:', error);
    return null;
  }
}

/**
 * State type for Zustand store
 */
type Store = CodePreviewState & CodePreviewActions;

export const useCodePreviewStore = create<Store>((set, get) => ({
  // Initial state
  currentFile: null,
  isLoading: false,
  error: null,
  isLargeFile: false,
  loadedChunks: 0,
  totalChunks: 0,
  fileSize: 0,
  showLargeFileWarning: false,
  pendingFilePath: null,
  viewMode: 'source',
  safetyMode: 'safe',

  /**
   * Open a file and load its content
   */
  openFile: async (filePath) => {
    console.log(`[CodePreviewStore] Opening file: ${filePath}`);

    // Check if it's a text file
    if (!isTextFile(filePath)) {
      const error = '此文件类型不支持预览';
      console.warn(`[CodePreviewStore] ${error}: ${filePath}`);
      set({ error, currentFile: null });
      return { success: false, error };
    }

    // Get file size first
    const fileSize = await getFileSize(filePath);
    if (fileSize === null) {
      const error = '无法获取文件信息';
      set({ error, currentFile: null });
      return { success: false, error };
    }

    // Check for large file
    if (fileSize > LARGE_FILE_THRESHOLD) {
      const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
      console.log(`[CodePreviewStore] Large file detected: ${fileSize} bytes, ${totalChunks} chunks`);
      set({
        isLargeFile: true,
        showLargeFileWarning: true,
        pendingFilePath: filePath,
        fileSize,
        totalChunks,
        loadedChunks: 0,
      });
      return { success: true };
    }

    // Normal file loading
    set({ isLoading: true, error: null, isLargeFile: false });

    try {
      const content = await readFileChunk(filePath);
      if (content === null) {
        const error = '无法读取文件内容';
        set({ isLoading: false, error, currentFile: null });
        return { success: false, error };
      }

      const language = detectLanguage(filePath);
      const name = getBasename(filePath) || filePath;
      const previewable = isPreviewable(filePath);
      const isHtml = isHtmlFile(filePath);

      set({
        isLoading: false,
        currentFile: {
          path: filePath,
          name,
          content,
          language,
          isModified: false,
          originalContent: content,
          isPreviewable: previewable,
          isHtml,
        },
        fileSize,
        isLargeFile: false,
        loadedChunks: 0,
        totalChunks: 0,
        viewMode: previewable ? 'preview' : 'source',
        safetyMode: 'safe',
      });

      console.log(`[CodePreviewStore] File opened: ${filePath} (${language})`);
      return { success: true };
    } catch (error) {
      const errorMsg = `打开文件失败: ${error}`;
      console.error(`[CodePreviewStore] ${errorMsg}`);
      set({ isLoading: false, error: errorMsg, currentFile: null });
      return { success: false, error: errorMsg };
    }
  },

  /**
   * Update file content
   */
  updateContent: (content) => {
    const { currentFile } = get();
    if (!currentFile) return;

    const isModified = content !== currentFile.originalContent;
    set({
      currentFile: {
        ...currentFile,
        content,
        isModified,
      },
    });
  },

  /**
   * Save current file
   */
  saveFile: async () => {
    const { currentFile } = get();
    if (!currentFile) {
      return { success: false, error: '没有打开的文件' };
    }

    console.log(`[CodePreviewStore] Saving file: ${currentFile.path}`);

    try {
      const result = await window.api.fs.writeFile(currentFile.path, currentFile.content) as FileWriteResult;

      if (!result.success) {
        const error = result.error || '保存失败';
        console.error(`[CodePreviewStore] Save failed: ${error}`);
        set({ error });
        return { success: false, error };
      }

      // Update state after successful save
      set({
        currentFile: {
          ...currentFile,
          isModified: false,
          originalContent: currentFile.content,
        },
      });

      console.log(`[CodePreviewStore] File saved: ${currentFile.path}`);
      return { success: true };
    } catch (error) {
      const errorMsg = `保存文件失败: ${error}`;
      console.error(`[CodePreviewStore] ${errorMsg}`);
      set({ error: errorMsg });
      return { success: false, error: errorMsg };
    }
  },

  /**
   * Close current file
   */
  closeFile: () => {
    const { currentFile } = get();
    console.log(`[CodePreviewStore] Closing file: ${currentFile?.path}`);
    set({
      currentFile: null,
      error: null,
      isLargeFile: false,
      loadedChunks: 0,
      totalChunks: 0,
      fileSize: 0,
      showLargeFileWarning: false,
      pendingFilePath: null,
      viewMode: 'source',
      safetyMode: 'safe',
    });
  },

  /**
   * Load next chunk for large file
   */
  loadNextChunk: async () => {
    const {
      pendingFilePath,
      currentFile,
      loadedChunks,
      totalChunks,
      isLargeFile,
    } = get();

    const filePath = pendingFilePath || currentFile?.path;
    if (!filePath || !isLargeFile) {
      return false;
    }

    const nextChunk = loadedChunks + 1;
    const start = loadedChunks * CHUNK_SIZE;
    const end = Math.min(nextChunk * CHUNK_SIZE, get().fileSize);

    console.log(`[CodePreviewStore] Loading chunk ${nextChunk}/${totalChunks}: ${start}-${end}`);

    set({ isLoading: true });

    try {
      const chunkContent = await readFileChunk(filePath, start, end);
      if (chunkContent === null) {
        set({ isLoading: false, error: '无法读取文件内容' });
        return false;
      }

      const prevContent = currentFile?.content || '';
      const newContent = prevContent + chunkContent;
      const language = currentFile?.language || detectLanguage(filePath);
      const name = currentFile?.name || getBasename(filePath) || filePath;
      const previewable = isPreviewable(filePath);
      const isHtml = isHtmlFile(filePath);

      const isLastChunk = nextChunk >= totalChunks;

      set({
        isLoading: false,
        loadedChunks: nextChunk,
        currentFile: {
          path: filePath,
          name,
          content: newContent,
          language,
          isModified: false,
          originalContent: isLastChunk ? newContent : '',
          isPreviewable: previewable,
          isHtml,
        },
        // Clear pending path after first chunk loads
        pendingFilePath: null,
        showLargeFileWarning: false,
        viewMode: previewable ? 'preview' : 'source',
        safetyMode: 'safe',
      });

      console.log(`[CodePreviewStore] Chunk ${nextChunk}/${totalChunks} loaded`);
      return !isLastChunk;
    } catch (error) {
      console.error('[CodePreviewStore] Failed to load chunk:', error);
      set({ isLoading: false, error: `加载失败: ${error}` });
      return false;
    }
  },

  /**
   * Load all remaining chunks
   */
  loadAllChunks: async () => {
    const { totalChunks, loadedChunks } = get();
    console.log(`[CodePreviewStore] Loading all chunks: ${loadedChunks} -> ${totalChunks}`);

    let hasMore = true;
    while (hasMore) {
      hasMore = await get().loadNextChunk();
    }

    console.log('[CodePreviewStore] All chunks loaded');
  },

  /**
   * Confirm loading large file
   */
  confirmLargeFile: async () => {
    const { pendingFilePath } = get();
    if (!pendingFilePath) return;

    console.log(`[CodePreviewStore] User confirmed large file: ${pendingFilePath}`);
    set({ showLargeFileWarning: false });

    // Load first chunk
    await get().loadNextChunk();
  },

  /**
   * Cancel loading large file
   */
  cancelLargeFile: () => {
    console.log('[CodePreviewStore] User cancelled large file loading');
    set({
      showLargeFileWarning: false,
      pendingFilePath: null,
      isLargeFile: false,
      loadedChunks: 0,
      totalChunks: 0,
      fileSize: 0,
    });
  },

  /**
   * Clear error
   */
  clearError: () => {
    set({ error: null });
  },

  /**
   * Set view mode (source/preview)
   */
  setViewMode: (mode) => {
    const { currentFile } = get();
    if (!currentFile?.isPreviewable) return;
    set({ viewMode: mode });
  },

  /**
   * Toggle view mode
   */
  toggleViewMode: () => {
    const { currentFile, viewMode } = get();
    if (!currentFile?.isPreviewable) return;
    set({ viewMode: viewMode === 'source' ? 'preview' : 'source' });
  },

  /**
   * Set safety mode for HTML preview
   */
  setSafetyMode: (mode) => {
    const { currentFile } = get();
    if (!currentFile?.isHtml) return;
    set({ safetyMode: mode });
  },

  /**
   * Toggle safety mode
   */
  toggleSafetyMode: () => {
    const { currentFile, safetyMode } = get();
    if (!currentFile?.isHtml) return;
    set({ safetyMode: safetyMode === 'safe' ? 'unsafe' : 'safe' });
  },
}));
