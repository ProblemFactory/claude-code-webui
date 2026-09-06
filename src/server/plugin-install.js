'use strict';
// PLUGIN INSTALL SOURCES (Plugin Ph4, 2.369.30 — docs/design-harness-plugins.md
// §3.2 "打包/分发/版本", docs/plugins.md). Four ways a plugin package reaches
// data/plugins/<id>/, ONE staging pipeline:
//   path            copy a local directory holding vibespace-plugin.json
//   git             `git clone --depth 1` (execFile, 60s, https/ssh forms only — no shell)
//   zip             a `.vsp` (= zip) upload, extracted with the system `unzip`
//                   (the same tool src/routes/files.js archive ops use), Zip-Slip-proof
//   github-release  owner/repo[@tag] → the release's *.vsp asset via the public
//                   GitHub API (no token) → the zip path
// Every source lands in <rootDir>/data/plugins-staging/<random>/ (same
// filesystem as data/plugins so the final step is a rename), the manifest is
// validated THERE (host version, capability paths against the forbidden roots),
// symlinks anywhere in the package are refused (a symlink to / plus a file
// under it is the classic Zip-Slip-by-link), and only then does the package
// move into place. A previous copy of the same id is MOVED to the trash, never
// deleted — same for uninstall: data/plugins-trash/<id>-<ts>/{plugin,state}.
// ORCH tier. Pure staging helpers are exported for the test suite.
// 2.369.43: the walk + the copy are ASYNC (an owner-supplied path must never
// block the event loop), auditTree also returns a package contentHash (the
// loader's "is this the same package?" test for reinstall consent), and the
// uploaded temp file is removed on EVERY exit path (the source whitelist used
// to throw above the try/finally).
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { validateManifest } = require('../plugin-manifest');

const MANIFEST = 'vibespace-plugin.json';
const MAX_ZIP_BYTES = 50 * 1024 * 1024;       // upload / release asset cap
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;  // unpacked cap (path/git/zip)
const MAX_PACKAGE_FILES = 20000;
const MAX_PACKAGE_DEPTH = 32;                 // a bounded walk (symlinks are refused, but depth is still capped)
const GIT_TIMEOUT_MS = 60000;
const GIT_HTTPS_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._\/-]+$/;
const GIT_SSH_RE = /^(?:ssh:\/\/)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?[:/][A-Za-z0-9._\/-]+$/;
const GH_SPEC_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:@([A-Za-z0-9._\/-]+))?$/;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { const e = new Error((String(stderr || '').trim() || err.message).split('\n')[0].slice(0, 300)); e.code = err.code; return reject(e); }
    resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

/** Walk a directory tree: refuse symlinks, count files/bytes, cap both, and
 *  (opt-in) fingerprint the CONTENT — sha256 over `relpath\0size\0filehash` in
 *  sorted order. That fingerprint is the installer's answer to "is this the
 *  same package?", which is what lets the loader decide whether an existing
 *  plugin's consent may survive a reinstall.
 *  ASYNC BY LAW (2.369.43): this walks an OWNER-SUPPLIED path — the old sync
 *  walk + sync ≤200 MB copy blocked the whole instance's event loop (the "never
 *  block the event loop" law; three past outages came from exactly this). Depth
 *  is bounded too: symlinks are refused, but a pathological tree must not
 *  recurse without a limit. */
async function auditTree(root, { maxFiles = MAX_PACKAGE_FILES, maxBytes = MAX_PACKAGE_BYTES, maxDepth = MAX_PACKAGE_DEPTH, hash = true } = {}) {
  let files = 0, bytes = 0;
  const entries = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth) throw httpErr(400, `package nests deeper than ${maxDepth} directories`);
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) throw httpErr(400, `package contains a symlink (${path.relative(root, p)}) — symlinks are refused in plugin packages`);
      if (d.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!d.isFile()) throw httpErr(400, `package contains a non-regular file (${path.relative(root, p)})`);
      const st = await fsp.stat(p);
      files++; bytes += st.size;
      if (files > maxFiles) throw httpErr(413, `package has more than ${maxFiles} files`);
      if (bytes > maxBytes) throw httpErr(413, `package is larger than ${Math.round(maxBytes / 1048576)} MB`);
      entries.push({ rel: path.relative(root, p), size: st.size, abs: p });
    }
  };
  await walk(root, 0);
  let contentHash = null;
  if (hash) {
    const h = crypto.createHash('sha256');
    for (const e of entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) h.update(`${e.rel}\0${e.size}\0${await hashFile(e.abs)}\n`);
    contentHash = h.digest('hex');
  }
  return { files, bytes, contentHash };
}

/** sha256 of one file, STREAMED (a 200 MB readFile would spike memory). */
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** The directory inside `stage` that holds the manifest: the root, or a single
 *  top-level folder (GitHub zips / cp of a folder wrap the package once). */
function findPackageRoot(stage) {
  if (fs.existsSync(path.join(stage, MANIFEST))) return stage;
  const entries = fs.readdirSync(stage, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') && d.name !== '__MACOSX');
  if (entries.length === 1 && entries[0].isDirectory() && fs.existsSync(path.join(stage, entries[0].name, MANIFEST))) return path.join(stage, entries[0].name);
  throw httpErr(400, `no ${MANIFEST} at the package root`);
}

function expandTilde(p) { return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p; }

// ── staging per source (each returns the directory holding the manifest) ──
async function stageFromPath(value, stage) {
  const src = path.resolve(expandTilde(String(value || '').trim()));
  if (!src || src === '/') throw httpErr(400, 'path: give the directory that holds vibespace-plugin.json');
  let st; try { st = await fsp.stat(src); } catch { throw httpErr(400, `path: ${src} does not exist`); }
  if (!st.isDirectory()) throw httpErr(400, `path: ${src} is not a directory`);
  if (!fs.existsSync(path.join(src, MANIFEST))) throw httpErr(400, `path: ${src} has no ${MANIFEST}`);
  await auditTree(src, { hash: false }); // refuse symlinks + size before copying anything (the STAGED copy is what gets fingerprinted)
  const dest = path.join(stage, 'pkg');
  await fsp.cp(src, dest, { recursive: true, verbatimSymlinks: true, filter: (p) => path.basename(p) !== '.git' });
  return dest;
}

async function stageFromGit(value, stage) {
  let url = String(value || '').trim(), ref = null;
  const hash = url.indexOf('#');
  if (hash > 0) { ref = url.slice(hash + 1); url = url.slice(0, hash); }
  if (!GIT_HTTPS_RE.test(url) && !GIT_SSH_RE.test(url)) throw httpErr(400, 'git: URL must be https://host/owner/repo(.git) or git@host:owner/repo.git (optionally #branch)');
  if (ref && !/^[A-Za-z0-9._\/-]{1,100}$/.test(ref)) throw httpErr(400, 'git: invalid #ref');
  const dest = path.join(stage, 'pkg');
  const args = ['clone', '--depth', '1', '--quiet', ...(ref ? ['--branch', ref] : []), '--', url, dest];
  try {
    await run('git', args, { timeout: GIT_TIMEOUT_MS, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } });
  } catch (e) { throw httpErr(400, `git clone failed: ${e.message}${e.code === null || /timed?\s*out|ETIMEDOUT/i.test(e.message) ? ' (60s limit)' : ''}`); }
  try { fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true }); } catch { }
  await auditTree(dest, { hash: false });
  return dest;
}

/** unzip with a Zip-Slip audit first: every member name is checked before a
 *  single byte is extracted (unzip itself strips leading / and refuses .. in
 *  recent versions, but a listing pass is cheap and version-proof). */
async function stageFromZip(zipPath, stage) {
  let st; try { st = fs.statSync(zipPath); } catch { throw httpErr(400, 'zip: file missing'); }
  if (st.size > MAX_ZIP_BYTES) throw httpErr(413, `zip: larger than ${Math.round(MAX_ZIP_BYTES / 1048576)} MB`);
  let listing;
  try { listing = (await run('unzip', ['-Z1', zipPath], { timeout: 30000 })).stdout; }
  catch (e) { throw httpErr(400, `not a readable .vsp/.zip archive: ${e.message}`); }
  const names = listing.split('\n').filter(Boolean);
  if (!names.length) throw httpErr(400, 'zip: archive is empty');
  if (names.length > MAX_PACKAGE_FILES) throw httpErr(413, `zip: more than ${MAX_PACKAGE_FILES} entries`);
  for (const n of names) {
    if (n.startsWith('/') || n.includes('\\') || n.split('/').some((seg) => seg === '..')) throw httpErr(400, `zip: refused entry "${n.slice(0, 80)}" (path traversal)`);
  }
  const dest = path.join(stage, 'pkg');
  fs.mkdirSync(dest, { recursive: true });
  try { await run('unzip', ['-q', '-o', zipPath, '-d', dest], { timeout: 120000 }); }
  catch (e) { if (!(e.code === 1)) throw httpErr(400, `unzip failed: ${e.message}`); } // exit 1 = warnings only
  await auditTree(dest, { hash: false });
  return dest;
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

async function stageFromGithubRelease(value, stage) {
  const m = GH_SPEC_RE.exec(String(value || '').trim());
  if (!m) throw httpErr(400, 'github-release: use owner/repo or owner/repo@tag');
  const [, owner, repo, tag] = m;
  const api = `https://api.github.com/repos/${owner}/${repo}/releases/${tag ? 'tags/' + encodeURIComponent(tag) : 'latest'}`;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'vibespace-plugin-installer' };
  let rel;
  try {
    const r = await fetchWithTimeout(api, { headers });
    if (!r.ok) throw new Error(r.status === 404 ? 'release not found (public repositories only)' : `GitHub API answered ${r.status}`);
    rel = await r.json();
  } catch (e) { throw httpErr(400, `github-release: ${e.message}`); }
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const asset = assets.find((a) => /\.vsp$/i.test(a.name || '')) || (assets.filter((a) => /\.zip$/i.test(a.name || '')).length === 1 ? assets.find((a) => /\.zip$/i.test(a.name || '')) : null);
  if (!asset) throw httpErr(400, `github-release: release ${rel.tag_name || ''} has no *.vsp asset (assets: ${assets.map((a) => a.name).join(', ') || 'none'})`);
  if (Number(asset.size) > MAX_ZIP_BYTES) throw httpErr(413, `github-release: asset ${asset.name} is larger than ${Math.round(MAX_ZIP_BYTES / 1048576)} MB`);
  const zipPath = path.join(stage, 'asset.vsp');
  try {
    const r = await fetchWithTimeout(asset.browser_download_url, { headers: { 'user-agent': headers['user-agent'] } }, 120000);
    if (!r.ok) throw new Error(`download answered ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) throw new Error('asset exceeds the size cap');
    fs.writeFileSync(zipPath, buf);
  } catch (e) { throw httpErr(400, `github-release: ${e.message}`); }
  const dir = await stageFromZip(zipPath, stage);
  return { dir, resolvedValue: `${owner}/${repo}@${rel.tag_name || tag || 'latest'}` };
}

function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true }); // only after the copy succeeded — a move, never a delete
  }
}

function create({ rootDir, hostVersion = null, forbiddenRoots = [], log = console } = {}) {
  const pluginsDir = path.join(rootDir, 'data', 'plugins');
  const stateDir = path.join(rootDir, 'data', 'plugins-state');
  const stagingDir = path.join(rootDir, 'data', 'plugins-staging');
  const trashDir = path.join(rootDir, 'data', 'plugins-trash');

  /** Move a plugin's dir + state dir to the trash (never rmSync). Returns the trash path or null. */
  function trash(id, { reason = 'uninstall' } = {}) {
    const pdir = path.join(pluginsDir, id), sdir = path.join(stateDir, id);
    if (!fs.existsSync(pdir) && !fs.existsSync(sdir)) return null;
    const dest = path.join(trashDir, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dest, { recursive: true });
    if (fs.existsSync(pdir)) moveDir(pdir, path.join(dest, 'plugin'));
    if (reason === 'uninstall' && fs.existsSync(sdir)) moveDir(sdir, path.join(dest, 'state'));
    try { fs.writeFileSync(path.join(dest, 'why.json'), JSON.stringify({ id, reason, at: new Date().toISOString() }, null, 2)); } catch { }
    return dest;
  }

  /**
   * Install (or replace) from a source. `expectId` (update) refuses a package
   * whose id differs from the record being updated.
   * `contentHash` fingerprints the staged package so the loader can tell a
   * byte-identical reinstall from a DIFFERENT package claiming the same id.
   * @returns {{ id, version, dir, replaced: boolean, previous: string|null, source, value, contentHash, warnings }}
   */
  async function install({ source, value, file = null, expectId = null } = {}) {
    // The uploaded temp file is cleaned in EVERY exit path — the source
    // whitelist used to throw ABOVE the try/finally, so a bad `source` left the
    // multipart upload sitting in os.tmpdir() forever (2.369.43).
    try {
      source = String(source || '').trim();
      if (!['path', 'git', 'zip', 'github-release'].includes(source)) throw httpErr(400, 'source must be path | git | zip | github-release');
      fs.mkdirSync(stagingDir, { recursive: true });
      const stage = fs.mkdtempSync(path.join(stagingDir, 'st-'));
      let resolvedValue = value;
      try {
        let pkgDir;
        if (source === 'path') pkgDir = await stageFromPath(value, stage);
        else if (source === 'git') pkgDir = await stageFromGit(value, stage);
        else if (source === 'zip') {
          if (!file) throw httpErr(400, 'zip: upload the .vsp file as the multipart field "file"');
          pkgDir = await stageFromZip(file, stage);
          resolvedValue = path.basename(String(value || file));
        } else { const r = await stageFromGithubRelease(value, stage); pkgDir = r.dir; resolvedValue = r.resolvedValue; }
        const root = findPackageRoot(pkgDir);
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf-8')); }
        catch (e) { throw httpErr(400, `${MANIFEST}: ${e.message}`); }
        const v = validateManifest(raw, { hostVersion, homeDir: os.homedir(), forbiddenRoots });
        if (!v.ok) throw httpErr(400, `invalid manifest: ${v.errors.join('; ')}`);
        const id = v.manifest.id;
        if (expectId && id !== expectId) throw httpErr(409, `the package is "${id}" but this record is "${expectId}" — install it as a new plugin instead`);
        if (v.manifest.server && !fs.existsSync(path.join(root, 'server.js'))) throw httpErr(400, 'manifest says server: true but the package has no server.js');
        const { contentHash } = await auditTree(root); // the fingerprint of what actually lands on disk
        const target = path.join(pluginsDir, id);
        const replaced = fs.existsSync(target);
        const previous = replaced ? trash(id, { reason: expectId ? 'update' : 'reinstall' }) : null;
        fs.mkdirSync(pluginsDir, { recursive: true });
        moveDir(root, target);
        log.log?.(`[plugins] installed ${id}@${v.manifest.version} from ${source}${replaced ? ' (previous copy in trash)' : ''}`);
        return { id, version: v.manifest.version, dir: target, replaced, previous, source, value: resolvedValue, contentHash, warnings: v.warnings };
      } finally {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch { }
      }
    } finally {
      if (file) { try { fs.rmSync(file, { force: true }); } catch { } }
    }
  }

  return { install, trash, pluginsDir, stateDir, trashDir, stagingDir };
}

module.exports = { create, auditTree, findPackageRoot, stageFromZip, GIT_HTTPS_RE, GIT_SSH_RE, GH_SPEC_RE, MAX_ZIP_BYTES, MANIFEST };
