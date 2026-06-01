/**
 * Validator
 * 验证器（幻觉检测）
 * @module main/controller/validator
 */

import { Logger } from '../utils/logger'
import type { ValidationResult, Issue } from './types'

const logger = new Logger('Validator')

/**
 * 验证规则实现
 */
export const ValidationRules = {
  /**
   * 检查空函数体
   * @param content 代码内容
   * @returns 验证结果
   */
  no_empty_function_bodies(content: string): ValidationResult {
    const issues: Issue[] = []

    // 正则匹配空函数体
    // 匹配: function name() {} 或 const name = () => {} 或 name() {}
    const patterns = [
      // function name() {}
      /function\s+\w+\s*\([^)]*\)\s*\{\s*\}/g,
      // const name = () => {}
      /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{\s*\}/g,
      // const name = async () => {}
      /const\s+\w+\s*=\s*async\s*\([^)]*\)\s*=>\s*\{\s*\}/g,
      // async function name() {}
      /async\s+function\s+\w+\s*\([^)]*\)\s*\{\s*\}/g,
      // export function name() {}
      /export\s+function\s+\w+\s*\([^)]*\)\s*\{\s*\}/g,
      // export const name = () => {}
      /export\s+const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{\s*\}/g,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        issues.push({
          severity: 'critical',
          location: `行 ${getLineNumber(content, match.index || 0)}`,
          description: `空函数体: ${match[0].slice(0, 50)}...`,
          suggestion: '实现函数逻辑或添加 // TODO 注释说明'
        })
      }
    }

    return { pass: issues.length === 0, issues }
  },

  /**
   * 检查 TODO 占位符
   * @param content 代码内容
   * @returns 验证结果
   */
  no_todo_placeholders(content: string): ValidationResult {
    const issues: Issue[] = []

    // 匹配 TODO 注释（允许 TODO 但需要检查上下文）
    // 这里我们检查是否整个函数只有 TODO
    const patterns = [
      // function name() { // TODO }
      /function\s+\w+\s*\([^)]*\)\s*\{\s*\/\/\s*TODO[^\}]*\}/gi,
      // const name = () => { // TODO }
      /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{\s*\/\/\s*TODO[^\}]*\}/gi,
      // function name() { /* TODO */ }
      /function\s+\w+\s*\([^)]*\)\s*\{\s*\/\*\s*TODO[^\}]*\*\/\s*\}/gi,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        issues.push({
          severity: 'major',
          location: `行 ${getLineNumber(content, match.index || 0)}`,
          description: `TODO 占位符未实现: ${match[0].slice(0, 50)}...`,
          suggestion: '实现具体逻辑或标记为已知问题'
        })
      }
    }

    return { pass: issues.length === 0, issues }
  },

  /**
   * 检查生产代码中的模拟数据
   * @param content 代码内容
   * @returns 验证结果
   */
  no_mock_data_in_prod(content: string): ValidationResult {
    const issues: Issue[] = []

    // 匹配常见的模拟数据模式
    const patterns = [
      // const mockData = ...
      /const\s+mock\w*\s*=\s*\[/gi,
      // const fakeData = ...
      /const\s+fake\w*\s*=\s*\[/gi,
      // const testData = ...
      /const\s+test\w*Data\s*=\s*\[/gi,
      // // Mock: ...
      /\/\/\s*Mock:/gi,
      // /* Mock data */
      /\/\*\s*Mock\s*data\s*\*\//gi,
      // return { // mock
      /return\s*\{[^}]*\/\/\s*mock/gi,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        issues.push({
          severity: 'major',
          location: `行 ${getLineNumber(content, match.index || 0)}`,
          description: `发现模拟数据: ${match[0].slice(0, 50)}...`,
          suggestion: '使用真实数据源或移除模拟数据'
        })
      }
    }

    return { pass: issues.length === 0, issues }
  },

  /**
   * 检查空逻辑块
   * @param content 代码内容
   * @returns 验证结果
   */
  no_empty_logic_blocks(content: string): ValidationResult {
    const issues: Issue[] = []

    // 匹配空逻辑块
    const patterns = [
      // if (condition) {}
      /if\s*\([^)]+\)\s*\{\s*\}/g,
      // else {}
      /else\s*\{\s*\}/g,
      // for (...) {}
      /for\s*\([^)]+\)\s*\{\s*\}/g,
      // while (...) {}
      /while\s*\([^)]+\)\s*\{\s*\}/g,
      // try {} catch (...) {}
      /try\s*\{\s*\}\s*catch\s*\([^)]+\)\s*\{\s*\}/g,
      // switch (...) {}
      /switch\s*\([^)]+\)\s*\{\s*\}/g,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        issues.push({
          severity: 'major',
          location: `行 ${getLineNumber(content, match.index || 0)}`,
          description: `空逻辑块: ${match[0].slice(0, 50)}...`,
          suggestion: '实现逻辑或添加注释说明'
        })
      }
    }

    return { pass: issues.length === 0, issues }
  },

  /**
   * 检查硬编码凭证
   * @param content 代码内容
   * @returns 验证结果
   */
  no_hardcoded_credentials(content: string): ValidationResult {
    const issues: Issue[] = []

    // 匹配可能的凭证
    const patterns = [
      // password = "..."
      /password\s*=\s*["'][^"']+["']/gi,
      // apiKey = "..."
      /api[_-]?key\s*=\s*["'][^"']+["']/gi,
      // secret = "..."
      /secret\s*=\s*["'][^"']+["']/gi,
      // token = "..."
      /token\s*=\s*["'][^"']+["']/gi,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        issues.push({
          severity: 'critical',
          location: `行 ${getLineNumber(content, match.index || 0)}`,
          description: `硬编码凭证: ${match[0].slice(0, 30)}...`,
          suggestion: '使用环境变量或配置文件'
        })
      }
    }

    return { pass: issues.length === 0, issues }
  },

  /**
   * 检查调试代码
   * @param content 代码内容
   * @returns 验证结果
   */
  no_debug_code(content: string): ValidationResult {
    const issues: Issue[] = []

    // 匹配调试代码
    const patterns = [
      // console.log(...)
      /console\.(log|debug|info)\s*\([^)]*\)/g,
      // debugger
      /\bdebugger\b/g,
      // alert(...)
      /\balert\s*\([^)]*\)/g,
    ]

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        issues.push({
          severity: 'minor',
          location: `行 ${getLineNumber(content, match.index || 0)}`,
          description: `调试代码: ${match[0].slice(0, 30)}...`,
          suggestion: '移除调试代码或使用条件编译'
        })
      }
    }

    return { pass: issues.length === 0, issues }
  }
}

/**
 * 获取行号
 * @param content 内容
 * @param index 字符索引
 * @returns 行号
 */
function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

/**
 * 运行验证
 * @param rules 规则列表
 * @param content 代码内容
 * @returns 验证结果
 */
export function validate(rules: string[], content: string): ValidationResult {
  const allIssues: Issue[] = []

  for (const rule of rules) {
    const ruleImpl = ValidationRules[rule as keyof typeof ValidationRules]
    if (ruleImpl) {
      const result = ruleImpl(content)
      allIssues.push(...result.issues)
    } else {
      logger.warn(`Unknown validation rule: ${rule}`)
    }
  }

  return {
    pass: allIssues.length === 0,
    issues: allIssues
  }
}

/**
 * 验证文件
 * @param rules 规则列表
 * @param filePath 文件路径
 * @returns 验证结果
 */
export async function validateFile(rules: string[], filePath: string): Promise<ValidationResult> {
  const fs = await import('fs')

  try {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return validate(rules, content)
  } catch (error) {
    logger.error(`Failed to validate file: ${error}`)
    return {
      pass: false,
      issues: [{
        severity: 'critical',
        location: filePath,
        description: `无法读取文件: ${error}`
      }]
    }
  }
}

/**
 * 验证多个文件
 * @param rules 规则列表
 * @param filePaths 文件路径列表
 * @returns 验证结果
 */
export async function validateFiles(rules: string[], filePaths: string[]): Promise<ValidationResult> {
  const allIssues: Issue[] = []

  for (const filePath of filePaths) {
    const result = await validateFile(rules, filePath)
    allIssues.push(...result.issues)
  }

  return {
    pass: allIssues.length === 0,
    issues: allIssues
  }
}
