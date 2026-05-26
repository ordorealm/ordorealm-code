/**
 * Shared Logger Utility
 *
 * Provides a unified logging interface for all modules.
 * Supports configurable log levels and optional debug mode.
 *
 * @module main/utils/logger
 */

/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Logger configuration options
 */
export interface LoggerConfig {
  /** Whether logging is enabled (default: true) */
  enabled?: boolean
  /** Minimum log level to output (default: 'info') */
  level?: LogLevel
  /** Enable debug mode (shows debug messages, overrides level) */
  debug?: boolean
}

/**
 * Log level priority for comparison
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/**
 * Unified Logger Class
 *
 * Provides consistent logging across all modules with support for:
 * - Enable/disable logging
 * - Log level filtering
 * - Debug mode
 * - Formatted output with timestamp, prefix, and level
 *
 * @example
 * ```typescript
 * // Basic usage
 * const logger = new Logger('MyModule')
 * logger.info('Operation started')
 * logger.error('Something went wrong', error)
 *
 * // With configuration
 * const logger = new Logger('MyModule', { level: 'debug', enabled: true })
 * logger.debug('Detailed information')
 *
 * // Debug mode
 * const logger = new Logger('MyModule', { debug: true })
 * logger.debugLog('Only visible when debug is true')
 * ```
 */
export class Logger {
  private readonly prefix: string
  private enabled: boolean
  private level: LogLevel
  private debugMode: boolean

  /**
   * Create a new Logger instance
   *
   * @param prefix - Prefix to include in all log messages (usually module name)
   * @param config - Optional configuration options
   */
  constructor(prefix: string, config?: LoggerConfig) {
    this.prefix = prefix
    this.enabled = config?.enabled ?? true
    this.level = config?.level ?? 'info'
    this.debugMode = config?.debug ?? false
  }

  /**
   * Format a log message
   *
   * @param level - Log level
   * @param message - Message content
   * @returns Formatted message string
   */
  private format(level: string, message: string): string {
    const timestamp = new Date().toISOString()
    return `[${timestamp}] [${this.prefix}] [${level}] ${message}`
  }

  /**
   * Check if a log level should be output
   *
   * @param level - Level to check
   * @returns True if should log
   */
  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) return false
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level]
  }

  /**
   * Log a debug message
   *
   * @param message - Message to log
   * @param args - Additional arguments
   */
  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.log(this.format('DEBUG', message), ...args)
    }
  }

  /**
   * Log an info message
   *
   * @param message - Message to log
   * @param args - Additional arguments
   */
  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.log(this.format('INFO', message), ...args)
    }
  }

  /**
   * Log a warning message
   *
   * @param message - Message to log
   * @param args - Additional arguments
   */
  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('WARN', message), ...args)
    }
  }

  /**
   * Log an error message
   *
   * @param message - Message to log
   * @param args - Additional arguments
   */
  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(this.format('ERROR', message), ...args)
    }
  }

  /**
   * Log a debug message only when debug mode is enabled
   * This is a convenience method for conditional debug logging
   *
   * @param message - Message to log
   * @param args - Additional arguments
   */
  debugLog(message: string, ...args: unknown[]): void {
    if (this.enabled && this.debugMode) {
      console.log(this.format('DEBUG', message), ...args)
    }
  }

  /**
   * Set whether logging is enabled
   *
   * @param enabled - Enable state
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * Set the minimum log level
   *
   * @param level - Log level
   */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  /**
   * Set debug mode
   *
   * @param debug - Debug mode state
   */
  setDebug(debug: boolean): void {
    this.debugMode = debug
  }

  /**
   * Get current configuration
   *
   * @returns Current logger configuration
   */
  getConfig(): LoggerConfig {
    return {
      enabled: this.enabled,
      level: this.level,
      debug: this.debugMode,
    }
  }
}

/**
 * Create a Logger instance with optional configuration
 *
 * @param prefix - Module prefix
 * @param config - Optional configuration
 * @returns Logger instance
 */
export function createLogger(prefix: string, config?: LoggerConfig): Logger {
  return new Logger(prefix, config)
}

export default Logger
