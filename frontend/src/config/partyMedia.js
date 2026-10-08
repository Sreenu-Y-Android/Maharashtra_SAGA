/**
 * Maharashtra Political Watch — branding and media catalogue for the client:
 * leadership monitoring for Maharashtra, presented under Eknath Shinde. No
 * party branding: the monitored leaders span several parties across
 * government and opposition.
 *
 * Remote images use Wikipedia's stable Special:FilePath redirect (always the
 * current version of a Commons file; every file name below was checked to
 * resolve). If one fails to load, the image helper falls back to a copy
 * shipped in /public, so the UI never breaks.
 *
 * Re-branding for another client means editing this file, public/index.html,
 * and the data files in src/data — no page code needs to change.
 */

const wiki = (filename) =>
  `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;

/* ─── App / client identity ─────────────────────────────────────── */
export const BRAND = {
  appName: 'Maharashtra Political Watch',
  appShortName: 'MH WATCH',
  tagline: 'Social Media Intelligence for Maharashtra Leadership',
  // No party branding on this site — left empty on purpose.
  partyName: '',
  partyShort: '',
  partyUnit: '',
  stateName: 'Maharashtra',
  leaderName: 'Eknath Shinde',
  leaderTitle: 'Deputy Chief Minister of Maharashtra',
  constituencyCount: 288,
  lokSabhaCount: 48,
};

/* ─── Portraits of the client leadership ─────────────────────────── */
// Eknath Shinde: CC BY-SA 4.0 (Wikimedia Commons).
export const PARTY_PORTRAITS = [
  {
    id: 'portrait-primary',
    src: wiki('Eknath_Shinde_SS.jpg'),
    alt: 'Eknath Shinde — Deputy Chief Minister of Maharashtra',
    caption: 'Deputy Chief Minister · Maharashtra',
  },
];

/* The "hero" image used across the app (login, header, dashboard avatar). */
export const PARTY_HERO = PARTY_PORTRAITS[0];

/* ─── Maharashtra imagery ───────────────────────────────────────── */
export const STATE_GALLERY = [
  {
    id: 'mh-gateway',
    src: wiki('Mumbai_03-2016_30_Gateway_of_India.jpg'),
    alt: 'Gateway of India, Mumbai',
    caption: 'Gateway of India · Mumbai',
  },
  {
    id: 'mh-ajanta',
    src: wiki('Ajanta_(63).jpg'),
    alt: 'Ajanta Caves',
    caption: 'Ajanta Caves · Chhatrapati Sambhajinagar',
  },
  {
    id: 'mh-shaniwarwada',
    src: wiki('Shaniwarwada_gate.JPG'),
    alt: 'Shaniwar Wada gate',
    caption: 'Shaniwar Wada · Pune',
  },
  {
    id: 'mh-raigad',
    src: wiki('Raigad_fort.jpg'),
    alt: 'Raigad Fort',
    caption: 'Raigad Fort · Raigad',
  },
];

/* ─── Party visual marks ─────────────────────────────────────────── */
// No party flag or logo on this site; the app mark stands in.
export const PARTY_MARK = {
  flag: null,
  logo: '/app-mark.png',
};

/* ─── Local fallback served from /public ─────────────────────────── */
export const LOCAL_FALLBACK = '/cm-portrait.jpg';
export const LOCAL_LOGO = '/app-mark.png';

/* ─── Key constituencies for the client ──────────────────────────── */
export const KEY_CONSTITUENCIES = [
  { name: 'Nagpur South West',  district: 'Nagpur' },       // CM Devendra Fadnavis
  { name: 'Kopri-Pachpakhadi',  district: 'Thane' },        // Deputy CM Eknath Shinde
  { name: 'Baramati',           district: 'Pune' },         // Pawar family seat
  { name: 'Worli',              district: 'Mumbai City' },  // Aaditya Thackeray
  { name: 'Karjat Jamkhed',     district: 'Ahilyanagar' },  // Rohit Pawar
];

/* ─── Talking points the government champions (AI summary / dashboard) */
export const FOCUS_TOPICS = [
  'Good governance & delivery',
  'Invest Maharashtra & industrial investment',
  'Mukhyamantri Majhi Ladki Bahin Yojana',
  'Farmer loan waiver & drought relief',
  'Jobs & recruitment (MPSC, police bharti)',
  'Metro, roads & urban infrastructure',
  'Law & order',
  'Welfare delivery (PM Awas & state schemes)',
];
