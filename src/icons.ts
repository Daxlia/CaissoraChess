// Icone SVG inline (24×24, tratto). Contenuto statico dell'app, mai input dell'utente.
const wrap = (d: string): string => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  play: wrap('<path d="M8 4l12 8-12 8z"/>'),
  training: wrap('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  academy: wrap('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5"/>'),
  themes: wrap('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M13 3h8v8M3 13h8v8" opacity=".45"/>'),
  settings: wrap('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  flip: wrap('<path d="M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4"/>'),
  first: wrap('<path d="M6 5v14M18 5l-9 7 9 7z"/>'),
  prev: wrap('<path d="M16 5l-9 7 9 7z"/>'),
  next: wrap('<path d="M8 5l9 7-9 7z"/>'),
  last: wrap('<path d="M18 5v14M6 5l9 7-9 7z"/>'),
  bulb: wrap('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>'),
  star: wrap('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
} as const;
