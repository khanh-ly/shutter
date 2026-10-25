/*
 * Slideshow: loads the photo list from Synology Photos, then cross-fades
 * between two layers, preloading each photo before it is shown.
 */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27,
    PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, FF: 417, RW: 412,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457
  };
  var TV_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind',
    'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info'];

  var FADE_MS = 1500;
  // The first photo after loading fades in faster than the 1.5s crossfades.
  var FIRST_FADE_MS = 600;
  var SHARPEN_MS = 500;   // full photo over its small preview

  // Kept on the TV between launches, so the slideshow can start at once: the DSM session
  // (reused instead of signing in) and the last photo list per source (refreshed in the
  // background after starting).
  var SESSION_KEY = 'synframe.session';
  var LIBRARY_KEY = 'synframe.library';
  var VIEW_KEY = 'synframe.view'; // where the app was: its screen, and the photo on show
  var LIBRARY_CACHE_MAX = 20000; // photos; bigger libraries just load as usual
  // Ken Burns drift directions, as unit offsets (x, y) of the photo.
  var KB_DRIFTS = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0], ne: [-1, 1], nw: [1, 1], se: [-1, -1], sw: [1, -1] };
  var kbVariants = [];
  var kbStyle = document.createElement('style');
  document.head.appendChild(kbStyle);
  var REFRESH_LIBRARY_MS = 6 * 60 * 60 * 1000;
  var RETRY_MS = 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };

  // ---------- launch timing (development) ----------

  // Milestones since the page started loading; sent to config's launchTimingUrl once the
  // first photo is on screen. Does nothing unless that's set.
  var marks = [];
  function mark(name) {
    marks.push([name, Math.round(window.performance && performance.now ? performance.now() : 0)]);
  }
  function sendMarks() {
    var url = window.SYNFRAME_DEFAULTS && SYNFRAME_DEFAULTS.launchTimingUrl;
    if (!url || sendMarks.done) return;
    sendMarks.done = true;
    var t = window.performance && performance.timing || {};
    var nav = t.navigationStart || 0;
    var page = [['page: DOM ready', t.domContentLoadedEventEnd - nav], ['page: load event', t.loadEventEnd - nav]];
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'text/plain');
      xhr.send(JSON.stringify({ at: Date.now(), navigationStart: nav, marks: page.concat(marks) }));
    } catch (e) {}
  }
  mark('app script running');
  var slides = [$('slideA'), $('slideB')];
  var active = 0;

  var settings = null;
  var client = null;
  var photos = [];
  var order = [];
  var pos = -1;
  var paused = false;
  var timer = null;
  var retryTimer = null;
  var refreshTimer = null;
  var failures = 0;
  var loadToken = 0;
  var sourceLabel = '';
  var currentPhoto = null;
  var started = false; // the slideshow has a list and has begun for the current source
  // Launched back into the album grid or Settings: the slideshow has its list but waits,
  // off screen, until it's chosen (no point decoding a photo nobody sees).
  var holdSlideshow = false;
  var resumePhoto = null; // id of the photo to start from, when picking up where it left off
  var libraryToken = 0; // changes per start(), so a list fetched for an earlier source is ignored
  var infoTimer = null;
  var INFO_MS = 8000;

  // ---------- TV integration ----------

  // The clock and caption dates, media keys and the screensaver. All are slow on the TV
  // the first time (date formatting loads the TV's locale data; the Samsung APIs, absent in
  // a normal browser, take a while to load), so this waits until the first photo is on screen.
  function tvSetup() {
    if (tvSetup.done) return;
    tvSetup.done = true;
    datesReady = true;
    updateClock();
    if (currentPhoto) $('caption-date').textContent = formatTaken(currentPhoto.time);
    try {
      if (window.tizen && tizen.tvinputdevice) tizen.tvinputdevice.registerKeyBatch(TV_KEYS);
    } catch (e) {}
    var s = document.createElement('script');
    s.src = '$WEBAPIS/webapis/webapis.js';
    s.onload = function () { keepScreenOn(true); };
    document.head.appendChild(s);
  }

  function keepScreenOn(on) {
    try {
      var ac = window.webapis && webapis.appcommon;
      if (ac) ac.setScreenSaver(on ? ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF : ac.AppCommonScreenSaverState.SCREEN_SAVER_ON);
    } catch (e) {}
  }

  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
  }

  // ---------- UI helpers ----------

  // Loading: just the spinner, no text.
  function showLoading() {
    $('message').classList.add('loading');
    $('message').classList.remove('hidden');
  }

  // Problems: a title and an explanation (no spinner).
  function showMessage(title, body) {
    $('message').classList.remove('loading');
    $('message-title').textContent = title;
    $('message-body').textContent = body || '';
    $('message').classList.remove('hidden');
  }

  function hideMessage() {
    $('message').classList.add('hidden');
  }

  var toastTimer = null;
  function toast(text, ms) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('visible'); }, ms || 2500);
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Date formatters are slow to create on the TV, so each is made once, and only after the
  // first photo is on screen (see tvSetup).
  var datesReady = false;
  var dateFormats = {};
  function formatDate(d, opts) {
    var key = JSON.stringify(opts);
    if (!dateFormats[key]) dateFormats[key] = new Intl.DateTimeFormat([], opts);
    return dateFormats[key].format(d);
  }

  function updateClock() {
    if (!datesReady) return;
    var now = new Date();
    var text;
    try {
      text = formatDate(now, { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      text = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    }
    $('clock').textContent = text;
  }

  function formatTaken(seconds) {
    if (!seconds) return '';
    // Synology Photos stores the taken time as wall-clock time, so read it as UTC
    // to avoid shifting it by the TV's time zone.
    var d = new Date(seconds * 1000);
    try {
      return formatDate(d, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    } catch (e) {
      return d.toUTCString().slice(5, 16);
    }
  }

  /*
   * Builds the Ken Burns moves from the pan & zoom settings: zoom amount, zoom in/out
   * or both, and whether to drift. The drift stays inside the zoom margin so no edge
   * ever shows: translate() applies after scale(), so an offset of x% moves the photo
   * by zoom·x%, and each edge has (zoom − 1)/2 to spare.
   */
  function applyKenBurns() {
    var zoom = 1 + (Number(settings.kbZoom) || 6) / 100;
    var margin = (zoom - 1) / (2 * zoom) * 100;
    var dx = +(margin * 0.7).toFixed(3), dy = +(margin * 0.53).toFixed(3);
    var kinds = settings.kbDirection === 'in' ? ['in'] : settings.kbDirection === 'out' ? ['out'] : ['in', 'out'];
    var drifts = settings.kbDrift === false ? ['c'] : Object.keys(KB_DRIFTS);
    var still = 'scale(1) translate(0, 0)';
    var css = [];
    kbVariants = [];
    kinds.forEach(function (kind) {
      drifts.forEach(function (dir) {
        var d = KB_DRIFTS[dir] || [0, 0];
        var moved = 'scale(' + zoom + ') translate(' + d[0] * dx + '%, ' + d[1] * dy + '%)';
        var from = kind === 'in' ? still : moved, to = kind === 'in' ? moved : still;
        var name = 'kb-' + kind + '-' + dir;
        kbVariants.push(name);
        css.push('.motion .mover.' + name + ' { -webkit-animation-name: ' + name + '; animation-name: ' + name + '; }');
        css.push('@-webkit-keyframes ' + name + ' { from { -webkit-transform: ' + from + '; } to { -webkit-transform: ' + to + '; } }');
        css.push('@keyframes ' + name + ' { from { transform: ' + from + '; } to { transform: ' + to + '; } }');
      });
    });
    kbStyle.textContent = css.join('\n');
  }

  function applyDisplaySettings() {
    applyKenBurns();
    document.body.className = 'fit-' + settings.fit +
      (settings.motion ? ' motion' : '') +
      (settings.clock ? ' show-clock' : '') +
      (settings.info ? ' show-info' : '');
    updateClock();
  }

  // ---------- ordering ----------

  function shuffled(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(i);
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = a[j]; a[j] = a[k]; a[k] = t;
    }
    return a;
  }

  function buildOrder() {
    resetStrip();
    if (settings.order === 'shuffle') {
      order = shuffled(photos.length);
    } else {
      order = photos.map(function (_, i) { return i; });
      var sign = settings.order === 'newest' ? -1 : 1;
      order.sort(function (a, b) { return sign * (photos[a].time - photos[b].time); });
    }
  }

  function step(dir) {
    if (!photos.length) return null;
    pos += dir;
    if (pos >= order.length) {
      var last = order[order.length - 1];
      buildOrder();
      // Don't show the same photo twice in a row across a reshuffle.
      if (order.length > 1 && order[0] === last) order.push(order.shift());
      pos = 0;
    } else if (pos < 0) {
      pos = order.length - 1;
    }
    return photos[order[pos]];
  }

  function peekNext() {
    if (!photos.length) return null;
    return photos[order[(pos + 1) % order.length]];
  }

  // ---------- slideshow ----------

  function photoUrl(photo) {
    if (settings.quality === 'original' && !photo.originalFailed) return client.originalUrl(photo);
    return client.thumbnailUrl(photo, photo.xlReady ? 'xl' : 'm');
  }

  function schedule() {
    clearTimeout(timer);
    // Not while the film strip is open: closing it picks the timing up again.
    if (!paused && !stripOpen()) timer = setTimeout(function () { show(1); }, settings.interval * 1000);
  }

  // Decoding a large photo takes the TV well over a second, so photos are decoded before
  // they're shown (otherwise the fade freezes while it decodes), and the next one is
  // downloaded and decoded ahead of time.
  var ahead = null;

  function fetchDecoded(url) {
    var entry = { url: url, img: new Image(), state: 'loading', waiting: null };
    var img = entry.img;
    function settle(state) {
      entry.state = state;
      var cb = entry.waiting;
      entry.waiting = null;
      if (cb) cb(entry);
    }
    img.onload = function () {
      if (img.decode) img.decode().then(function () { settle('ready'); }, function () { settle('ready'); });
      else settle('ready');
    };
    img.onerror = function () { settle('failed'); };
    img.src = url;
    return entry;
  }

  function whenSettled(entry, cb) {
    if (entry.state === 'loading') entry.waiting = cb;
    else cb(entry);
  }

  function stageEmpty() {
    return !slides[0].classList.contains('active') && !slides[1].classList.contains('active');
  }

  function show(dir) {
    clearTimeout(timer);
    var photo = step(dir);
    if (!photo) return;
    var token = ++loadToken;
    var url = photoUrl(photo);
    var entry = ahead && ahead.url === url ? ahead : null;
    ahead = null;
    var firstOne = !currentPhoto;
    if (firstOne) mark('first photo requested');

    // Nothing on screen (launch, a new album): fade in the small thumbnail, which decodes
    // in a blink, then fetch the full photo and sharpen to it. The full photo waits for
    // the fade, because decoding it alongside makes everything crawl on the TV.
    var smallUrl = client.thumbnailUrl(photo, 'm');
    var previewShown = false;
    if (stageEmpty() && url !== smallUrl && !(entry && entry.state === 'ready')) {
      whenSettled(fetchDecoded(smallUrl), function (p) {
        if (token !== loadToken) return;
        if (p.state === 'ready') {
          previewShown = true;
          if (firstOne) mark('first photo preview revealed (fade starts)');
          hideMessage();
          reveal(photo, p.img);
        }
        setTimeout(function () {
          if (token === loadToken) whenSettled(entry || fetchDecoded(url), done);
        }, previewShown ? FIRST_FADE_MS : 0);
      });
    } else {
      whenSettled(entry || fetchDecoded(url), done);
    }

    function done(e) {
      if (token !== loadToken) return;
      if (e.state === 'failed') return failed();
      failures = 0;
      photo.retried = false;
      if (previewShown) sharpen(e.img);
      else {
        hideMessage();
        reveal(photo, e.img);
      }
      if (firstOne) {
        mark('first photo revealed sharp (' + e.img.naturalWidth + 'x' + e.img.naturalHeight + ')');
        setTimeout(tvSetup, FIRST_FADE_MS + 100);
        setTimeout(sendMarks, 40000);
      }
      schedule();
      var next = peekNext();
      if (next) ahead = fetchDecoded(photoUrl(next));
    }

    function failed() {
      failures++;
      if (failures >= 5) {
        showMessage('Having trouble loading photos', 'Retrying… Press Back for albums and settings.');
      }
      // A failed image is often an expired session; ping re-signs in if so.
      // Then retry the same photo once, then (for originals, e.g. HEIC the TV
      // can't decode) fall back to the preview, and only then move on.
      client.ping().catch(function () {}).then(function () {
        if (token !== loadToken) return;
        if (!photo.retried) {
          photo.retried = true;
          pos -= dir;
        } else if (settings.quality === 'original' && !photo.originalFailed) {
          photo.originalFailed = true;
          pos -= dir;
        }
        setTimeout(function () { if (token === loadToken) show(dir); }, failures >= 5 ? 15000 : 300);
      });
    }
  }

  // Fades the full photo in over the small preview on the current slide.
  function sharpen(img) {
    var mover = slides[active].querySelector('.mover');
    var old = mover.querySelector('.photo');
    img.className = 'photo sharpening';
    img.alt = '';
    mover.appendChild(img);
    void img.offsetWidth;
    img.classList.add('in');
    setTimeout(function () {
      if (old.parentNode) old.parentNode.removeChild(old);
      img.className = 'photo';
    }, SHARPEN_MS + 100);
  }

  /*
   * Paints the blurred backdrop into the slide's small canvas: the photo cropped to fill,
   * blurred and darkened, then stretched over the screen by CSS. Stretching a tiny image
   * is itself a smooth blur, so this needs no CSS filter, which TVs can silently skip
   * when graphics memory runs short, and it's ready the moment the photo is.
   */
  function paintBackdrop(canvas, img) {
    var ctx = canvas.getContext('2d');
    var canFilter = 'filter' in ctx;
    // Without canvas filters (older TVs), a smaller canvas does the blurring on its own.
    var w = canvas.width = canFilter ? 192 : 40;
    var h = canvas.height = canFilter ? 108 : 22;
    var iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    // Draw a little past the edges so the blur doesn't fade out at the borders.
    var pad = canFilter ? 12 : 0;
    var scale = Math.max((w + pad * 2) / iw, (h + pad * 2) / ih);
    var sw = (w + pad * 2) / scale, sh = (h + pad * 2) / scale;
    ctx.imageSmoothingEnabled = true;
    if (canFilter) ctx.filter = 'blur(5px)';
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, -pad, -pad, w + pad * 2, h + pad * 2);
    if (canFilter) ctx.filter = 'none';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, w, h);
  }

  function reveal(photo, img) {
    var portrait = img.naturalWidth < img.naturalHeight;
    var next = 1 - active;
    var el = slides[next];
    var mover = el.querySelector('.mover');

    // Show the already-decoded image itself rather than loading the URL into another element.
    img.className = 'photo';
    img.alt = '';
    var shown = el.querySelectorAll('.photo');
    for (var i = 1; i < shown.length; i++) mover.removeChild(shown[i]);
    mover.replaceChild(img, shown[0]);
    if (portrait || settings.fit === 'blur') paintBackdrop(el.querySelector('.bg'), img);

    // Restart the pan/zoom animation with a random direction.
    mover.className = 'mover';
    void mover.offsetWidth;
    // Last through both fades so the motion never stops mid-crossfade.
    mover.style.webkitAnimationDuration = mover.style.animationDuration = (settings.interval * 1000 + FADE_MS * 2) + 'ms';
    mover.className = 'mover kb ' + pick(kbVariants);

    // Portraits are never cropped to fill the screen: they're shown whole over a
    // blurred copy of themselves, whatever the "Photo fit" setting says.
    el.classList.toggle('portrait', portrait);
    // Nothing on screen yet (launch, or a new album): a quicker fade-in than a crossfade.
    var first = stageEmpty();
    if (first) {
      el.style.webkitTransitionDuration = el.style.transitionDuration = FIRST_FADE_MS + 'ms';
      setTimeout(function () { el.style.webkitTransitionDuration = el.style.transitionDuration = ''; }, FIRST_FADE_MS + 100);
    }
    el.classList.add('active');
    slides[active].classList.remove('active');
    active = next;

    $('caption-date').textContent = datesReady ? formatTaken(photo.time) : '';
    rememberPhoto(photo);
    $('caption-sub').textContent = sourceLabel;
    currentPhoto = photo;
    if (infoOpen()) showInfo(); // browsing with the panel open: show this photo's details
  }

  function togglePause() {
    paused = !paused;
    document.body.classList.toggle('paused', paused);
    if (paused) {
      clearTimeout(timer);
      toast('Paused');
    } else {
      toast('Playing');
      schedule();
    }
  }

  // ---------- loading ----------

  // "Saturday 18 September 2026, 14:23" (wall-clock time, read as UTC like formatTaken).
  function formatTakenFull(seconds) {
    if (!seconds) return 'Date unknown';
    var d = new Date(seconds * 1000);
    try {
      return formatDate(d, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    } catch (e) {
      return d.toUTCString().slice(0, 22);
    }
  }

  // ---------- photo info (▼ / Info) ----------

  // Camera and place per photo id, asked of the NAS the first time a photo's details open.
  var details = {};

  function loadDetails(p) {
    if (details[p.id]) return;
    details[p.id] = { pending: true };
    client.photoDetails(p).then(function (d) {
      details[p.id] = d;
    }, function () {
      delete details[p.id]; // try again next time
    }).then(function () {
      if (infoOpen() && currentPhoto === p) fillInfo();
    });
  }

  function fillInfo() {
    var p = currentPhoto;
    if (!p) return;
    loadDetails(p);
    var d = details[p.id] || {};
    $('info-date').textContent = formatTakenFull(p.time);
    $('info-place').textContent = d.place || '';
    $('info-camera').textContent = [d.camera, d.lens].filter(Boolean).join(' \u00b7 ');
    $('info-exposure').textContent = d.exposure || '';
    $('info-source').textContent = sourceLabel || (settings.source === 'shared' ? 'Shared Space' : 'All my photos');
    var size = p.width && p.height ? p.width + ' \u00d7 ' + p.height : '';
    $('info-file').textContent = [p.name, size].filter(Boolean).join(' \u00b7 ');
    $('info-position').textContent = order.length ? 'Photo ' + (pos + 1) + ' of ' + order.length : '';
  }

  function infoOpen() { return document.body.classList.contains('info-open'); }

  function showInfo() {
    if (!currentPhoto) return;
    fillInfo();
    document.body.classList.add('info-open');
    clearTimeout(infoTimer);
    infoTimer = setTimeout(hideInfo, INFO_MS);
  }

  function hideInfo() {
    clearTimeout(infoTimer);
    document.body.classList.remove('info-open');
  }

  // ---------- film strip (▲) ----------

  /*
   * Thumbnails of the slideshow's order around the photo on show. ◀ ▶ move the selection
   * (the track slides; the photo on show stays), OK shows the selected photo, and ▲, ▼ or
   * Back close it. The slideshow waits while it's open. Only the tiles near the selection
   * exist, so a library of thousands costs a few dozen small images.
   */
  var STRIP_PITCH = 270;    // px from one tile to the next (240 wide + gap)
  var STRIP_REACH = 8;      // tiles kept either side of the selection
  var STRIP_MS = 20000;     // closes itself after this long without a key
  var stripSel = 0;         // index into order
  var stripTiles = {};      // order index -> <img>
  var stripTimer = null;

  function stripOpen() { return document.body.classList.contains('strip-open'); }

  function openStrip() {
    if (!currentPhoto || !order.length) return;
    hideInfo();
    clearTimeout(timer);
    stripSel = Math.max(0, Math.min(pos, order.length - 1));
    // Place the track at once, without sliding there from wherever it was last time.
    var track = $('filmstrip-track');
    track.style.webkitTransition = track.style.transition = 'none';
    paintStrip();
    void track.offsetWidth;
    track.style.webkitTransition = track.style.transition = '';
    document.body.classList.add('strip-open');
    stripTouched();
  }

  function closeStrip() {
    if (!stripOpen()) return;
    clearTimeout(stripTimer);
    document.body.classList.remove('strip-open');
    schedule();
  }

  function stripTouched() {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(closeStrip, STRIP_MS);
  }

  function paintStrip() {
    var track = $('filmstrip-track');
    var lo = Math.max(0, stripSel - STRIP_REACH), hi = Math.min(order.length - 1, stripSel + STRIP_REACH);
    Object.keys(stripTiles).forEach(function (k) {
      if (k < lo || k > hi) {
        track.removeChild(stripTiles[k]);
        delete stripTiles[k];
      }
    });
    for (var i = lo; i <= hi; i++) {
      var tile = stripTiles[i];
      if (!tile) {
        tile = stripTiles[i] = new Image();
        tile.alt = '';
        tile.style.left = (i * STRIP_PITCH) + 'px';
        tile.src = client.thumbnailUrl(photos[order[i]], 'sm');
        track.appendChild(tile);
      }
      tile.className = 'strip-tile' + (i === stripSel ? ' selected' : '') + (i === pos ? ' current' : '');
    }
    var x = -(stripSel * STRIP_PITCH + 120);
    track.style.webkitTransform = track.style.transform = 'translateX(' + x + 'px)';
    var photo = photos[order[stripSel]];
    $('filmstrip-date').textContent = datesReady ? formatTaken(photo.time) : '';
    $('filmstrip-count').textContent = (stripSel + 1) + ' of ' + order.length;
  }

  // The order changed under the strip (a new list, a reshuffle): start it afresh.
  function resetStrip() {
    var track = $('filmstrip-track');
    while (track.firstChild) track.removeChild(track.firstChild);
    stripTiles = {};
    closeStrip();
  }

  function stripKey(e) {
    switch (e.keyCode) {
      case KEY.RIGHT: case KEY.FF:
        if (stripSel < order.length - 1) { stripSel++; paintStrip(); }
        break;
      case KEY.LEFT: case KEY.RW:
        if (stripSel > 0) { stripSel--; paintStrip(); }
        break;
      case KEY.ENTER:
        var pick = stripSel;
        closeStrip();
        if (pick !== pos) {
          pos = pick - 1;
          show(1);
        }
        break;
      case KEY.UP: case KEY.DOWN: case KEY.BACK: case KEY.ESC:
        closeStrip();
        break;
      default: return;
    }
    stripTouched();
    e.preventDefault();
  }

  function describeSource(s) {
    if (s.source === 'album') return s.albumName || 'Album';
    if (s.source === 'shared') return 'Shared Space';
    if (s.source === 'favorites') return 'Favorites';
    return '';
  }

  // ---------- remembered between launches ----------

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function accountKey(s) { return (s.server || '').replace(/\/+$/, '') + '|' + s.account; }
  function sourceKey(s) { return accountKey(s) + '|' + s.source + '|' + (s.source === 'album' ? s.albumId : ''); }

  function savedSession(s) {
    var saved = readStore(SESSION_KEY);
    return saved && saved.key === accountKey(s) ? saved.session : null;
  }

  function saveSession() {
    var session = client && client.session();
    if (session) writeStore(SESSION_KEY, { key: accountKey(settings), session: session });
  }

  // Photos are stored compactly; team and passphrase are the same for the whole list.
  function saveLibrary(list) {
    if (!list.length || list.length > LIBRARY_CACHE_MAX) return;
    writeStore(LIBRARY_KEY, {
      key: sourceKey(settings),
      team: list[0].team, passphrase: list[0].passphrase,
      photos: list.map(function (p) { return [p.id, p.name, p.cacheKey, p.xlReady ? 1 : 0, p.time, p.width, p.height]; })
    });
  }

  function savedLibrary(s) {
    var saved = readStore(LIBRARY_KEY);
    if (!saved || saved.key !== sourceKey(s) || !saved.photos || !saved.photos.length) return null;
    return saved.photos.map(function (a) {
      return { id: a[0], name: a[1], cacheKey: a[2], xlReady: !!a[3], time: a[4], width: a[5], height: a[6],
        team: saved.team, passphrase: saved.passphrase };
    });
  }

  // Starts the slideshow with the photos known so far.
  function begin(list) {
    started = true;
    photos = list;
    pos = -1;
    buildOrder();
    if (resumePhoto) placeBefore(resumePhoto); // pick up with the photo shown when the app closed
    if (!holdSlideshow) show(1);
  }

  // Sets the position so that the next photo shown is the one with this id (if it's in
  // the list). Returns whether it is.
  function placeBefore(id) {
    for (var i = 0; i < photos.length; i++) {
      if (photos[i].id === id) {
        pos = order.indexOf(i) - 1;
        return true;
      }
    }
    return false;
  }

  // ---------- where the app left off ----------

  // Saved as the screens change, so the next launch opens the same one. (The TV can
  // close an app without warning, e.g. when it's switched off, so there's no "on exit".)
  var lastView = readStore(VIEW_KEY) || {};
  function rememberView(view) {
    lastView.view = view;
    writeStore(VIEW_KEY, lastView);
  }
  function rememberPhoto(photo) {
    resumePhoto = null; // on screen now: no longer something to get back to
    lastView.source = sourceKey(settings);
    lastView.photo = photo.id;
    writeStore(VIEW_KEY, lastView);
  }

  // Takes a newer list (the full one, or a refresh) without interrupting the slideshow:
  // the photo on screen keeps its place, and new photos join the order.
  function adoptList(list) {
    // The photo on show, or the one still loading to be shown (the first photo, when
    // the full list comes in before it's on screen).
    var cur = currentPhoto || (pos >= 0 && photos[order[pos]]) || null;
    photos = list;
    buildOrder();
    pos = -1;
    if (cur) {
      if (placeBefore(cur.id)) pos++;
    } else if (resumePhoto) {
      placeBefore(resumePhoto); // nothing shown yet (held behind the grid): keep the resume point
    }
  }

  /*
   * Takes the current photo off screen at once (no fade), behind the loading spinner,
   * so a newly chosen album never shows the previous album's photo. The first new
   * photo then fades in from black (the slides' normal 1.5s opacity transition).
   */
  function clearStage() {
    slides.forEach(function (el) {
      el.style.webkitTransition = el.style.transition = 'none';
      el.classList.remove('active');
    });
    void slides[0].offsetWidth; // apply now, before the transition comes back
    slides.forEach(function (el) { el.style.webkitTransition = el.style.transition = ''; });
    $('caption-date').textContent = $('caption-sub').textContent = '';
    currentPhoto = null;
    closeStrip();
  }

  function start(newSettings) {
    var previous = client;
    var sameAccount = previous && settings && accountKey(settings) === accountKey(newSettings);
    settings = newSettings;
    applyDisplaySettings();
    clearTimeout(timer);
    clearTimeout(retryTimer);
    clearTimeout(refreshTimer);
    loadToken++;
    libraryToken++;
    paused = false;
    document.body.classList.remove('paused');

    // Same account (e.g. another album): keep the session. Otherwise reuse the one saved
    // from the last run, if it's for this account; a stale one is replaced on first use.
    var session = sameAccount ? previous.session() : savedSession(settings);
    if (previous && !sameAccount) previous.logout();
    client = new SynologyClient(Object.assign({}, settings, { session: session }));
    sourceLabel = describeSource(settings);

    if (!photos.length) {
      started = false;
      clearStage();
      // Start straight away from the list remembered for this source, if there is one;
      // loadLibrary then fetches the current list in the background.
      var remembered = savedLibrary(settings);
      mark(remembered ? 'remembered list: ' + remembered.length + ' photos' : 'no remembered list');
      if (remembered) begin(remembered);
      else showLoading();
    }
    loadLibrary();
  }

  function sourceOf(s) {
    return { type: s.source, albumId: s.albumId, passphrase: s.albumPassphrase };
  }

  /*
   * Fetches the photo list. Without a remembered list the slideshow begins as soon as the
   * first page (500 photos) is in; the full list is then adopted without interrupting it.
   */
  function loadLibrary() {
    var token = libraryToken;
    mark('list requested' + (client.session() ? ' (reusing session)' : ' (signing in)'));
    return client.listPhotos(sourceOf(settings), function (n, sofar) {
      mark('list page in: ' + n + ' photos');
      if (token === libraryToken && !started && sofar.length) begin(sofar.slice());
    }).then(function (list) {
      mark('full list in: ' + list.length + ' photos');
      if (token !== libraryToken) return;
      saveSession();
      if (!list.length) {
        var where = sourceLabel || 'your personal space';
        clearStage();
        started = false;
        photos = [];
        showMessage('No photos found', 'There are no photos in ' + where + '. Press Back to choose another album.');
        retryTimer = setTimeout(function () { start(settings); }, RETRY_MS * 5);
        return;
      }
      saveLibrary(list);
      if (started) adoptList(list);
      else begin(list);
      refreshTimer = setTimeout(refreshLibrary, REFRESH_LIBRARY_MS);
    }, function (err) {
      if (token !== libraryToken) return;
      if (started) {
        // Already playing from the remembered list: just try the refresh again later.
        refreshTimer = setTimeout(refreshLibrary, RETRY_MS);
        return;
      }
      if (err.code === 'busy') {
        // Not a fault: the NAS is overloaded for now (indexing, updating…). Just wait.
        showMessage('Waiting for your Synology', 'It\'s busy and not answering right now. Shutter will try again in a minute.');
      } else {
        showMessage('Could not load photos', (err.message || String(err)) + '\nRetrying in a minute. Press Back for albums and settings.');
      }
      retryTimer = setTimeout(function () { start(settings); }, RETRY_MS);
    });
  }

  // Pick up newly added photos without interrupting the slideshow.
  function refreshLibrary() {
    var token = libraryToken;
    client.listPhotos(sourceOf(settings)).then(function (list) {
      if (token !== libraryToken || !list.length) return;
      saveSession();
      saveLibrary(list);
      adoptList(list);
    }).catch(function () {}).then(function () {
      if (token === libraryToken) refreshTimer = setTimeout(refreshLibrary, REFRESH_LIBRARY_MS);
    });
  }

  // ---------- settings ----------

  var settingsUI = new SettingsUI($('settings'), {
    connect: function (draft) {
      var c = new SynologyClient(draft);
      return c.listAlbums().then(function (albums) {
        c.logout();
        return albums;
      });
    },
    onSave: function (s) {
      holdSlideshow = false;
      rememberView('slideshow');
      photos = [];
      start(s);
    },
    // Leaving Settings goes to the album grid (Save is what starts the slideshow).
    // Not set up yet: there's no grid to go to, so leave the app.
    onClose: function () {
      if (!settings) return exitApp();
      // Grid first, then remove Settings, in the same frame: the slideshow is never seen.
      openAlbums(true);
      settingsUI.close();
    }
  });

  function openSettings(message) {
    rememberView('settings');
    settingsUI.open(message);
  }

  // ---------- album browser ----------

  // The album grid is the app's top level: Back from the slideshow opens it, and Back
  // from it leaves the app. OK on the album that's playing goes back to the slideshow.
  var albumBrowser = new AlbumBrowser($('albums'), {
    onPick: function (pick) {
      rememberView('slideshow');
      var held = holdSlideshow;
      holdSlideshow = false;
      var same = pick.source === settings.source && (pick.source !== 'album' || pick.albumId === settings.albumId);
      if (same && photos.length) {
        if (held) show(1); // launched into the grid: the slideshow starts now
        return; // otherwise carry on where the slideshow was
      }
      var s = Object.assign({}, settings, pick);
      SettingsUI.save(s);
      photos = [];
      start(s);
    },
    onSettings: function () { openSettings(); },
    onBack: function () { exitDialog.open(); }
  });

  // ---------- exit confirmation ----------

  // Back on the album grid asks before leaving. Cancel is selected first, so an extra
  // press of OK doesn't close the app; Back in the dialog also cancels.
  var exitDialog = (function () {
    var root = $('exit-dialog');
    var buttons = Array.prototype.slice.call(root.querySelectorAll('.dialog-btn'));
    var focus = 0;
    function paint() { buttons.forEach(function (b, i) { b.classList.toggle('focused', i === focus); }); }
    function close() { root.classList.add('hidden'); }
    function choose(action) {
      close();
      if (action === 'exit') {
        rememberView('albums'); // after Exit, the next launch opens the album grid
        exitApp();
      }
    }
    buttons.forEach(function (b, i) {
      b.addEventListener('click', function () { focus = i; choose(b.getAttribute('data-action')); });
    });
    return {
      isOpen: function () { return !root.classList.contains('hidden'); },
      open: function () { focus = 0; paint(); root.classList.remove('hidden'); },
      handleKey: function (e) {
        switch (e.keyCode) {
          case KEY.LEFT: focus = 0; paint(); break;
          case KEY.RIGHT: focus = buttons.length - 1; paint(); break;
          case KEY.ENTER: choose(buttons[focus].getAttribute('data-action')); break;
          case KEY.BACK: case KEY.ESC: close(); break;
          default: return;
        }
        e.preventDefault();
      }
    };
  })();

  // instant: show the grid at once, with no fade (e.g. coming from Settings, where a
  // fade would let the slideshow show through for a moment).
  function openAlbums(instant) {
    // Not set up yet: there's nothing to sign in with.
    if (!client) return openSettings();
    rememberView('albums');
    albumBrowser.open(client, settings, { instant: instant });
  }

  // ---------- input ----------

  document.addEventListener('keydown', function (e) {
    if (exitDialog.isOpen()) {
      exitDialog.handleKey(e);
      return;
    }
    if (settingsUI.isOpen()) {
      settingsUI.handleKey(e);
      return;
    }
    if (albumBrowser.isOpen()) {
      albumBrowser.handleKey(e);
      return;
    }
    if (stripOpen()) {
      stripKey(e);
      return;
    }
    switch (e.keyCode) {
      case KEY.RIGHT: case KEY.FF: show(1); break;
      case KEY.LEFT: case KEY.RW: show(-1); break;
      case KEY.ENTER: case KEY.PLAY_PAUSE: case KEY.PLAY: case KEY.PAUSE: togglePause(); break;
      case KEY.UP: openStrip(); break;
      case KEY.DOWN: case KEY.INFO:
        if (infoOpen()) hideInfo();
        else if (currentPhoto) showInfo();
        else openAlbums(); // nothing on show (an error, no photos): the albums instead
        break;
      case KEY.RED: case KEY.GREEN: case KEY.YELLOW: case KEY.BLUE: openSettings(); break;
      case KEY.BACK: case KEY.ESC:
        if (infoOpen()) hideInfo();
        else openAlbums();
        break;
      default: return;
    }
    e.preventDefault();
  });

  document.addEventListener('visibilitychange', function () {
    if (!settings) return;
    if (document.hidden) {
      clearTimeout(timer);
    } else {
      keepScreenOn(true);
      if (photos.length && !holdSlideshow) show(1);
    }
  });

  // ---------- boot ----------

  setTimeout(tvSetup, 4000); // in case no photo shows (settings, errors)
  setInterval(updateClock, 15000);
  updateClock();

  var initial = SettingsUI.load();
  mark('settings read (source: ' + initial.source + ')');
  if (initial.server && initial.account && initial.password) {
    // Open where the app left off: the slideshow (from the same photo), the album grid, or
    // Settings. After Exit in the exit dialog, that's the album grid.
    if (lastView.source === sourceKey(initial)) resumePhoto = lastView.photo;
    holdSlideshow = lastView.view === 'albums' || lastView.view === 'settings';
    start(initial);
    if (lastView.view === 'albums') openAlbums();
    else if (lastView.view === 'settings') openSettings();
  } else {
    openSettings();
  }
})();
