// Run after npm run build:node. Uses isolated synthetic history, no model requests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiRpcAdapter } from '../dist/runtime/pi-rpc-adapter.js';
import { applyToolEvent } from '../dist/renderer/activity.js';

const root = await mkdtemp(join(tmpdir(), 'pideck-load-perf-'));
try {
  const sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  const header = (id) => JSON.stringify({type:'session',version:3,id,timestamp:new Date().toISOString(),cwd:root});
  for (let i = 0; i < 1000; i++) await writeFile(join(sessionDir, `${String(i).padStart(4,'0')}.jsonl`), header(`other-${i}`)+'\n');
  const sessionFile = join(sessionDir, 'zz-target.jsonl');
  await writeFile(sessionFile, header('target')+'\n'+JSON.stringify({type:'message',id:'msg',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'Saved history',timestamp:Date.now()}})+'\n');
  const samples = {scan:[],direct:[]};
  // Alternate order to reduce warm-cache bias.
  for (let round = 0; round < 4; round++) for (const mode of round % 2 ? ['direct','scan'] : ['scan','direct']) {
    const adapter = new PiRpcAdapter({harnessSessionId:'perf',piSessionId:'target',projectDir:root,sessionDir,
      piPath:process.execPath,piExecutableArgs:[resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')],
      piEnv:{PI_CODING_AGENT_DIR:join(root,'agent')},...(mode==='direct'?{piSessionFile:sessionFile}:{})});
    try {
      const start = performance.now();
      const state = await adapter.start();
      const messages = await adapter.getMessages();
      samples[mode].push(Math.round(performance.now()-start));
      assert.equal(state.sessionId,'target');
      assert.equal(messages.at(-1).content,'Saved history');
    } finally { await adapter.dispose(); }
  }
  console.log('SESSION_LOAD_MS', JSON.stringify(samples));
  const timings = {};
  let baseline;
  for (const indexed of [false,true]) {
    const items = [], indexes = indexed ? new Map() : undefined;
    const start = performance.now();
    for (let i = 0; i < 20000; i++) {
      applyToolEvent(items,{type:'tool_execution_start',toolCallId:String(i),toolName:'read',args:{path:`file-${i}`}},i,indexes);
      applyToolEvent(items,{type:'tool_execution_end',toolCallId:String(i),result:'Saved output'},i,indexes);
    }
    timings[indexed?'indexed':'scan'] = Math.round(performance.now()-start);
    if (!indexed) baseline = items;
    else assert.deepEqual(items,baseline);
  }
  console.log('HISTORY_20000_TOOLS_MS',JSON.stringify(timings));
} finally { await rm(root,{recursive:true,force:true}); }
