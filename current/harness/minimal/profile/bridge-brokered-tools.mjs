import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'codex-bridge-brokered-tools'
export const inject = ['tools']
export const Config = z.object({})

const progressiveDefinitions = {
  repo_read_file: {
    description: 'Read a bounded line range from a regular file in the task worktree.',
    parameters: {
      file_path: { type: 'string', required: true },
      start_line: { type: 'integer' },
      end_line: { type: 'integer' },
      offset_bytes: { type: 'integer', description: 'UTF-8 byte offset within the selected line range; use truncation.nextOffsetBytes to continue.' },
      max_bytes: { type: 'integer', description: 'Maximum returned text bytes (256-49152).' },
    },
  },
  repo_search: {
    description: 'Search tracked repository text with bounded git grep output.',
    parameters: {
      pattern: { type: 'string', required: true },
      paths: { type: 'array', items: { type: 'string' } },
    },
  },
  run_verification: {
    description: 'Run one exact verification command frozen by Codex, selected by index.',
    parameters: {
      command_index: { type: 'integer', required: true },
      timeout_seconds: { type: 'integer' },
    },
  },
  git_status: {
    description: 'Inspect read-only porcelain Git status in the task worktree.',
    parameters: {},
  },
  git_diff: {
    description: 'Inspect a bounded working-tree diff.',
    parameters: {
      file_path: { type: 'string' },
      stat_only: { type: 'boolean' },
    },
  },
}

function settings() {
  const baseUrl = process.env.CODEX_HARNESS_TOOL_URL?.replace(/\/+$/, '')
  const token = process.env.CODEX_HARNESS_TOOL_TOKEN
  const taskId = process.env.CODEX_HARNESS_TASK_ID
  if (!baseUrl || !/^[a-f0-9]{64}$/.test(token || '') || !/^[A-Za-z0-9._-]{1,160}$/.test(taskId || '')) {
    throw new Error('MINIMAL_TOOL_PLANE_COMPOSITION: brokered tool capability is unavailable')
  }
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.search || url.hash) {
    throw new Error('MINIMAL_TOOL_PLANE_COMPOSITION: brokered tools require isolated loopback relay')
  }
  return { baseUrl, token, taskId }
}

async function invoke(tool, args, signal) {
  const { baseUrl, token, taskId } = settings()
  const timeout = AbortSignal.timeout(7_300_000)
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, tool, arguments: args }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { throw new Error(`brokered tool returned non-JSON HTTP ${response.status}`) }
  if (!response.ok) throw new Error(String(value?.error || `brokered tool HTTP ${response.status}`))
  return value.result
}

function rendered(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function definition(name, description, parameters, execute) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) { return rendered(await execute(args, exec?.signal)) },
  })
}

export function apply(ctx) {
  settings()
  const disposers = new Map()
  const register = (name, description, parameters, execute = (args, signal) => invoke(name, args, signal)) => {
    if (disposers.has(name)) return
    disposers.set(name, ctx.tools.register(definition(name, description, parameters, execute)))
  }

  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  register(shell, 'Run one bounded command in a separate Bridge-owned Bubblewrap sibling. The command has no network, Provider, broker-socket, host-state, or parent-/proc capability.', {
    command: { type: 'string', required: true },
    timeout_seconds: { type: 'integer' },
  })
  register('str_replace_editor', 'View, create, replace, or insert text through the separate Bridge tool broker. Mutations are restricted to the frozen write lease.', {
    command: { type: 'string', required: true, enum: ['view', 'create', 'str_replace', 'insert'] },
    path: { type: 'string', required: true },
    file_text: { type: 'string' },
    insert_line: { type: 'integer' },
    new_str: { type: 'string' },
    old_str: { type: 'string' },
    view_range: { type: 'array', items: { type: 'integer' } },
    offset_bytes: { type: 'integer', description: 'UTF-8 byte offset within the selected view; use truncation.nextOffsetBytes to continue.' },
    max_bytes: { type: 'integer', description: 'Maximum returned text bytes (256-49152).' },
  })
  register('capability_catalog', 'List progressive capabilities authorized by the frozen leaf contract.', {}, (args, signal) => invoke('capability_catalog', args, signal))
  register('capability_enable', 'Enable one progressive capability already authorized by the frozen leaf contract.', {
    capability: { type: 'string', required: true, enum: ['repository_read', 'verification', 'git_inspect'] },
    reason: { type: 'string', required: true },
  }, async (args, signal) => {
    const result = await invoke('capability_enable', args, signal)
    for (const name of result?.tools || []) {
      const selected = progressiveDefinitions[name]
      if (selected) register(name, selected.description, selected.parameters)
    }
    return result
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
  }, 'brokered tool registry')
}
