/**
 * File Tree Component
 * Displays project file structure with expand/collapse and file operations
 * @module components/sidebar/FileTree
 */

import { useState, useCallback, useEffect, useRef, useMemo, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFileTreeStore } from '@/stores/filetree-store';
import { useProjectStore } from '@/stores/project-store';
import { useCodePreviewStore } from '@/stores/code-preview-store';
import { useGitStore } from '@/stores/git-store';
import { getBasename, getDirname, getLastSepIndex, validateName, normalizePath } from '@/utils/path';
import type { FileNode, DiffFile } from '@/types';

/**
 * Compressed node type for directory chain compression
 */
interface CompressedNode {
  /** Full path of the START directory in chain (used for expand/collapse key) */
  path: string;
  /** Full path of the END directory in chain (where children actually live) */
  endPath: string;
  /** Display name (may be "a.b.c" for compressed) */
  displayName: string;
  /** Original directory names in the chain */
  nameChain: string[];
  /** Node type */
  type: 'file' | 'directory' | 'compressed';
  /** Children nodes */
  children: CompressedNode[];
  /** Is selected */
  isSelected: boolean;
  /** Original node reference for context menu */
  originalNode: FileNode;
}

interface ContextMenuState {
  isVisible: boolean;
  x: number;
  y: number;
  targetPath: string;
  targetType: 'file' | 'directory';
}

interface ConfirmDialogState {
  isVisible: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

interface RenameDialogState {
  isVisible: boolean;
  path: string;
  currentName: string;
}

interface FileTreeProps {
  /** Callback when a file is selected (to switch to file tab) */
  onFileSelect?: () => void;
}

/**
 * Diff badge component - shows status and line counts
 */
function DiffBadge({ diffFile }: { diffFile: DiffFile }): JSX.Element {
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    added: { bg: 'bg-green-500/20', text: 'text-green-500', label: 'A' },
    modified: { bg: 'bg-yellow-500/20', text: 'text-yellow-500', label: 'M' },
    deleted: { bg: 'bg-red-500/20', text: 'text-red-500', label: 'D' },
    renamed: { bg: 'bg-blue-500/20', text: 'text-blue-500', label: 'R' },
    untracked: { bg: 'bg-gray-500/20', text: 'text-gray-500', label: '?' },
  };

  const config = statusConfig[diffFile.status] || statusConfig.modified;

  return (
    <div className="flex items-center gap-1 text-xs mr-2">
      {/* Status label */}
      <span className={`px-1 rounded ${config.bg} ${config.text}`}>
        {config.label}
      </span>
      {/* Line counts */}
      {diffFile.additions > 0 && (
        <span className="text-green-500">+{diffFile.additions}</span>
      )}
      {diffFile.deletions > 0 && (
        <span className="text-red-500">-{diffFile.deletions}</span>
      )}
    </div>
  );
}

/**
 * Find a node by path in the file tree
 */
function findNodeByPath(root: FileNode | null, path: string): FileNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * FileNode component - renders a single file/folder node
 */
interface FileNodeProps {
  node: FileNode;
  depth: number;
  onContextMenu: (e: MouseEvent, node: FileNode) => void;
  onSelect: (path: string, type: 'file' | 'directory') => void;
  expandedPaths: Set<string>;
  diffFiles: Map<string, DiffFile>;
  fileViewMode: 'diff' | 'all';
}

/**
 * Check if a directory contains any diff files (recursively)
 */
function directoryHasDiffFiles(dirPath: string, diffFiles: Map<string, DiffFile>): boolean {
  // Normalize paths for cross-platform comparison
  const normalizedDir = normalizePath(dirPath);
  const dirWithSlash = normalizedDir.endsWith('/') ? normalizedDir : normalizedDir + '/';

  // Check if any diff file path starts with this directory path
  for (const filePath of diffFiles.keys()) {
    const normalizedFile = normalizePath(filePath);
    if (normalizedFile.startsWith(dirWithSlash)) {
      return true;
    }
  }
  return false;
}

/**
 * Get diff file info for a path (with automatic path normalization for cross-platform compatibility)
 * FileTree paths use system separator (e.g., \ on Windows), diffFiles keys use /
 */
function getDiffFileForPath(filePath: string, diffFiles: Map<string, DiffFile>): DiffFile | undefined {
  // diffFiles keys are normalized to forward slashes in git-store.ts
  // So we need to normalize the lookup key too
  const normalizedPath = normalizePath(filePath);
  return diffFiles.get(normalizedPath);
}

/**
 * Check if a file has diff changes (with automatic path normalization)
 */
function hasDiffFileForPath(filePath: string, diffFiles: Map<string, DiffFile>): boolean {
  return getDiffFileForPath(filePath, diffFiles) !== undefined;
}

/**
 * Check if a directory can be compressed (has only one child directory, no files)
 * For unloaded directories (no children), we optimistically assume they CAN be compressed
 */
function canCompressDirectory(node: FileNode, diffFiles: Map<string, DiffFile>, fileViewMode: 'diff' | 'all'): boolean {
  if (node.type !== 'directory') {
    return false;
  }

  // In diff mode, only compress if directory has diff files
  if (fileViewMode === 'diff' && !directoryHasDiffFiles(node.path, diffFiles)) {
    return false;
  }

  // No children loaded yet - optimistically assume compressible (will be resolved on expand)
  if (!node.children || node.children.length === 0) {
    return true;
  }

  // Count visible children
  const visibleChildren = node.children.filter(child => {
    if (fileViewMode === 'diff') {
      if (child.type === 'file') {
        return hasDiffFileForPath(child.path, diffFiles);
      } else {
        return directoryHasDiffFiles(child.path, diffFiles);
      }
    }
    return true;
  });

  // Can compress if only one visible child directory
  return visibleChildren.length === 1 && visibleChildren[0].type === 'directory';
}

/**
 * Check if a loaded directory can actually be compressed (has actual children data)
 */
function canActuallyCompressDirectory(node: FileNode, diffFiles: Map<string, DiffFile>, fileViewMode: 'diff' | 'all'): boolean {
  if (node.type !== 'directory' || !node.children || node.children.length === 0) {
    return false;
  }

  // In diff mode, only compress if directory has diff files
  if (fileViewMode === 'diff' && !directoryHasDiffFiles(node.path, diffFiles)) {
    return false;
  }

  // Count visible children
  const visibleChildren = node.children.filter(child => {
    if (fileViewMode === 'diff') {
      if (child.type === 'file') {
        return hasDiffFileForPath(child.path, diffFiles);
      } else {
        return directoryHasDiffFiles(child.path, diffFiles);
      }
    }
    return true;
  });

  return visibleChildren.length === 1 && visibleChildren[0].type === 'directory';
}

/**
 * Compress directory chain (IDEA-style)
 * Merges single-child directories into "a.b.c" format
 * Only compresses TRUE single-child chains, stops at branch points
 *
 * IMPORTANT: The returned `path` is the START directory's path, not the end.
 * This is because expandedPaths uses the start path as the key.
 */
function compressNode(node: FileNode, diffFiles: Map<string, DiffFile>, fileViewMode: 'diff' | 'all'): CompressedNode {
  // For files, return as-is
  if (node.type === 'file') {
    return {
      path: node.path,
      endPath: node.path,
      displayName: node.name,
      nameChain: [node.name],
      type: 'file',
      children: [],
      isSelected: node.isSelected ?? false,
      originalNode: node,
    };
  }

  // Check if this directory can be compressed (single child directory, no files)
  // Only compress if children are loaded and it's a TRUE single-child chain
  const visibleChildren = (node.children || []).filter(child => {
    if (fileViewMode === 'diff') {
      if (child.type === 'file') {
        return hasDiffFileForPath(child.path, diffFiles);
      }
      return directoryHasDiffFiles(child.path, diffFiles);
    }
    return true;
  });

  // Can compress only if: exactly 1 child directory, 0 files, and children are loaded
  const childDirs = visibleChildren.filter(c => c.type === 'directory');
  const childFiles = visibleChildren.filter(c => c.type === 'file');

  if (childDirs.length === 1 && childFiles.length === 0 && childDirs[0].children !== undefined) {
    // Recursively compress the single child
    const compressedChild = compressNode(childDirs[0], diffFiles, fileViewMode);

    // KEY: node.path is the START path (used as expand/collapse key in expandedPaths)
    // compressedChild.endPath is the END path (where children actually live in the store)
    return {
      path: node.path,  // START path - used as expandedPaths key
      endPath: compressedChild.endPath,  // END path - where children live
      displayName: `${node.name}.${compressedChild.displayName}`,
      nameChain: [node.name, ...compressedChild.nameChain],
      type: 'compressed',
      children: compressedChild.children,  // Final branch point's children
      isSelected: node.isSelected || compressedChild.isSelected,
      originalNode: node,  // Start node
    };
  }

  // Cannot compress: either multiple children, has files, or children not loaded
  // Process children normally
  const children = visibleChildren.map(child => compressNode(child, diffFiles, fileViewMode));

  return {
    path: node.path,
    endPath: node.path,
    displayName: node.name,
    nameChain: [node.name],
    type: 'directory',
    children,
    isSelected: node.isSelected ?? false,
    originalNode: node,
  };
}

/**
 * Props for compressed tree node
 */
interface CompressedNodeProps {
  node: CompressedNode;
  depth: number;
  onContextMenu: (e: MouseEvent, originalNode: FileNode) => void;
  onSelect: (path: string, type: 'file' | 'directory') => void;
  expandedPaths: Set<string>;
  diffFiles: Map<string, DiffFile>;
  fileViewMode: 'diff' | 'all';
}

/**
 * Render a compressed tree node
 */
function CompressedTreeNode({ node, depth, onContextMenu, onSelect, expandedPaths, diffFiles, fileViewMode }: CompressedNodeProps): JSX.Element | null {
  const { toggleExpand, loadDirectoryChain, setExpandedPaths } = useFileTreeStore();

  // 🔧 关键修复：始终使用 node.path (START路径) 作为展开键
  // 原因：node.path 在展开前后保持不变，而 node.endPath 可能变化
  // expandedChildren 使用 node.endPath 来查找子节点，这是正确的
  const isExpanded = expandedPaths.has(node.path);

  const diffFile = node.type === 'file' ? getDiffFileForPath(node.path, diffFiles) : undefined;

  // For expanded compressed nodes, we need to get fresh children from the store
  // because the compressed node's children may be stale
  const root = useFileTreeStore(state => state.root);

  const expandedChildren = useMemo(() => {
    if (!isExpanded) return [];
    if (node.type === 'file') return [];

    // For 'directory' type, just use node.children directly
    if (node.type === 'directory') {
      return node.children;
    }

    // For 'compressed' type, get children from the END path in the store
    // node.path = START path (used as expand key)
    // node.endPath = END path (where children actually live)
    if (!root) {
      console.log('[FileTree] expandedChildren: no root, using node.children');
      return node.children;
    }

    // Find the node at the END path - this is where children are stored
    const endNode = findNodeByPath(root, node.endPath);
    console.log('[FileTree] expandedChildren:', {
      path: node.path,
      endPath: node.endPath,
      endNodeFound: !!endNode,
      endNodeChildren: endNode?.children?.length || 0,
    });

    if (!endNode?.children) return node.children;

    // Recursively compress the children for display
    // 🔧 修复：使用 fileViewMode 而不是 diffFiles.size > 0
    const filtered = endNode.children
      .filter(child => {
        if (fileViewMode === 'diff') {
          if (child.type === 'file') {
            return hasDiffFileForPath(child.path, diffFiles);
          }
          return directoryHasDiffFiles(child.path, diffFiles);
        }
        return true;
      })
      .map(child => compressNode(child, diffFiles, fileViewMode));

    console.log('[FileTree] expandedChildren: returning', filtered.length, 'children');
    return filtered;
  }, [isExpanded, node, root, diffFiles, fileViewMode]);

  const handleClick = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      onSelect(node.path, node.type === 'file' ? 'file' : 'directory');

      console.log('[FileTree] handleClick:', {
        path: node.path,
        endPath: node.endPath,
        type: node.type,
        isExpanded,
      });

      if (node.type !== 'file') {
        // 🔧 修复：使用 node.path 作为展开键（始终一致）
        if (isExpanded) {
          // Collapse: remove from expandedPaths
          console.log('[FileTree] Collapsing:', node.path);
          const newExpanded = new Set(expandedPaths);
          newExpanded.delete(node.path);
          setExpandedPaths(newExpanded);
        } else {
          // Expand: load children if needed
          // 🔧 关键修复：无论是 compressed 还是 directory，都需要加载子目录链
          // 这样可以避免点击后结构变化（子目录"合并进"父节点）的问题
          const storeNode = findNodeByPath(root, node.path);
          const needsLoad = !storeNode?.children || storeNode.children.length === 0;

          if (needsLoad || node.type === 'compressed') {
            // 对于压缩节点或未加载的目录，使用 loadDirectoryChain
            // 这会递归加载所有子目录的链
            console.log('[FileTree] Loading chain from:', node.path);
            await loadDirectoryChain(node.path);
          } else if (node.type === 'directory') {
            // 对于已加载的普通目录，检查子目录是否需要加载链
            // 这确保子目录在显示前也被正确压缩
            const childDirs = (storeNode?.children || []).filter(c => c.type === 'directory');
            for (const childDir of childDirs) {
              if (!childDir.children || childDir.children.length === 0) {
                console.log('[FileTree] Pre-loading chain for child:', childDir.path);
                await loadDirectoryChain(childDir.path);
              }
            }
          }

          console.log('[FileTree] Expanding:', node.path);
          const newExpanded = new Set(expandedPaths);
          newExpanded.add(node.path);
          setExpandedPaths(newExpanded);
        }
      }
    },
    [node.path, node.endPath, node.type, isExpanded, onSelect, loadDirectoryChain, setExpandedPaths, expandedPaths, root]
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node.originalNode);
    },
    [onContextMenu, node.originalNode]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick(e as unknown as MouseEvent);
      }
    },
    [handleClick]
  );

  // Calculate indentation
  const paddingLeft = depth * 16 + 8;

  // Get icon based on type
  const getIcon = (): string => {
    if (node.type === 'file') {
      const ext = node.displayName.split('.').pop()?.toLowerCase() || '';
      const iconMap: Record<string, string> = {
        ts: '🔷', tsx: '⚛️', js: '📜', jsx: '⚛️', json: '📋',
        md: '📝', css: '🎨', html: '🌐', java: '☕', py: '🐍',
        png: '🖼️', jpg: '🖼️', svg: '🎭', gitignore: '🙈', env: '🔐',
      };
      return iconMap[ext] || '📄';
    }
    // Directory or compressed
    return isExpanded ? '📂' : '📁';
  };

  return (
    <div>
      {/* Node row */}
      <div
        className={`
          flex items-center h-6 cursor-pointer select-none
          transition-colors duration-100
          ${node.isSelected ? 'bg-accent-blue/20 text-accent-blue' : 'hover:bg-bg-hover text-text-primary'}
        `}
        style={{ paddingLeft }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        role="treeitem"
        aria-selected={node.isSelected}
        aria-expanded={node.type !== 'file' ? isExpanded : undefined}
        tabIndex={0}
      >
        {/* Expand/collapse arrow */}
        {node.type !== 'file' && (
          <span className="w-4 h-4 flex items-center justify-center text-xs text-text-muted">
            {isExpanded ? '▼' : '▶'}
          </span>
        )}
        {node.type === 'file' && <span className="w-4" />}

        {/* Icon */}
        <span className="mr-1.5 text-sm">{getIcon()}</span>

        {/* Name (may be compressed like "a.b.c") */}
        <span className="text-sm truncate flex-1" title={node.path}>
          {node.displayName}
        </span>

        {/* Diff badge for files */}
        {node.type === 'file' && diffFile && (
          <DiffBadge diffFile={diffFile} />
        )}
      </div>

      {/* Children - use expandedChildren for compressed nodes */}
      {node.type !== 'file' && isExpanded && expandedChildren.length > 0 && (
        <div role="group">
          {expandedChildren.map((child) => (
            <CompressedTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onSelect={onSelect}
              expandedPaths={expandedPaths}
              diffFiles={diffFiles}
              fileViewMode={fileViewMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileTreeNode({ node, depth, onContextMenu, onSelect, expandedPaths, diffFiles, fileViewMode }: FileNodeProps): JSX.Element | null {
  const { toggleExpand } = useFileTreeStore();
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = node.isSelected;
  const diffFile = node.type === 'file' ? getDiffFileForPath(node.path, diffFiles) : undefined;

  // Check if should hide (for diff mode)
  // For files: hide if not in diffFiles
  // For directories: hide if no diff files under this directory
  const shouldHide = fileViewMode === 'diff' && (
    (node.type === 'file' && !diffFile) ||
    (node.type === 'directory' && !directoryHasDiffFiles(node.path, diffFiles))
  );

  const handleClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onSelect(node.path, node.type);

      if (node.type === 'directory') {
        toggleExpand(node.path);
      }
    },
    [node.path, node.type, onSelect, toggleExpand]
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node);
    },
    [onContextMenu, node]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick(e as unknown as MouseEvent);
      }
    },
    [handleClick]
  );

  // Now we can safely return after all hooks are called
  if (shouldHide) {
    return null;
  }

  // Calculate indentation
  const paddingLeft = depth * 16 + 8;

  // Get file icon based on type and name
  const getFileIcon = (): string => {
    if (node.type === 'directory') {
      return isExpanded ? '📂' : '📁';
    }

    // File type icons based on extension
    const ext = node.name.split('.').pop()?.toLowerCase() || '';
    const iconMap: Record<string, string> = {
      ts: '🔷',
      tsx: '⚛️',
      js: '📜',
      jsx: '⚛️',
      json: '📋',
      md: '📝',
      css: '🎨',
      html: '🌐',
      png: '🖼️',
      jpg: '🖼️',
      svg: '🎭',
      gitignore: '🙈',
      env: '🔐',
    };

    return iconMap[ext] || '📄';
  };

  return (
    <div>
      {/* Node row */}
      <div
        className={`
          flex items-center h-6 cursor-pointer select-none
          transition-colors duration-100
          ${isSelected ? 'bg-accent-blue/20 text-accent-blue' : 'hover:bg-bg-hover text-text-primary'}
        `}
        style={{ paddingLeft }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.type === 'directory' ? isExpanded : undefined}
        tabIndex={0}
      >
        {/* Expand/collapse arrow for directories */}
        {node.type === 'directory' && (
          <span className="w-4 h-4 flex items-center justify-center text-xs text-text-muted">
            {isExpanded ? '▼' : '▶'}
          </span>
        )}
        {node.type === 'file' && <span className="w-4" />}

        {/* File/folder icon */}
        <span className="mr-1.5 text-sm">{getFileIcon()}</span>

        {/* File/folder name */}
        <span className="text-sm truncate flex-1">{node.name}</span>

        {/* Diff badge for files */}
        {node.type === 'file' && diffFile && (
          <DiffBadge diffFile={diffFile} />
        )}
      </div>

      {/* Children (if expanded directory) */}
      {node.type === 'directory' && isExpanded && node.children && (
        <div role="group">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onSelect={onSelect}
              expandedPaths={expandedPaths}
              diffFiles={diffFiles}
              fileViewMode={fileViewMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * FileTree component
 * Displays project file structure with:
 * - Expand/collapse directories
 * - File selection
 * - Context menu for file operations
 * - Virtual scrolling for large trees
 */
export function FileTree({ onFileSelect }: FileTreeProps = {}): JSX.Element {
  const { root, expandedPaths, selectFile, loadDirectory, createFile, createDirectory, delete: deleteNode, rename, setExpandedPaths } = useFileTreeStore();
  const { projects, activeProjectId } = useProjectStore();
  const { openFile } = useCodePreviewStore();
  const { diffFiles, fileViewMode } = useGitStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isVisible: false,
    x: 0,
    y: 0,
    targetPath: '',
    targetType: 'file',
  });

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isVisible: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [renameDialog, setRenameDialog] = useState<RenameDialogState>({
    isVisible: false,
    path: '',
    currentName: '',
  });

  const [newItemDialog, setNewItemDialog] = useState<{
    isVisible: boolean;
    type: 'file' | 'directory';
    parentPath: string;
  }>({
    isVisible: false,
    type: 'file',
    parentPath: '',
  });

  const [newItemName, setNewItemName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Menu position state for boundary detection
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });

  // Load file tree when active project changes
  useEffect(() => {
    const activeProject = projects.find((p) => p.id === activeProjectId);

    if (activeProject) {
      // Load with depth 1 to avoid blocking on large projects
      loadDirectory(activeProject.path, 1);

      // File watcher temporarily disabled - causes UI blocking on large projects
      // TODO: Implement lightweight file watching in separate process
      // or use manual refresh button
    }
  }, [activeProjectId, projects, loadDirectory]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu((prev) => ({ ...prev, isVisible: false }));
      }
    };

    if (contextMenu.isVisible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu.isVisible]);

  // Adjust menu position to stay within viewport
  useEffect(() => {
    if (contextMenu.isVisible && contextMenuRef.current) {
      const menu = contextMenuRef.current;
      const menuRect = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let x = contextMenu.x;
      let y = contextMenu.y;

      // Adjust horizontal position
      if (x + menuRect.width > viewportWidth - 8) {
        x = viewportWidth - menuRect.width - 8;
      }

      // Adjust vertical position
      if (y + menuRect.height > viewportHeight - 8) {
        y = viewportHeight - menuRect.height - 8;
      }

      // Ensure minimum position
      x = Math.max(8, x);
      y = Math.max(8, y);

      setMenuPosition({ x, y });
    }
  }, [contextMenu.isVisible, contextMenu.x, contextMenu.y]);

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: MouseEvent, node: FileNode) => {
    setContextMenu({
      isVisible: true,
      x: e.clientX,
      y: e.clientY,
      targetPath: node.path,
      targetType: node.type,
    });
  }, []);

  // Handle file selection
  const handleSelect = useCallback(
    (path: string, type: 'file' | 'directory') => {
      selectFile(path);
      if (type === 'file') {
        // Open file in code preview
        openFile(path);
        // Notify parent to switch to file tab
        onFileSelect?.();
      }
      console.log(`[FileTree] Selected ${type}: ${path}`);
    },
    [selectFile, openFile, onFileSelect]
  );

  // Context menu actions
  const handleNewFile = useCallback(() => {
    const parentPath = contextMenu.targetType === 'directory'
      ? contextMenu.targetPath
      : getDirname(contextMenu.targetPath);

    setNewItemDialog({ isVisible: true, type: 'file', parentPath });
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath, contextMenu.targetType]);

  const handleNewDirectory = useCallback(() => {
    const parentPath = contextMenu.targetType === 'directory'
      ? contextMenu.targetPath
      : getDirname(contextMenu.targetPath);

    setNewItemDialog({ isVisible: true, type: 'directory', parentPath });
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath, contextMenu.targetType]);

  const handleRename = useCallback(() => {
    const currentName = getBasename(contextMenu.targetPath);
    setRenameValue(currentName);
    setRenameDialog({
      isVisible: true,
      path: contextMenu.targetPath,
      currentName,
    });
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath]);

  const handleDelete = useCallback(() => {
    const name = getBasename(contextMenu.targetPath);
    const isDirectory = contextMenu.targetType === 'directory';

    setConfirmDialog({
      isVisible: true,
      title: `删除${isDirectory ? '文件夹' : '文件'}`,
      message: `确定要删除 "${name}" 吗？${isDirectory ? '\n文件夹内的所有内容都将被删除。' : ''}`,
      onConfirm: async () => {
        await deleteNode(contextMenu.targetPath);
        setConfirmDialog((prev) => ({ ...prev, isVisible: false }));
      },
    });
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath, contextMenu.targetType, deleteNode]);

  // Copy operations
  const handleCopyName = useCallback(async () => {
    const name = getBasename(contextMenu.targetPath);
    await window.api.clipboard.writeText(name);
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath]);

  const handleCopyRelativePath = useCallback(async () => {
    const activeProject = projects.find((p) => p.id === activeProjectId);
    if (!activeProject) return;

    // Normalize paths for cross-platform comparison
    const normalizedTarget = contextMenu.targetPath.replace(/\\/g, '/');
    const normalizedProject = activeProject.path.replace(/\\/g, '/');

    const relativePath = normalizedTarget.startsWith(normalizedProject + '/')
      ? normalizedTarget.slice(normalizedProject.length + 1)
      : contextMenu.targetPath;
    await window.api.clipboard.writeText(relativePath);
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath, projects, activeProjectId]);

  const handleCopyAbsolutePath = useCallback(async () => {
    await window.api.clipboard.writeText(contextMenu.targetPath);
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath]);

  const handleOpenInExplorer = useCallback(async () => {
    await window.api.shell.openPath(contextMenu.targetPath);
    setContextMenu((prev) => ({ ...prev, isVisible: false }));
  }, [contextMenu.targetPath]);

  // Create new file/directory
  const handleCreateItem = useCallback(async () => {
    const trimmedName = newItemName.trim();
    const validationError = validateName(trimmedName);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    const { parentPath, type } = newItemDialog;

    setErrorMessage(null);
    const result = type === 'file'
      ? await createFile(parentPath, trimmedName)
      : await createDirectory(parentPath, trimmedName);

    if (!result.success) {
      setErrorMessage(result.error || '创建失败');
      return;
    }

    // Expand parent directory to show new item
    setExpandedPaths(new Set(expandedPaths).add(parentPath));

    setNewItemDialog({ isVisible: false, type: 'file', parentPath: '' });
    setNewItemName('');
    setErrorMessage(null);
  }, [newItemName, newItemDialog, createFile, createDirectory, validateName, expandedPaths, setExpandedPaths]);

  // Rename file/directory
  const handleRenameConfirm = useCallback(async () => {
    const trimmedValue = renameValue.trim();

    if (trimmedValue === renameDialog.currentName) {
      setRenameDialog({ isVisible: false, path: '', currentName: '' });
      return;
    }

    const validationError = validateName(trimmedValue);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setErrorMessage(null);
    const result = await rename(renameDialog.path, trimmedValue);

    if (!result.success) {
      setErrorMessage(result.error || '重命名失败');
      return;
    }

    setRenameDialog({ isVisible: false, path: '', currentName: '' });
    setRenameValue('');
    setErrorMessage(null);
  }, [renameValue, renameDialog, rename, validateName]);

  // Handle click on empty space to deselect
  const handleContainerClick = useCallback(() => {
    // Clear selection
  }, []);

  // Compress directory tree (IDEA-style)
  // MUST be called before any early returns (React hooks rules)
  // Use diffFiles.size as dependency to avoid unnecessary recalculations
  const diffFilesSize = diffFiles.size;
  const compressedRoot = useMemo(() => {
    if (!root) return null;
    return compressNode(root, diffFiles, fileViewMode);
  }, [root, diffFilesSize, fileViewMode]);

  if (!root) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        请选择或创建一个项目
      </div>
    );
  }

  // In diff mode with no changes, show empty state
  if (fileViewMode === 'diff' && diffFiles.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted text-sm px-4">
        <span className="text-2xl mb-2">✨</span>
        <span>工作区很干净</span>
        <span className="text-xs mt-1 text-text-muted">没有待提交的变更</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto bg-bg-primary"
      onClick={handleContainerClick}
      role="tree"
      aria-label="文件树"
    >
      {/* Root node - use compressed rendering */}
      {compressedRoot && (
        <CompressedTreeNode
          node={compressedRoot}
          depth={0}
          onContextMenu={handleContextMenu}
          onSelect={handleSelect}
          expandedPaths={expandedPaths}
          diffFiles={diffFiles}
          fileViewMode={fileViewMode}
        />
      )}

      {/* Context Menu - rendered via Portal to avoid clipping */}
      {contextMenu.isVisible && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed z-[99999] bg-bg-primary border border-border rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          role="menu"
        >
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleNewFile}
            role="menuitem"
          >
            <span>📄</span> 新建文件
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleNewDirectory}
            role="menuitem"
          >
            <span>📁</span> 新建文件夹
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleRename}
            role="menuitem"
          >
            <span>✏️</span> 重命名
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover text-accent-red flex items-center gap-2"
            onClick={handleDelete}
            role="menuitem"
          >
            <span>🗑️</span> 删除
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleCopyName}
            role="menuitem"
          >
            <span>📋</span> 复制名称
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleCopyRelativePath}
            role="menuitem"
          >
            <span>📁</span> 复制相对路径
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleCopyAbsolutePath}
            role="menuitem"
          >
            <span>📂</span> 复制绝对路径
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-bg-hover flex items-center gap-2 text-text-primary"
            onClick={handleOpenInExplorer}
            role="menuitem"
          >
            <span>🔍</span> 打开资源管理器
          </button>
        </div>,
        document.body
      )}

      {/* New Item Dialog */}
      {newItemDialog.isVisible && createPortal(
        <div className="fixed left-0 right-0 bottom-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm" style={{ top: 'var(--title-bar-height, 0)' }}>
          <div className="bg-bg-primary rounded-lg shadow-xl p-4 w-96 min-w-[300px]">
            <h3 className="text-lg font-medium mb-1 text-text-primary">
              新建{newItemDialog.type === 'file' ? '文件' : '文件夹'}
            </h3>
            {/* Show parent path with word-break */}
            <p className="text-xs text-text-muted mb-3 break-all leading-relaxed bg-bg-secondary px-2 py-1.5 rounded">
              📁 {newItemDialog.parentPath}
            </p>
            <input
              type="text"
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 bg-bg-primary text-text-primary ${
                errorMessage ? 'border-red-500 focus:ring-red-500' : 'border-border focus:ring-accent-indigo'
              }`}
              placeholder={newItemDialog.type === 'file' ? '文件名' : '文件夹名'}
              value={newItemName}
              onChange={(e) => {
                setNewItemName(e.target.value);
                setErrorMessage(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateItem();
                if (e.key === 'Escape') {
                  setNewItemDialog({ isVisible: false, type: 'file', parentPath: '' });
                  setNewItemName('');
                  setErrorMessage(null);
                }
              }}
              autoFocus
            />
            {/* Error message */}
            {errorMessage && (
              <p className="text-xs text-red-500 mt-2">{errorMessage}</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                onClick={() => {
                  setNewItemDialog({ isVisible: false, type: 'file', parentPath: '' });
                  setNewItemName('');
                  setErrorMessage(null);
                }}
              >
                取消
              </button>
              <button
                className="px-4 py-2 text-sm bg-accent-indigo text-white rounded-md hover:bg-accent-indigo/80"
                onClick={handleCreateItem}
              >
                创建
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Rename Dialog */}
      {renameDialog.isVisible && createPortal(
        <div className="fixed left-0 right-0 bottom-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm" style={{ top: 'var(--title-bar-height, 0)' }}>
          <div className="bg-bg-primary rounded-lg shadow-xl p-4 w-96">
            <h3 className="text-lg font-medium mb-2 text-text-primary">重命名</h3>
            {/* Show original name */}
            <p className="text-xs text-text-muted mb-3">
              原名称: {renameDialog.currentName}
            </p>
            <input
              type="text"
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 bg-bg-primary text-text-primary ${
                errorMessage ? 'border-red-500 focus:ring-red-500' : 'border-border focus:ring-accent-indigo'
              }`}
              value={renameValue}
              onChange={(e) => {
                setRenameValue(e.target.value);
                setErrorMessage(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameConfirm();
                if (e.key === 'Escape') {
                  setRenameDialog({ isVisible: false, path: '', currentName: '' });
                  setRenameValue('');
                  setErrorMessage(null);
                }
              }}
              autoFocus
            />
            {/* Error message */}
            {errorMessage && (
              <p className="text-xs text-red-500 mt-2">{errorMessage}</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                onClick={() => {
                  setRenameDialog({ isVisible: false, path: '', currentName: '' });
                  setRenameValue('');
                  setErrorMessage(null);
                }}
              >
                取消
              </button>
              <button
                className="px-4 py-2 text-sm bg-accent-indigo text-white rounded-md hover:bg-accent-indigo/80"
                onClick={handleRenameConfirm}
              >
                确认
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Confirm Dialog */}
      {confirmDialog.isVisible && createPortal(
        <div className="fixed left-0 right-0 bottom-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm" style={{ top: 'var(--title-bar-height, 0)' }}>
          <div className="bg-bg-primary rounded-lg shadow-xl p-4 w-80">
            <h3 className="text-lg font-medium mb-2 text-text-primary">{confirmDialog.title}</h3>
            <p className="text-sm text-text-muted mb-4 whitespace-pre-line">{confirmDialog.message}</p>
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                onClick={() => setConfirmDialog((prev) => ({ ...prev, isVisible: false }))}
              >
                取消
              </button>
              <button
                className="px-4 py-2 text-sm bg-accent-red text-white rounded-md hover:bg-accent-red/80"
                onClick={confirmDialog.onConfirm}
              >
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
