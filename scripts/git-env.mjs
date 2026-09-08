// THE ONE SANITIZED GIT ENVIRONMENT for tooling that runs inside somebody
// else's git process (test-architecture §42 rounds 6–7 — read that essay for
// the reproductions; this module is only its single spelling).
//
// WHY THIS EXISTS: git's entire "which repository / which index / which
// objects / which config" layer lives in environment variables, and a
// `git -C <dir> …` obeys every one of them. Our tooling does NOT choose its
// own process — it runs inside `npm run build`, inside the pre-push hook, and
// (since the fast/heavy split) inside a child the pre-push hook DETACHES —
// i.e. inside processes git itself populates with GIT_DIR / GIT_INDEX_FILE /
// GIT_PREFIX. Measured on git 2.51: a hook is handed GIT_INDEX_FILE and
// GIT_PREFIX, and GIT_DIR is normal for any tool driving a worktree. A heavy
// gate run that inherited those would point `git worktree add` (test-restore-
// smoke, test-client-boot, …) at whatever repository the environment names —
// the exact class that once REINITIALISED the production checkout and flipped
// its shared core.bare to true.
//
// DELIBERATELY KEPT: PATH and GIT_EXEC_PATH (they belong to the git on PATH),
// GIT_CONFIG_NOSYSTEM / GIT_ATTR_NOSYSTEM (they only REMOVE ambient system
// files — strictly more isolation, never less), and the identity/pager/trace
// names (they cannot steer which repository is written).
export const GIT_REDIRECTORS = [
  // which repository / work tree / index
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_INDEX_VERSION', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_PREFIX',
  // which objects
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  // which config (and therefore, indirectly, all of the above)
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  // how OUR pathspecs are read, and what `git init` installs into a fixture
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  'GIT_TEMPLATE_DIR',
];

export const gitEnvFrom = (raw) => {
  const e = { ...raw };
  for (const k of GIT_REDIRECTORS) delete e[k];
  // GIT_CONFIG_COUNT's numbered pairs are separate names — drop them too.
  for (const k of Object.keys(e)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete e[k];
  return e;
};
