import { App } from './lib/app.js';
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  // Remove loading screen
  const splash = document.getElementById('loading-screen');
  if (splash) { splash.style.opacity = '0'; setTimeout(() => splash.remove(), 300); }
});
