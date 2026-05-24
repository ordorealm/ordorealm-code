/**
 * Git Operations Module
 * Provides Git branch and diff operations via child process
 *
 * Cross-platform compatible: uses spawn() instead of exec() to avoid
 * shell interpretation issues on Windows (e.g., % format strings)
 *
 * @module main/git
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ─── Types (mirror renderer types for IPC) ────────────────────────────────────

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  isMain: boolean;
  upstream?: string;
  lastCommit?: {
    hash: string;
    message: string;
    date: string;
    author: string;
  };
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
  oldPath?: string;
  worktreeStatus?: 'unstaged' | 'staged' | 'untracked';
}

export interface LineDiff {
  oldLineNumber: number | null;
  newLineNumber: number | null;
  type: 'added' | 'deleted' | 'modified' | 'context';
  content: string;
}

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  lines: LineDiff[];
  stats: {
    additions: number;
    deletions: number;
    changes: number;
  };
}

// ─── Git Configuration ────────────────────────────────────────────────────────

interface GitConfig {
  /** Path to Git executable */
  gitPath: string;
  /** Path to Bash shell (Windows: Git Bash) */
  bashPath?: string;
  /** Environment variables to pass to Git */
  env?: NodeJS.ProcessEnv;
}

/** Current Git configuration */
let gitConfig: GitConfig = {
  gitPath: 'git',
};

/**
 * Configure Git execution environment
 * Called by main process after RuntimeManager initialization
 *
 * @param config - Git configuration from RuntimeManager
 */
export function setGitConfig(config: GitConfig): void {
  gitConfig = config;
  console.log('[Git] Configuration updated:', {
    gitPath: config.gitPath,
    bashPath: config.bashPath,
    hasEnv: !!config.env,
  });
}

/**
 * Get current Git configuration
 */
export function getGitConfig(): GitConfig {
  return { ...gitConfig };
}

// ─── Core Git Execution ───────────────────────────────────────────────────────

interface GitCommandOptions {
  /** Working directory for the command */
  cwd: string;
  /** Git command arguments (e.g., ['branch', '-a', '--format=...']) */
  args: string[];
  /** Additional environment variables */
  env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Execute a Git command using spawn()
 *
 * This is cross-platform safe because:
 * 1. We pass arguments as an array, not a shell string
 * 2. We don't use shell interpretation (shell: false)
 * 3. Git format strings like %(refname) are passed directly to Git
 *
 * @param options - Command options
 * @returns Promise resolving to stdout content
 */
async function executeGit(options: GitCommandOptions): Promise<string> {
  const { cwd, args, env, timeout = 30000 } = options;

  return new Promise((resolve, reject) => {
    // Build environment: process.env + gitConfig.env + custom env
    const execEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...gitConfig.env,
      ...env,
    };

    // On Windows, ensure Git can find its DLLs
    if (process.platform === 'win32' && gitConfig.gitPath) {
      // Add Git's directory to PATH for DLL resolution
      const gitDir = path.dirname(gitConfig.gitPath);
      execEnv.PATH = `${gitDir}${path.delimiter}${execEnv.PATH || ''}`;
    }

    const spawnOptions = {
      cwd,
      env: execEnv,
      shell: false, // Critical: don't use shell to avoid % interpretation on Windows
      windowsHide: true,
    };

    console.log('[Git] Executing:', gitConfig.gitPath, args.join(' '));

    const gitProcess = spawn(gitConfig.gitPath, args, spawnOptions);

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    // Set timeout
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        gitProcess.kill();
        reject(new Error(`Git command timed out after ${timeout}ms`));
      }, timeout);
    }

    gitProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });

    gitProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });

    gitProcess.on('error', (err: Error) => {
      if (timeoutId) clearTimeout(timeoutId);

      // Provide helpful error message for common issues
      let errorMsg = `Failed to execute git: ${err.message}`;

      if (err.message.includes('ENOENT') || err.message.includes('spawn')) {
        // Git executable not found
        errorMsg = `Git executable not found at: ${gitConfig.gitPath}. ` +
          (process.platform === 'win32'
            ? 'Please ensure the bundled Git runtime is included in the package, or install Git on your system.'
            : 'Please install Git on your system.');
      }

      reject(new Error(errorMsg));
    });

    gitProcess.on('close', (code: number) => {
      if (timeoutId) clearTimeout(timeoutId);

      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const errorMsg = stderr.trim() || `Git command failed with code ${code}`;
        reject(new Error(errorMsg));
      }
    });
  });
}

/**
 * Parse a command string into arguments array
 * Handles quoted strings properly
 *
 * @param argsString - Command arguments as a string
 * @returns Array of arguments
 */
function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === quoteChar) {
        // End of quoted section
        inQuote = false;
        // Don't include the quote character
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Execute a Git command (legacy interface for compatibility)
 *
 * @param repoPath - Repository path
 * @param args - Git arguments as a string (will be parsed)
 * @returns Promise resolving to stdout content
 */
async function gitCommand(repoPath: string, args: string): Promise<string> {
  const argsArray = parseCommandArgs(args);
  return executeGit({
    cwd: repoPath,
    args: argsArray,
    timeout: 60000, // 1 minute timeout for large operations
  });
}

// ─── Git Operations ───────────────────────────────────────────────────────────

/**
 * Check if a path is a git repository
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const gitDir = path.join(dirPath, '.git');
    const stats = await fs.promises.stat(gitDir);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Get all branches (local and remote)
 */
export async function listBranches(repoPath: string): Promise<{
  local: GitBranch[];
  remote: GitBranch[];
}> {
  // Check if it's a git repo
  if (!(await isGitRepo(repoPath))) {
    return { local: [], remote: [] };
  }

  // Git format string - passed directly to Git via args array
  // This is safe on all platforms because we use spawn() with shell: false
  const format = '%(refname:short)|%(upstream:short)|%(objectname:short)|%(contents:subject)|%(committerdate:iso)|%(authorname)';

  // Use spawn with args array to avoid shell interpretation
  const output = await executeGit({
    cwd: repoPath,
    args: ['branch', '-a', `--format=${format}`],
    timeout: 30000,
  });

  const local: GitBranch[] = [];
  const remote: GitBranch[] = [];

  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    const [name, upstream, hash, message, date, author] = line.split('|');

    // Check if this is a remote branch
    // Remote branches appear as "remotes/origin/xxx" or sometimes just "origin/xxx"
    const isRemote = name.startsWith('remotes/') || name.startsWith('origin/');

    // Clean up the branch name
    let branchName = name;
    if (name.startsWith('remotes/')) {
      branchName = name.replace('remotes/', '');
    }

    // Skip if this is still a remote-tracking branch (origin/xxx)
    if (branchName.startsWith('origin/') || branchName.includes('/')) {
      // This is a remote branch, add to remote list
      const branch: GitBranch = {
        name: branchName,
        isCurrent: false,
        isRemote: true,
        isMain: branchName === 'origin/main' || branchName === 'origin/master',
        upstream: upstream || undefined,
        lastCommit: hash ? {
          hash,
          message,
          date,
          author,
        } : undefined,
      };
      remote.push(branch);
      continue;
    }

    const isMain = branchName === 'main' || branchName === 'master';

    const branch: GitBranch = {
      name: branchName,
      isCurrent: false, // Will be set by getCurrentBranch
      isRemote: false,
      isMain,
      upstream: upstream || undefined,
      lastCommit: hash ? {
        hash,
        message,
        date,
        author,
      } : undefined,
    };

    local.push(branch);
  }

  // Get current branch and mark it
  const currentBranch = await getCurrentBranch(repoPath);
  local.forEach(b => {
    b.isCurrent = b.name === currentBranch;
  });

  return { local, remote };
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    return await executeGit({
      cwd: repoPath,
      args: ['branch', '--show-current'],
    });
  } catch {
    return '';
  }
}

/**
 * Get the main branch name (main or master)
 */
export async function getMainBranch(repoPath: string): Promise<string> {
  try {
    // Try to get from remote HEAD
    const remoteHead = await executeGit({
      cwd: repoPath,
      args: ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    });
    if (remoteHead) {
      const match = remoteHead.match(/refs\/remotes\/origin\/(.+)/);
      if (match) return match[1];
    }
  } catch {
    // Ignore
  }

  // Check if main or master exists
  try {
    const branches = await executeGit({
      cwd: repoPath,
      args: ['branch', '--list', 'main', 'master'],
    });
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
  } catch {
    // Ignore
  }

  return 'main'; // Default
}

/**
 * Switch to a different branch
 */
export async function checkout(repoPath: string, branch: string): Promise<void> {
  await executeGit({
    cwd: repoPath,
    args: ['checkout', branch],
  });
}

/**
 * Force switch to a different branch (discard local changes)
 */
export async function checkoutForce(repoPath: string, branch: string): Promise<void> {
  await executeGit({
    cwd: repoPath,
    args: ['checkout', '-f', branch],
  });
}

/**
 * Commit all changes and switch to a different branch
 */
export async function commitAndCheckout(repoPath: string, branch: string, message?: string): Promise<void> {
  const commitMsg = message || `WIP: Save changes before switching to ${branch}`;
  // Add all changes
  await executeGit({
    cwd: repoPath,
    args: ['add', '-A'],
  });
  // Commit with message
  await executeGit({
    cwd: repoPath,
    args: ['commit', '-m', commitMsg],
  });
  // Checkout target branch
  await executeGit({
    cwd: repoPath,
    args: ['checkout', branch],
  });
}

/**
 * Get diff files between two branches
 */
export async function getBranchDiffFiles(
  repoPath: string,
  targetBranch: string,
  currentBranch: string
): Promise<DiffFile[]> {
  console.log('[Git] getBranchDiffFiles:', { repoPath, targetBranch, currentBranch });

  const output = await executeGit({
    cwd: repoPath,
    args: ['diff', '--numstat', `${targetBranch}..${currentBranch}`],
    timeout: 60000,
  });

  console.log('[Git] diff output length:', output.length, 'first 200 chars:', output.substring(0, 200));

  const result = parseNumstatOutput(output);
  console.log('[Git] parsed diff files:', result.length);
  return result;
}

/**
 * Get working tree changes (unstaged + staged + untracked)
 */
export async function getWorktreeDiffFiles(repoPath: string): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  const fileMap = new Map<string, DiffFile>();

  // Get staged changes
  try {
    const stagedOutput = await executeGit({
      cwd: repoPath,
      args: ['diff', '--cached', '--numstat'],
    });
    const stagedFiles = parseNumstatOutput(stagedOutput);
    stagedFiles.forEach(f => {
      f.worktreeStatus = 'staged';
      fileMap.set(f.path, f);
    });
  } catch {
    // Ignore
  }

  // Get unstaged changes
  try {
    const unstagedOutput = await executeGit({
      cwd: repoPath,
      args: ['diff', '--numstat'],
    });
    const unstagedFiles = parseNumstatOutput(unstagedOutput);
    unstagedFiles.forEach(f => {
      const existing = fileMap.get(f.path);
      if (existing) {
        // Already staged, combine stats
        existing.additions += f.additions;
        existing.deletions += f.deletions;
      } else {
        f.worktreeStatus = 'unstaged';
        fileMap.set(f.path, f);
      }
    });
  } catch {
    // Ignore
  }

  // Get untracked files
  try {
    const untrackedOutput = await executeGit({
      cwd: repoPath,
      args: ['ls-files', '--others', '--exclude-standard'],
    });
    const untrackedFiles = untrackedOutput.split('\n').filter(Boolean);
    untrackedFiles.forEach(filePath => {
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, {
          path: filePath,
          status: 'untracked',
          additions: 0,
          deletions: 0,
          worktreeStatus: 'untracked',
        });
      }
    });
  } catch {
    // Ignore
  }

  return Array.from(fileMap.values());
}

/**
 * Parse diff --numstat output
 * Format: ADDITIONS\tDELETIONS\tPATH
 * For binary files: -\t-\tPATH
 * For renames: 0\t0\tOLD_PATH => NEW_PATH
 */
function parseNumstatOutput(output: string): DiffFile[] {
  if (!output.trim()) return [];

  const files: DiffFile[] = [];
  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');

    if (parts.length < 3) continue;

    const [additionsStr, deletionsStr, pathPart] = parts;

    // Handle renames: "old_path => new_path"
    let filePath: string;
    let oldPath: string | undefined;
    let status: DiffFile['status'] = 'modified';

    if (pathPart.includes(' => ')) {
      // Rename case
      const [oldP, newP] = pathPart.split(' => ');
      oldPath = oldP;
      filePath = newP;
      status = 'renamed';
    } else {
      filePath = pathPart;
      // Determine status based on additions/deletions
      if (additionsStr === '-' || deletionsStr === '-') {
        // Binary file, treat as modified
        status = 'modified';
      } else if (parseInt(additionsStr, 10) > 0 && parseInt(deletionsStr, 10) === 0) {
        // Only additions - could be new file
        status = 'added';
      } else if (parseInt(additionsStr, 10) === 0 && parseInt(deletionsStr, 10) > 0) {
        // Only deletions - could be deleted file
        status = 'deleted';
      } else {
        status = 'modified';
      }
    }

    const file: DiffFile = {
      path: filePath,
      status,
      additions: additionsStr === '-' ? 0 : parseInt(additionsStr, 10) || 0,
      deletions: deletionsStr === '-' ? 0 : parseInt(deletionsStr, 10) || 0,
    };

    if (oldPath) {
      file.oldPath = oldPath;
    }

    files.push(file);
  }

  return files;
}

/**
 * Get detailed diff for a single file between branches
 */
export async function getBranchFileDiff(
  repoPath: string,
  targetBranch: string,
  currentBranch: string,
  filePath: string
): Promise<FileDiff | null> {
  try {
    // Get diff in unified format
    const diffOutput = await executeGit({
      cwd: repoPath,
      args: ['diff', '-U0', `${targetBranch}...${currentBranch}`, '--', filePath],
      timeout: 30000,
    });

    return parseFileDiff(filePath, diffOutput);
  } catch (error) {
    console.error('[Git] Failed to get file diff:', error);
    return null;
  }
}

/**
 * Get detailed diff for a working tree file
 */
export async function getWorktreeFileDiff(
  repoPath: string,
  filePath: string,
  staged: boolean
): Promise<FileDiff | null> {
  try {
    // Check if file is untracked
    const statusOutput = await executeGit({
      cwd: repoPath,
      args: ['status', '--porcelain', '--', filePath],
    });
    const isUntracked = statusOutput.startsWith('??');

    if (isUntracked) {
      // For untracked files, show entire file as added
      const fullPath = path.join(repoPath, filePath);
      try {
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const lineDiffs: LineDiff[] = lines.map((line, index) => ({
          oldLineNumber: null,
          newLineNumber: index + 1,
          type: 'added' as const,
          content: line,
        }));

        return {
          path: filePath,
          oldContent: null,
          newContent: content,
          lines: lineDiffs,
          stats: {
            additions: lines.length,
            deletions: 0,
            changes: lines.length,
          },
        };
      } catch {
        return null;
      }
    }

    const diffArgs = staged
      ? ['diff', '-U0', '--cached', '--', filePath]
      : ['diff', '-U0', '--', filePath];

    const diffOutput = await executeGit({
      cwd: repoPath,
      args: diffArgs,
      timeout: 30000,
    });

    return parseFileDiff(filePath, diffOutput);
  } catch (error) {
    console.error('[Git] Failed to get worktree file diff:', error);
    return null;
  }
}

/**
 * Parse unified diff output into FileDiff
 */
function parseFileDiff(filePath: string, diffOutput: string): FileDiff {
  const lines: LineDiff[] = [];
  let additions = 0;
  let deletions = 0;
  let oldContent: string | null = null;
  let newContent: string | null = null;

  if (!diffOutput) {
    return {
      path: filePath,
      oldContent,
      newContent,
      lines,
      stats: { additions, deletions, changes: 0 },
    };
  }

  const diffLines = diffOutput.split('\n');

  // Parse hunk headers and content
  let currentOldLine = 0;
  let currentNewLine = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentNewLine = parseInt(hunkMatch[2], 10);
      continue;
    }

    // Skip diff header lines
    if (line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('Binary files')) {
      continue;
    }

    // Parse content lines
    if (line.startsWith('+')) {
      lines.push({
        oldLineNumber: null,
        newLineNumber: currentNewLine++,
        type: 'added',
        content: line.substring(1),
      });
      additions++;
    } else if (line.startsWith('-')) {
      lines.push({
        oldLineNumber: currentOldLine++,
        newLineNumber: null,
        type: 'deleted',
        content: line.substring(1),
      });
      deletions++;
    } else if (line.startsWith(' ')) {
      lines.push({
        oldLineNumber: currentOldLine++,
        newLineNumber: currentNewLine++,
        type: 'context',
        content: line.substring(1),
      });
    }
  }

  return {
    path: filePath,
    oldContent,
    newContent,
    lines,
    stats: {
      additions,
      deletions,
      changes: additions + deletions,
    },
  };
}

/**
 * Get file content at a specific branch
 */
export async function getFileAtBranch(
  repoPath: string,
  branch: string,
  filePath: string
): Promise<string | null> {
  try {
    return await executeGit({
      cwd: repoPath,
      args: ['show', `${branch}:${filePath}`],
      timeout: 30000,
    });
  } catch {
    return null;
  }
}

/**
 * Get git status summary
 */
export async function getStatusSummary(repoPath: string): Promise<{
  branch: string;
  isClean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}> {
  const branch = await getCurrentBranch(repoPath);

  try {
    // Get porcelain status
    const statusOutput = await executeGit({
      cwd: repoPath,
      args: ['status', '--porcelain=v1'],
    });

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;

    statusOutput.split('\n').filter(Boolean).forEach(line => {
      const indexStatus = line.charAt(0);
      const workTreeStatus = line.charAt(1);

      if (indexStatus !== ' ' && indexStatus !== '?') staged++;
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') unstaged++;
      if (indexStatus === '?' || workTreeStatus === '?') untracked++;
    });

    // Get ahead/behind count
    let ahead = 0;
    let behind = 0;

    try {
      const countOutput = await executeGit({
        cwd: repoPath,
        args: ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      });
      const [aheadStr, behindStr] = countOutput.split('\t');
      ahead = parseInt(aheadStr, 10) || 0;
      behind = parseInt(behindStr, 10) || 0;
    } catch {
      // No upstream, ignore
    }

    return {
      branch,
      isClean: staged === 0 && unstaged === 0 && untracked === 0,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
    };
  } catch {
    return {
      branch,
      isClean: true,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
    };
  }
}
