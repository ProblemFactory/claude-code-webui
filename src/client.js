import { App } from './lib/app.js';
window.addEventListener('DOMContentLoaded', async () => {
  window.app = new App();
  await window.app.ready;
  const splash = document.getElementById('loading-screen');
  if (splash) { splash.style.opacity = '0'; setTimeout(() => splash.remove(), 300); }
});
