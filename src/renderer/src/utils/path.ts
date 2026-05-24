/**
 * Cross-platform path utilities for renderer process
 * Handles both Windows (\) and Unix (/) path separators
 * @module utils/path
 */

/**
 * Join path segments with forward slash
 * Normalizes multiple consecutive slashes to single slash
 */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
}

/**
 * Get the base name (file name) from a path
 * Works with both Windows and Unix path separators
 */
export function getBasename(filePath: string): string {
  if (!filePath) return '';
  // Handle both / and \ separators
  return filePath.split(/[/\\]/).pop() || '';
}

/**
 * Get the directory name from a path
 * Works with both Windows and Unix path separators
 */
export function getDirname(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split(/[/\\]/);
  parts.pop();
  return parts.join('/') || '/';
}

/**
 * Get the last separator index in a path
 * Returns the position of either / or \, whichever comes last
 */
export function getLastSepIndex(filePath: string): number {
  return Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\')
  );
}

/**
 * Check if a path starts with a given directory path
 * Works with both Windows and Unix path separators
 */
export function pathStartsWith(filePath: string, dirPath: string): boolean {
  // Normalize both paths
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = dirPath.replace(/\\/g, '/');

  // Ensure dir path ends with /
  const dirWithSlash = normalizedDir.endsWith('/')
    ? normalizedDir
    : normalizedDir + '/';

  return normalizedFile.startsWith(dirWithSlash);
}

/**
 * Normalize a path to use forward slashes
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Get relative path from absolute path and base path
 */
export function getRelativePath(absolutePath: string, basePath: string): string {
  const normalizedAbs = normalizePath(absolutePath);
  const normalizedBase = normalizePath(basePath);

  if (normalizedAbs.startsWith(normalizedBase)) {
    let relative = normalizedAbs.slice(normalizedBase.length);
    if (relative.startsWith('/')) {
      relative = relative.slice(1);
    }
    return relative;
  }

  return absolutePath;
}

/**
 * Validate file/directory name for cross-platform compatibility
 * Returns error message if invalid, null if valid
 */
export function validateName(name: string, platform?: NodeJS.Platform): string | null {
  if (!name.trim()) {
    return '名称不能为空';
  }

  // Get platform (default to current if not specified)
  const isWindows = platform === 'win32';

  // Check for invalid characters
  // Windows: < > : " / \ | ? * and control characters (0x00-0x1F)
  // Unix: / and \0 only
  if (isWindows) {
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
      return '名称包含无效字符';
    }

    // Windows reserved names
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedNames.test(name)) {
      return '名称是系统保留字';
    }

    // Windows doesn't allow trailing space or dot
    if (name.endsWith(' ') || name.endsWith('.')) {
      return '名称不能以空格或点结尾';
    }
  } else {
    // Unix/macOS only checks for / and null
    if (name.includes('/') || name.includes('\0')) {
      return '名称包含无效字符';
    }
  }

  // Check length
  if (name.length > 255) {
    return '名称过长（最多255字符）';
  }

  // Check for leading dots or spaces (common restriction)
  if (name.startsWith('.') || name.startsWith(' ')) {
    return '名称不能以点号或空格开头';
  }

  return null;
}

// Export as object for convenient access
export const pathUtils = {
  join: joinPath,
  basename: getBasename,
  dirname: getDirname,
  lastSepIndex: getLastSepIndex,
  startsWith: pathStartsWith,
  normalize: normalizePath,
  relative: getRelativePath,
  validateName,
};
