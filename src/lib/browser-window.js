/**
 * Open an embedded browser window with URL bar, proxy toggle, and error overlay.
 * Returns the winInfo object.
 */
export function openBrowser(app, url, { syncId } = {}) {
  app._hideWelcome();
  const startUrl = url || '';
  const winInfo = app.wm.createWindow({ title: startUrl ? new URL(startUrl).hostname : 'Browser', type: 'browser', syncId });
  winInfo._openSpec = { action: 'openBrowser', url: startUrl };
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;height:100%';

  // URL bar
  const urlBar = document.createElement('div');
  urlBar.style.cssText = 'display:flex;gap:4px;padding:4px 6px;border-bottom:1px solid var(--border);background:var(--bg-titlebar);flex-shrink:0';
  const urlInput = document.createElement('input');
  urlInput.className = 'file-path-input';
  urlInput.value = startUrl;
  urlInput.placeholder = 'Enter URL...';
  const goBtn = document.createElement('button');
  goBtn.className = 'file-tool-btn'; goBtn.textContent = '\u2192'; goBtn.title = 'Go';
  goBtn.style.width = '28px';
  let proxyMode = false;
  const proxyBtn = document.createElement('button');
  proxyBtn.className = 'file-tool-btn'; proxyBtn.title = 'Proxy mode (bypass X-Frame-Options)';
  proxyBtn.style.cssText = 'width:auto;padding:0 6px;font-size:10px';
  proxyBtn.textContent = 'Proxy: Off';
  proxyBtn.onclick = () => {
    proxyMode = !proxyMode;
    proxyBtn.textContent = proxyMode ? 'Proxy: On' : 'Proxy: Off';
    proxyBtn.style.color = proxyMode ? 'var(--accent)' : '';
    // Re-navigate with new mode
    if (urlInput.value) navigate(urlInput.value);
  };
  const openExtBtn = document.createElement('button');
  openExtBtn.className = 'file-tool-btn'; openExtBtn.textContent = '\u2197'; openExtBtn.title = 'Open in new tab';
  openExtBtn.style.width = '28px';
  openExtBtn.onclick = () => { if (urlInput.value) window.open(urlInput.value, '_blank'); };
  urlBar.append(urlInput, goBtn, proxyBtn, openExtBtn);

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'flex:1;border:none;width:100%;background:#fff';
  // No sandbox for maximum compatibility — same-origin pages (noVNC, local services) work fully
  // External sites may still block via X-Frame-Options (browser security, can't bypass)

  const errorMsg = document.createElement('div');
  errorMsg.style.cssText = 'display:none;flex:1;padding:20px;text-align:center;color:var(--text-dim);font-size:12px';

  const navigate = (u) => {
    if (!u) return;
    if (!u.match(/^https?:\/\//)) u = 'http://' + u;
    urlInput.value = u;
    errorMsg.style.display = 'none';
    iframe.style.display = '';
    iframe.src = proxyMode ? `/proxy/${u}` : u;
    try { app.wm.setTitle(winInfo.id, new URL(u).hostname); } catch {}
    winInfo._browserUrl = u;
  };

  // Detect load failures (X-Frame-Options, CSP, etc.)
  iframe.addEventListener('load', () => {
    try { iframe.contentWindow.document; } catch {
      // Cross-origin blocked — show error
      errorMsg.innerHTML = `<p>This site blocked iframe embedding (X-Frame-Options).</p><p style="margin-top:8px"><a href="${urlInput.value}" target="_blank" style="color:var(--accent)">Open in new tab \u2197</a></p><p style="margin-top:12px;font-size:11px;opacity:0.6">Tip: Same-origin pages (noVNC, local services) work fine in this browser.</p>`;
      errorMsg.style.display = '';
      iframe.style.display = 'none';
    }
  });

  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlInput.value); });
  goBtn.onclick = () => navigate(urlInput.value);

  container.append(urlBar, iframe, errorMsg);
  winInfo.content.appendChild(container);
  winInfo.onClose = () => app._checkWelcome();

  if (startUrl) navigate(startUrl);
  return winInfo;
}
