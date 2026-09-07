'use strict';
/**
 * THE pre-resume writer sweep — ONE implementation for every machine
 * (CS separation, 2.276.0).
 *
 * THE INVARIANT it enforces: before resuming a conversation, no OTHER process
 * may still be writing that conversation's transcript. Two writers on one
 * JSONL is the B-4058 corruption class ("resume did nothing", vanishing
 * turns, keeper remnants that fool diagnosis).
 *
 * WHY IT LIVES HERE: it used to be a template literal inside the WS create
 * handler with THREE transport-specific invocations — and LOCAL had none at
 * all. A local resume of a conversation still held by a claude in an external
 * terminal had exactly the same double-writer risk; the fix only ever landed
 * on the remote paths because that is where the incident was reported. That
 * asymmetry is the bug class the CS separation exists to kill: the local twin
 * is the one nobody exercises when fixing a remote bug. Now `hostId` is just
 * a parameter — falsy means this machine (device #0) — and one call site
 * serves ssh, dial and local.
 */

/** THE /proc fd scan, as POSIX shell functions — ONE implementation (B-3185).
 *
 *  `vs_fd_scan <ere>` prints `<pid>\t<fd target>` for every open fd whose
 *  symlink target matches; `vs_fd_pids <ere>` reduces that to a deduped pid
 *  list. Emitted into the sweep script AND into boot-restore's "who holds this
 *  conversation's JSONL" probe, which is the same scan with the kill removed.
 *
 *  WHY BATCHED: the sweep used to fork an `ls` + a `grep` PER PROCESS —
 *  measured on the dev box (32 cores, loadavg 3.4, 3678 processes) that is
 *  7356 forks and 9.9–10.7s wall, over half the 20s budget spent on fork/exec
 *  alone and past it entirely on a busier or bigger machine; boot-restore's
 *  variant forked a `readlink` PER FD (405,735 of them here, ~6.4 minutes) and
 *  so ALWAYS blew its own 6s timeout into a silent empty result. One `ls -l`
 *  over 400 fd directories plus one awk does the same scan in 3.0s / ~20
 *  forks — 20s now covers ~24k processes.
 *
 *  WHY CHUNKED: `vs_fd_chunk` EXECS `ls`, so its argv is one operand per
 *  process and is bounded by ARG_MAX/MAX_ARG_STRLEN — a single `ls` over every
 *  process on a big machine is one execve whose size grows with the process
 *  table, and an E2BIG there fails into a discarded stderr and a silently empty
 *  result. 400-directory chunks can never reach that limit. (The OLD probe's
 *  `/proc/[0-9]*` `/fd/` fd-level glob was consumed by a SHELL for-loop — it
 *  never reached execve at all, so ARG_MAX was never its problem; its problem
 *  was the 405,735 `readlink` forks.)
 *
 *  WHY /proc/self/fd rides in every chunk: `ls -l` prints the `<dir>:` headers
 *  the pid attribution reads ONLY when it has more than one operand — a chunk
 *  that happened to hold a single process would otherwise attribute nothing.
 *  It is ALSO why the awk clears `p` on EVERY directory header and not only on
 *  the ones it recognises: `/proc/self/fd` is the fd table of the `ls` process
 *  itself, which inherits the caller's fds — with a sticky `p`, an inherited
 *  matching fd (the sweeping shell's own, a redirect, an editor's) was
 *  attributed to whichever numeric pid came last in the chunk, and the sweep
 *  would SIGTERM a process that never held the transcript. */
function fdScanShellFns() {
  return `vs_fd_chunk() {
  ls -l "$@" /proc/self/fd 2>/dev/null | awk '
    BEGIN { pat = ENVIRON["VS_FD_PAT"] }
    $0 ~ "^/.*:$" { p = ""; if ($0 ~ "^/proc/[0-9]+/fd:$") p = substr($0, 7, length($0) - 10); next }
    p != "" && $0 ~ pat { i = index($0, " -> "); if (i) print p "\\t" substr($0, i + 4) }
  '
}
vs_fd_scan() {
  VS_FD_PAT=$1; export VS_FD_PAT
  set --
  for pdir in /proc/[0-9]*; do
    set -- "$@" "$pdir/fd"
    [ $# -lt 400 ] || { vs_fd_chunk "$@"; set --; }
  done
  [ $# -eq 0 ] || vs_fd_chunk "$@"
  return 0
}
vs_fd_pids() { vs_fd_scan "$1" | cut -f1 | sort -u; }`;
}

/** Is pid $1 the `$2` CLI (claude | codex)? — the sweep's SECONDARY guard.
 *
 *  The fd evidence is the primary signal (this process holds THIS
 *  conversation's transcript open); this decides whether the holder is the
 *  agent CLI (a writer) or a reader that must be left alone.
 *
 *  It used to be a substring test over the WHOLE `ps -o args=` line, so every
 *  process whose command line merely MENTIONED a path under ~/.claude read as
 *  the CLI and was SIGTERMed: `tail -f ~/.claude/projects/<id>.jsonl`, an
 *  editor with the transcript open, and — the incident that put the workaround
 *  in the suite — a test process running from a git worktree under
 *  ~/.claude/worktrees/, which matched its own guard and killed itself.
 *
 *  Decide by the EXECUTABLE instead, in three rungs, because the CLI ships in
 *  three shapes: a native binary (argv[0] basename `claude`, exe
 *  ~/.local/share/<name>/versions/<ver>), an npm bin shim run through a
 *  shebang (`node <prefix>/bin/claude …`), and a direct entry-point run
 *  (`node …/@anthropic-ai/claude-code/cli.js`, `node …/@openai/codex/bin/codex.js`).
 *  Only argv[0] and the interpreter's first NON-FLAG operand are ever
 *  consulted — never a later argument, which is what made the old rule fire on
 *  a path that happened to be an argument.
 *
 *  RUNG 3 IS NARROWED BY THE PRESENTATION (r2). The native install's image IS
 *  the version FILE (`~/.local/share/claude/versions/2.1.257`), so its basename
 *  is a version number and the rung has to accept the install DIRECTORY — but
 *  the CLI RE-EXECS THAT SAME IMAGE as its bundled helper tools. Measured live
 *  on this box, twice, minutes apart: 18–19 processes have an exe under
 *  `…/.local/share/claude/versions/<ver>`, and 2–3 of them at any moment are
 *  `ugrep -G --ignore-files …` whose argv[0] is a bare `ugrep`. "Runs the CLI's
 *  binary image" is therefore NOT "is the CLI", and r1's rung ("anything under
 *  versions/") answered YES for those helpers — a WIDENING smuggled into a
 *  narrowing fix, so a search helper that inherited its parent's transcript fd
 *  was a SIGTERM target. The rung now also asks how the process PRESENTS
 *  itself, and takes either honest answer:
 *    · argv[0] basename starts with `<name>` — a shim/launcher that names the
 *      CLI (the exact-basename case never gets here; rung 1 has it), and
 *    · argv[0] basename EQUALS the exe basename — nothing was renamed, i.e. a
 *      wrapper that `exec`s the image itself (`exec "$IMG" "$@"`), which is the
 *      shape that keeps this rung from being unreachable in the first place.
 *  A re-exec'd helper fails both: it renames itself to the tool it is running
 *  (argv[0] `ugrep`, exe `…/versions/2.1.238`). The measured real CLI never
 *  needs this rung at all — its argv[0] is `~/.local/bin/claude`, so rung 1
 *  answers — which is exactly why widening it was pure downside. A narrowing
 *  fix must not widen anything. */
function cliIdentityShellFns() {
  return `vs_argv() {
  if [ -r "/proc/$1/cmdline" ]; then
    # the redirect itself fails LOUDLY (shell-level) when the pid exits between
    # the test and the open — routine in a machine-wide scan, so the whole
    # compound, not just tr, is silenced
    { tr '\\0' '\\n' < "/proc/$1/cmdline" | sed -n "$(($2 + 1))p"; } 2>/dev/null
  else
    ps -p "$1" -o args= 2>/dev/null | awk -v i="$(($2 + 1))" '{ print $i }'
  fi
}
vs_is_cli() {
  vs_c_a0=$(vs_argv "$1" 0)
  case "\${vs_c_a0##*/}" in "$2"|"$2".exe) return 0;; esac
  case "\${vs_c_a0##*/}" in
    node|nodejs|node.exe|bun|deno)
      vs_c_i=1
      while [ "$vs_c_i" -le 6 ]; do
        vs_c_a=$(vs_argv "$1" "$vs_c_i")
        [ -n "$vs_c_a" ] || return 1
        case "$vs_c_a" in -*) vs_c_i=$((vs_c_i + 1)); continue;; esac
        vs_c_d=\${vs_c_a%/*}
        case "\${vs_c_a##*/}" in
          "$2"|"$2".js|"$2".mjs|"$2".cjs) return 0;;
          cli.js|cli.mjs|cli.cjs) case "\${vs_c_d##*/}" in *"$2"*) return 0;; esac;;
        esac
        return 1
      done
      return 1
      ;;
  esac
  vs_c_e=$(readlink "/proc/$1/exe" 2>/dev/null)
  [ -n "$vs_c_e" ] || return 1
  case "\${vs_c_e##*/}" in "$2"|"$2".exe) return 0;; esac
  case "$vs_c_e" in
    */"$2"/versions/*)
      # it PRESENTS as the CLI (a shim/launcher argv[0])…
      case "\${vs_c_a0##*/}" in "$2"*) return 0;; esac
      # …or it renamed nothing at all (argv[0] IS the image: a wrapper's
      # \`exec "\$IMG" "\$@"\`). A re-exec'd helper always renames itself.
      [ -n "$vs_c_a0" ] && [ "\${vs_c_a0##*/}" = "\${vs_c_e##*/}" ] && return 0
      ;;
  esac
  return 1
}`;
}

/** POSIX sweep script. Every kill leg echoes `SWEPT:<pid>` so the caller can
 *  TELL THE USER what was stopped instead of silently killing their terminal
 *  session (the honesty rule — a sweep is destructive by design).
 *
 *  `backend` selects the transcript-holder legs — claude: `<rid>.jsonl` fd/lsof
 *  + the CLI's own ~/.claude/sessions lock files; codex: an open
 *  `rollout-*-<threadId>.jsonl` (or `.jsonl.zst`, codex ≥0.153 may compress)
 *  + a `codex resume <threadId>` / `CODEX_WEBUI_RESUME_ID=<threadId>` argv.
 *  The pipe-session-meta and keeper legs are shared. `protectSids` (codex
 *  only) = webui ids of LIVE VibeSpace codex sessions on this machine: a codex
 *  app-server keeps EVERY rollout of its thread tree open for its whole
 *  lifetime (measured on the dev box: one app-server with the parent + three
 *  sub-agent rollouts still open two days after the sub-agents finished), so a
 *  holder spawned under a live session (CLAUDE_WEBUI_SESSION_ID in its
 *  argv/environ) is never a target — for live sessions the resume-already-live
 *  guard is the only arbiter; the sweep reaches EXTERNAL/orphaned writers. */
function writerSweepScript(rid, shq, { backend = 'claude', protectSids = [] } = {}) {
  // Shared legs: daemon pipe-session metas + legacy keeper records reference
  // the conversation id verbatim whatever the backend.
  const shared = `for kf in "$HOME"/.vibespace/*/state/sessions/*.json; do
  [ -e "$kf" ] || continue
  grep -q "$RID" "$kf" 2>/dev/null || continue
  grep -q '"exited"' "$kf" 2>/dev/null && continue
  cpid=$(sed -n 's/.*"childPid":\\([0-9]*\\).*/\\1/p' "$kf" | head -1)
  [ -n "$cpid" ] && kill -TERM "$cpid" 2>/dev/null && echo "SWEPT:$cpid"
done
find "$HOME/.vibespace/run" -maxdepth 1 -name '*.json' 2>/dev/null | while read -r kf; do
  grep -q "$RID" "$kf" 2>/dev/null || continue
  grep -q '"exited"' "$kf" 2>/dev/null && continue
  node "$HOME/.vibespace/bin/vibespace-remote-keeper" stop "$(basename "$kf" .json)" >/dev/null 2>&1 || true
done`;
  if (backend === 'codex') {
    const protect = protectSids.map((s) => String(s)).filter((s) => /^[\w-]+$/.test(s)).join(' ');
    return `RID=${shq(rid)}
PROTECT=${shq(protect)}
# codex writer sweep (VS_WRITER_SWEEP): the app-server keeps rollout-*-<threadId>.jsonl
# (codex >=0.153 may write .jsonl.zst) open for its lifetime — and EVERY thread of its
# tree (sub-agent rollouts included), so a holder spawned under a LIVE VibeSpace codex
# session (PROTECT) is never a target; only external/orphaned writers are swept.
vs_sid_of() {
  { ps -p "$1" -o args= 2>/dev/null | tr ' ' '\\n'
    tr '\\0' '\\n' 2>/dev/null < "/proc/$1/environ" || ps -p "$1" -E -o command= 2>/dev/null | tr ' ' '\\n'
  } | sed -n 's/^CLAUDE_WEBUI_SESSION_ID=//p' | head -1
}
${fdScanShellFns()}
${cliIdentityShellFns()}
# $1=pid. The PROTECT check + the kill; the CALLER supplies the evidence that
# this pid is a codex writer at all — an open rollout fd (which needs the
# vs_is_cli executable test, since holding a file open says nothing about who
# you are) or an argv that NAMES this thread id (self-evidencing, and the shape
# that matches is a VibeSpace wrapper/dtach master that is not the codex binary).
vs_codex_kill() {
  sid=$(vs_sid_of "$1")
  if [ -n "$sid" ]; then case " $PROTECT " in *" $sid "*) return 0;; esac; fi
  kill -TERM "$1" 2>/dev/null && echo "SWEPT:$1"
}
if [ -d /proc/1 ] || [ -d /proc/self ]; then
  for pid in $(vs_fd_pids "/rollout-.*-$RID.jsonl"); do
    vs_is_cli "$pid" codex || continue
    vs_codex_kill "$pid"
  done
elif command -v lsof >/dev/null 2>&1; then
  find "$HOME/.codex/sessions" -name "rollout-*-$RID.jsonl*" 2>/dev/null | while read -r J; do
    for pid in $(lsof -t -- "$J" 2>/dev/null); do
      vs_is_cli "$pid" codex || continue
      vs_codex_kill "$pid"
    done
  done
fi
# argv leg: \`codex resume <threadId>\` (a TUI in an external terminal) names the thread
# on its command line; so does an orphaned VibeSpace wrapper (CODEX_WEBUI_RESUME_ID=).
# The sweep's own shell carries RID in argv too (sh -c <this script>) — the
# VS_WRITER_SWEEP sentinel skips it and its subshells.
ps -eo pid=,args= 2>/dev/null | while read -r pid args; do
  case "$args" in *VS_WRITER_SWEEP*) continue;; esac
  case "$args" in *codex*resume*"$RID"*|*"CODEX_WEBUI_RESUME_ID=$RID"*) vs_codex_kill "$pid";; esac
done
${shared}`;
  }
  return `RID=${shq(rid)}
# writer sweep (VS_WRITER_SWEEP), portable: /proc fd scan on Linux; lsof on
# macOS/BSD ssh hosts (no /proc there — the old script silently swept NOTHING,
# audit 2.192.0). Holding the transcript open is the EVIDENCE; vs_is_cli decides
# whether the holder is the CLI (a writer) or a reader that must survive.
${fdScanShellFns()}
${cliIdentityShellFns()}
vs_claude_kill() {
  vs_is_cli "$1" claude || return 0
  kill -TERM "$1" 2>/dev/null && echo "SWEPT:$1"
}
if [ -d /proc/1 ] || [ -d /proc/self ]; then
  for pid in $(vs_fd_pids "/$RID.jsonl"); do vs_claude_kill "$pid"; done
elif command -v lsof >/dev/null 2>&1; then
  J=$(find "$HOME/.claude/projects" -maxdepth 2 -name "$RID.jsonl" 2>/dev/null | head -1)
  if [ -n "$J" ]; then
    for pid in $(lsof -t -- "$J" 2>/dev/null); do vs_claude_kill "$pid"; done
  fi
fi
# The CLI's own lock file names the pid; the executable test is what keeps a
# STALE file whose pid has been reused from killing an unrelated process.
find "$HOME/.claude/sessions" -maxdepth 1 -name '*.json' 2>/dev/null | while read -r f; do
  pid=$(basename "$f" .json)
  grep -q "\\"sessionId\\":\\"$RID\\"" "$f" 2>/dev/null || continue
  kill -0 "$pid" 2>/dev/null || continue
  vs_claude_kill "$pid"
done
${shared}`;
}

/** Run the sweep on ANY machine. hostId falsy ⇒ this machine (device #0).
 *  Returns {swept: [pid…], via: 'device'|'ssh'}; throws if it could not run
 *  (the caller must decide: refuse the resume, or warn and continue).
 *  `backend`/`protectSids` select the script legs (see writerSweepScript). */
async function sweepWriters(hosts, hostId, rid, { shq, timeoutMs = 20000, connectMs = 15000, execFileAsync, backend = 'claude', protectSids = [] } = {}) {
  const script = writerSweepScript(rid, shq, { backend, protectSids });
  try {
    const dm = await hosts.deviceBounded(hostId, connectMs);
    const r = await dm.runCmd('sh', ['-c', script], { timeoutMs });
    return { swept: parseSwept(r?.stdout), via: 'device' };
  } catch (e) {
    // ssh hosts keep the legacy per-op channel as the fallback the data plane
    // has always had; local and dial have no second channel by design.
    if (!hostId || !execFileAsync) throw e;
    const h = hosts.get(hostId);
    if (h?.transport === 'dial') throw e;
    const out = await execFileAsync('ssh', [...hosts.sshArgs(h, { multiplex: true }), '--', script], { timeout: timeoutMs, encoding: 'utf-8' });
    return { swept: parseSwept(out), via: 'ssh' };
  }
}

function parseSwept(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^SWEPT:(\d+)/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

module.exports = { writerSweepScript, sweepWriters, parseSwept, fdScanShellFns, cliIdentityShellFns };
