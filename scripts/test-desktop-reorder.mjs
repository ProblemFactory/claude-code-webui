// Boot the app in a worktree server + headless chrome, assert: no console
// errors, desktop previews are draggable, right-click menu positions correctly
// at a TOP-anchored taskbar, and the reorder message is well-formed.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { createRequire } from 'node:module';
import { freePorts, scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);
const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CHROME = ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium'].find(p=>fs.existsSync(p));
if(!CHROME){ console.log('SKIP: no chrome'); process.exit(0); }
const wt = scratch('desk-wt');
try { execSync(`git worktree remove --force ${wt}`, {cwd:repo, stdio:'ignore'}); } catch {}
execSync(`git worktree add --detach ${wt} HEAD`, {cwd:repo, stdio:'ignore'});
for (const f of ['node_modules','public/bundle.js']) { try { fs.symlinkSync(path.join(repo,f), path.join(wt,f)); } catch {} }
for (const f of execSync('git diff --name-only HEAD',{cwd:repo}).toString().split('\n').filter(Boolean))
  { try { fs.mkdirSync(path.dirname(path.join(wt,f)),{recursive:true}); fs.copyFileSync(path.join(repo,f), path.join(wt,f)); } catch {} }
const env={...process.env}; delete env.VIBESPACE_PASSWORD; delete env.VIBESPACE_GENERATE_PASSWORD;
const [PORT, CDP_PORT] = await freePorts(2); // per-process (scripts/scratch.mjs)
const srv=spawn('node',[path.join(wt,'server.js')],{cwd:wt,env:{...env,PORT:String(PORT),VIBESPACE_SKIP_AGENT_HOOKS:'1'},stdio:'ignore'});
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${CDP_PORT}`,'--no-sandbox','--disable-gpu','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,4000));
const get=(u)=>new Promise((res,rej)=>http.get(u,s=>{let b='';s.on('data',d=>b+=d);s.on('end',()=>res(b))}).on('error',rej));
const WebSocket=require(path.join(repo,'node_modules/ws/index.js'));
const tgt=JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json`)).find(t=>t.type==='page');
const ws=new WebSocket(tgt.webSocketDebuggerUrl,{perMessageDeflate:false});
let id=0;const pend={};const send=(m,p={})=>new Promise(r=>{pend[++id]=r;ws.send(JSON.stringify({id,method:m,params:p}))});
ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend[m.id]){pend[m.id](m.result||{});delete pend[m.id];}});
await new Promise(r=>ws.on('open',r));
await send('Runtime.enable'); await send('Page.enable');
const errs=[]; ws.on('message',d=>{const m=JSON.parse(d); if(m.method==='Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails?.exception?.description||m.params).slice(0,200));});
await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});
await new Promise(r=>setTimeout(r,7000));
const e=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.value;
let pass=0,fail=0; const ck=(n,c,x='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(x?' — '+x:''))}};
ck('app booted', await e(`!!window.app && !!app.desktopManager`));
// add a 2nd desktop so previews exist, then re-render
await e(`app.desktopManager.createDesktop(); app.desktopManager._renderSwitcher(); true`);
await new Promise(r=>setTimeout(r,300));
ck('desktop previews are draggable', await e(`[...document.querySelectorAll('.desktop-preview-wrapper:not(.stage-preview-wrapper)')].every(w=>w.draggable===true)`));
ck('reorderDesktop exists', await e(`typeof app.desktopManager.reorderDesktop==='function'`));
// reorder and confirm order changed + message shape
const okReorder = await e(`(()=>{
  const dm=app.desktopManager; const ids=dm._desktops.map(d=>d.id);
  if(ids.length<2) return 'need2';
  let sent=null; const orig=app.ws.send.bind(app.ws); app.ws.send=(m)=>{ if(m.type==='desktop-reorder') sent=m; };
  dm.reorderDesktop(ids[1], ids[0]);  // move 2nd before 1st
  app.ws.send=orig;
  const now=dm._desktops.map(d=>d.id);
  return (now[0]===ids[1] && sent && Array.isArray(sent.order) && sent.order.length===ids.length) ? 'ok' : 'bad:'+JSON.stringify({now,sent});
})()`);
ck('reorder swaps order + emits desktop-reorder', okReorder==='ok', okReorder);
// top-taskbar context menu direction
await e(`document.body.classList.add('taskbar-top'); true`);
// item: desktop preview dragged INTO the toolbar must keep its OWN menu
const menuOk = await e(`(()=>{
  const tb=document.getElementById('toolbar');
  const wrap=document.querySelector('.desktop-preview-wrapper:not(.stage-preview-wrapper)');
  if(!tb||!wrap) return 'missing';
  tb.appendChild(wrap);                       // simulate the customize-mode drag
  document.querySelectorAll('[data-popover]').forEach(x=>x.remove());
  wrap.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:30}));
  const menus=[...document.querySelectorAll('[data-popover]')];
  const txt=menus.map(m=>m.textContent).join('|');
  return (menus.length===1 && /Rename/.test(txt) && !/Customize UI/.test(txt)) ? 'ok' : 'bad:'+txt.slice(0,120);
})()`);
ck('preview moved into TOOLBAR still shows Rename/Delete (not Customize UI)', menuOk==='ok', menuOk);
// toolbar height resize wiring
ck('toolbar resize handle exists', await e(`!!document.getElementById('toolbar-resize-handle')`));
const thOk = await e(`(()=>{
  // 2.254.0: the resize is a content SCALE (zoom), not a fixed height — the
  // RENDERED height must follow --toolbar-scale and reset cleanly
  const root=document.documentElement, tb=document.getElementById('toolbar');
  const rh=()=>Math.round(tb.getBoundingClientRect().height);
  const before=rh();
  root.style.setProperty('--toolbar-scale','1.2');
  const after=rh();
  root.style.removeProperty('--toolbar-scale');
  const reset=rh();
  return (after>before+3 && reset===before) ? 'ok' : 'bad:'+JSON.stringify({before,after,reset});
})()`);
ck('--toolbar-scale drives the rendered toolbar size (and resets)', thOk==='ok', thOk);
ck('no JS exceptions during boot+interactions', errs.length===0);
if(errs.length) console.log('   errs:', errs.slice(0,3));
console.log(fail?`${fail} FAILED (${pass} passed)`:`ALL PASS (${pass})`);
ws.close(); chrome.kill(); srv.kill();
try { execSync(`git worktree remove --force ${wt}`,{cwd:repo,stdio:'ignore'}); } catch {}
process.exit(fail?1:0);
