/**
 * Skill library related type definitions
 * @module types/skill-library
 */

import type { AgentType } from '@/types/agent.types';

/**
 * A skill library entity representing a packaged set of skills and configurations
 * that can be activated in a project directory
 */
export interface SkillLibrary {
  /** Skill library unique ID (UUID) */
  id: string;

  /** Skill library name */
  name: string;

  /** Skill library description */
  description: string;

  /** Applicable agent type */
  agentType: AgentType;

  /** Original zip file size in bytes */
  fileSize: number;

  /** Creation time (ISO format) */
  createdAt: string;

  /** Last update time (ISO format) */
  updatedAt: string;
}

/**
 * Parameters for creating a new skill library
 */
export interface CreateSkillLibraryParams {
  /** Absolute path to the zip file */
  zipPath: string;

  /** Skill library name */
  name: string;

  /** Skill library description */
  description: string;

  /** Applicable agent type */
  agentType: AgentType;
}

/**
 * Parameters for updating an existing skill library's metadata
 */
export interface UpdateSkillLibraryParams {
  /** Skill library ID to update */
  id: string;

  /** New skill library name */
  name: string;

  /** New skill library description */
  description: string;
}

/**
 * Result of validating a skill library zip file
 */
export interface SkillLibraryValidationResult {
  /** Whether validation passed */
  valid: boolean;

  /** Validation error messages, if any */
  errors?: string[];
}

/**
 * Parameters for activating a skill library in a project
 */
export interface ActivateSkillLibraryParams {
  /** Skill library ID to activate */
  id: string;

  /** Absolute path to the target project directory */
  projectPath: string;
}

/**
 * Result of activating a skill library
 */
export interface ActivateSkillLibraryResult {
  /** Whether activation succeeded */
  success: boolean;

  /** Error message if activation failed */
  error?: string;
}
