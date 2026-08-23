const statusElement = document.querySelector('#backend-status');

try {
  const response = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Health check returned ${response.status}`);
  }

  statusElement.textContent = 'online';
  statusElement.dataset.ready = 'true';
} catch {
  statusElement.textContent = 'unavailable';
  statusElement.dataset.ready = 'false';
}
