#!/usr/bin/env node
// MANUAL live check for the OpenCode serve-mode store (S9, B-03f2): runs the
// REAL locator/keeper against the installed `opencode` (the record lives in a
// temp dir so the repo's data/ is never touched; the serve reads the user's
// own ~/.local/share/opencode store), prints the discovery entries (with the
// first-user-message names once they land), dumps one conversation as
// 'acp-events' records + the normalizer's view, optionally forks.
//   node scripts/dev/opencode-serve-live.mjs [--session <id>] [--fork <id>] [--keep]
// --fork creates a REAL session copy in the user's store ("<title> (fork #n)").
// --keep leaves the serve running (record printed) instead of stopping it.
// Never in the gate: it needs the real CLI and touches the real store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const serve = require(path.join(REPO, 'src/opencode-serve.js'));
const { AcpMessageManager } = require(path.join(REPO, 'src/acp-message-manager.js'));
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oc-live-'));
const env = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^VIBESPACE_|^CLAUDE_CODE_/.test(k)) delete e[k]; return e; };
const facts = serve.install({ dataDir, command: process.env.OPENCODE_CMD || 'opencode', env, log: console, onCaps: (c, st) => console.log('caps verdict:', c, 'version', st.version) });
const t0 = Date.now();
const client = await facts.locator.ensure();
console.log('locator:', JSON.stringify(facts.locator.state()), `(${Date.now() - t0}ms)`);
if (!client) { console.error('no serve:', facts.reasonUnavailable()); process.exit(1); }
let entries = await facts.discover({});
await new Promise((r) => setTimeout(r, 1500));
facts.invalidate(); entries = await facts.discover({});
console.log(`sessions: ${entries.length}`);
for (const e of entries.slice(0, 30)) console.log(`  ${e.backendSessionId}  ${e.status.padEnd(7)} ${e.agentKind.padEnd(8)} ${new Date(e.startedAt).toISOString()}  ${e.cwd}  "${e.name}"  [${e.opencode.model || '-'} / ${e.opencode.agent || '-'}]`);
const target = arg('--session') || entries.find((e) => e.agentKind === 'primary')?.backendSessionId;
if (target) {
  const conv = await facts.readConversation(target);
  console.log(`\nconversation ${target}: ${conv.messages.length} messages → ${conv.records.length} acp-events records`);
  const kinds = {}; for (const r of conv.records) { const k = r.kind + (r.kind === 'update' ? ':' + r.update.sessionUpdate : ''); kinds[k] = (kinds[k] || 0) + 1; }
  console.log('  record kinds:', kinds);
  const mm = new AcpMessageManager(target); const msgs = mm.convertHistory(conv.records);
  console.log(`  normalized: ${msgs.length} messages (${msgs.filter((m) => m.role === 'user').length} user, ${msgs.filter((m) => m.role === 'assistant').length} assistant, ${msgs.filter((m) => m.role === 'tool').length} tool); status`, mm.status());
  for (const m of msgs.slice(0, 12)) console.log('   -', m.role.padEnd(9), m.status.padEnd(9), (m.toolName || m.content[0]?.type || '').padEnd(10), JSON.stringify(m.content[0]?.text || m.content[0]?.input || '').slice(0, 100));
}
const forkId = arg('--fork');
if (forkId) {
  try { const f = await facts.forkSession(forkId); console.log('\nforked:', f.id, JSON.stringify(f.title), f.directory); }
  catch (e) { console.error('\nfork failed:', e.message); }
}
if (argv.includes('--keep')) { console.log('\nkeeping the serve up; record:', facts.locator.recordPath); }
else { facts.locator.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); console.log('\nstopped.'); }
