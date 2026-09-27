import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import NativePruner, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { fixture, longOutput, text, tool } from './fixture.mjs'

test('oversized tool output is pruned before the next real DSH model request', async t => {
  const f = await fixture(t)
  const original = f.events.find(e => e.type === 'tool/result' && e.surfaceOp === 'append')
  const replacement = f.events.find(e => e.type === 'tool/result' && e.surfaceOp?.op === 'replace')
  const received = f.requests[1].messages.find(m => m.role === 'tool')
  assert.equal(original.data.message.content[0].text, longOutput)
  assert.equal(received.content[0].text, longOutput.slice(0, 4096) + PRUNE_MARKER + longOutput.slice(-1024))
  assert.equal(received.toolCallId, original.data.message.toolCallId)
  assert.equal(received.id, original.data.message.id)
  assert.deepEqual(replacement.sourceEventSeqs, [original.seq])
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every(request => request.maxTokens === 8192))
})

test('short results and user instructions remain intact', async t => {
  const f = await fixture(t, { output: 'short result' })
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
  assert.equal(f.requests[1].messages.find(m => m.role === 'tool').content[0].text, 'short result')
  assert.equal(f.requests[1].messages.find(m => m.role === 'user').content[0].text, 'Use the tool and finish the task')
})

test('already pruned results are not rewritten on later turns', async t => {
  const f = await fixture(t, { script: [
    { blocks: [tool('one')], reason: { kind: 'tool-calls' } },
    { blocks: [text('done')] }, { blocks: [text('next done')] }
  ] })
  f.handle.agent.followup(createUserMessage({ content: [text('Next task')], source: { kind: 'user' } }))
  await f.handle.agent.whenIdle()
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 1)
  assert.equal(f.requests.length, 3)
})

test('pruning failures keep the conversation running with the original result', async t => {
  const f = await fixture(t, { setup(ctx) {
    ctx.tokenMeter.estimateMessage = () => { throw new Error('fixture meter failure') }
  } })
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].messages.find(m => m.role === 'tool').content[0].text, longOutput)
  assert.equal(f.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed')
})

test('disabled pruning leaves oversized results unchanged', async t => {
  const f = await fixture(t, { config: { enabled: false } })
  assert.equal(f.requests[1].messages.find(m => m.role === 'tool').content[0].text, longOutput)
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
})

test('rejected steps do not run pruning', async t => {
  const f = await fixture(t, { setup(ctx) {
    ctx.on('agent/pre-step', async ({ step }, next) => step === 2 ? { kind: 'reject' } : next())
  } })
  assert.equal(f.requests.length, 1)
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
})

test('the existing native compaction pruner keeps its service and configuration', async t => {
  const f = await fixture(t, { setup: async ctx => {
    await ctx.plugin(NativePruner, { thresholdChars: 16000 })
  } })
  assert.equal(f.ctx.toolResultPruner.config.thresholdChars, 16000)
  assert.equal(f.ctx.toolResultPruner.pruneContent([text('x'.repeat(10000))]), null)
  assert.ok(f.requests[1].messages.find(m => m.role === 'tool').content[0].text.length < 8192)
})

test('this plugin alone does not auto-continue an output-limited turn', async t => {
  const f = await fixture(t, { script: [{ blocks: [text('partial')], reason: { kind: 'max-tokens' } }] })
  assert.equal(f.requests.length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'max-tokens')
})

test('user cancellation at a request boundary remains authoritative', async t => {
  const f = await fixture(t, { setup(ctx) {
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      const decision = await next()
      if (step === 2) agent.cancel({ kind: 'user' })
      return decision
    })
  } })
  assert.equal(f.requests.length, 1)
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
  assert.equal(f.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted')
})

test('configured character budgets preserve Unicode code points', async t => {
  const f = await fixture(t, { config: { thresholdChars: 1000, headChars: 100, tailChars: 100 }, output: '😀'.repeat(1500) })
  assert.equal(f.requests[1].messages.find(m => m.role === 'tool').content[0].text, '😀'.repeat(100) + PRUNE_MARKER + '😀'.repeat(100))
})
