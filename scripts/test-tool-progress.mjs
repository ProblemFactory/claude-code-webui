// tool_progress must never be treated as a subagent message (2.227.7).
// Real record shape captured from a live stream buffer.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server.js', import.meta.url));
let failed = 0; const check=(n,c,e)=>{ if(c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e?' — '+e:''}`);} };

// 1. The dispatch contract: a tool_progress record carries parent_tool_use_id
//    (the SAME field subagent messages use) — the branch order in server.js
//    must check the TYPE first.
const rec = { type:'tool_progress', tool_use_id:'toolu_X-heartbeat-0', tool_name:'Bash',
  parent_tool_use_id:'toolu_X', elapsed_time_seconds:30, heartbeat:true, session_id:'s', uuid:'u' };
const src = fs.readFileSync('src/server/stdout/claude-stream-json.js', 'utf8'); // S5: the claude stream-json consumer module
const iProgress = src.indexOf("msg.type === 'tool_progress'");
const iSub = src.indexOf("} else if (msg.parent_tool_use_id || msg.isSidechain) {");
check('server checks tool_progress BEFORE the subagent branch', iProgress > 0 && iSub > iProgress, `${iProgress}/${iSub}`);
check('subagent branch is an else-if (cannot also fire)', iSub > 0);
check('tool_progress is broadcast on its own channel', /type: 'tool-progress'/.test(src));
check('elapsed seconds are forwarded', /elapsedSeconds: msg\.elapsed_time_seconds/.test(src));

// 2. The client must not paint the agent status line for it.
const cv = fs.readFileSync('src/lib/chat-view.js', 'utf8');
check('client has a dedicated _onToolProgress', /_onToolProgress\(/.test(cv));
check('tool-progress routes away from _onSubagentMessage', /'tool-progress'[\s\S]{0,80}_onToolProgress/.test(cv));
check('progress line yields to a real agent status line', /chat-agent-live-status'\)\) return;/.test(cv));
check('progress line has no View Log / message count', !/_onToolProgress[\s\S]{0,1200}chat-agent-view-btn/.test(cv));
console.log(failed===0?'ALL PASS':`${failed} FAILED`); process.exit(failed?1:0);
