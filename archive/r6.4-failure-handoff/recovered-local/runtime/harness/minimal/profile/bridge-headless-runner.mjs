import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'codex-bridge-headless-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']
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
  if (agents === undefined || defaultModel === undefined || sessions === undefined || presets === undefined) return

  const selection = defaultModel.currentSelection()
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
  const visibleTools = ctx.tools.schemas(agent).map(tool => tool.name)
  const requiredTools = [
    process.platform === 'win32' ? 'pwsh' : 'bash',
    'str_replace_editor',
    'mcp__bridge__capability_catalog',
    'mcp__bridge__capability_enable',
  ]
  const missingTools = requiredTools.filter(name => !visibleTools.includes(name))
  if (missingTools.length > 0) {
    throw new Error(`MINIMAL_TOOL_PLANE: missing model-visible tools: ${missingTools.join(', ')}; visible=${visibleTools.join(', ')}`)
  }
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
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
