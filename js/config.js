/*
 * Default settings. You can pre-fill these before packaging so you don't have
 * to type anything with the TV remote. Anything changed on the TV's settings
 * screen is saved on the TV and overrides these values.
 */
window.SYNFRAME_DEFAULTS = {
  server: '',          // e.g. 'http://192.168.1.20:5000' (DSM address on your LAN)
  account: '',         // DSM username (a dedicated, read-only user is recommended)
  password: '',        // don't commit a real password

  source: 'personal',  // 'personal' (all my photos) | 'favorites' | 'album' | 'shared' (Shared Space)
  albumId: '',
  albumName: '',
  albumPassphrase: '',

  interval: 30,        // seconds per photo
  order: 'shuffle',    // 'shuffle' | 'newest' | 'oldest'
  fit: 'blur',         // 'cover' (fill, crop) | 'blur' (fit, blurred edges) | 'black' (fit, black bars)
  motion: true,        // slow pan/zoom ("Ken Burns")
  kbZoom: 6,           // pan & zoom amount, %: 3 | 6 | 10 | 15
  kbDirection: 'both', // 'both' | 'in' | 'out'
  kbDrift: true,       // drift sideways/up/down while zooming
  clock: true,
  info: true,          // show the date the photo was taken
  quality: 'xl',       // 'xl' (Synology large thumbnail, fast) | 'original' (full file, slower)

  // Development only: if set, each launch POSTs its step timings (JSON) to this URL,
  // e.g. 'http://<your Mac>:8099'. Leave empty.
  launchTimingUrl: ''
};
