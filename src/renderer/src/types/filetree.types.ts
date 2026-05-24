/**
 * File tree related type definitions
 * @module types/filetree
 */

/**
 * File node in the file tree
 */
export interface FileNode {
  /** Unique identifier */
  id: string;
  /** File or directory name */
  name: string;
  /** Full path to the file/directory */
  path: string;
  /** Node type */
  type: 'file' | 'directory';
  /** Child nodes (for directories) */
  children?: FileNode[];
  /** Whether the directory is expanded */
  isExpanded?: boolean;
  /** Whether the node is selected */
  isSelected?: boolean;
}

/**
 * File tree state managed by Zustand store
 */
export interface FileTreeState {
  /** Root node of the file tree */
  root: FileNode | null;
  /** Currently selected file path */
  selectedPath: string | null;
  /** Set of expanded directory paths */
  expandedPaths: Set<string>;
}
