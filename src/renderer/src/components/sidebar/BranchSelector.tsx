/**
 * Branch Selector Component
 * Git branch selection and diff mode toggle
 * @module components/sidebar/BranchSelector
 */

import { useState } from 'react';
import { useGitStore } from '@/stores/git-store';

/**
 * BranchSelector component
 * Shows branch dropdown and diff mode toggle
 */
export function BranchSelector(): JSX.Element | null {
  const {
    isGitRepo,
    branches,
    currentBranch,
    mainBranch,
    targetBranch,
    isCurrentMain,
    fileViewMode,
    isLoadingBranches,
    checkout,
    checkoutForce,
    commitAndCheckout,
    setTargetBranch,
    setFileViewMode,
  } = useGitStore();

  const [error, setError] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Don't render if not a git repo
  if (!isGitRepo) return null;

  const handleCheckout = async (branch: string) => {
    // Skip if selecting the same branch
    if (branch === currentBranch) return;

    setError(null);
    setPendingBranch(null);
    const result = await checkout(branch);
    if (!result.success) {
      // Parse git error message for better display
      const errorMsg = result.error || '切换分支失败';
      if (errorMsg.includes('would be overwritten by checkout')) {
        setError('有未提交的更改会被覆盖');
        setPendingBranch(branch);
      } else {
        setError(errorMsg.slice(0, 100)); // Truncate long error
      }
    }
  };

  const handleForceCheckout = () => {
    setShowConfirm(true);
  };

  const handleConfirmForceCheckout = async () => {
    if (!pendingBranch) return;
    setShowConfirm(false);
    setError(null);
    const result = await checkoutForce(pendingBranch);
    if (!result.success) {
      setError('强制切换失败: ' + (result.error || '未知错误'));
    }
    setPendingBranch(null);
  };

  const handleCommitAndCheckout = async () => {
    if (!pendingBranch) return;
    setError(null);
    const result = await commitAndCheckout(pendingBranch);
    if (!result.success) {
      setError('提交并切换失败: ' + (result.error || '未知错误'));
    }
    setPendingBranch(null);
  };

  const handleCancel = () => {
    setError(null);
    setPendingBranch(null);
    setShowConfirm(false);
  };

  return (
    <div className="p-2 border-b border-border space-y-2">
      {/* Confirm force checkout dialog */}
      {showConfirm && (
        <div className="space-y-2 px-3 py-2 bg-bg-secondary border border-red-400 rounded text-xs shadow-sm">
          <div className="text-red-500 dark:text-red-400 font-medium">
            ⚠️ 确认强制切换？
          </div>
          <div className="text-text-secondary">
            此操作将丢弃所有未提交的更改，代码将永久丢失！
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleConfirmForceCheckout}
              disabled={isLoadingBranches}
              className="flex-1 px-2 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50 font-medium"
            >
              确认丢弃并切换
            </button>
            <button
              onClick={handleCancel}
              disabled={isLoadingBranches}
              className="flex-1 px-2 py-1.5 bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded transition-colors disabled:opacity-50 border border-border"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Warning message with actions */}
      {error && !showConfirm && (
        <div className="space-y-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded text-xs shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-amber-700 dark:text-amber-300 flex-1 truncate" title={error}>
              ⚠️ {error}
            </span>
            <button
              onClick={handleCancel}
              className="text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 shrink-0"
            >
              ✕
            </button>
          </div>
          {pendingBranch && (
            <div className="flex gap-2">
              <button
                onClick={handleCommitAndCheckout}
                disabled={isLoadingBranches}
                className="flex-1 px-2 py-1.5 bg-accent-indigo hover:bg-accent-indigo/80 text-white rounded transition-colors disabled:opacity-50 font-medium"
                title="提交当前更改后切换分支"
              >
                提交并切换
              </button>
              <button
                onClick={handleForceCheckout}
                disabled={isLoadingBranches}
                className="flex-1 px-2 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50 font-medium"
                title="丢弃所有未提交的更改并切换分支"
              >
                强制切换
              </button>
            </div>
          )}
        </div>
      )}

      {/* First row: Branch selection */}
      <div className="flex items-center gap-2">
        {/* Current branch */}
        <select
          value={currentBranch}
          onChange={(e) => handleCheckout(e.target.value)}
          disabled={isLoadingBranches}
          className="flex-1 min-w-0 text-xs bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-indigo disabled:opacity-50 truncate"
        >
          {branches.local.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name} {b.isMain ? '⭐' : ''}
            </option>
          ))}
        </select>

        {/* Target branch / Worktree indicator */}
        {isCurrentMain ? (
          // Main branch: show worktree indicator
          <div className="flex-1 min-w-0 text-xs text-center px-2 py-1.5 bg-bg-tertiary border border-border rounded text-text-muted truncate">
            工作区
          </div>
        ) : (
          // Other branch: show target branch selector
          <select
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            className="flex-1 min-w-0 text-xs bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-indigo truncate"
          >
            <option value={mainBranch}>{mainBranch}</option>
            {branches.local
              .filter((b) => b.name !== mainBranch && b.name !== currentBranch)
              .slice(0, 5)
              .map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
          </select>
        )}
      </div>

      {/* Second row: File view mode toggle */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setFileViewMode('diff')}
          className={getButtonClass(fileViewMode === 'diff')}
        >
          差异
        </button>
        <button
          onClick={() => setFileViewMode('all')}
          className={getButtonClass(fileViewMode === 'all')}
        >
          全部
        </button>
      </div>
    </div>
  );
}

/**
 * Get button class based on active state
 */
function getButtonClass(isActive: boolean): string {
  return `
    flex-1 text-xs px-2 py-1 rounded transition-colors
    ${isActive
      ? 'bg-accent-indigo text-white'
      : 'bg-bg-tertiary text-text-muted hover:text-text-secondary hover:bg-bg-hover'}
  `;
}

export default BranchSelector;
