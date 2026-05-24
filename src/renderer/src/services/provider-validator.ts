/**
 * Provider API Key 验证服务
 * 验证 API Key 有效性
 */

import type { Provider, ApiType } from '@/types';

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  models?: string[];
}

/** API Key 格式级别 */
export type KeyFormatLevel = 'strict' | 'loose' | 'warning';

/** Key 格式检查结果 */
export interface KeyFormatCheckResult {
  valid: boolean;
  level: KeyFormatLevel;
  message: string;
  isOfficialKey: boolean;
}

/**
 * 检测是否为官方 Base URL
 */
function isOfficialBaseUrl(baseUrl: string, apiType: ApiType): boolean {
  const officialUrls: Record<ApiType, string[]> = {
    anthropic: ['https://api.anthropic.com'],
    openai: ['https://api.openai.com', 'https://api.openai.com/v1'],
  };

  const normalizedInput = baseUrl.replace(/\/+$/, '').toLowerCase();
  return officialUrls[apiType].some(url => normalizedInput === url.replace(/\/+$/, '').toLowerCase());
}

/**
 * 验证 API Key 格式（支持第三方）
 * @param apiType API 类型
 * @param apiKey API Key
 * @param baseUrl Base URL（用于判断是否为官方 API）
 * @returns 格式检查结果
 */
export function validateKeyFormat(
  apiType: ApiType,
  apiKey: string,
  baseUrl?: string
): KeyFormatCheckResult {
  if (!apiKey || apiKey.trim().length === 0) {
    return {
      valid: false,
      level: 'strict',
      message: 'API Key 不能为空',
      isOfficialKey: false,
    };
  }

  const trimmedKey = apiKey.trim();
  const isOfficial = baseUrl ? isOfficialBaseUrl(baseUrl, apiType) : true;

  // 官方 API：严格验证格式
  if (isOfficial) {
    if (apiType === 'openai') {
      // OpenAI 官方 Key 格式: sk-xxx 或 sk-proj-xxx 或 sk-svcacct-xxx
      if (/^sk(-[a-z]+)?-[A-Za-z0-9_-]{20,}$/.test(trimmedKey)) {
        return {
          valid: true,
          level: 'strict',
          message: 'OpenAI 官方 API Key 格式正确',
          isOfficialKey: true,
        };
      }
      return {
        valid: false,
        level: 'strict',
        message: 'OpenAI 官方 API Key 应以 sk- 开头',
        isOfficialKey: false,
      };
    }

    if (apiType === 'anthropic') {
      // Anthropic 官方 Key 格式: sk-ant-xxx
      if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmedKey)) {
        return {
          valid: true,
          level: 'strict',
          message: 'Anthropic 官方 API Key 格式正确',
          isOfficialKey: true,
        };
      }
      return {
        valid: false,
        level: 'strict',
        message: 'Anthropic 官方 API Key 应以 sk-ant- 开头',
        isOfficialKey: false,
      };
    }
  }

  // 第三方 API：放宽验证，只检查基本长度
  if (trimmedKey.length >= 10) {
    return {
      valid: true,
      level: 'loose',
      message: '第三方 API Key 格式已接受（非官方格式，但仍会尝试验证连接）',
      isOfficialKey: false,
    };
  }

  // Key 太短，警告但允许
  if (trimmedKey.length >= 5) {
    return {
      valid: true,
      level: 'warning',
      message: 'API Key 长度较短，可能无效，但允许继续',
      isOfficialKey: false,
    };
  }

  return {
    valid: false,
    level: 'strict',
    message: 'API Key 长度过短',
    isOfficialKey: false,
  };
}

/** 默认验证超时时间（毫秒） */
const VALIDATION_TIMEOUT = 15000;

/** 默认验证模型 */
const DEFAULT_VALIDATION_MODELS: Record<ApiType, string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

/**
 * 验证 API Key 是否能连接到服务
 * 通过发送一个轻量级的 API 请求来验证
 * @param provider Provider 配置
 * @note provider.apiKey 可能是加密存储的值，调用此函数前应确保使用解密后的 Key
 *       建议使用 useProviderStore.getState().getDecryptedKey(provider.id) 获取解密后的 Key
 */
export async function validateProviderConnection(
  provider: Provider
): Promise<ValidationResult> {
  // ⚠️ 注意：如果 provider 来自存储，apiKey 是加密的
  // 调用者应确保传入解密后的 Key，或此函数内部需要解密
  const apiKey = provider.apiKey;

  // 检查 Key 格式（支持第三方）
  const formatCheck = validateKeyFormat(provider.apiType, apiKey, provider.baseUrl);
  if (!formatCheck.valid) {
    return {
      valid: false,
      error: formatCheck.message,
    };
  }

  // 如果是非官方 Key 且只是警告级别，仍然尝试连接
  // 连接验证会给出最终结果

  try {
    switch (provider.apiType) {
      case 'openai':
        return await validateOpenAI(provider.baseUrl, apiKey);
      case 'anthropic':
        // 使用界面设置的模型，如果没有则使用默认模型
        return await validateAnthropic(provider.baseUrl, apiKey, provider.defaultModel);
      default:
        return { valid: false, error: '不支持的 API 类型' };
    }
  } catch (error) {
    return {
      valid: false,
      error: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 标准化 baseUrl，移除末尾斜杠和版本路径
 */
function normalizeBaseUrl(baseUrl: string, apiType: ApiType): string {
  let url = baseUrl.replace(/\/+$/, '');

  // 移除已有的版本路径，避免重复拼接
  if (apiType === 'anthropic') {
    // 移除 /v1, /v2 等版本路径
    url = url.replace(/\/v\d+$/, '');
  } else if (apiType === 'openai') {
    // 移除 /v1, /v2 等版本路径
    url = url.replace(/\/v\d+$/, '');
  }

  return url;
}

/**
 * 创建带超时的 fetch 请求
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number = VALIDATION_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 验证 OpenAI API Key
 */
async function validateOpenAI(baseUrl: string, apiKey: string): Promise<ValidationResult> {
  // 标准化 baseUrl 并正确拼接路径
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, 'openai');
  const url = `${normalizedBaseUrl}/v1/models`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        valid: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const models = (data.data || []).map((m: { id: string }) => m.id);

    return {
      valid: true,
      models,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        valid: false,
        error: '请求超时，请检查网络连接',
      };
    }
    throw error;
  }
}

/**
 * 验证 Anthropic API Key
 * @param baseUrl API 基础 URL
 * @param apiKey API Key
 * @param model 用于验证的模型，如果不提供则使用默认模型
 */
async function validateAnthropic(
  baseUrl: string,
  apiKey: string,
  model?: string
): Promise<ValidationResult> {
  // 使用界面设置的模型，如果没有则使用默认模型
  const validationModel = model || DEFAULT_VALIDATION_MODELS.anthropic;

  // 标准化 baseUrl 并正确拼接路径
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, 'anthropic');
  const url = `${normalizedBaseUrl}/v1/messages`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: validationModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    if (response.status === 401) {
      return { valid: false, error: 'API Key 无效' };
    }

    if (response.status === 404) {
      // 模型不存在，但 API Key 有效
      return {
        valid: false,
        error: `模型 ${validationModel} 不存在，请检查模型名称`,
      };
    }

    if (response.status === 400 || response.ok) {
      // 400 说明 Key 有效但请求参数可能有问题
      // 200 说明 Key 有效
      return {
        valid: true,
        models: [validationModel, 'claude-3-5-sonnet-latest', 'claude-3-opus-latest'],
      };
    }

    const errorText = await response.text().catch(() => 'Unknown error');
    return {
      valid: false,
      error: `HTTP ${response.status}: ${errorText}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        valid: false,
        error: '请求超时，请检查网络连接',
      };
    }
    throw error;
  }
}
