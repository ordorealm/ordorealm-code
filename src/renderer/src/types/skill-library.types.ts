/**
 * Skill library type definitions
 * @module types/skill-library
 */

import type { AgentType } from './agent.types';

/**
 * Skill library metadata
 */
export interface SkillLibrary {
  /** Unique ID (UUID) */
  id: string;

  /** Skill library name */
  name: string;

  /** Skill library description */
  description: string;

  /** Applicable Agent type */
  agentType: AgentType;

  /** Original zip file size in bytes */
  fileSize: number;

  /** Creation time (ISO format) */
  createdAt: string;

  /** Last update time (ISO format) */
  updatedAt: string;
}

/**
 * Skill library validation result
 */
export interface SkillLibraryValidateResult {
  /** Whether valid */
  valid: boolean;

  /** Error message */
  error?: string;
}

/**
 * Skill library activation result
 */
export interface SkillLibraryActivateResult {
  /** Whether successful */
  success: boolean;

  /** Error message */
  error?: string;
}
