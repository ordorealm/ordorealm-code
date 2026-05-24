/**
 * Git Types
 * Type definitions for Git branch and diff operations
 * @module types/git.types
 */

/** Git 分支信息 */
export interface GitBranch {
  /** 分支名 */
  name: string;
  /** 是否为当前分支 */
  isCurrent: boolean;
  /** 是否为远程分支 */
  isRemote: boolean;
  /** 是否为主分支 (main/master) */
  isMain: boolean;
  /** 上游分支 */
  upstream?: string;
  /** 最后一次提交信息 */
  lastCommit?: {
    hash: string;
    message: string;
    date: string;
    author: string;
  };
}

/** 差异文件状态 */
export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

/** 工作区变更状态（仅主分支模式） */
export type WorktreeStatus = 'unstaged' | 'staged' | 'untracked';

/** 差异文件信息 */
export interface DiffFile {
  /** 文件路径 */
  path: string;
  /** 变更状态 */
  status: DiffStatus;
  /** 新增行数 */
  additions: number;
  /** 删除行数 */
  deletions: number;
  /** 重命名前的路径（仅 renamed 状态） */
  oldPath?: string;
  /** 工作区状态（仅主分支模式） */
  worktreeStatus?: WorktreeStatus;
}

/** 行差异类型 */
export type LineDiffType = 'added' | 'deleted' | 'modified' | 'context';

/** 行差异信息 */
export interface LineDiff {
  /** 原文件行号（删除行为 null） */
  oldLineNumber: number | null;
  /** 新文件行号（新增行为 null） */
  newLineNumber: number | null;
  /** 差异类型 */
  type: LineDiffType;
  /** 行内容 */
  content: string;
}

/** 文件完整差异 */
export interface FileDiff {
  /** 文件路径 */
  path: string;
  /** 原文件内容（新增文件为 null） */
  oldContent: string | null;
  /** 新文件内容（删除文件为 null） */
  newContent: string | null;
  /** 逐行差异 */
  lines: LineDiff[];
  /** 统计信息 */
  stats: {
    additions: number;
    deletions: number;
    changes: number;
  };
}

/** 文件显示模式 */
export type FileViewMode = 'diff' | 'all';

/** 对比模式 */
export type CompareMode = 'branch' | 'worktree';

/** Git 状态摘要 */
export interface GitStatusSummary {
  /** 当前分支 */
  branch: string;
  /** 是否为干净的工作区 */
  isClean: boolean;
  /** 已暂存文件数 */
  staged: number;
  /** 未暂存文件数 */
  unstaged: number;
  /** 未跟踪文件数 */
  untracked: number;
  /** 领先远程的提交数 */
  ahead: number;
  /** 落后远程的提交数 */
  behind: number;
}
