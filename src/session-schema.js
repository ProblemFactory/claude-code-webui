'use strict';
// SESSION FIELD SCHEMA (拆分P3 — the blackboard gets owners).
// The live session object in activeSessions accumulated ~50 underscore fields
// written from anywhere ("blackboard" anti-pattern): nothing said which module
// owned a field, what persisted it, or whether two writers raced. This module
// is the AUTHORITATIVE registry — every `session._field` write site must have
// a row here. scripts/test-session-schema.mjs enforces it: an unregistered
// write FAILS the suite until the field is added WITH an owner; a dead row
// must be removed. PURE module (no requires) — safe to import anywhere.
//
// owner values name the module that conceptually owns writes:
//   stdout    src/server/session-stdout.js (the parse + meta store)
//   ws        src/ws-handler.js / src/ws-create.js (protocol handlers)
//   goal      src/server/goal-sync.js + the set-goal ws case
//   pool      src/server/usage-pool-engine.js (model lock / pool identity)
//   brain     src/server/session-brain.js (dual-feed gate)
//   boot      src/server/boot-restore.js (restore-time backfill)
//   dial      dial/agentd transport plumbing
// persisted: 'meta' = session-meta json, 'wrapper' = wrapper meta file,
//            null = in-memory only (dies with the process by design).

const SESSION_FIELDS = {
  // identity / lifecycle
  _webuiId:            { owner: 'brain',  persisted: null,      note: 'webui id stamped for device-feed side effects' },
  _normalizer:         { owner: 'stdout', persisted: null,      note: 'MessageManager instance for the live stream' },
  _normEpoch:          { owner: 'stdout', persisted: null,      note: 'normalizer identity epoch — client full-reset discriminator (2.89.x)' },
  _subNormalizers:     { owner: 'stdout', persisted: null,      note: 'per-subagent normalizers map' },
  _historyLoaded:      { owner: 'ws',     persisted: null,      note: 'first-attach full-JSONL rebuild flag (set AFTER success, 2.89.2)' },
  _rebuildQueue:       { owner: 'ws',     persisted: null,      note: 'live records held back during the time-sliced first-attach rebuild, replayed in order (2.369.16 feedLive gate)' },
  _rebuildPromise:     { owner: 'ws',     persisted: null,      note: 'single-flight rebuild promise — concurrent attaches await it instead of rebuilding twice (2.369.16)' },
  _rebuildProgress:    { owner: 'ws',     persisted: null,      note: '{done,total} of the in-flight rebuild — rides the 10s progress attach-acks (2.369.16)' },
  _jobsEventsSeenTs:   { owner: 'agent-routes', persisted: null, note: 'Background Work event delivery marker (2.342.0) — restart = full redelivery, mirroring group-snap semantics' },
  _csiAccepted:        { owner: 'jobs-wiring', persisted: null,  note: 'crossSessionInbound=accept pushed to this pre-2.344.0 live chat session via apply_flag_settings (2.344.1 catch-up; restart = harmless re-push)' },
  _startSubagentWatcher: { owner: 'stdout', persisted: null,    note: 'bound helper for restart re-arm of agent watchers' },

  // streaming / turn state
  _isStreaming:        { owner: 'stdout', persisted: 'wrapper', note: 'explicit protocol-signal streaming flag (never heuristic)' },
  _streamingLabel:     { owner: 'stdout', persisted: null,      note: 'current activity label (thinking/tool/responding)' },
  _autoResume:         { owner: 'ws',     persisted: 'session-config', note: 'per-session auto-continue-after-limit preference (undefined = follow claude.autoResumeOnLimit; 2.368.0)' },
  _outputStyle:        { owner: 'ws',     persisted: 'session-meta',   note: 'the EFFECTIVE response style this session runs with (claude output style / codex Personality). Spawn-scoped on claude (--settings, stream-json has no /output-style); LIVE on codex (thread/settings/update) — capsOf(backend).responseStyle.live decides. 2.368.0, generalized 2.369.58; persisted so a server restart does not report "default" for a session really running one' },
  _streamingKind:      { owner: 'ws',     persisted: null,      note: 'streaming-label kind (compacting) — drives the client Stop two-step guard; set on a /compact send, reset with the label at turn end (2.365.0)' },
  _codexResetTriedAt:  { owner: 'engine', persisted: null,      note: 'codex reset-credit attempt throttle (one try per limit event, 10min floor; 2.368.21)' },
  _turnWallSigs:       { owner: 'engine', persisted: null,      note: 'wall machine (2.369.0): wall signals accumulated on the CURRENT turn ({at, resetsAtMs, bucket, scopedName, key} — key = the org-verified cache key the mark landed on, B-2c9b); the result record classifies' },
  _turnWorkAfterSig:   { owner: 'engine', persisted: null,      note: 'wall machine: assistant records seen after the last wall signal (work evidence → turn classifies NORMAL)' },
  _wallProbeTimer:     { owner: 'engine', persisted: null,      note: 'wall machine: pending quota-probe backoff timer (30m→1h→2h) when no reset time is known' },
  _arFiring:           { owner: 'auto-resume', persisted: null, note: 'async pre-fire gate in flight (probe+verdict) — tick skips the session meanwhile' },
  _codexLastResetsAt:  { owner: 'engine', persisted: null,      note: 'resets_at (unix sec) of the codex limit that triggered the reset-credit try — auto-resume arms from it if the credit fails (2.368.21)' },
  _codexLimitsWaiters: { owner: 'engine', persisted: null,      note: 'rpc-rate-limits probe waiters (S4 caps-routed quota probe): {resolve,timer} entries settled by the next rate_limits_updated AFTER its cache write; bounded by a timeout' },
  _interruptTimer:     { owner: 'ws',     persisted: null,      note: 'delayed-SIGINT fallback handle (2s, cancel on protocol success)' },
  _wrapperFrameFile:   { owner: 'ws',     persisted: null,      note: 'wrapper understands _frame_file pointers (meta.caps at wrapper boot, chat-wrapper AND codex-chat-wrapper; 2.361.1 skew gate — old wrappers silently DROP pointer lines; positive verdict only)' },
  _msgReachability:    { owner: 'agent',  persisted: 'meta',    note: 'per-session external reach override for agent messaging (2.362.0 Channels v1: inherit|visible|messageable, widening only; set via Session Properties)' },
  _stdinAckReceived:   { owner: 'stdout', persisted: null,      note: 'wrapper _stdin_ack seen — broken-pty detector input' },
  _pendingEditor:      { owner: 'ws',     persisted: null,      note: 'Ctrl+G editor open in flight' },

  // goal
  _goal:               { owner: 'goal',   persisted: 'wrapper', note: 'active objective text' },
  _goalStatus:         { owner: 'goal',   persisted: 'wrapper', note: 'active/paused/blocked/usageLimited/…' },
  _goalElapsed:        { owner: 'goal',   persisted: 'wrapper', note: 'seconds used' },
  _goalTokensUsed:     { owner: 'goal',   persisted: 'wrapper', note: 'tokens used' },
  _prevGoal:           { owner: 'goal',   persisted: 'wrapper', note: 'replaced goal for /goal resume' },
  _lastGoalStatusUuid: { owner: 'goal',   persisted: null,      note: 'JSONL goal_status dedup cursor' },
  _goalJsonlFetchAt:   { owner: 'goal',   persisted: null,      note: 'remote transcript pull throttle for goal sync' },

  // model / billing identity
  _servedModel:        { owner: 'stdout', persisted: null,      note: 'last MAIN-THREAD assistant model (never sidechain)' },
  _servedModelAt:      { owner: 'stdout', persisted: null,      note: 'timestamp of the above' },
  _pickedModel:        { owner: 'pool',   persisted: 'meta',    note: 'set-model pick (plan C identity ladder)' },
  _pickedModelAt:      { owner: 'pool',   persisted: 'meta',    note: 'timestamp of the pick' },
  _spawnModel:         { owner: 'ws',     persisted: 'meta',    note: 'model at spawn (identity ladder fallback)' },
  _modelLocked:        { owner: 'pool',   persisted: 'meta',    note: 'per-conversation model lock flag' },
  _lockedModel:        { owner: 'pool',   persisted: 'meta',    note: 'lock target (full id upgraded from the CLI echo)' },
  _fallbackStopFired:  { owner: 'pool',   persisted: null,      note: 'once-per-turn stop-on-fallback belt latch' },
  _apiKeySource:       { owner: 'stdout', persisted: 'meta',    note: "CLI's own init apiKeySource (billing truth)" },
  _effort:             { owner: 'ws',     persisted: 'meta',    note: 'effort the NEXT turn will run at; ws on a client pick, and (2.369.61) the codex stdout consumer from wrapper_meta.effortNext — a `/effort` typed into the chat used to leave this stale for the next resume' },
  _permissionMode:     { owner: 'ws',     persisted: 'meta',    note: 'launch/set permission mode (not in JSONL)' },

  // resume / fork
  _forkRequested:      { owner: 'ws',     persisted: null,      note: 'one-shot fork flag gating id adoption (2.156.1)' },
  _resumeSpawn:        { owner: 'ws',     persisted: 'meta',    note: 'spawn was a --resume (implicit-fork adoption gate)' },
  _sawFirstId:         { owner: 'stdout', persisted: 'meta',    note: 'first id line consumed (adoption bookkeeping)' },
  _resumeSwept:        { owner: 'ws',     persisted: null,      note: 'writer sweep SWEPT: pids for the created reply' },
  _resumeWarning:      { owner: 'ws',     persisted: null,      note: 'non-fatal resume degradation note for the client' },
  _reattachAttempts:   { owner: 'stdout', persisted: null,      note: 'bounded dead-socket re-attach counter' },
  _cwdRecreated:       { owner: 'ws',     persisted: 'meta',    note: 'B-7812 recreate-cwd notice armed' },

  // remote / transport
  _remoteState:        { owner: 'stdout', persisted: 'wrapper', note: 'remote keeper link state (reconnecting chip)' },
  _remotePort:         { owner: 'ws',     persisted: null,      note: 'reverse-tunnel port for VIBESPACE_API' },
  _agentdSession:      { owner: 'ws',     persisted: 'meta',    note: 'daemon pipe-session marker (R6/M2)' },
  _agentdCfgFile:      { owner: 'ws',     persisted: null,      note: 'attach-cli cfg file path (cleanup)' },
  _dialDeviceId:       { owner: 'dial',   persisted: 'meta',    note: 'owning dial device id' },
  _dialReversePort:    { owner: 'dial',   persisted: null,      note: 'device-side reverse forward port' },
  _bridgePort:         { owner: 'dial',   persisted: 'meta',    note: 'DialSessionBridge loopback port' },

  // misc consumers
  _sizeOwnerWs:        { owner: 'ws',     persisted: null,      note: 'size-override owner connection' },
  _todos:              { owner: 'stdout', persisted: null,      note: 'TodoWrite/TaskCreate-derived {done,total,current}' },
  _sbSeen:             { owner: 'brain',  persisted: null,      note: 'first-writer-wins record gate (bounded set)' },
  _codexThreadBaseline: { owner: 'ws',    persisted: null,      note: 'codex thread listing baseline for capture' },
  _captureReservedThreadId: { owner: 'ws', persisted: null,     note: 'codex reserved thread id during create' },
};

module.exports = { SESSION_FIELDS };
