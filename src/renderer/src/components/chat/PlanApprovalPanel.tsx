/**
 * Plan Approval Panel Component
 *
 * Displays when Claude calls ExitPlanMode tool.
 * Shows the plan content (allowedPrompts list) and allows user to approve or reject.
 *
 * @module components/chat/PlanApprovalPanel
 */

import { useState, useCallback } from 'react';

/** FileText icon (SVG) */
const FileTextIcon = () => (
  <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

/** CheckCircle icon (SVG) */
const CheckCircleIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

/** XCircle icon (SVG) */
const XCircleIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </svg>
);

/**
 * Allowed prompt item structure
 */
interface AllowedPrompt {
  tool?: string;
  prompt?: string;
}

interface PlanApprovalPanelProps {
  /** Tool input containing allowedPrompts */
  toolInput: Record<string, unknown>;
  /** Callback when user approves the plan */
  onApprove: () => void;
  /** Callback when user rejects the plan */
  onReject: () => void;
  /** Whether the panel is disabled */
  disabled?: boolean;
}

/**
 * Plan Approval Panel Component
 *
 * Renders an amber/yellow themed approval dialog for plan execution requests.
 */
export function PlanApprovalPanel({
  toolInput,
  onApprove,
  onReject,
  disabled = false,
}: PlanApprovalPanelProps): JSX.Element | null {
  const [decided, setDecided] = useState(false);

  const handleApprove = useCallback(() => {
    if (disabled || decided) return;
    setDecided(true);
    onApprove();
  }, [disabled, decided, onApprove]);

  const handleReject = useCallback(() => {
    if (disabled || decided) return;
    setDecided(true);
    onReject();
  }, [disabled, decided, onReject]);

  // Don't render after decision
  if (decided) return null;

  // Parse allowedPrompts with type guard
  const allowedPrompts = Array.isArray(toolInput.allowedPrompts)
    ? (toolInput.allowedPrompts as AllowedPrompt[])
    : undefined;
  const hasPrompts = Array.isArray(allowedPrompts) && allowedPrompts.length > 0;

  // If first value is a string (markdown plan content)
  const firstValue = Object.values(toolInput)[0];
  const planText = typeof firstValue === 'string' ? firstValue : null;

  return (
    <div className="flex justify-center my-3 px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="w-full max-w-2xl rounded-xl border border-accent-yellow/30 bg-bg-secondary overflow-hidden shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-tertiary border-b border-border">
          <FileTextIcon />
          <span className="text-xs font-medium text-accent-yellow">计划已完成 — 请审批</span>
          <span className="text-xs text-text-muted ml-auto">Claude 请求退出计划模式</span>
        </div>

        {/* Plan content */}
        <div className="px-4 py-3">
          {hasPrompts ? (
            <div className="space-y-2">
              <div className="text-xs text-text-muted mb-2">计划执行步骤：</div>
              <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
                {allowedPrompts!.map((item, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-sm">
                    <span className="flex-shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center bg-bg-tertiary text-text-muted mt-0.5">
                      {idx + 1}
                    </span>
                    <div>
                      {item.tool && (
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono bg-bg-tertiary text-text-muted mr-1.5">
                          {item.tool}
                        </span>
                      )}
                      <span className="text-text-primary">{item.prompt || ''}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : planText ? (
            <pre className="text-xs text-text-primary whitespace-pre-wrap max-h-60 overflow-y-auto font-mono leading-relaxed">
              {planText}
            </pre>
          ) : (
            <p className="text-sm text-text-muted">Claude 已完成计划，点击「批准」开始执行。</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="px-4 pb-4 pt-2 flex items-center justify-end gap-3 border-t border-border">
          <button
            onClick={handleReject}
            disabled={disabled}
            className={`
              flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
              border border-accent-red/30 text-accent-red bg-bg-primary
              hover:bg-bg-hover hover:border-accent-red/50 active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            `}
          >
            <XCircleIcon />
            拒绝计划
          </button>
          <button
            onClick={handleApprove}
            disabled={disabled}
            className={`
              flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
              bg-accent-green text-white
              hover:bg-accent-green/80 active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            `}
          >
            <CheckCircleIcon />
            批准计划
          </button>
        </div>
      </div>
    </div>
  );
}

PlanApprovalPanel.displayName = 'PlanApprovalPanel';

export default PlanApprovalPanel;
