/**
 * Ask User Question Panel Component
 *
 * Displays when Claude calls AskUserQuestion tool.
 * Supports multiple questions, option buttons (single/multi-select), and custom input.
 *
 * @module components/chat/AskUserQuestionPanel
 */

import { useState, useCallback } from 'react';
import type { Question } from '@/types';

/**
 * Question option
 */
interface QuestionOption {
  label: string;
  description?: string;
}

// Re-export Question for backward compatibility
export type { Question } from '@/types';

interface AskUserQuestionPanelProps {
  /** Questions to display */
  questions: Question[];
  /** Callback when answers are submitted */
  onSubmit: (answers: Record<string, string>) => void;
  /** Whether the panel is disabled */
  disabled?: boolean;
}

/**
 * Ask User Question Panel Component
 *
 * Displays when Claude calls AskUserQuestion tool.
 * Supports multiple questions, option buttons (single/multi-select), and custom input.
 */
export function AskUserQuestionPanel({
  questions,
  onSubmit,
  disabled = false,
}: AskUserQuestionPanelProps): JSX.Element | null {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<string, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const setAnswer = useCallback((idx: number, value: string) => {
    setAnswers(prev => ({ ...prev, [String(idx)]: value }));
  }, []);

  const setCustomInput = useCallback((idx: number, value: string) => {
    setCustomInputs(prev => ({ ...prev, [String(idx)]: value }));
  }, []);

  const toggleMultiAnswer = useCallback((idx: number, value: string, question: Question) => {
    setMultiAnswers(prev => {
      const current = prev[String(idx)] || [];
      const next = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      return { ...prev, [String(idx)]: next };
    });
    // Also update the single-answer store for the submit check
    setAnswers(prev => {
      const key = String(idx);
      const currentMulti = multiAnswers[key] || [];
      const isInMulti = currentMulti.includes(value);
      let nextMulti: string[];
      if (isInMulti) {
        nextMulti = currentMulti.filter(v => v !== value);
      } else {
        nextMulti = [...currentMulti, value];
      }
      return { ...prev, [key]: nextMulti.join(', ') };
    });
  }, [multiAnswers]);

  const handleSubmit = useCallback(() => {
    if (disabled || submitted) return;
    setSubmitted(true);

    // 拼接额外描述到答案后面
    const finalAnswers: Record<string, string> = {};
    for (const [key, value] of Object.entries(answers)) {
      const customInput = customInputs[key];
      if (customInput && customInput.trim()) {
        finalAnswers[key] = `${value}：${customInput.trim()}`;
      } else {
        finalAnswers[key] = value;
      }
    }

    onSubmit(finalAnswers);
  }, [disabled, submitted, answers, customInputs, onSubmit]);

  const isQuestionAnswered = useCallback((idx: number, question: Question) => {
    const key = String(idx);
    if (question.multiSelect) {
      return (multiAnswers[key]?.length ?? 0) > 0;
    }
    return !!answers[key];
  }, [answers, multiAnswers]);

  const allAnswered = questions.every((q, idx) => isQuestionAnswered(idx, q));

  if (submitted) return null;

  return (
    <div className="flex justify-center my-3 px-4">
      <div className="w-full max-w-2xl rounded-xl border border-accent-indigo/30 bg-bg-secondary overflow-hidden shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-tertiary border-b border-border">
          <svg className="w-3.5 h-3.5 text-accent-indigo flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs font-medium text-accent-indigo">Claude 需要您的回答</span>
          <span className="text-xs text-text-muted ml-auto">{questions.length} 个问题</span>
        </div>

        <div className="px-4 py-3 space-y-4">
          {questions.map((q, idx) => (
            <div key={idx} className="space-y-2">
              {/* Question text */}
              <div className="text-sm font-medium text-text-primary">
                <span className="text-accent-indigo mr-1.5 text-xs font-bold">Q{idx + 1}</span>
                {q.question}
              </div>

              {/* Options */}
              {q.options && q.options.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt, optIdx) => {
                    const isMultiSelect = q.multiSelect === true;
                    const isSingleSelected = answers[String(idx)] === opt.label;
                    const isMultiSelected = (multiAnswers[String(idx)] || []).includes(opt.label);
                    const isSelected = isMultiSelect ? isMultiSelected : isSingleSelected;

                    return (
                      <button
                        key={optIdx}
                        onClick={() => {
                          if (isMultiSelect) {
                            toggleMultiAnswer(idx, opt.label, q);
                          } else {
                            setAnswer(idx, opt.label);
                          }
                        }}
                        disabled={disabled}
                        title={opt.description}
                        className={`
                          flex items-start gap-1.5 px-3 py-1.5 rounded-lg text-sm text-left
                          border transition-all duration-150 active:scale-95
                          disabled:opacity-40 disabled:cursor-not-allowed
                          focus:outline-none focus:ring-1 focus:ring-accent-indigo/50
                          ${isSelected
                            ? 'border-accent-indigo bg-bg-tertiary text-accent-indigo'
                            : 'border-border bg-bg-primary text-text-primary hover:border-accent-indigo/50 hover:bg-bg-hover'
                          }
                        `}
                      >
                        {isSelected && (
                          <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                        <span className="max-w-[300px]">{opt.label}</span>
                        {isMultiSelect && (
                          <span className="text-[10px] text-accent-indigo/70 ml-0.5">(多选)</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                /* Text input */
                <input
                  type="text"
                  value={answers[String(idx)] || ''}
                  onChange={e => setAnswer(idx, e.target.value)}
                  disabled={disabled}
                  placeholder="请输入您的答案..."
                  className="
                    w-full h-8 px-3 rounded-lg text-sm
                    bg-bg-primary border border-border
                    text-text-primary placeholder:text-text-muted
                    focus:outline-none focus:border-accent-indigo focus:ring-1 focus:ring-accent-indigo/30
                    disabled:opacity-40 disabled:cursor-not-allowed
                  "
                />
              )}

              {/* 额外描述输入框 */}
              {q.options && q.options.length > 0 && (
                <input
                  type="text"
                  value={customInputs[String(idx)] || ''}
                  onChange={e => setCustomInput(idx, e.target.value)}
                  disabled={disabled}
                  placeholder="补充说明（可选）..."
                  className="
                    w-full h-8 px-3 rounded-lg text-sm mt-2
                    bg-bg-primary border border-border
                    text-text-primary placeholder:text-text-muted
                    focus:outline-none focus:border-accent-indigo focus:ring-1 focus:ring-accent-indigo/30
                    disabled:opacity-40 disabled:cursor-not-allowed
                  "
                />
              )}
            </div>
          ))}
        </div>

        {/* Submit button */}
        <div className="px-4 pb-4 pt-1 flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered || disabled}
            className={`
              px-4 py-1.5 rounded-lg text-sm font-medium
              bg-accent-indigo text-white
              hover:bg-accent-indigo/80 active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            `}
          >
            提交回答
          </button>
        </div>
      </div>
    </div>
  );
}
