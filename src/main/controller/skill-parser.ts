/**
 * Skill Parser
 * 技能编排解析器
 * @module main/controller/skill-parser
 */

import * as fs from 'fs'
import * as path from 'path'
import { Logger } from '../utils/logger'
import type { SkillOrchestration, StepDef, OutputDef } from './types'
import { SKILLS_DIR } from './types'

const logger = new Logger('SkillParser')

/**
 * 解析技能编排文件
 * @param projectRoot 项目根目录
 * @param skillName 技能名称（不含 .md 后缀）
 * @returns 技能编排
 */
export async function parseSkill(
  projectRoot: string,
  skillName: string
): Promise<SkillOrchestration> {
  const skillPath = path.join(projectRoot, SKILLS_DIR, `${skillName}.md`)
  logger.info(`Parsing skill: ${skillPath}`)

  try {
    // 检查文件是否存在
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill file not found: ${skillPath}`)
    }

    // 读取文件内容
    const content = await fs.promises.readFile(skillPath, 'utf-8')

    // 解析 YAML frontmatter 和步骤
    const skill = parseSkillContent(content, skillName)

    // 验证技能结构
    validateSkill(skill)

    logger.info(`Skill parsed successfully: ${skill.meta.name}`)
    return skill

  } catch (error) {
    logger.error(`Failed to parse skill: ${error}`)
    throw error
  }
}

/**
 * 解析技能内容
 * @param content 文件内容
 * @param skillName 技能名称
 * @returns 技能编排
 */
function parseSkillContent(content: string, skillName: string): SkillOrchestration {
  // 提取 YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    throw new Error('Skill file missing YAML frontmatter')
  }

  const frontmatter = frontmatterMatch[1]
  const body = content.slice(frontmatterMatch[0].length).trim()

  // 解析 frontmatter
  const meta = parseYamlSection(frontmatter) as Record<string, any>

  // 解析步骤
  const steps = parseSteps(body)

  // 构建技能编排
  const skill: SkillOrchestration = {
    meta: {
      name: meta.meta?.name || skillName,
      description: meta.meta?.description || '',
      version: meta.meta?.version || '1.0.0'
    },
    trigger: meta.trigger || {
      command: `/${skillName}`
    },
    flow: meta.flow || {
      entry: 'step_init'
    },
    steps
  }

  // 可选字段
  if (meta.output) {
    skill.output = meta.output as OutputDef
  }
  if (meta.sub_controllers) {
    skill.sub_controllers = meta.sub_controllers as string[]
  }
  if (meta.constraints) {
    skill.constraints = meta.constraints as Record<string, number | boolean>
  }

  return skill
}

/**
 * 解析 YAML 部分（简化版，不支持复杂嵌套）
 * @param yaml YAML 字符串
 * @returns 解析结果
 */
function parseYamlSection(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')
  let currentKey = ''
  let currentIndent = 0
  let currentObject: Record<string, unknown> = result
  const objectStack: Array<{ obj: Record<string, unknown>; indent: number }> = []

  for (const line of lines) {
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) {
      continue
    }

    // 计算缩进
    const indent = line.search(/\S/)
    const trimmed = line.trim()

    // 解析键值对
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, colonIndex).trim()
    let value: unknown = trimmed.slice(colonIndex + 1).trim()

    // 处理缩进变化
    if (indent < currentIndent) {
      // 回退到上层对象
      while (objectStack.length > 0 && objectStack[objectStack.length - 1].indent >= indent) {
        objectStack.pop()
      }
      currentObject = objectStack.length > 0 ? objectStack[objectStack.length - 1].obj : result
      currentIndent = objectStack.length > 0 ? objectStack[objectStack.length - 1].indent : 0
    }

    // 解析值
    if (value === '') {
      // 嵌套对象
      value = {}
      objectStack.push({ obj: currentObject, indent: currentIndent })
      currentObject[key] = value
      currentObject = value as Record<string, unknown>
      currentIndent = indent
    } else if (typeof value === 'string') {
      // 字符串值
      if (value.startsWith('[') && value.endsWith(']')) {
        // 数组
        value = value.slice(1, -1).split(',').map(s => s.trim())
      } else if (value === 'true') {
        value = true
      } else if (value === 'false') {
        value = false
      } else if (/^\d+$/.test(value)) {
        value = parseInt(value, 10)
      } else if (/^\d+\.\d+$/.test(value)) {
        value = parseFloat(value)
      }
      currentObject[key] = value
    }

    currentKey = key
  }

  return result
}

/**
 * 解析步骤定义
 * @param body 文档主体
 * @returns 步骤列表
 */
function parseSteps(body: string): StepDef[] {
  const steps: StepDef[] = []
  const lines = body.split('\n')

  let currentStep: StepDef | null = null
  let inStepsSection = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 检测 steps 部分
    if (trimmed === 'steps:' || trimmed.startsWith('steps:')) {
      inStepsSection = true
      continue
    }

    if (!inStepsSection) {
      continue
    }

    // 检测步骤 ID（以 - id: 开头）
    const idMatch = trimmed.match(/^- id:\s*(\S+)/)
    if (idMatch) {
      // 保存上一个步骤
      if (currentStep) {
        steps.push(currentStep)
      }
      currentStep = {
        id: idMatch[1],
        action: 'output' // 默认动作
      }
      continue
    }

    // 解析步骤属性
    if (currentStep) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/)
      if (propMatch) {
        const [, key, value] = propMatch
        setStepProperty(currentStep, key, value.trim())
      }
    }
  }

  // 保存最后一个步骤
  if (currentStep) {
    steps.push(currentStep)
  }

  return steps
}

/**
 * 设置步骤属性
 * @param step 步骤
 * @param key 属性键
 * @param value 属性值
 */
function setStepProperty(step: StepDef, key: string, value: string): void {
  // 移除引号
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }

  switch (key) {
    case 'action':
      step.action = value as StepDef['action']
      break
    case 'description':
      step.description = value
      break
    case 'target':
      step.target = value
      break
    case 'content':
      step.content = value
      break
    case 'output':
      step.output = value
      break
    case 'tool':
      step.tool = value
      break
    case 'agent':
      step.agent = value
      break
    case 'controller':
      step.controller = value
      break
    case 'next':
      step.next = value
      break
    case 'on_success':
      step.on_success = value
      break
    case 'on_fail':
      step.on_fail = value
      break
    case 'on_error':
      step.on_error = value
      break
    case 'on_no_match':
      step.on_no_match = value
      break
    case 'on_issues':
      step.on_issues = value
      break
    case 'on_pass':
      step.on_pass = value
      break
    case 'condition':
      step.condition = value
      break
    case 'message':
      step.message = value
      break
    case 'status':
      step.status = value
      break
    case 'min_rounds':
    case 'min_iterations':
      step.min_rounds = parseInt(value, 10)
      break
    case 'max_rounds':
    case 'max_iterations':
      step.max_rounds = parseInt(value, 10)
      break
    case 'from':
      step.from = value
      break
    default:
      // 处理其他属性（如 input, parameters, changes 等）
      if (value.startsWith('${') && value.endsWith('}')) {
        // 变量引用
        if (!step.input) step.input = {}
        step.input[key] = value
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // 数组
        const arr = value.slice(1, -1).split(',').map(s => s.trim())
        if (!step.input) step.input = {}
        step.input[key] = arr
      } else {
        if (!step.input) step.input = {}
        step.input[key] = value
      }
  }
}

/**
 * 验证技能结构
 * @param skill 技能
 */
function validateSkill(skill: SkillOrchestration): void {
  // 验证 meta
  if (!skill.meta.name) {
    throw new Error('Skill missing meta.name')
  }

  // 验证 trigger
  if (!skill.trigger.command) {
    throw new Error('Skill missing trigger.command')
  }

  // 验证 flow
  if (!skill.flow.entry) {
    throw new Error('Skill missing flow.entry')
  }

  // 验证 steps
  if (!skill.steps || skill.steps.length === 0) {
    throw new Error('Skill has no steps')
  }

  // 验证步骤 ID 唯一性
  const stepIds = new Set<string>()
  for (const step of skill.steps) {
    if (stepIds.has(step.id)) {
      throw new Error(`Duplicate step ID: ${step.id}`)
    }
    stepIds.add(step.id)
  }

  // 验证 entry 存在
  if (!stepIds.has(skill.flow.entry)) {
    throw new Error(`Entry step not found: ${skill.flow.entry}`)
  }
}

/**
 * 获取步骤
 * @param skill 技能
 * @param stepId 步骤 ID
 * @returns 步骤定义
 */
export function getStep(skill: SkillOrchestration, stepId: string): StepDef | undefined {
  return skill.steps.find(s => s.id === stepId)
}

/**
 * 获取所有步骤 ID
 * @param skill 技能
 * @returns 步骤 ID 列表
 */
export function getStepIds(skill: SkillOrchestration): string[] {
  return skill.steps.map(s => s.id)
}
