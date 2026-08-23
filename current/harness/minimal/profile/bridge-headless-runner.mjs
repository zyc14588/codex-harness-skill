import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'codex-bridge-headless-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets', 'tools', 'systemPrompt', 'llm']
export const Config = z.object({
  task: z.string().required(),
  presetId: z.string().required(),
})

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('agentPresets')
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || presets === undefined
    || tools === undefined || systemPrompt === undefined) return
  const taskId = process.env.CODEX_HARNESS_TASK_ID
  const requestStatePath = process.env.CODEX_HARNESS_REQUEST_STATE_MODULE
  const attemptModel = process.env.CODEX_HARNESS_ATTEMPT_MODEL
  const attemptReasoningEffort = process.env.CODEX_HARNESS_REASONING_EFFORT
  if (!taskId || !requestStatePath) {
    throw new Error('MINIMAL_TOOL_PLANE_COMPOSITION: Bridge request-state environment is unavailable')
  }
  if ((attemptModel !== 'deepseek-v4-flash' && attemptModel !== 'deepseek-v4-pro')
    || (attemptReasoningEffort !== 'off' && attemptReasoningEffort !== 'high')) {
    throw new Error('THINKING_POLICY_STATE: Bridge attempt reasoning policy is unavailable')
  }
  const requestState = await import(pathToFileURL(requestStatePath).href)

  const selection = {
    ...defaultModel.currentSelection(),
    model: attemptModel,
    reasoningEffort: attemptReasoningEffort,
  }
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, config.presetId)
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()
  const visibleTools = tools.schemas(agent).map(tool => tool.name)
  const assembled = await systemPrompt.assemble({ agent, scope: agent })
  const assembledTools = (assembled.tools ?? []).map(tool => tool.name)
  const requiredTools = [
    process.platform === 'win32' ? 'pwsh' : 'bash',
    'str_replace_editor',
    'capability_catalog',
    'capability_enable',
  ]
  await requestState.publishMinimalRunnerSnapshot({
    taskId,
    presetId: config.presetId,
    visibleTools,
    assembledTools,
    requiredTools,
  })
  const disposeThinkingPolicy = ctx.on('agent/request', async ({ agent: subject }, next) => {
    const resolved = await next()
    if (subject !== agent) return resolved
    return { ...resolved, reasoningEffort: attemptReasoningEffort }
  }, { global: true, prepend: true })
  const disposeRequestObserver = ctx.on('llm/stream', (options, next) => {
    if (String(options.sessionId ?? '') !== String(agent.id)) return next()
    return (async function* observeAdapterRequest() {
      await requestState.recordMinimalAdapterRequest({
        taskId,
        purpose: options.purpose,
        toolNames: (options.tools ?? []).map(tool => tool.name),
        reasoningEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      })
      yield* next()
    })()
  }, { global: true, prepend: true })
  const firstSeq = agent.session.seq
  try {
    await requestState.armMinimalPrimaryMutation({ taskId })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    disposeRequestObserver()
    disposeThinkingPolicy()
  }
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(`${outcome.text}\n`)
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('codex-bridge-headless-runner: appExit is unavailable')
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  void run(ctx, config, io).catch(error => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
