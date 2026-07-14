(() => {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const bucket = Math.floor(Date.now() / TWELVE_HOURS);
  const status = document.getElementById('city-calendar-status');
  const note = document.getElementById('calendar-refresh-note');
  const script = document.createElement('script');

  script.src = `https://static.elfsight.com/platform/platform.js?refresh=${bucket}`;
  script.async = true;
  script.dataset.useServiceCore = '';
  script.onload = () => {
    if (status) status.hidden = true;
    try {
      localStorage.setItem('ofallon-calendar-refresh', String(Date.now()));
    } catch (_) {}
  };
  script.onerror = () => {
    if (status) {
      status.classList.add('calendar-error');
      status.innerHTML = 'The live calendar is temporarily unavailable. <a href="https://ofallon.mo.us/city-calendar" target="_blank" rel="noopener">View events on the City website ↗</a>';
    }
  };

  if (note) {
    const refreshed = new Date(bucket * TWELVE_HOURS);
    note.textContent = `Automatic refresh window: ${refreshed.toLocaleDateString([], {month:'short', day:'numeric'})} at ${refreshed.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`;
  }

  document.head.appendChild(script);
})();
