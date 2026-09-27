import test from 'node:test'
import assert from 'node:assert/strict'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import { fixture, text, tool, longOutput } from './fixture.mjs'

test('large JSON is passed through without changing syntax, values, or numeric lexemes', async t => {
  const output = '{"counter":9007199254740993,"status":"ok","body":' + JSON.stringify('x'.repeat(18000)) + ',"next":false}'
  const f = await fixture(t, { output })
  const actual = f.requests[1].messages.find(m => m.role === 'tool').content[0].text
  assert.equal(actual, output)
  assert.doesNotThrow(() => JSON.parse(actual))
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
})

test('JSON split over text blocks is not cut', async t => {
  const parts = [text('{"data":"' + 'x'.repeat(9000)), text('y'.repeat(9000) + '","ok":true}')]
  const f = await fixture(t, { render: () => parts })
  assert.deepEqual(f.requests[1].messages.find(m => m.role === 'tool').content, parts)
})

for (const [name, output] of [
  ['prefixed JSON', 'Process exited 0\nOutput:\n' + JSON.stringify({data:'x'.repeat(17000),status:'ok'})],
  ['JSON Lines', Array.from({length:1000},(_,i)=>JSON.stringify({row:i,value:'unchanged'})).join('\n')],
  ['fenced JSON', '```json\n'+JSON.stringify({data:'x'.repeat(17000)})+'\n```'],
  ['incomplete JSON', '{"unfinished":"'+'x'.repeat(17000)],
  ['skill markup', '<skill_content name="fixture">'+longOutput+'</skill_content>'],
  ['file wrapper', '<path>fixture.json</path>\n'+longOutput]
]) test(`${name} is preserved`, async t => {
  const f = await fixture(t, { output })
  assert.equal(f.requests[1].messages.find(m => m.role === 'tool').content[0].text, output)
  assert.equal(f.events.filter(e => e.type === 'compaction/prune').length, 0)
})

for(const toolName of ['skill','read','read_file','readFile']) test(`${toolName} output preserves middle instructions and file content`, async t => {
  const output='intro '.repeat(1000)+'MANDATORY MIDDLE CONTRACT\n'+'ending '.repeat(1000)
  const f=await fixture(t,{toolName,output})
  assert.equal(f.requests[1].messages.find(m=>m.role==='tool').content[0].text,output)
})

test('custom protected tool names are respected',async t=>{
  const f=await fixture(t,{config:{protectedTools:['fixture_tool']}})
  assert.equal(f.requests[1].messages.find(m=>m.role==='tool').content[0].text,longOutput)
})

test('observed todo schema error is validated without rewriting model arguments',async t=>{
  const argumentsText=JSON.stringify({todos:[{content:'Build artifact',activeForm:'Building artifact'}]})
  const f=await fixture(t,{setup:ctx=>ctx.plugin(Todo,{allowParallelInProgress:true}),script:[
    {blocks:[tool('large-output')],reason:{kind:'tool-calls'}},
    {blocks:[{type:'tool-call',id:'invalid-plan',name:'todo_write',arguments:argumentsText}],reason:{kind:'tool-calls'}},
    {blocks:[text('validation observed')]}
  ]})
  const call=f.events.find(e=>e.type==='tool/call'&&e.data.name==='todo_write')
  assert.equal(call.data.arguments,argumentsText)
  const result=f.events.find(e=>e.type==='tool/result'&&e.data.message.toolCallId==='invalid-plan')
  assert.equal(result.data.error.code,'INVALID_ARGS')
  assert.match(result.data.message.content[0].text,/status/)
  assert.match(result.data.message.content[0].text,/activeForm/)
  assert.ok(!f.events.some(e=>e.type==='todo/write'))
  const before=f.requests[0].tools.find(t=>t.name==='todo_write')
  const after=f.requests[2].tools.find(t=>t.name==='todo_write')
  assert.deepEqual(after,before)
})
