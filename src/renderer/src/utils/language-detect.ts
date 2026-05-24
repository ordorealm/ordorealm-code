/**
 * Language detection utility for code preview
 * @module utils/language-detect
 */

import { getBasename } from './path';

/**
 * Map of file extensions to Monaco Editor language IDs
 */
const LANGUAGE_MAP: Record<string, string> = {
  // TypeScript/JavaScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',

  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',

  // Data formats
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.toml': 'ini',

  // Documentation
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.rst': 'restructuredtext',

  // Programming languages
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',

  // Shell/Scripts
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',

  // Config files
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.env': 'plaintext',
  '.gitignore': 'plaintext',
  '.dockerignore': 'plaintext',
  '.editorconfig': 'ini',

  // Other
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.vue': 'vue',
  '.svelte': 'html',
  '.dockerfile': 'dockerfile',
  '.makefile': 'makefile',
};

/**
 * Special filenames that map to specific languages
 */
const SPECIAL_FILES: Record<string, string> = {
  'dockerfile': 'dockerfile',
  'makefile': 'makefile',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  'podfile': 'ruby',
  'vagrantfile': 'ruby',
  'jenkinsfile': 'groovy',
  '.gitignore': 'plaintext',
  '.dockerignore': 'plaintext',
  '.env': 'plaintext',
  '.editorconfig': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  'tsconfig.json': 'jsonc',
  'package.json': 'json',
  'package-lock.json': 'json',
  'yarn.lock': 'plaintext',
  'pnpm-lock.yaml': 'yaml',
};

/**
 * Detect Monaco Editor language ID from file path
 * @param filePath File path or filename
 * @returns Monaco Editor language ID
 */
export function detectLanguage(filePath: string): string {
  // Extract filename (cross-platform)
  const filename = getBasename(filePath).toLowerCase();

  // Check special files first
  if (SPECIAL_FILES[filename]) {
    return SPECIAL_FILES[filename];
  }

  // Get extension
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return 'plaintext';
  }

  // Handle double extensions like .d.ts, .spec.ts
  const ext = filename.slice(lastDotIndex);
  const doubleExt = filename.slice(Math.max(0, filename.lastIndexOf('.', lastDotIndex - 1)));

  // Check double extension first
  if (doubleExt && LANGUAGE_MAP[doubleExt]) {
    return LANGUAGE_MAP[doubleExt];
  }

  // Check single extension
  if (LANGUAGE_MAP[ext]) {
    return LANGUAGE_MAP[ext];
  }

  return 'plaintext';
}

/**
 * Check if a file is a text file that can be displayed in the editor
 * @param filePath File path
 * @returns Whether the file is a text file
 */
export function isTextFile(filePath: string): boolean {
  const filename = getBasename(filePath).toLowerCase();
  const lastDotIndex = filename.lastIndexOf('.');

  if (lastDotIndex === -1) {
    // Check special files without extension
    return !!SPECIAL_FILES[filename];
  }

  const ext = filename.slice(lastDotIndex);

  // Binary file extensions to exclude
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib', '.app',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.sqlite', '.db',
  ]);

  return !binaryExtensions.has(ext);
}

/**
 * Get file size threshold for large file warning (in bytes)
 */
export const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB

/**
 * Check if a file is considered large
 * @param size File size in bytes
 * @returns Whether the file is large
 */
export function isLargeFile(size: number): boolean {
  return size > LARGE_FILE_THRESHOLD;
}
