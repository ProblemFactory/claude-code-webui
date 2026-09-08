'use strict';
/**
 * LOCAL ORACLES — the PURE registry of human-triggered, ZERO-NETWORK CLI reads
 * VibeSpace may run on a user's behalf (owner ruling 6 of
 * docs/design-harness-features.md §5.1: "用（逐条附「不发 vendor 请求」证据进
 * 白名单豁免；人触发/已有节拍）", and §4.2's hard gate: **每条附一份不发请求的
 * 证据，不能靠形状推断**).
 *
 * §ban-safety is the one law whose violation gets accounts BANNED (the Max ban
 * postmortem's PRIMARY cause was background auth/usage traffic). So the shape
 * of this file is deliberately adversarial to itself:
 *
 *   ORACLES     — commands MEASURED to open zero INET sockets. Each carries
 *                 its own proof: the tool, the date, the CLI version, and the
 *                 per-run connect counts. scripts/test-vendor-whitelist.mjs
 *                 refuses an entry without one, and RE-RUNS the measurement
 *                 when strace + the CLI are both available.
 *   NOT_ORACLES — the candidates that were measured and FAILED, kept here
 *                 forever as NEGATIVE CONTROLS. The suite asserts none of them
 *                 can appear in ORACLES, and the UI shows the reason rather
 *                 than silently offering nothing.
 *
 * AN ENTRY MAY ALSO EXPLAIN A MISSING FEATURE (round-2 verifier, 2026-09-07).
 * `blocks: '<backend>.<capsPath>'` on a NOT_ORACLES row says "this measurement
 * is WHY that capability row is false". Two consequences, both enforced:
 *   · scripts/test-vendor-whitelist.mjs asserts the named caps row really IS
 *     false — a rejection that stopped being enforced is a lie, and a caps row
 *     someone re-enabled without re-measuring fails the suite.
 *   · the UI shows a `blocks` row ALWAYS, not only when a harness has no
 *     oracles at all. codex has three shipped oracles, so without this the
 *     one rejection that explains a MISSING BUTTON would have been the only
 *     invisible one.
 *
 * THE MEASUREMENT (2026-09-07, this machine — `unshare -rn` is unavailable in
 * the sandbox, so the rung used is strace):
 *     env -i HOME=<empty dir> PATH=… TERM=dumb \
 *       strace -f -qq -e trace=network -o out.strace <cmd>
 *   then: every `connect(` line with AF_INET/AF_INET6 is counted. AF_UNIX and
 *   AF_NETLINK are NOT network (they are the local socket + NSS plumbing every
 *   process does). A DNS `connect(…:53)` to a resolver counts as INET —
 *   resolving a vendor host is already the CLI deciding to talk to it.
 *
 * RESULT, verbatim (see NOT_ORACLES for the failures):
 *   claude auth status --json   5 INET connects → api.anthropic.com:443
 *                               (160.79.104.10 / 2607:6bc0::10 — the same host
 *                               `getent hosts api.anthropic.com` returns), and
 *                               it STILL connects with logged-out creds AND
 *                               with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
 *                               DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1
 *                               DISABLE_ERROR_REPORTING=1 all set.
 *   claude agents --json        5 INET connects → the same host.
 *   codex doctor --json         16 INET connects; its own report names the
 *                               reason: checks `network.provider_reachability`
 *                               ("active provider endpoints are reachable over
 *                               HTTP") and `network.websocket_reachability`.
 *                               `codex doctor --help` offers no offline flag.
 * Control: `claude --version` = 0 INET connects, so this is not "every claude
 * invocation" — it is these specific subcommands, which is exactly why the
 * measurement had to be per-command instead of per-CLI.
 *
 * HOW AN ORACLE RUNS (the server side, src/server/local-oracles.js):
 *   · ONLY on a button click. Never a timer, never at boot, never on a poll.
 *   · under agentEnv() (the sanitized env — never raw process.env).
 *   · with the ACCOUNT's isolated config dir supplied through the harness's
 *     own creds.spawnEnvVar, so "which login is this" is answered for the
 *     account the user clicked, not for the machine.
 *   · argv comes from THIS file. A caller cannot pass its own arguments.
 */

/** A proof record's required shape (the suite enforces it). */
const PROOF_KEYS = Object.freeze(['tool', 'date', 'version', 'runs']);

const ORACLES = Object.freeze([
  Object.freeze({
    id: 'codex-login-status',
    backend: 'codex',
    label: 'Login status',
    description: 'Which ChatGPT/OpenAI login this account’s isolated config dir holds, straight from the CLI.',
    // `codex login status` writes its answer to STDERR ("Logged in using
    // ChatGPT") and leaves stdout empty — both streams are captured and shown.
    argv: Object.freeze(['login', 'status']),
    json: false,                 // `codex login status --help` offers no --json (dumped 0.153.4)
    streams: 'both',
    timeoutMs: 20000,
    proof: Object.freeze({
      tool: 'strace -f -qq -e trace=network',
      date: '2026-09-07',
      version: 'codex-cli 0.153.4',
      runs: Object.freeze([
        Object.freeze({ what: 'empty HOME (logged out)', inetConnects: 0, unixConnects: 0, note: 'prints "Not logged in" on stderr, exit 1' }),
        Object.freeze({ what: 'a COPY of a real logged-in auth.json', inetConnects: 0, unixConnects: 0, note: 'prints "Logged in using ChatGPT"; the token file’s md5 was unchanged afterwards — it does not refresh' }),
      ]),
    }),
  }),
  Object.freeze({
    id: 'codex-mcp-list',
    backend: 'codex',
    label: 'Configured MCP servers',
    description: 'The MCP servers this account’s config declares — read from its own config dir, no server is started.',
    argv: Object.freeze(['mcp', 'list', '--json']),
    json: true,                  // `codex mcp list --help`: "--json  Output the configured servers as JSON"
    streams: 'stdout',
    timeoutMs: 20000,
    proof: Object.freeze({
      tool: 'strace -f -qq -e trace=network',
      date: '2026-09-07',
      version: 'codex-cli 0.153.4',
      runs: Object.freeze([
        Object.freeze({ what: 'empty HOME', inetConnects: 0, unixConnects: 0, note: 'prints []' }),
      ]),
    }),
  }),
  Object.freeze({
    id: 'codex-features-list',
    backend: 'codex',
    label: 'Feature flags',
    description: 'Which Codex features are on for this account — stage and effective state, from config only.',
    argv: Object.freeze(['features', 'list']),
    json: false,                 // `codex features list --help` offers no --json (dumped 0.153.4)
    streams: 'stdout',
    timeoutMs: 20000,
    proof: Object.freeze({
      tool: 'strace -f -qq -e trace=network',
      date: '2026-09-07',
      version: 'codex-cli 0.153.4',
      runs: Object.freeze([
        Object.freeze({ what: 'empty HOME', inetConnects: 0, unixConnects: 0, note: 'prints the feature table' }),
      ]),
    }),
  }),
]);

/**
 * MEASURED AND REJECTED. These are the three the design doc proposed
 * (§4.2 / decision 6). They are NOT oracles; they stay here as the negative
 * controls the suite pins and as the honest text the UI shows instead of an
 * empty menu.
 */
const NOT_ORACLES = Object.freeze([
  Object.freeze({
    id: 'claude-auth-status',
    backend: 'claude',
    label: 'claude auth status',
    argv: Object.freeze(['auth', 'status', '--json']),
    measured: Object.freeze({
      tool: 'strace -f -qq -e trace=network', date: '2026-09-07', version: '2.1.257 (Claude Code)',
      inetConnects: 5, host: 'api.anthropic.com (160.79.104.10:443 / 2607:6bc0::10)',
      alsoWith: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 — still 5',
    }),
    verdict: 'It reaches api.anthropic.com even with no credentials and with every traffic-suppressing env set. The Max-ban postmortem’s primary cause was exactly this class of call, so it is not offered.',
  }),
  Object.freeze({
    id: 'claude-agents-list',
    backend: 'claude',
    label: 'claude agents --json',
    argv: Object.freeze(['agents', '--json']),
    measured: Object.freeze({
      tool: 'strace -f -qq -e trace=network', date: '2026-09-07', version: '2.1.257 (Claude Code)',
      inetConnects: 5, host: 'api.anthropic.com (160.79.104.10:443 / 2607:6bc0::10)',
    }),
    // FACT-CHECK (`claude agents --help`, 2.1.257): this lists BACKGROUND
    // SESSIONS ("Print active sessions (interactive and background) as a JSON
    // array"), not installed agent definitions. Even if it were free, it would
    // not answer the question it was proposed for.
    verdict: 'It reaches api.anthropic.com, and it lists background SESSIONS rather than installed agents — not the fact it was proposed for.',
  }),
  Object.freeze({
    id: 'codex-doctor',
    backend: 'codex',
    label: 'codex doctor --json',
    argv: Object.freeze(['doctor', '--json']),
    measured: Object.freeze({
      tool: 'strace -f -qq -e trace=network', date: '2026-09-07', version: 'codex-cli 0.153.4',
      inetConnects: 16, host: 'provider endpoints + a websocket probe (Cloudflare-fronted)',
      selfReported: 'network.provider_reachability = "active provider endpoints are reachable over HTTP"; network.websocket_reachability',
    }),
    verdict: 'Its report names two network checks it performs by design, and `codex doctor --help` offers no offline flag. Not an oracle.',
  }),
  // ── THE ONE THAT WAS ALREADY SHIPPING (round-2 verifier, 2026-09-07) ──
  // The first cut of the read-only rule view answered codex's INSTANCE scope
  // by spawning `codex app-server` and asking it `config/read`. Nobody had
  // measured that child. It was measured on the branch's own code path and it
  // reaches chatgpt.com — the SAME class of call this file rejects `codex
  // doctor` for, from a button whose sibling rows advertise "no network
  // requests (measured)". Consistency is the whole point of the file: a
  // registry that rejects a 16-connect command and quietly ships a 6-connect
  // one measures nothing.
  //
  // What survives: the codex SESSION scope, which goes through the session's
  // OWN already-running app-server over its stdin (`read-permission-rules`) —
  // no new process, no new socket, and it is the scope that can see the
  // `sessionFlags` layer anyway. What is gone: the instance scope for codex
  // (`permissionRules.instance` is FALSE on the caps row, and the suite pins
  // that this row and this entry agree).
  //
  // If the owner later decides a human-triggered vendor connection is
  // acceptable HERE, the reversal is: flip the caps row, move this entry out,
  // add the third vendor-request file to the §ban-safety allowlist WITH this
  // measurement, and warn in the dialog before the read runs. That is an owner
  // decision (routing table: "Quota/vendor calls — NOWHERE new"), not a
  // refactor, which is exactly why the capability is off rather than quietly
  // connecting.
  Object.freeze({
    id: 'codex-app-server-config-read',
    backend: 'codex',
    label: 'codex app-server (config/read)',
    argv: Object.freeze(['app-server']),
    blocks: 'codex.permissionRules.instance',
    measured: Object.freeze({
      tool: 'strace -f -qq -e trace=network', date: '2026-09-07', version: 'codex-cli 0.153.4',
      // Measured driving the real JSON-RPC handshake the reader used
      // (initialize → initialized → config/read {includeLayers:true} → kill),
      // under `env -i HOME=<empty dir>` — i.e. LOGGED OUT, so this is the
      // app-server's own startup and not a token refresh.
      inetConnects: 7, host: 'chatgpt.com (104.18.32.47 / 172.64.155.209 — `getent ahosts chatgpt.com`), 2 of them port 443, plus one 443 connect to 172.182.252.133',
      alsoWith: 'an EMPTY CODEX_HOME (no credentials at all) — still connects; with a real login the round-2 verifier measured 6 × chatgpt.com:443',
    }),
    verdict: 'Starting `codex app-server` connects to chatgpt.com before it will answer `config/read`, even with no credentials — the same measured-and-rejected class as `codex doctor`. The codex INSTANCE scope of the permission-rule view is therefore not offered; the SESSION scope answers through the session\'s own running app-server and opens no new socket.',
  }),
]);

const byId = new Map(ORACLES.map((o) => [o.id, o]));
const rejectedById = new Map(NOT_ORACLES.map((o) => [o.id, o]));

/** The oracle with this id, or null. Callers NEVER build their own argv. */
function oracle(id) { return byId.get(String(id || '')) || null; }
/** Every oracle for a harness (the ⋯ menu's rows). */
function oraclesFor(backend) { return ORACLES.filter((o) => o.backend === backend); }
/** Every measured-and-rejected candidate for a harness (the honest note). */
function rejectedFor(backend) { return NOT_ORACLES.filter((o) => o.backend === backend); }
/** Was this id measured and rejected? (the UI's "why is there nothing here".) */
function rejected(id) { return rejectedById.get(String(id || '')) || null; }

/**
 * The measurement that explains a FALSE capability row, or null.
 * `capPath` is the dotted path under the backend's caps row, e.g.
 * `blockedCapability('codex', 'permissionRules.instance')`.
 *
 * Callers on BOTH sides use it: the server turns it into the typed refusal's
 * detail (so a user who asks anyway is told the real reason rather than a
 * generic "this harness cannot"), and the menu turns it into a disabled row
 * (so a MISSING button is explained where the button would have been). The
 * fact lives here once — a hand-written sentence in either place is the second
 * copy that goes stale the day the measurement is redone.
 */
function blockedCapability(backend, capPath) {
  const want = `${backend}.${capPath}`;
  return NOT_ORACLES.find((o) => o.blocks === want) || null;
}
/** Every rejection that explains a missing capability (shown unconditionally). */
function blockingRejectionsFor(backend) { return NOT_ORACLES.filter((o) => o.backend === backend && o.blocks); }

module.exports = { ORACLES, NOT_ORACLES, PROOF_KEYS, oracle, oraclesFor, rejectedFor, rejected, blockedCapability, blockingRejectionsFor };
