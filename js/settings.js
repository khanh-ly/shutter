/*
 * Settings screen built for a TV remote, in two columns: categories on the left,
 * that category's options on the right. In the categories, ▲▼ moves (the options
 * follow along) and ▶/OK steps into the options. In the options, ▲▼ moves, ◀▶
 * changes a choice, OK edits a text field (opens the TV keyboard) or presses a
 * button, and Back returns to the categories. Mouse clicks work too, for testing
 * in a desktop browser.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'synframe.settings';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27, IME_DONE: 65376, IME_CANCEL: 65385
  };

  function loadSettings() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) {}
    return Object.assign({}, global.SYNFRAME_DEFAULTS, saved);
  }

  function saveSettings(settings) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // What's still missing before we can connect, or '' if nothing.
  function missing(d) {
    if (!d.server || !d.account || !d.password) return 'Enter the DSM address, username and password first.';
    return '';
  }

  function onOff(field) {
    return Object.assign({ type: 'choice', options: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] }, field);
  }

  function hasMotion(s) { return s.motion; }

  var CATEGORIES = [
    { id: 'account', label: 'Account' },
    { id: 'photos', label: 'Photos' },
    { id: 'slideshow', label: 'Slideshow' },
    { id: 'motion', label: 'Pan & zoom' },
    { id: 'screen', label: 'On screen' },
    { id: 'about', label: 'About' }
  ];

  var APP_NAME = 'Shutter';
  var APP_TAGLINE = 'The unofficial Synology Photos app for Samsung TV';
  var COPYRIGHT = '\u00a9 2026 Khanh Ly';
  var LICENSE = 'MIT License';
  var REPO = 'github.com/khanh-ly/shutter'; // shown as text: the TV can't open links

  /*
   * The installed version and some facts about the TV, for the About page. The
   * version comes from config.xml (via the TV, or by reading the file in a desktop
   * browser) so it can't drift from what's packaged.
   */
  var aboutInfo = null;
  function loadAboutInfo() {
    if (aboutInfo) return aboutInfo;
    var tv = '';
    try {
      var sys = global.tizen && tizen.systeminfo;
      if (sys) {
        var model = sys.getCapability('http://tizen.org/system/model_name');
        var platform = sys.getCapability('http://tizen.org/feature/platform.version');
        tv = [model, platform && 'Tizen ' + platform].filter(Boolean).join(' \u00b7 ');
      }
    } catch (e) {}
    var version = '';
    try { version = tizen.application.getCurrentApplication().appInfo.version; } catch (e) {}
    aboutInfo = new Promise(function (resolve) {
      if (version) return resolve({ version: version, tv: tv });
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'config.xml', true);
      xhr.onload = function () {
        var m = /<widget[^>]*\sversion="([^"]+)"/.exec(xhr.responseText || '');
        resolve({ version: m ? m[1] : '', tv: tv });
      };
      xhr.onerror = function () { resolve({ version: '', tv: tv }); };
      xhr.send();
    });
    return aboutInfo;
  }
  var SAVE = CATEGORIES.length; // the Save button sits below the categories

  /*
   * opts.connect(settingsDraft) -> Promise<albums[]>   test sign-in, load albums
   * opts.onSave(settings)                              start the slideshow
   * opts.onClose()                                     Back pressed (only if already configured)
   */
  function SettingsUI(root, opts) {
    var self = this;
    this.root = root;
    this.catsEl = root.querySelector('#settings-cats');
    this.saveEl = root.querySelector('#settings-save');
    this.rowsEl = root.querySelector('#settings-rows');
    this.statusEl = root.querySelector('#settings-status');
    this.opts = opts;
    this.zone = 'cats'; // 'cats' (left column) or 'opts' (right column)
    this.cat = 0;       // current category, or SAVE
    this.focus = 0;     // option row in the right column
    this.rowEls = [];
    this.albums = [];
    this.fields = [
      { cat: 'account', key: 'server', label: 'DSM address', type: 'text', placeholder: 'http://192.168.1.20:5000' },
      { cat: 'account', key: 'account', label: 'Username', type: 'text', placeholder: 'photoframe' },
      { cat: 'account', key: 'password', label: 'Password', type: 'password' },
      { cat: 'account', key: 'connect', label: 'Connect & load albums', type: 'button', action: this.connect.bind(this) },
      { cat: 'photos', key: 'source', label: 'Show photos from', type: 'choice', options: [
        { value: 'personal', label: 'All my photos' },
        { value: 'album', label: 'One album' },
        { value: 'shared', label: 'Shared Space' }
      ] },
      { cat: 'photos', key: 'albumId', label: 'Album', type: 'choice', options: [], when: function (s) { return s.source === 'album'; } },
      { cat: 'slideshow', key: 'interval', label: 'Change photo every', type: 'choice', options: [
        { value: 10, label: '10 seconds' }, { value: 20, label: '20 seconds' }, { value: 30, label: '30 seconds' },
        { value: 60, label: '1 minute' }, { value: 120, label: '2 minutes' }, { value: 300, label: '5 minutes' },
        { value: 600, label: '10 minutes' }, { value: 1800, label: '30 minutes' }, { value: 3600, label: '1 hour' }
      ] },
      { cat: 'slideshow', key: 'order', label: 'Order', type: 'choice', options: [
        { value: 'shuffle', label: 'Shuffle' }, { value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }
      ] },
      { cat: 'slideshow', key: 'fit', label: 'Photo fit', type: 'choice', options: [
        { value: 'blur', label: 'Whole photo, blurred edges' },
        { value: 'black', label: 'Whole photo, black edges' },
        { value: 'cover', label: 'Fill the screen (crops)' }
      ] },
      { cat: 'slideshow', key: 'quality', label: 'Image size', type: 'choice', options: [
        { value: 'xl', label: 'Large preview (fast)' },
        { value: 'original', label: 'Original file (slower)' }
      ] },
      onOff({ cat: 'motion', key: 'motion', label: 'Slow pan & zoom' }),
      { cat: 'motion', key: 'kbZoom', label: 'Zoom amount', type: 'choice', when: hasMotion, options: [
        { value: 3, label: 'Very subtle (3%)' }, { value: 6, label: 'Subtle (6%)' },
        { value: 10, label: 'Medium (10%)' }, { value: 15, label: 'Strong (15%)' }
      ] },
      { cat: 'motion', key: 'kbDirection', label: 'Zoom direction', type: 'choice', when: hasMotion, options: [
        { value: 'both', label: 'In and out' }, { value: 'in', label: 'In only' }, { value: 'out', label: 'Out only' }
      ] },
      onOff({ cat: 'motion', key: 'kbDrift', label: 'Drift', when: hasMotion }),
      onOff({ cat: 'screen', key: 'clock', label: 'Clock' }),
      onOff({ cat: 'screen', key: 'info', label: 'Date taken' })
    ];
    this.draft = loadSettings();
    this._seedAlbumOption();
    this.saveEl.addEventListener('click', function () { self.save(); });
  }

  SettingsUI.load = loadSettings;
  SettingsUI.save = saveSettings;

  SettingsUI.prototype.isOpen = function () {
    return !this.root.classList.contains('hidden');
  };

  SettingsUI.prototype.open = function (message) {
    this.draft = loadSettings();
    this.showPassword = false;
    this._seedAlbumOption();
    this.root.classList.remove('hidden');
    this.setStatus(message || '', message ? 'error' : '');
    // Missing sign-in details (or a problem to fix): start on Account, on the first
    // empty field. Otherwise start on the categories.
    var firstEmpty = ['server', 'account', 'password'].filter(function (k) { return !this.draft[k]; }, this)[0];
    this.selectCat(0);
    if (firstEmpty || message) this.enterOpts(firstEmpty || 'server');
  };

  SettingsUI.prototype.close = function () {
    this.root.classList.add('hidden');
  };

  // Show the saved album even before albums are fetched from the DSM.
  SettingsUI.prototype._seedAlbumOption = function () {
    var field = this._field('albumId');
    if (this.albums.length) {
      field.options = this.albums.map(function (a) { return { value: a.id, label: a.name + (a.count ? ' (' + a.count + ')' : '') }; });
    } else if (this.draft.albumId) {
      field.options = [{ value: this.draft.albumId, label: this.draft.albumName || ('Album ' + this.draft.albumId) }];
    } else {
      field.options = [{ value: '', label: 'Press "Connect" to load albums' }];
    }
  };

  SettingsUI.prototype._field = function (key) {
    return this.fields.filter(function (f) { return f.key === key; })[0];
  };

  // The current category's options that apply right now.
  SettingsUI.prototype._visible = function () {
    var d = this.draft;
    var cat = CATEGORIES[this.cat] ? CATEGORIES[this.cat].id : '';
    return this.fields.filter(function (f) { return f.cat === cat && (!f.when || f.when(d)); });
  };

  SettingsUI.prototype._renderCats = function () {
    var self = this;
    self.catsEl.innerHTML = '';
    self.catEls = CATEGORIES.map(function (c, i) {
      var item = el('div', 'cat', c.label);
      item.addEventListener('click', function () { self.selectCat(i); self.enterOpts(); });
      self.catsEl.appendChild(item);
      return item;
    });
  };

  // Shows a category's options on the right (or nothing, for Save).
  SettingsUI.prototype.selectCat = function (i) {
    if (i < 0 || i > SAVE) return;
    this._syncInputs(); // keep anything typed before its row disappears
    this.cat = i;
    this.zone = 'cats';
    if (!this.catEls) this._renderCats();
    if (i !== SAVE) this.render();
    this._paintFocus();
  };

  // Moves into the right column, onto the given option (or the first one).
  SettingsUI.prototype.enterOpts = function (key) {
    var keys = this._visible().map(function (f) { return f.key; });
    if (!keys.length) return;
    this.zone = 'opts';
    this.setFocus(Math.max(0, keys.indexOf(key)));
  };

  SettingsUI.prototype.leaveOpts = function () {
    var row = this.rowEls[this.focus];
    if (row && row.input) row.input.blur();
    this.zone = 'cats';
    this._paintFocus();
  };

  SettingsUI.prototype.render = function () {
    var self = this;
    self.rowsEl.innerHTML = '';
    self.rowEls = [];
    if (CATEGORIES[self.cat] && CATEGORIES[self.cat].id === 'about') return self._renderAbout();
    self._visible().forEach(function (f, i) {
      var row = el('div', 'row row-' + f.type);
      row.addEventListener('click', function () { self.zone = 'opts'; self.setFocus(i); });

      if (f.type === 'button') {
        row.appendChild(el('span', 'label', f.label));
        row.addEventListener('click', function () { f.action(); });
      } else {
        row.appendChild(el('span', 'label', f.label));
        if (f.type === 'choice') {
          var value = el('span', 'value');
          var prev = el('span', 'arrow', '◀');
          var next = el('span', 'arrow', '▶');
          prev.addEventListener('click', function (e) { e.stopPropagation(); self.setFocus(i); self.cycle(-1); });
          next.addEventListener('click', function (e) { e.stopPropagation(); self.setFocus(i); self.cycle(1); });
          value.appendChild(prev);
          value.appendChild(el('span', 'choice-text', self._choiceLabel(f)));
          value.appendChild(next);
          row.appendChild(value);
        } else {
          var input = el('input', 'value');
          var secret = f.type === 'password';
          input.type = secret && !self.showPassword ? 'password' : 'text';
          input.value = self.draft[f.key] || '';
          input.placeholder = f.placeholder || '';
          input.setAttribute('autocomplete', 'off');
          input.setAttribute('autocapitalize', 'off');
          input.setAttribute('spellcheck', 'false');
          // Spaces can be part of a password, so only trim the other fields.
          row.sync = function () { self.draft[f.key] = secret ? input.value : input.value.trim(); };
          // TV keyboards don't always fire 'input' for every character, so also sync on
          // change/blur, and _syncInputs() reads every field again before connecting or saving.
          input.addEventListener('input', row.sync);
          input.addEventListener('change', row.sync);
          input.addEventListener('blur', row.sync);
          input.addEventListener('focus', function () { self.zone = 'opts'; self.focus = i; self._paintFocus(); });
          row.appendChild(input);
          row.input = input;
          if (secret) {
            var toggle = el('span', 'reveal', self.showPassword ? '◀ Hide ▶' : '◀ Show ▶');
            toggle.addEventListener('click', function (e) { e.stopPropagation(); self.setFocus(i); self.togglePassword(); });
            row.appendChild(toggle);
            row.toggle = toggle;
          }
        }
      }
      self.rowsEl.appendChild(row);
      self.rowEls.push(row);
    });
    self._paintFocus();
  };

  // The About page: information only, so there's nothing to step into from the categories.
  SettingsUI.prototype._renderAbout = function () {
    var d = this.draft;
    var box = el('div', 'about');
    box.appendChild(el('div', 'about-name', APP_NAME));
    box.appendChild(el('div', 'about-tagline', APP_TAGLINE));
    var version = el('div', 'about-version', 'Version \u2026');
    box.appendChild(version);
    box.appendChild(el('div', 'about-line', COPYRIGHT + ' \u00b7 Released under the ' + LICENSE));
    box.appendChild(el('div', 'about-repo', 'Source code, help and updates: ' + REPO));

    var details = el('div', 'about-details');
    function detail(label, value) {
      if (!value) return;
      var row = el('div', 'about-detail');
      row.appendChild(el('span', 'about-label', label));
      row.appendChild(el('span', 'about-value', value));
      details.appendChild(row);
    }
    detail('DSM address', d.server);
    detail('Signed in as', d.account);
    var tvRow = el('div', 'about-detail');
    details.appendChild(tvRow);
    box.appendChild(details);

    box.appendChild(el('div', 'about-small',
      'Settings icon from Material Design Icons by Google, Apache License 2.0.'));
    box.appendChild(el('div', 'about-small',
      'Not affiliated with or endorsed by Synology Inc. or Samsung Electronics. Synology and ' +
      'Synology Photos are trademarks of Synology Inc. Samsung and The Frame are trademarks of ' +
      'Samsung Electronics Co., Ltd.'));
    this.rowsEl.appendChild(box);

    loadAboutInfo().then(function (info) {
      version.textContent = info.version ? 'Version ' + info.version : 'Version unknown';
      if (info.tv) {
        tvRow.appendChild(el('span', 'about-label', 'This TV'));
        tvRow.appendChild(el('span', 'about-value', info.tv));
      }
    });
  };

  // Switches the password between dots and plain text. Not saved: it starts hidden each time.
  SettingsUI.prototype.togglePassword = function () {
    this.showPassword = !this.showPassword;
    var self = this;
    this.rowEls.forEach(function (row) {
      if (!row.toggle) return;
      row.input.type = self.showPassword ? 'text' : 'password';
      row.toggle.textContent = self.showPassword ? '◀ Hide ▶' : '◀ Show ▶';
    });
  };

  SettingsUI.prototype._choiceLabel = function (f) {
    var v = this.draft[f.key];
    var opt = f.options.filter(function (o) { return o.value === v; })[0];
    return opt ? opt.label : (f.options[0] ? f.options[0].label : '');
  };

  SettingsUI.prototype.setFocus = function (i) {
    var n = this.rowEls.length;
    if (i < 0 || i >= n) return;
    this.focus = i;
    this._paintFocus();
  };

  // The focus ring sits in one column; the other column shows the current category.
  SettingsUI.prototype._paintFocus = function () {
    var self = this;
    var inOpts = self.zone === 'opts';
    (self.catEls || []).forEach(function (c, i) {
      c.classList.toggle('current', i === self.cat);
      c.classList.toggle('focused', !inOpts && i === self.cat);
    });
    self.saveEl.classList.toggle('focused', !inOpts && self.cat === SAVE);
    (self.rowEls || []).forEach(function (r, i) { r.classList.toggle('focused', inOpts && i === self.focus); });
  };

  SettingsUI.prototype.cycle = function (dir) {
    var f = this._visible()[this.focus];
    if (!f || f.type !== 'choice' || !f.options.length) return;
    var values = f.options.map(function (o) { return o.value; });
    var idx = values.indexOf(this.draft[f.key]);
    idx = (idx + dir + values.length) % values.length;
    this.draft[f.key] = values[idx];
    if (f.key === 'albumId') {
      var album = this.albums.filter(function (a) { return a.id === values[idx]; })[0];
      if (album) {
        this.draft.albumName = album.name;
        this.draft.albumPassphrase = album.passphrase;
      }
    }
    var keepKey = f.key;
    this.render();
    this.setFocus(this._visible().map(function (x) { return x.key; }).indexOf(keepKey));
  };

  SettingsUI.prototype.setStatus = function (text, kind) {
    this.statusEl.textContent = text;
    this.statusEl.className = kind || '';
  };

  SettingsUI.prototype._syncInputs = function () {
    this.rowEls.forEach(function (row) { if (row.sync) row.sync(); });
  };

  SettingsUI.prototype.connect = function () {
    var self = this;
    self._syncInputs();
    var problem = missing(self.draft);
    if (problem) {
      self.setStatus(problem, 'error');
      return Promise.resolve(false);
    }
    self.setStatus('Connecting…', 'busy');
    return self.opts.connect(self.draft).then(function (albums) {
      self.albums = albums;
      if (self.draft.albumId && !albums.some(function (a) { return a.id === self.draft.albumId; })) {
        self.draft.albumId = '';
      }
      if (!self.draft.albumId && albums.length) {
        self.draft.albumId = albums[0].id;
        self.draft.albumName = albums[0].name;
        self.draft.albumPassphrase = albums[0].passphrase;
      }
      self._seedAlbumOption();
      self.setStatus('Connected. Found ' + albums.length + ' album' + (albums.length === 1 ? '' : 's') + '.', 'ok');
      // Next step: choose what to show.
      self.selectCat(1);
      self.enterOpts('source');
      return true;
    }, function (err) {
      self.setStatus(err.message || String(err), 'error');
      return false;
    });
  };

  SettingsUI.prototype.save = function () {
    this._syncInputs();
    var d = this.draft;
    var problem = missing(d);
    if (problem) {
      this.setStatus(problem, 'error');
      this.selectCat(0);
      this.enterOpts(['server', 'account', 'password'].filter(function (k) { return !d[k]; })[0]);
      return;
    }
    if (d.source === 'album' && !d.albumId) {
      this.setStatus('Press "Connect & load albums" (in Account) and pick an album first.', 'error');
      this.selectCat(0);
      this.enterOpts('connect');
      return;
    }
    saveSettings(d);
    this.close();
    this.opts.onSave(Object.assign({}, d));
  };

  // Returns true if the key was used by the settings screen.
  SettingsUI.prototype.handleKey = function (e) {
    var code = e.keyCode;
    var handled = this.zone === 'cats' ? this._catKey(code) : this._optKey(e, code);
    if (handled) e.preventDefault();
    return true;
  };

  SettingsUI.prototype._catKey = function (code) {
    switch (code) {
      case KEY.UP: this.selectCat(this.cat - 1); break;
      case KEY.DOWN: this.selectCat(this.cat + 1); break;
      case KEY.RIGHT: if (this.cat !== SAVE) this.enterOpts(); break;
      case KEY.ENTER:
        if (this.cat === SAVE) this.save();
        else this.enterOpts();
        break;
      case KEY.BACK:
      case KEY.ESC:
        this.opts.onClose();
        break;
      default:
        return false;
    }
    return true;
  };

  SettingsUI.prototype._optKey = function (e, code) {
    var row = this.rowEls[this.focus];
    var field = this._visible()[this.focus];
    var editing = row && row.input && document.activeElement === row.input;

    if (editing) {
      if (code === KEY.ENTER || code === KEY.IME_DONE || code === KEY.IME_CANCEL || code === KEY.BACK || code === KEY.ESC) {
        row.input.blur();
        if (code === KEY.ENTER || code === KEY.IME_DONE) this.setFocus(this.focus + 1);
        return true;
      }
      if (code === KEY.UP || code === KEY.DOWN) {
        row.input.blur();
        this.setFocus(this.focus + (code === KEY.UP ? -1 : 1));
        return true;
      }
      return false; // let the input handle typing and ◀▶
    }

    switch (code) {
      case KEY.UP: this.setFocus(this.focus - 1); break;
      case KEY.DOWN: this.setFocus(this.focus + 1); break;
      case KEY.LEFT:
      case KEY.RIGHT:
        if (field && field.type === 'password') this.togglePassword();
        else if (field && field.type === 'choice') this.cycle(code === KEY.LEFT ? -1 : 1);
        // Text fields and buttons have nothing to change: ◀ goes back to the categories.
        else if (code === KEY.LEFT) this.leaveOpts();
        break;
      case KEY.ENTER:
        if (!field) break;
        if (field.type === 'button') field.action();
        else if (field.type === 'choice') this.cycle(1);
        else row.input.focus();
        break;
      case KEY.BACK:
      case KEY.ESC:
        this.leaveOpts();
        break;
      default:
        return false;
    }
    return true;
  };

  global.SettingsUI = SettingsUI;
})(window);
