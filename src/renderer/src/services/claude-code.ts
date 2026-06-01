/**
 * Claude Code Agent 服务
 * 通过 Electron IPC 调用本地 claude 命令
 * @module services/claude-code
 */

import type { Provider } from '@/types';

/** Claude Code 执行结果 */
export interface ClaudeCodeResult {
  success: boolean;
  output?: string;
  error?: string;
  toolCalls?: ToolCallResult[];
  duration?: number;
}

/** 工具调用结果 */
export interface ToolCallResult {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'success' | 'error';
  duration: number;
}

/** 进度事件数据 */
export interface ProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'init' | 'status' | 'rate_limit' | 'remote_user_message';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
  initData?: {
    model?: string;
    tools?: string[];
    mcpServers?: { name: string; status: string }[];
    slashCommands?: string[];
    skills?: string[];
    plugins?: { name: string; path: string }[];
    agents?: string[];
    cwd?: string;
    projectSkillNames?: string[];
  };
  /** Status data for api_retry, task events, tool progress etc. */
  statusData?: {
    status: string;
    reason?: string;
    /** task_started / task_progress / task_updated */
    taskId?: string;
    subagentType?: string;
    description?: string;
    /** task_progress */
    toolUseId?: string;
    /** task_updated */
    taskStatus?: string;
    error?: string;
    /** tool_progress */
    toolName?: string;
    parentToolUseId?: string;
    elapsed_time_seconds?: number;
    /** tool_use_summary */
    precedingToolUseIds?: string[];
    /** session_state_changed */
    sessionState?: 'idle' | 'running' | 'requires_action';
    /** permission_denied */
    permissionDenied?: {
      toolName: string;
      reason: string;
    };
    /** rate_limit */
    rateLimit?: {
      tier: string;
      requestsRemaining?: number;
      resetAt?: string;
    };
    /** memory_recall */
    memories?: Array<{
      path: string;
      scope: string;
      content?: string;
    }>;
    /** notification */
    notification?: {
      level: 'info' | 'warning' | 'error';
      title?: string;
    };
  };
}

/** Claude Code 执行选项 */
export interface ClaudeExecuteOptions {
  prompt: string;
  workingDirectory: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  apiType?: 'anthropic' | 'openai';
}

/** 进度回调类型 */
export type ProgressCallback = (data: ProgressEvent) => void;

/**
 * 执行 Claude Code 命令
 * 通过 IPC 调用主进程执行 claude 命令
 * @param prompt 提示词
 * @param workingDirectory 工作目录
 * @param provider API Provider 配置（apiKey 应为加密存储的值，此函数会自动解密）
 * @param onProgress 进度回调（可选）
 * @returns 执行结果
 */
export async function executeClaudeCode(
  prompt: string,
  workingDirectory: string,
  provider: Provider,
  onProgress?: ProgressCallback
): Promise<ClaudeCodeResult> {
  // API Key 加密存储，需要解密后使用
  // 注意：此函数已被弃用，新代码应使用 session-store 的 sendMessage
  const apiKey = provider.apiKey;

  console.log('[ClaudeCode] executeClaudeCode called');
  console.log('[ClaudeCode] Provider:', provider.name);
  console.log('[ClaudeCode] API Key exists:', !!apiKey);
  console.log('[ClaudeCode] Base URL:', provider.baseUrl);
  console.log('[ClaudeCode] Model:', provider.defaultModel);
  console.log('[ClaudeCode] API Type:', provider.apiType);

  if (!apiKey) {
    return {
      success: false,
      error: 'API Key 无效或未配置',
    };
  }

  // ⚠️ 警告：provider.apiKey 可能是加密的
  // 调用者应使用 useProviderStore.getState().getDecryptedKey(provider.id) 获取解密后的 Key
  // 此处保留原逻辑以保持兼容性，但调用者应确保传入解密后的 Key

  try {
    console.log('[ClaudeCode] Calling window.api.claude.execute...');
    const result = await window.api.claude.execute(
      {
        prompt,
        workingDirectory,
        apiKey,
        baseUrl: provider.baseUrl,
        model: provider.defaultModel,
        apiType: provider.apiType,
      },
      onProgress
    );

    console.log('[ClaudeCode] Result:', result);
    return result;
  } catch (error) {
    console.error('[ClaudeCode] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 检查 Claude Code CLI 是否可用
 * @returns CLI 是否可用
 */
export async function checkClaudeCodeAvailable(): Promise<boolean> {
  try {
    const result = await window.api.claude.checkAvailable();
    return result.available;
  } catch {
    return false;
  }
}

/**
 * 获取 Claude Code CLI 版本
 * @returns 版本字符串或 null
 */
export async function getClaudeCodeVersion(): Promise<string | null> {
  try {
    const result = await window.api.claude.getVersion();
    return result.version;
  } catch {
    return null;
  }
}

/**
 * 流式执行 Claude Code 命令
 * 使用 --print 模式获取流式输出
 * @param prompt 提示词
 * @param workingDirectory 工作目录
 * @param provider API Provider 配置
 * @param onProgress 进度回调
 * @returns 执行结果
 */
export async function streamClaudeCode(
  prompt: string,
  workingDirectory: string,
  provider: Provider,
  onProgress: ProgressCallback
): Promise<ClaudeCodeResult> {
  return executeClaudeCode(prompt, workingDirectory, provider, onProgress);
}

/**
 * 带超时的执行 Claude Code 命令
 * @param prompt 提示词
 * @param workingDirectory 工作目录
 * @param provider API Provider 配置
 * @param timeoutMs 超时时间（毫秒）
 * @param onProgress 进度回调（可选）
 * @returns 执行结果
 */
export async function executeClaudeCodeWithTimeout(
  prompt: string,
  workingDirectory: string,
  provider: Provider,
  timeoutMs: number = 300000, // 默认 5 分钟
  onProgress?: ProgressCallback
): Promise<ClaudeCodeResult> {
  // API Key 加密存储，需要解密后使用
  // ⚠️ 调用者应使用 useProviderStore.getState().getDecryptedKey(provider.id) 获取解密后的 Key
  const apiKey = provider.apiKey;

  if (!apiKey) {
    return {
      success: false,
      error: 'API Key 无效或未配置',
    };
  }

  try {
    const result = await window.api.claude.execute(
      {
        prompt,
        workingDirectory,
        apiKey,
        baseUrl: provider.baseUrl,
        model: provider.defaultModel,
        apiType: provider.apiType,
        timeout: timeoutMs,
      },
      onProgress
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 检查是否为超时错误
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return {
        success: false,
        error: `执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`,
      };
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}
