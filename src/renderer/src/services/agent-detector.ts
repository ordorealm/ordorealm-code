/**
 * Agent 安装检测服务
 * 检测不同 Agent 类型的安装状态
 * @module services/agent-detector
 */

import type { AgentType } from '@/types';

/** Agent 安装状态 */
export interface AgentInstallStatus {
  agentType: AgentType;
  installed: boolean;
  version: string | null;
  installCommand: string;
  installUrl: string;
  displayName: string;
}

/**
 * 检测 Claude Code CLI 安装状态
 * Claude Code SDK 是内置的，所以检查 SDK 是否可用
 */
async function checkClaudeCode(): Promise<{ installed: boolean; version: string | null }> {
  try {
    // 首先检查内置 SDK 是否可用
    const sdkResult = await window.api.claude.checkAvailable();
    if (sdkResult.available) {
      // SDK 可用，获取版本
      const versionResult = await window.api.claude.getVersion();
      return { installed: true, version: versionResult.version };
    }

    // SDK 不可用，检查系统 CLI
    const result = await window.api.claude.checkAgentInstalled('claude-code');
    return result;
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * 检测 Codex CLI 安装状态
 * Codex CLI 是 OpenAI 官方的终端编程 Agent
 */
async function checkCodexAgent(): Promise<{ installed: boolean; version: string | null }> {
  try {
    const result = await window.api.claude.checkAgentInstalled('codex');
    return result;
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * 检测 OpenCode 安装状态
 * OpenCode 是开源的多 Provider 编程 Agent
 */
async function checkOpenCodeAgent(): Promise<{ installed: boolean; version: string | null }> {
  try {
    const result = await window.api.claude.checkAgentInstalled('opencode');
    return result;
  } catch {
    return { installed: false, version: null };
  }
}

/** Agent 安装信息映射 */
const AGENT_INSTALL_INFO: Record<AgentType, { command: string; url: string; displayName: string }> = {
  'claude-code': {
    command: 'npm install -g @anthropic-ai/claude-code',
    url: 'https://docs.anthropic.com/en/docs/claude-code',
    displayName: 'Claude Code',
  },
  'codex': {
    command: 'npm install -g @openai/codex',
    url: 'https://github.com/openai/codex',
    displayName: 'Codex CLI',
  },
  'opencode': {
    command: 'go install github.com/opencode-ai/opencode@latest',
    url: 'https://github.com/opencode-ai/opencode',
    displayName: 'OpenCode',
  },
};

/**
 * 检测指定 Agent 的安装状态
 * @param agentType Agent 类型
 * @returns 安装状态信息
 */
export async function checkAgentInstalled(agentType: AgentType): Promise<AgentInstallStatus> {
  let checkResult: { installed: boolean; version: string | null };

  switch (agentType) {
    case 'claude-code':
      checkResult = await checkClaudeCode();
      break;
    case 'codex':
      checkResult = await checkCodexAgent();
      break;
    case 'opencode':
      checkResult = await checkOpenCodeAgent();
      break;
    default:
      checkResult = { installed: false, version: null };
  }

  const info = AGENT_INSTALL_INFO[agentType];

  return {
    agentType,
    installed: checkResult.installed,
    version: checkResult.version,
    installCommand: info.command,
    installUrl: info.url,
    displayName: info.displayName,
  };
}

/**
 * 检测所有 Agent 的安装状态
 * @returns 所有 Agent 的安装状态列表
 */
export async function checkAllAgentsInstalled(): Promise<AgentInstallStatus[]> {
  const agentTypes: AgentType[] = ['claude-code', 'codex', 'opencode'];
  const results = await Promise.all(agentTypes.map(checkAgentInstalled));
  return results;
}
