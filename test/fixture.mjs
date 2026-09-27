import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as pruning from '../lib/index.js'

export const text = value => ({ type: 'text', text: value })
export const tool = id => ({ type: 'tool-call', id: ToolCallId(id), name: 'fixture_tool', arguments: '{}' })
export const longOutput = 'BEGIN:' + 'long tool output;'.repeat(1000) + ':END'

export async function fixture(t, options = {}) {
  const ctx = new Context()
  for (const plugin of [Sessions, Projections, Agents, Llm, Prompt, Tools, TokenMeter]) await ctx.plugin(plugin)
  await ctx.plugin(Loop, {})
  await ctx.plugin(options.pruningPlugin || pruning, options.config || {})
  if (options.companion) await ctx.plugin(options.companion)
  const requests = [], events = [], executions = []
  ctx.on('session/event', (_session, event) => events.push(event))
  const script = options.script || [
    { blocks: [{ ...tool('one'), name: options.toolName || 'fixture_tool' }], reason: { kind: 'tool-calls' } },
    { blocks: [text('done')] }
  ]
  ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
    async *stream(request) {
      const index = requests.push(request) - 1
      if (index >= script.length) throw new Error('Unexpected extra model request')
      const entry = script[index]
      for (const [index, block] of (entry.blocks || []).entries()) yield { type: 'block-end', index, block }
      yield { type: 'finish', reason: entry.reason || { kind: 'stop' } }
    }
  }())
  ctx.tools.register({
    name: options.toolName || 'fixture_tool', description: 'Controlled tool fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: options.render || ((_args, value) => [text(value.text)]) },
    async execute(_args, execution) {
      executions.push(execution.callId)
      return { text: options.output ?? longOutput }
    }
  })
  if (options.setup) await options.setup(ctx)
  const handle = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'fixture-model', maxTokens: 8192 } })
  t.after(async () => { await handle.dispose(); await ctx.fiber.dispose() })
  handle.agent.followup(createUserMessage({ content: [text('Use the tool and finish the task')], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  return { ctx, handle, requests, events, executions }
}
