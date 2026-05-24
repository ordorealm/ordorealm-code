/**
 * Project related type definitions
 * @module types/project
 */

/**
 * Project entity representing a development project
 */
export interface Project {
  /** Unique identifier (UUID) */
  id: string;
  /** Project name */
  name: string;
  /** Project directory path */
  path: string;
  /** Creation timestamp (ISO8601) */
  createdAt: string;
  /** Last opened timestamp (ISO8601) */
  lastOpenedAt: string;
  /** Whether this project is currently active */
  isActive: boolean;
}

/**
 * Project state managed by Zustand store
 */
export interface ProjectState {
  /** List of all projects */
  projects: Project[];
  /** Currently active project ID */
  activeProjectId: string | null;
  /** Recently opened project IDs */
  recentProjects: string[];
}
