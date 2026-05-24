/**
 * Log Sanitization Utilities
 *
 * Provides functions to sanitize sensitive data before logging.
 * Ensures API Keys, tokens, and other secrets are never exposed in logs.
 *
 * @module electron/shared/log-sanitizer
 */

/** Patterns for sensitive data detection */
const SENSITIVE_PATTERNS = [
  // API Keys
  { pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi, replacement: '$1=***REDACTED***' },
  { pattern: /(?:anthropic|openai|claude)[_-]?api[_-]?key\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi, replacement: '$1=***REDACTED***' },

  // Tokens
  { pattern: /(?:token|bearer)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi, replacement: '$1=***REDACTED***' },
  { pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/gi, replacement: 'Bearer ***REDACTED***' },

  // Passwords
  { pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]?([^\s'"]+)['"]?/gi, replacement: '$1=***REDACTED***' },

  // Secrets
  { pattern: /(?:secret|private[_-]?key)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{10,})['"]?/gi, replacement: '$1=***REDACTED***' },

  // Connection strings with credentials
  { pattern: /(mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/gi, replacement: '$1://***:***@' },
]

/**
 * Sanitize a string by redacting sensitive data
 * @param text - Text to sanitize
 * @returns Sanitized text safe for logging
 */
export function sanitizeForLog(text: string): string {
  if (!text) return text

  let sanitized = text

  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }

  return sanitized
}

/**
 * Sanitize an object for logging
 * Recursively sanitizes string values in objects
 * @param obj - Object to sanitize
 * @param depth - Current recursion depth (max 5)
 * @returns Sanitized object safe for logging
 */
export function sanitizeObjectForLog(obj: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > 5) return '[MAX_DEPTH]'

  if (obj === null || obj === undefined) {
    return obj
  }

  if (typeof obj === 'string') {
    return sanitizeForLog(obj)
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectForLog(item, depth + 1))
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Redact known sensitive keys entirely
      const lowerKey = key.toLowerCase()
      if (
        lowerKey.includes('apikey') ||
        lowerKey.includes('api_key') ||
        lowerKey.includes('token') ||
        lowerKey.includes('password') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('privatekey')
      ) {
        sanitized[key] = '***REDACTED***'
      } else {
        sanitized[key] = sanitizeObjectForLog(value, depth + 1)
      }
    }
    return sanitized
  }

  return obj
}

/**
 * Create a safe log string from any input
 * @param args - Arguments to log
 * @returns Sanitized log string
 */
export function safeLog(...args: unknown[]): string {
  return args
    .map(arg => {
      if (typeof arg === 'string') {
        return sanitizeForLog(arg)
      }
      return JSON.stringify(sanitizeObjectForLog(arg))
    })
    .join(' ')
}

/**
 * Mask an API Key for display (show first 4 and last 4 chars)
 * @param key - API Key to mask
 * @returns Masked key like "sk-a...1234"
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 12) {
    return '***'
  }

  const start = key.slice(0, 4)
  const end = key.slice(-4)
  const middle = '*'.repeat(Math.min(8, key.length - 8))

  return `${start}${middle}${end}`
}

/**
 * Check if a string contains potential sensitive data
 * @param text - Text to check
 * @returns True if sensitive data patterns detected
 */
export function containsSensitiveData(text: string): boolean {
  if (!text) return false

  for (const { pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return true
    }
  }

  return false
}
