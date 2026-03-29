// Helper script to sanitize UI for documentation screenshots.
// Run via browser console or inject via agent-browser.
// Replaces personal data with generic demo names.

(function sanitizeForScreenshots() {
  // Sanitize sidebar session cards — replace names and paths
  const demoNames = [
    'API Server', 'Frontend Dev', 'Data Pipeline', 'CLI Tool',
    'Auth Service', 'Test Suite', 'Documentation', 'DevOps Config'
  ];
  const demoPaths = [
    '~/projects/api-server', '~/projects/frontend', '~/projects/pipeline',
    '~/projects/cli-tool', '~/projects/auth', '~/projects/tests',
    '~/projects/docs', '~/projects/devops'
  ];

  document.querySelectorAll('.session-card-name').forEach((el, i) => {
    el.textContent = demoNames[i % demoNames.length];
  });

  // Sanitize session detail values (paths, IDs)
  document.querySelectorAll('.session-detail-value').forEach(el => {
    const text = el.textContent;
    if (text.startsWith('/home/')) {
      el.textContent = text.replace(/\/home\/[^/]+/, '/home/user');
    }
    // Replace real session IDs with demo ones
    if (/^[0-9a-f]{8}-/.test(text)) {
      el.textContent = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    }
  });

  // Sanitize folder group headers
  document.querySelectorAll('.folder-path').forEach(el => {
    const text = el.childNodes[0]?.textContent || '';
    if (text.startsWith('/home/')) {
      el.childNodes[0].textContent = text.replace(/\/home\/[^/]+/, '/home/user');
    }
  });

  // Sanitize window title bars
  document.querySelectorAll('.window-title span').forEach(el => {
    const text = el.textContent;
    if (text.includes('/home/')) {
      el.textContent = text.replace(/\/home\/[^/]+/g, '/home/user');
    }
  });

  // Sanitize file explorer path input
  document.querySelectorAll('.file-path-input').forEach(el => {
    if (el.value.startsWith('/home/')) {
      el.value = el.value.replace(/\/home\/[^/]+/, '/home/user');
    }
  });

  console.log('UI sanitized for screenshots');
})();
