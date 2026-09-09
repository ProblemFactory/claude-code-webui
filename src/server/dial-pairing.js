'use strict';
// DIAL PAIRING PRIMITIVES (decomposition #13): Transport B server side —
// dial-token minting, dialed-in device registry, deviceForDial (never reuses a
// stop()ed DeviceManager — 2.169.0 invariant), host agentd provisioning,
// daemonPtyShim and the unpair teardown. Extracted VERBATIM. ORCH tier.
const fs = require('fs');
const path = require('path');

const { mk } = require('./lazy.js');

function create({ rootDir, AGENTD_DIR, agentdHostToken, getHosts, getMounts,
  getMachineMounts, getPortForwards, getExitProxy }) {
  const hosts = mk(getHosts);
  const mounts = mk(getMounts);
  const machineMounts = mk(getMachineMounts);
  const portForwards = mk(getPortForwards);
  const exitProxy = mk(getExitProxy);
  const _agentdInstalled = new Map(); // hostId → version
// ── Transport B (dial-out) server side: devices behind NAT dial US. Pairing
// mints {deviceId, dialToken}; the daemon presents the dial token at the ws
// upgrade (gates the endpoint), then the normal hello/vsht_ auth runs INSIDE
// the mux like every transport. Incoming dials land in a registry the
// device's transport waits on. ──
const agentdDials = new Map();      // deviceId → ws stream adapter (live dial)
// B-f3e8: the pairing credential lives ON the dial host record (hosts.json
// dialTokenHash) — dial-tokens.json is migrated once at boot (below, after
// HostManager construction) and there is no separate device registry anymore.
function agentdMintDialPair(deviceId) {
  ensureDir(AGENTD_DIR);
  const tok = 'vsdt_' + require('crypto').randomBytes(18).toString('hex');
  hosts.setDialToken(deviceId, require('crypto').createHash('sha256').update(tok).digest('hex'));
  // the device token (vsht_) for in-mux auth ships in the install payload
  return { deviceId, dialToken: tok, hostToken: agentdHostToken('dial-' + deviceId) };
}
/** Full unpair of a dial machine (DELETE /api/hosts/:id on a dial record):
 *  mounts torn down, vsht_ token file gone, live stream destroyed. The token
 *  hash dies with the host record itself. */
async function unpairDialDevice(deviceId) {
  try { await machineMounts.onMachineUnpaired(hosts.findByDeviceId(deviceId)?.id); } catch { }
  try { portForwards.onMachineUnpaired(hosts.findByDeviceId(deviceId)?.id); } catch { }
  try { exitProxy.onMachineUnpaired(hosts.findByDeviceId(deviceId)?.id); } catch { }
  try { fs.unlinkSync(path.join(AGENTD_DIR, `host-dial-${deviceId}.token`)); } catch { }
  const live = agentdDials.get(deviceId);
  if (live) { try { live.destroy(); } catch { } agentdDials.delete(deviceId); }
  agentdDialDevices.delete(deviceId);
}
// A DeviceManager over a DIALED-IN device (Transport B consumption): the
// device's daemon holds the mux-server end; we drive it (fs/serve-folder/
// tcp-forward) as the client over the live ws stream in agentdDials. Reused
// per device; reconnects follow the device's --dial retries (getStream picks
// up the fresh stream). Enables 'device' mounts + remote fs for NAT'd devices.
const agentdDialDevices = new Map(); // deviceId → DeviceManager
async function deviceForDial(deviceId, _retried = false) {
  // FAIL FAST when the device isn't dialed in: the stream transport's connect
  // loop otherwise backs off and retries FOREVER, so every operation against
  // an offline device (session create, mount, test) HUNG instead of erroring
  // (real report: create卡住/terminal空白/mount打不开 — Mac daemon died after
  // a self-upgrade re-exec and nothing surfaced it).
  const curStream = agentdDials.get(deviceId);
  if (!curStream) throw new Error(`device "${deviceId}" is offline — its daemon is not dialed in (rerun the install command on it)`);
  let dm = agentdDialDevices.get(deviceId);
  // STALE-STREAM GUARD (real report: online=true but every fs op/session
  // blank): the device re-dialed after a self-upgrade re-exec, so agentdDials
  // holds a FRESH stream — but the cached DeviceManager's mux is still bound
  // to the DEAD old stream, and its status().connected can lag true. Rebuild
  // whenever the live stream differs from the one this dm connected over.
  // A STOPPED dm must be treated exactly like a stale stream: stop() is
  // terminal (_connectLoop throws 'stopped' forever), so reusing one wedges
  // EVERY op against an otherwise-healthy device until the stream changes
  // (real userW outage: hours of "offline"/'stopped' while the Mac was
  // dialed-in and fine — a re-dial/unpair race stopped the cached dm).
  if (dm && (dm._stopped || (dm._dialStream && dm._dialStream !== curStream))) {
    try { dm.stop?.(); } catch { }
    dm = null;
    agentdDialDevices.delete(deviceId);
  }
  if (dm && dm.status().connected) return dm;
  if (!dm) {
    const { DeviceManager } = require('../agentd/client.js');
    dm = new DeviceManager({
      dataDir: path.join(rootDir, 'data'),
      bundlePath: path.join(rootDir, 'data', 'bin', 'vibespace-agentd.js'),
      version: require('../../package.json').version,
      transport: { kind: 'stream', hostToken: agentdHostToken('dial-' + deviceId), getStream: () => agentdDials.get(deviceId) || null },
      log: (...a) => console.log('[device-dial]', ...a),
    });
    agentdDialDevices.set(deviceId, dm);
  }
  dm._dialStream = curStream; // remember which stream we bind the mux to
  try {
    await dm.connect();
  } catch (e) {
    // never leave a failed dm in the cache — the next op must rebuild clean
    try { dm.stop?.(); } catch { }
    if (agentdDialDevices.get(deviceId) === dm) agentdDialDevices.delete(deviceId);
    // a dm stopped MID-CONNECT by a concurrent re-dial cleanup surfaces one
    // transient 'stopped' — while the stream is live, rebuild once instead of
    // failing the caller's FIRST op after a re-dial (seen live on the userW
    // verification: test probe errored once, next op self-healed)
    if (!_retried && String(e && e.message) === 'stopped' && agentdDials.get(deviceId)) {
      return deviceForDial(deviceId, true);
    }
    throw e;
  }
  return dm;
}
async function ensureAgentdOnHost(hostId) {
  const version = require('../../package.json').version;
  if (_agentdInstalled.get(hostId) === version) return;
  const bundlePath = path.join(rootDir, 'data', 'bin', 'vibespace-agentd.js');
  await hosts.installAgentd(hostId, bundlePath, version, agentdHostToken(hostId));
  _agentdInstalled.set(hostId, version);
}
// The node-pty DUCK over a device session handle. `onData`/`onExit` hold a SET
// of listeners, not one slot, because that is what node-pty's own onData does
// and setupSessionPty now registers TWO of them (the liveness stamp + the
// protocol consumer). A single-slot shim silently REPLACED the first
// registration — with the stamp registered first, the whole stdout consumer
// would have gone dead on every daemon-attached session. `dispose()` removes
// only its own callback.
function daemonPtyShim(handle) {
  const dataCbs = new Set(), exitCbs = new Set();
  handle.onData = (buf) => { const s = buf.toString('utf-8'); for (const cb of [...dataCbs]) { try { cb(s); } catch {} } };
  handle.onExit = (code) => { for (const cb of [...exitCbs]) { try { cb({ exitCode: code }); } catch {} } };
  return {
    _daemon: true,
    get pid() { return handle.pid; },
    onData(cb) { dataCbs.add(cb); return { dispose() { dataCbs.delete(cb); } }; },
    onExit(cb) { exitCbs.add(cb); return { dispose() { exitCbs.delete(cb); } }; },
    write(s) { try { handle.write(s); } catch {} },
    resize(cols, rows) { try { handle.resize(cols, rows); } catch {} },
    kill() { try { handle.kill(); } catch {} },
  };
}
const CHAT_WRAPPER = path.join(rootDir, 'data', 'bin', 'chat-wrapper.js');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

  return { CHAT_WRAPPER, agentdDialDevices, agentdDials,
    agentdMintDialPair, daemonPtyShim, deviceForDial, ensureAgentdOnHost,
    unpairDialDevice };
}
module.exports = { create };
