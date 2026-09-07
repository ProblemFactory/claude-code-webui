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

module.exports = { ORACLES, NOT_ORACLES, PROOF_KEYS, oracle, oraclesFor, rejectedFor, rejected };
