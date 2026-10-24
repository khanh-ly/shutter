/*
 * Album browser: large rounded covers for "All my photos", Shared Space and every
 * album the account can see, each with a frosted label, under a frosted header with
 * the title and a Settings button at the top right. Arrow keys move, OK plays,
 * Back closes; ▲ from the top row reaches Settings.
 */
(function (global) {
  'use strict';

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };
  var COLUMNS = 3;
  var SETTINGS = -1; // focus index of the Settings button

  // The label is a full-width band along the bottom of the cover; its height and the
  // cover's corner radius are in CSS px (keep in sync with .card-label and .cover in style.css).
  var LABEL_HEIGHT = 92;
  var COVER_RADIUS = 22;
  // The header floats over the grid (keep in sync with .albums-header in style.css).
  var HEADER_HEIGHT = 140;
  // Space kept around the focused card when scrolling, for its 5% scale and 5px ring.
  var FOCUS_ROOM = 24;
  // Space left below the last row when scrolled to the bottom (room for it comes from
  // the #albums-track::after spacer in style.css).
  var BOTTOM_ROOM = 96;
  // The glide to a new row: a CSS transition, so the GPU runs it at the display's
  // frame rate (a per-frame JS animation was choppy on the TV). Soft start, then a
  // slight overshoot that settles back: the y2 > 1 in the curve is the little bounce.
  // The grid is kept between visits and refreshed in the background; after this long
  // it's rebuilt from scratch instead.
  var CACHE_MS = 30 * 60 * 1000;
  // Covers load a few at a time and are revealed together once they're all in, or
  // after REVEAL_WAIT_MS at the latest (any stragglers fade in as they arrive).
  var COVER_PARALLEL = 4;
  var REVEAL_WAIT_MS = 1200;
  var COVERS_KEY = 'synframe.covers';

  // Opening the grid: it fades in over the slideshow, and the cards move in one after
  // another (see .card-slot in style.css), this far apart.
  var ENTER_STAGGER_MS = 55;
  var ENTER_MAX_STAGGER = 12; // cards after this many all start together

  var SCROLL_MS = 300;
  var SCROLL_EASE = 'cubic-bezier(0.45, 0, 0.25, 1.22)';


  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sameSource(tile, s) {
    if (tile.pick.source !== s.source) return false;
    return tile.pick.source !== 'album' || tile.pick.albumId === s.albumId;
  }

  // "2026", or "2022–2023" when an album spans years. Read as UTC like the slideshow's
  // date taken, since Synology stores taken times as wall-clock time.
  function yearsOf(a) {
    if (!a.startTime && !a.endTime) return '';
    var from = new Date((a.startTime || a.endTime) * 1000).getUTCFullYear();
    var to = new Date((a.endTime || a.startTime) * 1000).getUTCFullYear();
    if (to < from) { var t = from; from = to; to = t; }
    return from === to ? String(from) : from + '\u2013' + to;
  }

  function albumDetails(a) {
    var parts = [];
    if (a.count) parts.push(a.count + ' item' + (a.count === 1 ? '' : 's'));
    var years = yearsOf(a);
    if (years) parts.push(years);
    return parts.join(' \u00b7 ');
  }

  /*
   * Makes a canvas's corners transparent. TV browsers don't reliably clip a
   * GPU-drawn canvas to its parent's border-radius (only the scaled, focused
   * card got rounded), so the rounding is cut into the pixels instead.
   */
  // top / bottom: radius of the top and bottom corners, in canvas pixels.
  function roundCorners(ctx, w, h, top, bottom) {
    var max = Math.min(w / 2, h / 2);
    top = Math.min(top, max);
    bottom = Math.min(bottom === undefined ? top : bottom, max);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000'; // must be opaque: its alpha scales everything kept
    ctx.beginPath();
    ctx.moveTo(top, 0);
    ctx.arcTo(w, 0, w, h, top);
    ctx.arcTo(w, h, 0, h, bottom);
    ctx.arcTo(0, h, 0, 0, bottom);
    ctx.arcTo(0, 0, w, 0, top);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /*
   * A card's position on the track. While its slot is animating in, browsers make the
   * (transformed) slot the card's offsetParent, so add the slot's own offset then.
   */
  function cardPos(card) {
    var slot = card.parentNode;
    var top = card.offsetTop, left = card.offsetLeft;
    if (card.offsetParent === slot) {
      top += slot.offsetTop;
      left += slot.offsetLeft;
    }
    return { top: top, left: left };
  }

  function sizeCanvas(canvas, w, h) {
    var ratio = global.devicePixelRatio || 1;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    return canvas.getContext('2d');
  }

  /*
   * opts.onPick(pick)   pick = { source, albumId, albumName, albumPassphrase }
   * opts.onSettings()
   * opts.onClose()
   */
  function AlbumBrowser(root, opts) {
    var self = this;
    this.root = root;
    this.grid = root.querySelector('#albums-grid');
    this.track = root.querySelector('#albums-track');
    this.headerFrost = root.querySelector('.header-frost');
    this.scrollTarget = 0; // where the track is, or is gliding to
    // The track and the header's frost copy of it glide together, with the same transition.
    this.movers = [this.track, this.headerFrost];
    this.movers.forEach(function (m) {
      m.style.webkitTransition = '-webkit-transform ' + SCROLL_MS + 'ms ' + SCROLL_EASE;
      m.style.transition = 'transform ' + SCROLL_MS + 'ms ' + SCROLL_EASE;
    });
    this.status = root.querySelector('#albums-status');
    this.settingsBtn = root.querySelector('#albums-settings');
    this.loading = root.querySelector('#albums-loading');
    this.opts = opts;
    this.tiles = [];
    this.focus = 0;
    this.loadToken = 0;
    this.settingsBtn.addEventListener('click', function () { self.setFocus(SETTINGS); self.activate(); });
  }

  AlbumBrowser.prototype.isOpen = function () {
    return !this.root.classList.contains('hidden');
  };

  // Hides the grid but keeps it (covers and all), so going back to it is instant.
  AlbumBrowser.prototype.close = function () {
    this.root.classList.remove('shown');
    this.root.classList.add('hidden');
  };

  /*
   * Fades the grid in (CSS opacity transition on #albums). It's first settled as
   * hidden: if the browser hasn't computed its style since it was last closed (no
   * frame drawn in between), it would otherwise "fade" from its old, visible state.
   */
  AlbumBrowser.prototype._fadeIn = function () {
    var root = this.root;
    root.classList.remove('shown');
    root.classList.add('hidden');
    void root.offsetWidth; // settle as hidden
    root.classList.remove('hidden');
    void root.offsetWidth; // now transparent: the fade starts here
    root.classList.add('shown');
  };

  // Appears at once, with the opacity transition switched off meanwhile, so nothing
  // (not even an unfinished earlier fade) can make it fade.
  AlbumBrowser.prototype._showNow = function () {
    var root = this.root;
    root.style.webkitTransition = root.style.transition = 'none';
    root.classList.remove('hidden');
    root.classList.add('shown');
    void root.offsetWidth; // apply at full opacity before the transition comes back
    root.style.webkitTransition = root.style.transition = '';
  };

  // Moves the cards in one after another (a CSS animation on each card's slot).
  AlbumBrowser.prototype._playEntrance = function () {
    var root = this.root;
    this.tiles.forEach(function (t, i) {
      var d = Math.min(i, ENTER_MAX_STAGGER) * ENTER_STAGGER_MS + 'ms';
      t.slot.style.webkitAnimationDelay = t.slot.style.animationDelay = d;
    });
    root.classList.remove('enter');
    void root.offsetWidth; // restart the animation
    root.classList.add('enter');
  };

  function signature(albums, shared) {
    return JSON.stringify([shared, albums.map(function (a) {
      return [a.id, a.name, a.count, a.endTime, a.cover && a.cover.cacheKey];
    })]);
  }

  // client: a signed-in SynologyClient; current: the settings now playing.
  // opts.instant: appear at once instead of fading in.
  AlbumBrowser.prototype.open = function (client, current, opts) {
    var self = this;
    var token = ++self.loadToken;
    var key = client.server + '|' + client.account;
    var cached = self.cacheKey === key && self.tiles.length && Date.now() - self.cacheTime < CACHE_MS;
    self.client = client;
    self.current = current;
    if (opts && opts.instant) self._showNow();
    else self._fadeIn();

    if (cached) {
      // Show the grid as it was, at once, with the playing album marked and selected,
      // and finish any covers that hadn't arrived before the grid was last left.
      self._markPlaying(current);
      self.paintHeader();
      self._playEntrance();
      self.loadCovers(token);
    } else {
      self.track.innerHTML = '';
      self.jumpTo(0);
      self.tiles = [];
      self.signature = null;
      self.status.textContent = '';
      self.loading.classList.remove('hidden');
      self.setFocus(SETTINGS);
      self.remembered = decodeCovers(readCovers(key));
    }

    // Fetch the album list (again): build the grid, or rebuild it only if it changed.
    Promise.all([client.listAlbums(), client.hasSharedSpace()]).then(function (res) {
      if (token !== self.loadToken) return;
      self.loading.classList.add('hidden');
      var albums = res[0];
      var sig = signature(albums, res[1]);
      self.cacheKey = key;
      self.cacheTime = Date.now();
      if (sig === self.signature) return; // unchanged: keep what's on screen
      self.signature = sig;
      // Albums first (newest first, as listAlbums returns them), then Shared Space,
      // and "All my photos" last.
      var tiles = [];
      albums.forEach(function (a) {
        tiles.push({
          title: a.name,
          sub: albumDetails(a),
          cover: a.cover,
          pick: { source: 'album', albumId: a.id, albumName: a.name, albumPassphrase: a.passphrase },
          source: { type: 'album', albumId: a.id, passphrase: a.passphrase }
        });
      });
      if (res[1]) tiles.push({ title: 'Shared Space', pick: { source: 'shared' }, source: { type: 'shared' } });
      tiles.push({ title: 'All my photos', pick: { source: 'personal' }, source: { type: 'personal' } });
      self.status.textContent = albums.length ? '' : 'No albums are shared with this account yet.';
      self.render(tiles, self.current);
      self._playEntrance();
      self.loadCovers(token);
    }, function (err) {
      if (token !== self.loadToken) return;
      self.loading.classList.add('hidden');
      if (!self.tiles.length) self.status.textContent = err.message || String(err);
    });
  };

  // Moves the "Playing" badge to the album now playing and selects it.
  AlbumBrowser.prototype._markPlaying = function (current) {
    var focus = 0;
    this.tiles.forEach(function (t, i) {
      var playing = !!current && sameSource(t, current);
      if (playing) focus = i;
      if (playing && !t.badge) {
        t.badge = el('div', 'badge', 'Playing');
        t.el.firstChild.appendChild(t.badge);
      } else if (!playing && t.badge) {
        t.badge.parentNode.removeChild(t.badge);
        t.badge = null;
      }
    });
    this.setFocus(this.tiles.length ? focus : SETTINGS);
  };

  AlbumBrowser.prototype.render = function (tiles, current) {
    var self = this;
    self.tiles = tiles;
    self.track.innerHTML = '';
    tiles.forEach(function (t, i) {
      // The slot carries the entrance animation, so it doesn't fight the card's own
      // transform (the focused card is scaled up).
      var slot = el('div', 'card-slot');
      var card = el('div', 'card');
      var cover = el('div', 'cover');
      var art = el('canvas', 'cover-art');
      cover.appendChild(art);

      var label = el('div', 'card-label');
      var frost = el('canvas', 'card-frost');
      label.appendChild(frost);
      label.appendChild(el('div', 'card-title', t.title));
      var sub = el('div', 'card-sub', t.sub || '');
      label.appendChild(sub);
      cover.appendChild(label);

      card.appendChild(cover);
      card.addEventListener('click', function () { self.setFocus(i); self.activate(); });
      t.el = card;
      t.slot = slot;
      t.art = art;
      t.frost = frost;
      t.subEl = sub;
      slot.appendChild(card);
      self.track.appendChild(slot);
    });
    self._markPlaying(current);
    self.paintHeader(); // sized to the track now; covers are added as they arrive
  };

  /*
   * Loads covers COVER_PARALLEL at a time. Painted covers stay hidden until all of
   * them are in (or REVEAL_WAIT_MS has passed), then fade in together, so the grid
   * doesn't fill up one card at a time. Covers painted before are kept on the TV
   * (see the cover store below), so after the first time the grid opens with them.
   */
  AlbumBrowser.prototype.loadCovers = function (token) {
    var self = this;
    var queue = self.tiles.filter(function (t) { return !t.painted && !t.el.classList.contains('empty'); });
    var pending = queue.length;
    var revealed = false;
    var store = self.remembered || {};
    self.remembered = null;
    var unchecked = []; // remembered covers of tiles whose cover photo isn't known up front
    if (!pending) return;

    function reveal() {
      if (revealed || token !== self.loadToken) return;
      revealed = true;
      self.tiles.forEach(function (t) { if (t.painted) t.el.classList.add('loaded'); });
      self.paintHeader();
    }
    setTimeout(reveal, REVEAL_WAIT_MS);

    // A cover is in (or failed). done() also starts the next download.
    function settled(t) {
      pending--;
      if (revealed && t && t.painted) {
        t.el.classList.add('loaded');
        self.paintHeader();
      }
      if (!pending) {
        reveal();
        unchecked.forEach(check);
        self._saveCovers(token);
      }
    }
    function done(t) {
      settled(t);
      next();
    }

    function paintFrom(t, url, photo) {
      var img = new Image();
      img.onload = function () {
        if (token !== self.loadToken) return;
        self.paintCover(t, img, photoKey(photo));
        done(t);
      };
      img.onerror = function () {
        // DSM's own cover reference can be stale; fall back to the first photo once.
        if (t.cover && photo === t.cover) {
          t.cover = null;
          queue.unshift(t);
          pending++;
        }
        done(t);
      };
      img.src = url;
    }

    function fetchCover(t) {
      var known = t.cover ? Promise.resolve(t.cover) : self.client.coverPhoto(t.source);
      known.then(function (photo) {
        if (token !== self.loadToken) return;
        if (!photo) {
          t.el.classList.add('empty');
          if (!t.sub) t.subEl.textContent = 'No photos';
          return done(t);
        }
        paintFrom(t, self.client.thumbnailUrl(photo, 'xl'), photo);
      }, function () { done(t); });
    }

    // A remembered cover for "All my photos" or Shared Space may be out of date: once
    // everything is shown, look up the current cover photo and repaint if it changed.
    function check(t) {
      self.client.coverPhoto(t.source).then(function (photo) {
        if (token !== self.loadToken || !photo || photoKey(photo) === t.photoKey) return;
        var img = new Image();
        img.onload = function () {
          if (token !== self.loadToken) return;
          self.paintCover(t, img, photoKey(photo));
          self.paintHeader();
          self._saveCovers(token);
        };
        img.src = self.client.thumbnailUrl(photo, 'xl');
      }, function () {});
    }

    function next() {
      if (token !== self.loadToken || !queue.length) return;
      fetchCover(queue.shift());
    }

    // Remembered covers need nothing from the NAS: paint them all as soon as they're decoded.
    queue = queue.filter(function (t) {
      var kept = store[tileKey(t)];
      if (!kept || (t.cover && kept.photo !== photoKey(t.cover))) return true;
      kept.ready.then(function () {
        if (token !== self.loadToken) return;
        t.photoKey = kept.photo;
        if (!t.cover) unchecked.push(t);
        self.paintCover(t, kept.img, null);
        settled(t);
      }, function () {
        if (token === self.loadToken) fetchCover(t); // unreadable: download it after all
      });
      return false;
    });
    for (var i = 0; i < COVER_PARALLEL; i++) next();
  };

  /*
   * The cover store: each album's painted cover, as a small JPEG in localStorage, so the
   * grid can open with its covers the first time after launch instead of waiting on the
   * NAS. Saved in the background, one cover at a time, after the grid is shown.
   */
  function tileKey(t) {
    return t.source.type + ':' + (t.source.albumId || '');
  }
  function photoKey(photo) {
    return photo.id + '_' + photo.cacheKey;
  }
  function readCovers(owner) {
    try {
      var saved = JSON.parse(localStorage.getItem(COVERS_KEY));
      return saved && saved.owner === owner && saved.covers || {};
    } catch (e) {
      return {};
    }
  }

  // Starts loading the remembered covers (each gets .img, and .ready once loaded).
  function decodeCovers(covers) {
    Object.keys(covers).forEach(function (k) {
      var c = covers[k], img = new Image();
      c.img = img;
      c.ready = new Promise(function (resolve, reject) {
        img.onload = resolve; // small enough to decode quickly when drawn
        img.onerror = reject;
      });
      img.src = c.data;
    });
    return covers;
  }

  AlbumBrowser.prototype._saveCovers = function (token) {
    var self = this;
    var owner = self.cacheKey || '';
    var todo = self.tiles.filter(function (t) { return t.raw; });
    if (!todo.length) return;
    (function encodeNext() {
      if (token !== self.loadToken) return;
      var t = todo.shift();
      if (t) {
        try { t.rawData = t.raw.toDataURL('image/jpeg', 0.85); } catch (e) {}
        t.raw = null;
        return setTimeout(encodeNext, 50);
      }
      // Keep only the albums on the grid now, so the store can't grow without end.
      var old = readCovers(owner), covers = {};
      self.tiles.forEach(function (t) {
        var k = tileKey(t);
        if (t.rawData) covers[k] = { photo: t.photoKey, data: t.rawData };
        else if (old[k] && old[k].photo === t.photoKey) covers[k] = old[k];
        t.rawData = null;
      });
      try {
        localStorage.setItem(COVERS_KEY, JSON.stringify({ owner: owner, covers: covers }));
      } catch (e) {
        try { localStorage.removeItem(COVERS_KEY); } catch (e2) {} // full: don't keep a stale half
      }
    })();
  };

  /*
   * Draws the cover at card size (so the full preview can be released), then a
   * blurred copy of the strip behind the label for the frosted-glass look. Blurred
   * on canvas rather than with CSS backdrop-filter, which TVs can silently drop.
   */
  // photo: the key of the photo it was drawn from, to remember the cover by (null when
  // drawn from the store, which already has it).
  AlbumBrowser.prototype.paintCover = function (t, img, photo) {
    var w = t.art.clientWidth, h = t.art.clientHeight;
    if (!w || !h) return;
    var ctx = sizeCanvas(t.art, w, h);
    var iw = img.naturalWidth, ih = img.naturalHeight;
    var scale = Math.max(t.art.width / iw, t.art.height / ih);
    var sw = t.art.width / scale, sh = t.art.height / scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, t.art.width, t.art.height);
    t.painted = true; // shown by loadCovers' reveal

    // The strip of the cover behind the label (the full width of its bottom), in canvas pixels.
    var ratio = t.art.width / w;
    var lw = t.art.width, lh = LABEL_HEIGHT * ratio, ly = t.art.height - lh;
    var fctx = t.frost.getContext('2d');
    var canFilter = 'filter' in fctx;
    // Blur at reduced size; without canvas filters, a much smaller canvas blurs by stretching.
    var shrink = canFilter ? 4 : 16;
    t.frost.width = Math.max(1, Math.round(lw / shrink));
    t.frost.height = Math.max(1, Math.round(lh / shrink));
    // Draw a little past the edges so the blur doesn't fade there. The strip touches the
    // cover's sides and bottom, so there's no photo beyond it: stretch it slightly instead.
    var pad = canFilter ? 12 : 0; // 3x the blur radius, so the edges stay fully opaque
    if (canFilter) fctx.filter = 'blur(4px)';
    fctx.drawImage(t.art, 0, ly, lw, lh, -pad, -pad, t.frost.width + 2 * pad, t.frost.height + 2 * pad);
    if (canFilter) fctx.filter = 'none';
    // Tint so white text stays readable on bright covers.
    fctx.fillStyle = 'rgba(15, 17, 22, 0.32)';
    fctx.fillRect(0, 0, t.frost.width, t.frost.height);
    // Square top corners; bottom corners follow the cover's.
    roundCorners(fctx, t.frost.width, t.frost.height, 0, COVER_RADIUS * ratio * t.frost.width / lw);

    // Keep an unrounded copy to save in the cover store (JPEG has no transparent corners).
    if (photo) {
      t.photoKey = photo;
      t.raw = document.createElement('canvas');
      t.raw.width = t.art.width;
      t.raw.height = t.art.height;
      t.raw.getContext('2d').drawImage(t.art, 0, 0);
    }

    // Round the cover last: the frost above was copied from its unrounded pixels.
    roundCorners(ctx, t.art.width, t.art.height, COVER_RADIUS * ratio);
  };

  /*
   * The header's frost: a blurred copy of the whole track (every cover at its place on
   * the track, drawn small), painted once whenever a cover arrives. It slides with the
   * same GPU transition as the track and is seen through the header (.header-frost-clip),
   * so the blur moves in lockstep with the covers with no per-frame work. CSS backdrop
   * blur isn't reliable on the TV, and repainting per frame lagged behind the glide.
   */
  AlbumBrowser.prototype.paintHeader = function () {
    var c = this.headerFrost;
    var w = this.track.offsetWidth, h = this.track.offsetHeight;
    if (!w || !h) return;
    c.style.height = h + 'px';
    var ctx = c.getContext('2d');
    var canFilter = 'filter' in ctx;
    var k = canFilter ? 4 : 16; // CSS px per canvas px; without filters, stretching does the blurring
    c.width = Math.ceil(w / k);
    c.height = Math.ceil(h / k);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, c.width, c.height);
    if (canFilter) ctx.filter = 'blur(3px)';
    this.tiles.forEach(function (t) {
      if (!t.el.classList.contains('loaded')) return;
      var pos = cardPos(t.el);
      var x = pos.left, y = pos.top;
      var cw = t.el.offsetWidth, ch = t.el.offsetHeight;
      ctx.drawImage(t.art, x / k, y / k, cw / k, ch / k);
      ctx.drawImage(t.frost, x / k, (y + ch - LABEL_HEIGHT) / k, cw / k, LABEL_HEIGHT / k);
    });
    if (canFilter) ctx.filter = 'none';
  };

  // Glides the track so a card (with room for its focus ring) is clear of the header and
  // the screen edge. Returns true if a glide started.
  AlbumBrowser.prototype.ensureVisible = function (card) {
    var y = this.scrollTarget;
    var cardTop = cardPos(card).top;
    var top = cardTop - HEADER_HEIGHT - FOCUS_ROOM;
    var bottom = cardTop + card.offsetHeight + BOTTOM_ROOM - this.grid.clientHeight;
    // Back near the top row: go to the very top rather than stopping a few px short.
    if (y > top) return this.scrollTo(top < card.offsetHeight / 2 ? 0 : top);
    if (y < bottom) return this.scrollTo(bottom);
    return false;
  };

  // Moves the track and its frost copy together, in the same frame.
  AlbumBrowser.prototype._applyScroll = function (y) {
    var t = 'translate3d(0, ' + (-Math.round(y)) + 'px, 0)';
    this.movers.forEach(function (m) {
      m.style.webkitTransform = t;
      m.style.transform = t;
    });
  };

  // Moves the track without a glide (opening the screen).
  AlbumBrowser.prototype.jumpTo = function (y) {
    var saved = this.movers.map(function (m) { return [m.style.transition, m.style.webkitTransition]; });
    this.movers.forEach(function (m) { m.style.transition = m.style.webkitTransition = 'none'; });
    this.scrollTarget = y;
    this._applyScroll(y);
    void this.track.offsetHeight; // apply before the transition comes back
    this.movers.forEach(function (m, i) { m.style.transition = saved[i][0]; m.style.webkitTransition = saved[i][1]; });
  };

  /*
   * Glides the track to y. A new glide mid-way simply retargets: the browser continues
   * from wherever the track is; the header frost moves with it (_applyScroll).
   */
  AlbumBrowser.prototype.scrollTo = function (y) {
    var self = this;
    var max = Math.max(0, self.track.offsetHeight - self.grid.clientHeight);
    y = Math.max(0, Math.min(y, max));
    if (y === self.scrollTarget) return false;
    self.scrollTarget = y;
    self._applyScroll(y);
    return true;
  };

  AlbumBrowser.prototype.setFocus = function (i) {
    if (i !== SETTINGS && (i < 0 || i >= this.tiles.length)) return;
    this.focus = i;
    this.tiles.forEach(function (t, j) {
      t.el.classList.toggle('focused', j === i);
      t.slot.classList.toggle('focused', j === i);
    });
    this.settingsBtn.classList.toggle('focused', i === SETTINGS);
    if (i !== SETTINGS) this.ensureVisible(this.tiles[i].el);
  };

  AlbumBrowser.prototype.activate = function () {
    if (this.focus === SETTINGS) {
      this.close();
      this.opts.onSettings();
      return;
    }
    var t = this.tiles[this.focus];
    if (!t) return;
    this.close();
    this.opts.onPick(t.pick);
  };

  AlbumBrowser.prototype.handleKey = function (e) {
    var n = this.tiles.length;
    var f = this.focus;
    switch (e.keyCode) {
      case KEY.LEFT: if (f > 0) this.setFocus(f - 1); break;
      case KEY.RIGHT: if (f !== SETTINGS) this.setFocus(f + 1); break;
      case KEY.UP:
        // Settings sits in the header, above the top row.
        if (f === SETTINGS) break;
        if (f < COLUMNS) this.setFocus(SETTINGS);
        else this.setFocus(f - COLUMNS);
        break;
      case KEY.DOWN:
        // From Settings (top right), go to the top row's rightmost card.
        if (f === SETTINGS) { if (n) this.setFocus(Math.min(COLUMNS, n) - 1); break; }
        if (f + COLUMNS < n) this.setFocus(f + COLUMNS);
        // A shorter last row: drop to its last card rather than skipping it.
        else if (Math.floor(f / COLUMNS) < Math.floor((n - 1) / COLUMNS)) this.setFocus(n - 1);
        break;
      case KEY.ENTER: this.activate(); break;
      // The grid is the app's top level; the app decides what Back does (asks to exit).
      case KEY.BACK: case KEY.ESC: this.opts.onBack(); break;
      default: return false;
    }
    e.preventDefault();
    return true;
  };

  global.AlbumBrowser = AlbumBrowser;
})(window);
