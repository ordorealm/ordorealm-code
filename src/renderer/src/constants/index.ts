/**
 * 应用常量定义
 */

// 应用信息
export const APP_NAME = 'DevFlow IDE';
export const APP_VERSION = '1.0.0';

// 文件限制
export const MAX_SESSION_MESSAGES = 500;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const FILE_TREE_INIT_DEPTH = 2;

// API 相关
export const API_RETRY_COUNT = 3;
export const API_RETRY_DELAY = [2000, 5000, 10000]; // 毫秒

// 默认 Provider 配置
export const DEFAULT_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4',
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-opus',
  },
};

// 文件类型图标映射
export const FILE_ICONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'react',
  '.js': 'javascript',
  '.jsx': 'react',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'sass',
  '.html': 'html',
  '.md': 'markdown',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

// 语言检测映射
export const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'bash',
  '.bash': 'bash',
};
