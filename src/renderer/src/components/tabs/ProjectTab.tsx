/**
 * Project Tab Component
 * Displays a single project tab with drag support and session status indicator
 * @module components/tabs/ProjectTab
 */

import { useState, useRef, useCallback, type DragEvent } from 'react';
import type { Project } from '@/types';

/**
 * Session status info for display in tab
 */
export interface SessionStatusInfo {
  /** Whether session is running (streaming or has activity) */
  status: 'running' | 'idle';
  /** Current activity detail text (e.g., "正在思考...", "正在读取文件...") */
  activity: string | null;
}

interface ProjectTabProps {
  /** Project data */
  project: Project;
  /** Whether this tab is active */
  isActive: boolean;
  /** Session status for this project */
  sessionStatus: SessionStatusInfo;
  /** Whether this tab is being dragged */
  isDragging?: boolean;
  /** Callback when tab is clicked */
  onClick: () => void;
  /** Callback when close button is clicked */
  onClose: () => void;
  /** Callback when drag starts */
  onDragStart: (e: DragEvent<HTMLDivElement>, projectId: string) => void;
  /** Callback when dragging over */
  onDragOver: (e: DragEvent<HTMLDivElement>, projectId: string) => void;
  /** Callback when drag ends */
  onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  /** Callback on drop */
  onDrop: (e: DragEvent<HTMLDivElement>, projectId: string) => void;
}

/**
 * ProjectTab component
 * Renders a single project tab with:
 * - Session running status indicator (pulsing dot)
 * - Project name display
 * - Active state highlighting with bottom border
 * - Close button (visible on hover)
 * - Drag and drop support
 */
export function ProjectTab({
  project,
  isActive,
  sessionStatus,
  isDragging = false,
  onClick,
  onClose,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: ProjectTabProps): JSX.Element {
  const [isHovered, setIsHovered] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', project.id);
      onDragStart(e, project.id);
    },
    [onDragStart, project.id]
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      onDragOver(e, project.id);
    },
    [onDragOver, project.id]
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      onDrop(e, project.id);
    },
    [onDrop, project.id]
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const isRunning = sessionStatus.status === 'running';

  return (
    <div
      ref={tabRef}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={onDragEnd}
      onDrop={handleDrop}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`
        relative flex items-center gap-2 px-3 py-2 cursor-pointer select-none
        transition-colors duration-150 group
        ${isDragging ? 'opacity-50' : ''}
        ${isActive
          ? 'bg-bg-primary text-text-primary'
          : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover'
        }
      `}
      role="tab"
      aria-selected={isActive}
      aria-label={`项目: ${project.name}${isRunning ? ' (运行中)' : ''}`}
    >
      {/* Session running indicator */}
      {isRunning && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Pulsing dot */}
          <div className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
          {/* Activity text - only show for active tab with enough space */}
          {isActive && sessionStatus.activity && (
            <span className="text-xs text-text-muted truncate max-w-[80px]" title={sessionStatus.activity}>
              {sessionStatus.activity}
            </span>
          )}
        </div>
      )}

      {/* Project name */}
      <span className="text-sm font-medium truncate max-w-[120px]" title={project.name}>
        {project.name}
      </span>

      {/* Close button - visible on hover */}
      <button
        onClick={handleClose}
        className={`
          flex-shrink-0 w-4 h-4 flex items-center justify-center rounded
          transition-opacity duration-150
          ${isHovered ? 'opacity-100' : 'opacity-0'}
          hover:bg-bg-hover text-text-muted hover:text-text-primary
        `}
        aria-label={`关闭项目 ${project.name}`}
      >
        <svg
          className="w-3 h-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>

      {/* Active indicator - bottom border */}
      {isActive && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-indigo" />
      )}
    </div>
  );
}
