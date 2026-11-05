// CSM SVG Icons Library
(function () {
  'use strict';

  function svg(path, { size = 16, viewBox = '0 0 20 20', className = 'csm-icon' } = {}) {
    return `<svg class="${className}" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  const ICONS = {
    logo: `<img src="icons/logo.png" width="28" height="28" class="csm-logo-img" alt="CSM">`,

    refresh: svg('<path d="M3.5 10a6.5 6.5 0 0 1 11.5-4.2L17 8M17 3.5V8h-4.5M16.5 10a6.5 6.5 0 0 1-11.5 4.2L3 12M3 16.5V12h4.5"/>'),
    download: svg('<path d="M10 3.5v9M6 8.5l4 4 4-4M3.5 16.5h13"/>'),
    downloadAll: svg('<path d="M10 2.5v8.5M6.5 7.5l3.5 3.5 3.5-3.5M3 14.5h14M3 17.5h14"/>'),
    upload: svg('<path d="M10 12.5v-9M6 7.5l4-4 4 4M3.5 16.5h13"/>'),
    diff: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="14" r="2.5"/><circle cx="14" cy="10" r="2.5"/><path d="M6 8.5v3M8.5 6h2a3.5 3.5 0 0 1 3.5 3.5v.5"/>'),
    history: svg('<circle cx="10" cy="10" r="7.5"/><path d="M10 6v4l2.8 2"/>'),
    settings: svg('<circle cx="10" cy="10" r="2.8"/><path d="M16.2 12.4a1.2 1.2 0 0 0 .2 1.4l.1.1a1.5 1.5 0 0 1-2.1 2.1l-.1-.1a1.2 1.2 0 0 0-1.4-.2 1.2 1.2 0 0 0-.7 1.1v.2a1.5 1.5 0 0 1-3 0v-.2a1.2 1.2 0 0 0-.8-1.1 1.2 1.2 0 0 0-1.4.2l-.1.1a1.5 1.5 0 0 1-2.1-2.1l.1-.1a1.2 1.2 0 0 0 .2-1.4 1.2 1.2 0 0 0-1.1-.7H3.8a1.5 1.5 0 0 1 0-3h.2a1.2 1.2 0 0 0 1.1-.8 1.2 1.2 0 0 0-.2-1.4l-.1-.1a1.5 1.5 0 0 1 2.1-2.1l.1.1a1.2 1.2 0 0 0 1.4.2 1.2 1.2 0 0 0 .7-1.1v-.2a1.5 1.5 0 0 1 3 0v.2a1.2 1.2 0 0 0 .8 1.1 1.2 1.2 0 0 0 1.4-.2l.1-.1a1.5 1.5 0 0 1 2.1 2.1l-.1.1a1.2 1.2 0 0 0-.2 1.4 1.2 1.2 0 0 0 1.1.7h.2a1.5 1.5 0 0 1 0 3h-.2a1.2 1.2 0 0 0-1.1.8z"/>'),
    search: svg('<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>'),
    plus: svg('<path d="M10 4.5v11M4.5 10h11"/>'),
    close: svg('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>'),
    check: svg('<path d="M4.5 10.5l3.5 3.5 7.5-8"/>'),
    chevronDown: svg('<path d="M5.5 8l4.5 4.5 4.5-4.5"/>'),
    chevronRight: svg('<path d="M8 5.5l4.5 4.5-4.5 4.5"/>'),
    folder: svg('<path d="M3.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6a1.5 1.5 0 0 1 1.1.5l1.3 1.5h4a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3.5 14v-8.5z"/>'),
    external: svg('<path d="M11 4h5v5M15.5 4.5l-7.5 7.5M8 6H5a1.5 1.5 0 0 0-1.5 1.5v7.5A1.5 1.5 0 0 0 5 16.5h7.5A1.5 1.5 0 0 0 14 15v-3"/>'),
    terminal: svg('<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M6.5 8l2.5 2-2.5 2M10.5 13h3"/>'),
    trash: svg('<path d="M4.5 5.5h11M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6 5.5v9a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5v-9"/>'),
    filter: svg('<path d="M3.5 4.5h13l-5.2 6.1v4.8l-2.6 1.3v-6.1L3.5 4.5z"/>'),
    play: svg('<polygon points="6,4 16,10 6,16" fill="currentColor" stroke="none"/>'),
    alert: svg('<path d="M9.1 3.5a1 1 0 0 1 1.8 0l6.2 10.8a1 1 0 0 1-.9 1.7H3.8a1 1 0 0 1-.9-1.7l6.2-10.8z"/><path d="M10 7.5v3.5M10 13.5h.01"/>'),
    cloud: svg('<path d="M5.5 13.5a4 4 0 0 1-1-7.8 5 5 0 0 1 9.5-1.7 3.5 3.5 0 0 1 3 3.5 3.5 3.5 0 0 1-3.5 3.5H5.5z"/>'),
    laptop: svg('<rect x="3" y="4" width="14" height="9" rx="1.5"/><path d="M1.5 15.5h17"/>'),
    copy: svg('<rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M4 12V4.5A1.5 1.5 0 0 1 5.5 3H13"/>'),
    keyboard: svg('<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M5 8h.01M8 8h.01M11 8h.01M14 8h.01M5 11h.01M8 11h4M14 11h.01"/>'),
    user: svg('<circle cx="10" cy="7" r="3"/><path d="M4 16a6 6 0 0 1 12 0"/>'),
    edit: svg('<path d="M13.5 4.5l2 2M4 16l3.5-.5 8.5-8.5-3-3L4.5 12.5 4 16z"/>'),
    sheet: svg('<path d="M4 3a1.5 1.5 0 0 1 1.5-1.5h6l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 17V3z"/><path d="M11.5 1.5v4.5h4.5M7 9.5h6M7 13h6"/>'),
    link: svg('<path d="M8.5 11.5l3-3a2.8 2.8 0 0 1 4 4l-2 2a2.8 2.8 0 0 1-4 0M11.5 8.5l-3 3a2.8 2.8 0 0 1-4-4l2-2a2.8 2.8 0 0 1 4 0M7.5 12.5l5-5"/>'),
    file: svg('<path d="M4 3a1.5 1.5 0 0 1 1.5-1.5h6l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 17V3z"/><path d="M11.5 1.5v4.5h4.5"/>'),
    status: {
      synced: svg('<circle cx="10" cy="10" r="7.5" fill="#ecfdf5" stroke="#10b981"/><path d="M7 10l2 2 4-4" stroke="#059669"/>', { className: 'csm-status-icon icon-synced' }),
      updated: svg('<circle cx="10" cy="10" r="7.5" fill="#eff6ff" stroke="#3b82f6"/><path d="M10 5.5v5.5M7.5 8.5L10 11l2.5-2.5M6.5 13.5h7" stroke="#2563eb"/>', { className: 'csm-status-icon icon-updated' }),
      conflict: svg('<path d="M9.1 3.5a1 1 0 0 1 1.8 0l6.2 10.8a1 1 0 0 1-.9 1.7H3.8a1 1 0 0 1-.9-1.7l6.2-10.8z" fill="#fffbeb" stroke="#f59e0b"/><path d="M10 7.5v3.5M10 13.5h.01" stroke="#d97706" stroke-width="2"/>', { className: 'csm-status-icon icon-conflict' }),
      local_changed: svg('<circle cx="10" cy="10" r="7.5" fill="#faf5ff" stroke="#a855f7"/><path d="M10 13.5V8M7.5 10.5L10 8l2.5 2.5M6.5 5.5h7" stroke="#7e22ce"/>', { className: 'csm-status-icon icon-local-changed' }),
      missing_local: svg('<circle cx="10" cy="10" r="7.5" fill="#fef2f2" stroke="#ef4444"/><path d="M7 10h6" stroke="#dc2626" stroke-width="2"/>', { className: 'csm-status-icon icon-missing' }),
      never_synced: svg('<circle cx="10" cy="10" r="7.5" fill="#f0f9ff" stroke="#0ea5e9"/><path d="M10 7v6M7 10h6" stroke="#0284c7" stroke-width="2"/>', { className: 'csm-status-icon icon-never-synced' }),
      error: svg('<circle cx="10" cy="10" r="7.5" fill="#fef2f2" stroke="#f87171"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5" stroke="#b91c1c"/>', { className: 'csm-status-icon icon-error' })
    }
  };

  window.CSMIcons = ICONS;
})();
