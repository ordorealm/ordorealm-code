/**
 * Master Agent session configuration.
 *
 * Provides a bridge between electron/main (where SDK/config lives) and
 * src/main/agents (where the master agent session is managed).
 *
 * @module main/agents/session-config
 */

export interface MasterSessionConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  apiType: 'anthropic' | 'openai'
  /** Path to the Claude Code binary, resolved at startup */
  pathToClaudeCodeExecutable?: string
}

let config: MasterSessionConfig | null = null

export function setMasterSessionConfig(cfg: MasterSessionConfig): void {
  config = cfg
}

export function getMasterSessionConfig(): MasterSessionConfig | null {
  return config
}
