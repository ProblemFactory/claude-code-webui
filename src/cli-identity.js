'use strict';
/**
 * THE agent-CLI process identity — ONE rule, expressed twice (B-3185 r3).
 *
 * "Is pid N the `claude` / `codex` CLI?" is asked by three consumers that used
 * to answer it three different ways:
 *
 *   · the pre-resume WRITER SWEEP (src/writer-sweep.js) — decides who receives
 *     a SIGTERM, runs as POSIX shell on this machine, an ssh host or a dialed
 *     device;
 *   · the ssh discovery CO leg (src/hosts.js) — decides which codex threads are
 *     RUNNING, same shell, embedded VERBATIM from here;
 *   · the DISCOVERY FACTS (src/discovery-facts.js) — the local listing, the
 *     device snapshot's lock scan and its CO lines, in JavaScript.
 *
 * B-3185 replaced the substring/whole-argv rule with an EXECUTABLE test in the
 * shell copies and left the JS copy alone, recording the twin instead of
 * killing it. That record was the honest thing to do and also the thing the
 * STANDING SWEEP exists to stop: a rule with two spellings has two behaviours
 * the moment either is touched. Both spellings now live in THIS file, side by
 * side, and scripts/test-writer-sweep.mjs drives the SAME live pids through
 * both and demands the same verdict.
 *
 * THE RULE, in three rungs, because the CLI ships in three shapes:
 *   1. argv[0]'s BASENAME is the CLI name (`~/.local/bin/claude`, the vendor's
 *      `…/vendor/<triple>/bin/codex`) — the measured shape of a real install;
 *   2. argv[0] is an INTERPRETER (node/bun/deno) and its first NON-FLAG operand
 *      is the CLI's entry point (`node <prefix>/bin/claude`,
 *      `node …/@anthropic-ai/claude-code/cli.js`, `node …/@openai/codex/bin/codex.js`);
 *   3. the EXECUTABLE IMAGE is the CLI (`/proc/<pid>/exe` basename), or it is
 *      the native install's version file (`…/<name>/versions/<ver>`, whose
 *      basename is a version number) AND the process still PRESENTS as the CLI.
 *
 * Never a later argument, never the whole command line: the retired rule fired
 * on `tail -f ~/.claude/projects/<id>.jsonl`, on an editor with the transcript
 * open, and on a test process running from a worktree under ~/.claude/ — which
 * matched its own guard and SIGTERMed itself.
 *
 * RUNG 3 IS NARROWED BY THE PRESENTATION (r2). The CLI RE-EXECS ITS OWN IMAGE
 * as its bundled helper tools: measured live on the dev box, twice, minutes
 * apart, 18–19 processes have an exe under `…/.local/share/claude/versions/<ver>`
 * and 2–3 of them are `ugrep -G --ignore-files …` whose argv[0] is a bare
 * `ugrep`. "Runs the CLI's binary image" is therefore NOT "is the CLI". The
 * rung takes either honest presentation — argv[0] basename STARTS WITH the CLI
 * name (a launcher that names it), or argv[0] basename EQUALS the exe basename
 * (nothing was renamed: a wrapper's `exec "$IMG" "$@"`) — and a re-exec'd
 * helper satisfies neither, because it renames itself to the tool it runs.
 *
 * `(deleted)` IS STRIPPED FROM THE IMAGE (r3). When the image file is replaced
 * on disk while the process runs, the kernel appends ` (deleted)` to
 * /proc/<pid>/exe — and that is not an exotic state: it is exactly what the
 * claude auto-updater and `npm i -g @openai/codex` do to LIVE sessions. Without
 * the strip, both executable rungs miss (basename `claude (deleted)`, and the
 * "nothing was renamed" disjunct compares `2.1.257` against `2.1.257 (deleted)`),
 * so the ONE process the sweep exists to stop — a mid-update CLI still writing
 * the transcript — survived it. The double-writer corruption class the sweep
 * prevents is most likely precisely when an update has just landed.
 *
 * THE SHELL TEXT RUNS UNDER THE REMOTE LOGIN SHELL, NOT `sh`. The device rung
 * runs it as `sh -c`, but both ssh rungs — the sweep's fallback
 * (writer-sweep.js sweepWriters) and the discovery CO leg (hosts.js `_ssh`) —
 * hand the script to `ssh host -- <script>`, which the REMOTE USER'S LOGIN
 * SHELL interprets. So "POSIX sh" is the floor, not the target, and every
 * pattern here has to mean the same thing in zsh too. It bit immediately: in
 * zsh `(…)` is a glob GROUP, so the unquoted `${e% (deleted)}` above matched
 * " deleted" and stripped NOTHING — the r3 fix would have been dead on exactly
 * the hosts whose login shell is zsh (a very common default, including this
 * dev box). Quote any pattern whose literal characters are special somewhere.
 *
 * DEPENDENCY-FREE ON PURPOSE: the agentd bundle carries discovery-facts, so it
 * now carries this too. node builtins only, no repo imports.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

/** argv[0] values that mean "the real program is an ARGUMENT" (rung 2). */
const INTERPRETERS = new Set(['node', 'nodejs', 'node.exe', 'bun', 'deno']);
/** how many leading flags rung 2 will skip before giving up (shell twin: 6). */
const MAX_INTERP_FLAGS = 6;
/** the kernel's marker for "this image was unlinked/replaced since exec". */
const DELETED_SUFFIX = / \(deleted\)$/;

// `${x##*/}` and `${x%/*}`, verbatim — including the shell's answer for a value
// with NO slash (basename = the value, dirname = the value).
const shBase = (p) => { const s = String(p == null ? '' : p); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); };
const shDir = (p) => { const s = String(p == null ? '' : p); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(0, i); };

/** `vs_argv <pid> <i>` in JS: the i-th argv word, '' when unknown.
 *  /proc first (zero fork), `ps -o args=` where there is no /proc (macOS/BSD).
 *  NEVER throws — a machine-wide walk races every exiting process. */
function procArgv(pid, i) {
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0');
    return parts[i] === undefined ? '' : parts[i];
  } catch { /* no /proc, or the pid went away — fall through */ }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? (out.split(/\s+/)[i] || '') : '';
  } catch { return ''; }
}

/** `readlink /proc/<pid>/exe` with the kernel's ` (deleted)` marker stripped.
 *  '' when there is no /proc, no permission, or no such process. */
function procExe(pid) {
  try { return String(fs.readlinkSync(`/proc/${pid}/exe`)).replace(DELETED_SUFFIX, ''); }
  catch { return ''; }
}

/** THE predicate. `name` is the CLI's own name ('claude' | 'codex' | …).
 *  The JS twin of `vs_is_cli` below — same rungs, same order, same answers
 *  (scripts/test-writer-sweep.mjs drives both over the same live pids). */
function isCliProcess(pid, name) {
  const n = String(name || '');
  if (!n) return false;
  const a0 = procArgv(pid, 0);
  const b0 = shBase(a0);
  // rung 1 — argv[0] IS the CLI
  if (b0 === n || b0 === n + '.exe') return true;
  // rung 2 — an interpreter running the CLI's entry point (first NON-FLAG operand)
  if (INTERPRETERS.has(b0)) {
    for (let i = 1; i <= MAX_INTERP_FLAGS; i++) {
      const a = procArgv(pid, i);
      if (!a) return false;
      if (a.startsWith('-')) continue;
      const b = shBase(a);
      if (b === n || b === n + '.js' || b === n + '.mjs' || b === n + '.cjs') return true;
      if (b === 'cli.js' || b === 'cli.mjs' || b === 'cli.cjs') return shBase(shDir(a)).includes(n);
      return false;
    }
    return false;
  }
  // rung 3 — the executable image, narrowed by how the process presents itself
  const e = procExe(pid);
  if (!e) return false;
  const be = shBase(e);
  if (be === n || be === n + '.exe') return true;
  if (e.includes(`/${n}/versions/`)) {
    if (b0.startsWith(n)) return true;              // a launcher that NAMES the CLI
    if (a0 && b0 === be) return true;               // nothing renamed: `exec "$IMG" "$@"`
  }
  return false;
}

/** The SAME rule as POSIX shell functions, for the sweep and the ssh discovery
 *  CO leg (both embed this text VERBATIM). `vs_is_cli <pid> <name>`.
 *
 *  vs_argv silences the WHOLE cmdline compound, not just `tr`: a failing
 *  redirect is reported by the SHELL, and a machine-wide scan races every
 *  exiting process, so `cannot open /proc/N/cmdline` would otherwise land on
 *  the stderr of a script whose stderr the callers read. */
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
      while [ "$vs_c_i" -le ${MAX_INTERP_FLAGS} ]; do
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
  # the kernel appends " (deleted)" once the image is replaced on disk — which
  # is what an auto-update does to a LIVE session, so BOTH executable rungs
  # below would miss exactly the process the sweep exists to stop.
  # THE PATTERN IS QUOTED because this text runs under the REMOTE LOGIN SHELL
  # (\`ssh host -- <script>\`), and in zsh an unquoted \`(deleted)\` is a glob
  # GROUP matching the bare word — so \${e% (deleted)} silently strips nothing
  # and the fix is dead on exactly the hosts whose login shell is zsh.
  # Quoting makes it a literal in every shell (POSIX: quoted chars in the word
  # are not pattern characters). Verified dash/bash/busybox/zsh/ksh.
  vs_c_e=\${vs_c_e%' (deleted)'}
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

module.exports = { isCliProcess, cliIdentityShellFns, procArgv, procExe, INTERPRETERS, MAX_INTERP_FLAGS };
