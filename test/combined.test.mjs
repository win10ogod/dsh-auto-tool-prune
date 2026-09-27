import test from 'node:test'
import assert from 'node:assert/strict'
import * as continuation from 'dsh-turn-continuation'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { fixture, text, tool, longOutput } from './fixture.mjs'

test('automatic pruning and output-limit continuation complete one DSH turn together', async t => {
  const f = await fixture(t, {
    companion: continuation,
    script: [
      { blocks: [tool('before-limit')], reason: { kind: 'tool-calls' } },
      { blocks: [text('partial response')], reason: { kind: 'max-tokens' } },
      { blocks: [tool('after-limit')], reason: { kind: 'tool-calls' } },
      { blocks: [text('task completed')] }
    ]
  })
  assert.equal(f.requests.length, 4)
  assert.deepEqual(f.executions, ['before-limit', 'after-limit'])
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 2)
  const originals = f.events.filter(e => e.type === 'tool/result' && e.surfaceOp === 'append')
  assert.ok(originals.every(e => e.data.message.content[0].text === longOutput))
  const finalTools = f.requests[3].messages.filter(m => m.role === 'tool')
  assert.equal(finalTools.length, 2)
  assert.ok(finalTools.every(m => m.content[0].text.includes(PRUNE_MARKER)))
  assert.ok(f.requests.every(r => r.maxTokens === 8192 && r.provider === 'fixture' && r.model === 'fixture-model'))
  assert.equal(f.events.filter(e => e.type === 'assistant/message').at(-1).data.message.content[0].text, 'task completed')
})

test('pruning also composes with continuation after premature normal stop', async t => {
  const plan=(id,status)=>({type:'tool-call',id,name:'todo_write',arguments:JSON.stringify({todos:[{content:'Verify and deliver',status}]})})
  const f = await fixture(t, {
    companion: continuation,
    setup: ctx => ctx.plugin(Todo, {allowParallelInProgress:true}),
    script: [
      {blocks:[plan('plan','in_progress')],reason:{kind:'tool-calls'}},
      {blocks:[tool('work')],reason:{kind:'tool-calls'}},
      {blocks:[text('Now I will finalize and deliver.')]},
      {blocks:[plan('done','completed')],reason:{kind:'tool-calls'}},
      {blocks:[text('Verified result delivered.')]}
    ]
  })
  assert.equal(f.requests.length,5)
  assert.equal(f.events.filter(e=>e.type==='turn/start').length,1)
  assert.equal(f.events.filter(e=>e.type==='turn/end').length,1)
  assert.equal(f.events.filter(e=>e.type==='compaction/prune').length,1)
  assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.source.cause==='unfinished-todos').length,1)
  assert.equal(f.events.filter(e=>e.type==='turn/end')[0].data.reason.kind,'completed')
})
