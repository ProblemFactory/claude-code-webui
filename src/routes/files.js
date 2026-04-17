/**
 * File System API routes — file browsing, content read/write, upload/download,
 * clipboard image paste, binary chunks, Excel/Word preview.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const multer = require('multer');

const router = express.Router();

function expandTilde(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.substring(1));
  return p;
}
function safePath(p) { return path.resolve(expandTilde(p)); }

router.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

// System monospace fonts via fc-list (cached)
let _cachedMonoFonts = null;
router.get('/api/fonts', (req, res) => {
  if (_cachedMonoFonts) return res.json({ fonts: _cachedMonoFonts });
  try {
    const out = execFileSync('fc-list', [':spacing=mono', 'family'], { encoding: 'utf-8', timeout: 3000 });
    const fonts = [...new Set(
      out.trim().split('\n')
        .map(line => line.split(',')[0].trim())
        .filter(f => f && !/emoji|sign/i.test(f))
    )].sort((a, b) => a.localeCompare(b));
    _cachedMonoFonts = fonts;
    res.json({ fonts });
  } catch {
    res.json({ fonts: [] });
  }
});

// Directory autocomplete — returns dirs matching partial path, with 500ms timeout
router.get('/api/dir-complete', (req, res) => {
  const input = req.query.path || '';
  const timeout = setTimeout(() => { if (!res.headersSent) res.json({ suggestions: [] }); }, 500);

  try {
    const expanded = expandTilde(input);
    const lastSlash = expanded.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? expanded.substring(0, lastSlash) || '/' : '.';
    const prefix = lastSlash >= 0 ? expanded.substring(lastSlash + 1).toLowerCase() : expanded.toLowerCase();
    const resolved = path.resolve(parentDir);

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() && !(e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(resolved, e.name)).isDirectory(); } catch { return false; } })())) continue;
      if (e.name.startsWith('.') && !prefix.startsWith('.')) continue;
      if (prefix && !e.name.toLowerCase().startsWith(prefix)) continue;
      dirs.push(path.join(resolved, e.name));
      if (dirs.length >= 20) break;
    }
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ suggestions: dirs });
  } catch {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ suggestions: [] });
  }
});

router.get('/api/files', (req, res) => {
  const dirPath = safePath(req.query.path || os.homedir());
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(e => {
      let stat = null;
      try { stat = fs.statSync(path.join(dirPath, e.name)); } catch {}
      return {
        name: e.name,
        isDirectory: e.isDirectory() || (e.isSymbolicLink() && stat?.isDirectory()),
        size: stat?.size || 0,
        modified: stat?.mtimeMs || 0,
        created: stat?.birthtimeMs || 0,
      };
    });
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dirPath, items });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// File info (size + binary detection) without reading full content
router.get('/api/file/info', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const stat = fs.statSync(filePath);
    let isBinary = false;
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      for (let i = 0; i < bytesRead; i++) { if (buf[i] === 0) { isBinary = true; break; } }
    } catch {}
    res.json({ path: filePath, size: stat.size, modified: stat.mtimeMs, isBinary, isDirectory: stat.isDirectory() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Read text file content (limit raised to 10MB)
router.get('/api/file/content', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (>10MB). Use hex viewer.', size: stat.size });
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ path: filePath, content, size: stat.size });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Read binary file chunk as raw bytes
router.get('/api/file/binary', (req, res) => {
  const filePath = safePath(req.query.path);
  const offset = parseInt(req.query.offset) || 0;
  const length = Math.min(parseInt(req.query.length) || 65536, 1048576); // max 1MB per chunk
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    const stat = fs.statSync(filePath);
    res.set({ 'Content-Type': 'application/octet-stream', 'X-File-Size': stat.size, 'X-Offset': offset, 'X-Bytes-Read': bytesRead });
    res.send(buf.slice(0, bytesRead));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Serve raw files (PDF, images, etc.)
router.get('/api/file/raw', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    res.sendFile(filePath);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Download file
router.get('/api/download', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    res.download(filePath);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Preview Excel files
router.get('/api/file/excel', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    const sheets = workbook.SheetNames.map(name => ({
      name,
      data: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }),
    }));
    res.json({ sheets });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Preview Word files
router.get('/api/file/docx', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const mammoth = require('mammoth');
    mammoth.convertToHtml({ path: filePath }).then(result => {
      res.json({ html: result.value });
    }).catch(err => res.status(400).json({ error: err.message }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/api/mkdir', (req, res) => {
  try { fs.mkdirSync(safePath(req.body.path), { recursive: true }); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/api/file/write', (req, res) => {
  try { fs.writeFileSync(safePath(req.body.path), req.body.content || ''); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/api/rename', (req, res) => {
  try { fs.renameSync(safePath(req.body.oldPath), safePath(req.body.newPath)); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/api/file', (req, res) => {
  const filePath = safePath(req.query.path);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true });
    else fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// File upload
const upload = multer({ dest: '/tmp/claude-webui-uploads/' });
router.post('/api/upload', upload.array('files'), (req, res) => {
  const destDir = req.body.destDir || os.homedir();
  const preservePaths = req.body.preservePaths === '1'; // folder upload: keep relative paths
  // Client sends correct UTF-8 filenames as JSON to avoid multer encoding issues
  let clientNames = [];
  try { clientNames = JSON.parse(req.body.fileNames || '[]'); } catch {}
  try {
    const results = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const name = clientNames[i] || file.originalname;
      const dest = path.join(destDir, name);
      // For folder uploads, create intermediate directories
      if (preservePaths && name.includes('/')) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
      }
      fs.copyFileSync(file.path, dest);
      fs.unlinkSync(file.path);
      results.push({ name, path: dest, size: file.size });
    }
    res.json({ success: true, files: results });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Paste image from clipboard → save to temp file + set X clipboard via xclip
router.post('/api/paste-image', (req, res) => {
  try {
    const { dataUrl } = req.body; // "data:image/png;base64,..."
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Not an image' });
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid data URL' });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const mimeType = `image/${match[1]}`;
    const buf = Buffer.from(match[2], 'base64');
    const tmpPath = path.join(os.tmpdir(), `claude-paste-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buf);
    // Set system clipboard with image — macOS uses osascript, Linux uses xclip
    const isMac = process.platform === 'darwin';
    try {
      if (isMac) {
        execFileSync('osascript', ['-e', `set the clipboard to (read POSIX file "${tmpPath}" as «class PNGf»)`], { timeout: 5000 });
        res.json({ path: tmpPath, ready: true });
      } else {
        const clipEnv = { ...process.env, DISPLAY: process.env.DISPLAY || ':99' };
        const cp = spawn('bash', ['-c', `cat "${tmpPath}" | xclip -selection clipboard -t ${mimeType}`], {
          env: clipEnv, detached: true, stdio: 'ignore',
        });
        cp.unref();
        const pollStart = Date.now();
        const poll = () => {
          try {
            const out = execFileSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
              env: clipEnv, encoding: 'utf-8', timeout: 1000,
            });
            if (out.includes('image/')) return res.json({ path: tmpPath, ready: true });
          } catch {}
          if (Date.now() - pollStart < 5000) setTimeout(poll, 200);
          else res.json({ path: tmpPath, ready: false });
        };
        setTimeout(poll, 300);
      }
    } catch {
      res.json({ path: tmpPath, ready: false });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV/TSV streaming: read only requested row range from a file
// Supports large files by reading line-by-line without loading entire file
router.get('/api/file/csv', (req, res) => {
  const filePath = safePath(req.query.path);
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 100;
  const sep = req.query.sep || ',';

  try {
    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    let lineNum = 0, headerRow = null;
    const rows = [];
    let partial = '';
    let totalLines = 0;
    let done = false;

    stream.on('data', (chunk) => {
      if (done) return;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop(); // last partial line
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed) continue;
        if (lineNum === 0) {
          headerRow = trimmed.split(sep).map(c => c.trim());
        } else if (lineNum > offset && rows.length < limit) {
          rows.push(trimmed.split(sep).map(c => c.trim()));
        }
        lineNum++;
        totalLines = lineNum;
        // Stop reading early if we have enough data and want a rough total estimate
        if (rows.length >= limit && lineNum > offset + limit + 10000) {
          done = true;
          stream.destroy();
          break;
        }
      }
    });

    stream.on('end', () => {
      if (partial.trim()) { totalLines++; if (lineNum > offset && rows.length < limit) rows.push(partial.split(sep).map(c => c.trim())); }
      res.json({ header: headerRow, rows, offset: offset, total: totalLines, fileSize: stat.size });
    });
    stream.on('close', () => {
      if (!res.headersSent) {
        // Estimate total from file size if we stopped early
        const bytesPerLine = stat.size / Math.max(1, totalLines);
        const estimatedTotal = Math.round(stat.size / bytesPerLine);
        res.json({ header: headerRow, rows, offset, total: done ? estimatedTotal : totalLines, fileSize: stat.size, estimated: done });
      }
    });
    stream.on('error', (err) => { if (!res.headersSent) res.status(400).json({ error: err.message }); });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Format code via server-side CLI tools (for languages not supported by Prettier)
router.post('/api/format', (req, res) => {
  const { code, language, filePath } = req.body;
  if (!code || !language) return res.status(400).json({ error: 'code and language required' });

  // Map language → CLI formatter command
  const formatters = {
    python: { cmd: 'black', args: ['-', '-q', '--fast'], stdin: true },
    shell: { cmd: 'shfmt', args: ['-'], stdin: true },
    go: { cmd: 'gofmt', args: [], stdin: true },
    rust: { cmd: 'rustfmt', args: ['--edition', '2021'], stdin: true },
  };

  // Try ruff first for Python (faster), fall back to black
  const fmt = formatters[language];
  if (!fmt) return res.status(400).json({ error: `No server-side formatter for ${language}` });

  const tryFormat = (cmd, args) => {
    try {
      const result = execFileSync(cmd === 'ruff' ? 'ruff' : cmd,
        cmd === 'ruff' ? ['format', '-'] : args,
        { input: code, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      return result;
    } catch (err) {
      if (err.stdout) return err.stdout; // some formatters return non-zero but still output
      throw err;
    }
  };

  try {
    let formatted;
    if (language === 'python') {
      // Try ruff format first (fast), fall back to black
      try { formatted = tryFormat('ruff', ['format', '-']); }
      catch { formatted = tryFormat('black', ['-', '-q', '--fast']); }
    } else {
      formatted = tryFormat(fmt.cmd, fmt.args);
    }
    res.json({ formatted });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    res.status(422).json({ error: stderr.split('\n')[0]?.substring(0, 200) || 'Format failed' });
  }
});

module.exports = router;
