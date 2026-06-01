/**
 * Controller Engine Types
 * 类型定义文件
 * @module main/controller/types
 */

// ============ 静态配置类型 ============

/**
 * 工具参数定义
 */
export interface ToolParameterDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  enum?: string[]
  description?: string
  default?: unknown
  required?: boolean
}

/**
 * 工具效果定义
 */
export interface ToolEffects {
  updateTaskState?: boolean
  updateReviewCount?: boolean
  triggerValidator?: string
  incrementReviewCount?: boolean
  blockOnIssues?: boolean
}

/**
 * 工具定义
 */
export interface ToolDef {
  description: string
  parameters: Record<string, ToolParameterDef>
  effects?: ToolEffects
}

/**
 * 验证器规则
 */
export type ValidatorRule =
  | 'no_empty_function_bodies'
  | 'no_todo_placeholders'
  | 'no_mock_data_in_prod'
  | 'no_empty_logic_blocks'
  | 'no_hardcoded_credentials'
  | 'no_debug_code'

/**
 * 验证器失败处理方式
 */
export type ValidatorOnFail = 'block_and_report' | 'require_fix' | 'warn_only'

/**
 * 验证器定义
 */
export interface ValidatorDef {
  trigger: string
  rules: ValidatorRule[]
  onFail: ValidatorOnFail
}

/**
 * 约束定义
 */
export interface ConstraintsDef {
  spec_review_min_rounds: number
  plan_review_min_rounds: number
  code_review_min_rounds: number
  code_review_max_rounds: number
  require_tools_for_state_change: boolean
  timeout_per_task_minutes: number
}

/**
 * 状态机状态定义
 */
export interface StateMachineDef {
  phase_states: string[]
  task_states: string[]
  flow_states: string[]
}

/**
 * 静态配置
 */
export interface StaticConfig {
  version: string
  tools: Record<string, ToolDef>
  validators: Record<string, ValidatorDef>
  constraints: ConstraintsDef
  stateMachine: StateMachineDef
}

// ============ 技能编排类型 ============

/**
 * 步骤动作类型
 */
export type StepAction =
  | 'check_state'
  | 'load_state'
  | 'call_agent'
  | 'call_tool'
  | 'call_controller'
  | 'update_state'
  | 'write_file'
  | 'read_file'
  | 'select_next'
  | 'loop'
  | 'review_loop'
  | 'validation_pipeline'
  | 'condition'
  | 'switch'
  | 'output'
  | 'send_message'
  | 'apply_fixes'
  | 'rollback_state'
  | 'return_to_caller'
  | 'interactive_loop'
  | 'generate_document'

/**
 * 步骤条件
 */
export interface StepCondition {
  if: string
  then: string
  else?: string
}

/**
 * 工具调用参数
 */
export interface ToolCallParams {
  tool: string
  parameters: Record<string, unknown>
}

/**
 * Agent 调用参数
 */
export interface AgentCallParams {
  agent: string
  input: Record<string, unknown>
  timeout?: string
}

/**
 * 循环参数
 */
export interface LoopParams {
  min_iterations?: number
  max_iterations?: number
  exit_condition?: string
  steps: StepDef[]
}

/**
 * 验证管道参数
 */
export interface ValidationPipelineParams {
  steps: Array<{
    name: string
    validator?: string
    command?: string
    optional?: boolean
  }>
}

/**
 * 选择参数
 */
export interface SelectParams {
  from: string
  condition: string
  output?: string
  on_no_match?: string
}

/**
 * 步骤定义
 */
export interface StepDef {
  id: string
  action: StepAction
  description?: string
  expect?: Record<string, string>
  target?: string
  content?: string
  output?: string
  input?: Record<string, unknown>
  parameters?: Record<string, unknown>
  tool?: string
  agent?: string
  controller?: string
  changes?: Record<string, unknown>
  next?: string
  on_success?: string
  on_fail?: string
  on_error?: string
  on_no_match?: string
  on_issues?: string
  on_pass?: string
  condition?: string
  steps?: StepDef[] | LoopParams | ValidationPipelineParams
  cases?: Array<{
    when: string
    then: string
  }>
  message?: string
  status?: string
  min_rounds?: number
  max_rounds?: number
  from?: string
}

/**
 * 触发条件
 */
export interface TriggerDef {
  command: string
  condition?: string
  precondition_error?: string
  or?: string
}

/**
 * 流程定义
 */
export interface FlowDef {
  entry: string
  exit?: string
}

/**
 * 输出定义
 */
export interface OutputDef {
  files?: string[]
  state?: Record<string, string>
  report?: string
}

/**
 * 元数据
 */
export interface SkillMeta {
  name: string
  description: string
  version: string
}

/**
 * 技能编排
 */
export interface SkillOrchestration {
  meta: SkillMeta
  trigger: TriggerDef
  flow: FlowDef
  steps: StepDef[]
  output?: OutputDef
  sub_controllers?: string[]
  constraints?: Record<string, number | boolean>
}

// ============ 状态类型 ============

/**
 * 流程状态
 */
export type FlowState =
  | 'idle'
  | 'spec_in_progress'
  | 'spec_completed'
  | 'plan_in_progress'
  | 'plan_completed'
  | 'dev_in_progress'
  | 'dev_completed'
  | 'review_in_progress'
  | 'review_completed'
  | 'error'
  | 'aborted'

/**
 * 任务状态
 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'blocked'

/**
 * Phase 状态
 */
export type PhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'in_test'
  | 'completed'
  | 'failed'

/**
 * 审查状态
 */
export type ReviewStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'needs_fix'
  | 'max_exceeded'

/**
 * 任务定义
 */
export interface Task {
  id: string
  name: string
  spec: string
  status: TaskStatus
  dependencies: string[]
  acceptance_criteria?: string[]
  startedAt?: string
  completedAt?: string
  error?: string
  modifiedFiles?: string[]
  summary?: string
}

/**
 * Phase 定义
 */
export interface Phase {
  id: string
  name: string
  status: PhaseStatus
  tasks: string[]
  dependencies: string[]
  startedAt?: string
  completedAt?: string
  review?: {
    count: number
    maxCount: number
    status: ReviewStatus
    issues?: Issue[]
  }
}

/**
 * 问题定义
 */
export interface Issue {
  severity: 'critical' | 'major' | 'minor'
  location: string
  description: string
  suggestion?: string
}

/**
 * 控制器状态
 */
export interface ControllerState {
  flow: FlowState
  currentPhase?: string
  currentTask?: string
  phases: Phase[]
  tasks: Task[]
  reviewCount: number
  errors: Array<{
    timestamp: string
    message: string
    phaseId?: string
    taskId?: string
  }>
  startedAt?: string
  updatedAt?: string
}

// ============ 执行结果类型 ============

/**
 * Agent 执行结果
 */
export interface AgentResult {
  success: boolean
  status: 'done' | 'failed' | 'blocked'
  modifiedFiles: string[]
  summary: string
  issues?: Issue[]
  error?: string
}

/**
 * 工具调用结果
 */
export interface ToolResult {
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

/**
 * 步骤执行结果
 */
export interface StepResult {
  success: boolean
  output?: Record<string, unknown>
  toolCalls?: ToolCallParams[]
  data?: unknown
  error?: string
  nextStep?: string
}

/**
 * 验证结果
 */
export interface ValidationResult {
  pass: boolean
  issues: Issue[]
}

/**
 * 文档审核结果
 */
export interface DocReviewResult {
  verdict: 'pass' | 'needs_revision'
  issues: Issue[]
  summary: string
}

// ============ 工具调用类型 ============

/**
 * 工具调用
 */
export interface ToolCall {
  name: string
  parameters: Record<string, unknown>
}

/**
 * task_complete 工具参数
 */
export interface TaskCompleteParams {
  status: 'done' | 'failed' | 'blocked'
  modifiedFiles: string[]
  summary: string
  issues?: Issue[]
}

/**
 * review_complete 工具参数
 */
export interface ReviewCompleteParams {
  issues: Issue[]
  verdict: 'pass' | 'needs_fix'
}

/**
 * phase_complete 工具参数
 */
export interface PhaseCompleteParams {
  phaseId: string
  status: 'completed' | 'failed'
}

/**
 * request_input 工具参数
 */
export interface RequestInputParams {
  question: string
  type: 'text' | 'choice' | 'confirm'
  options?: Array<{
    value: string
    label: string
  }>
}

// ============ 配置文件路径 ============

export const CONTROLLER_CONFIG_PATH = '.claude/controller/config.json'
export const SKILLS_DIR = '.claude/skills'
export const AGENTS_DIR = '.claude/agents'
export const STATE_FILE_PATH = '.superspec/state.json'
export const PRODUCT_SPEC_PATH = '.superspec/Product-Spec.md'
export const DEV_PLAN_PATH = '.superspec/DEV-PLAN.md'