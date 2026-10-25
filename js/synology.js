/*
 * Minimal client for the Synology Photos web API (DSM 7).
 *
 * Written for the browser engine on 2017+ Samsung TVs (Chromium 47+), so it
 * sticks to Promises and XHR: no classes, async/await or fetch.
 */
(function (global) {
  'use strict';

  var PAGE_SIZE = 500;
  var MAX_ITEMS = 50000;
  var SESSION_ERRORS = [106, 107, 119];

  var AUTH_ERRORS = {
    400: 'Wrong username or password.',
    401: 'This DSM account is disabled.',
    402: 'This account is not allowed to sign in to DSM. Check its Application Privileges in DSM',
    403: 'This account uses 2-factor sign-in. Use an account without it.',
    404: 'The 2-factor code was rejected.',
    406: 'This account has to set up 2-factor sign-in first.',
    407: 'The DSM blocked this TV after too many failed sign-ins. Unblock its IP in DSM (Security > Protection).',
    408: 'The password has expired. Change it in DSM.',
    410: 'The password must be changed in DSM before signing in.'
  };

  function SynoError(message, code) {
    this.name = 'SynoError';
    this.message = message;
    this.code = code;
  }
  SynoError.prototype = Object.create(Error.prototype);

  function normalizeServer(server) {
    var s = (server || '').trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  }

  // Safe-to-show facts about a password, to spot TV keyboard surprises without revealing it.
  function describePassword(pw) {
    var notes = [pw.length + ' character' + (pw.length === 1 ? '' : 's') + ' sent'];
    if (/\s/.test(pw)) notes.push('contains a space');
    if (/[^\x20-\x7e]/.test(pw)) notes.push('contains non-standard characters');
    return notes.join(', ');
  }

  function query(params) {
    return Object.keys(params).filter(function (k) {
      return params[k] !== undefined && params[k] !== null && params[k] !== '';
    }).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  /*
   * Signs in with a DSM account. The session goes in the URL (_sid, plus the
   * SynoToken DSM hands out) rather than a cookie, so plain <img> tags can load photos.
   */
  // opts.session: a { sid, token } from an earlier run, to skip signing in. If DSM has
  // expired it, the first request gets a session error and signs in again (request()).
  function SynologyClient(opts) {
    this.server = normalizeServer(opts.server);
    this.account = opts.account;
    this.password = opts.password;
    this.sid = opts.session && opts.session.sid || null;
    this.token = opts.session && opts.session.token || null;
    this._login = null;
  }

  // The current session, to reuse next time (null if not signed in).
  SynologyClient.prototype.session = function () {
    return this.sid ? { sid: this.sid, token: this.token } : null;
  };

  SynologyClient.prototype.url = function (params) {
    return this.server + '/webapi/entry.cgi?' + query(params);
  };

  SynologyClient.prototype._auth = function () {
    return { _sid: this.sid, SynoToken: this.token };
  };

  SynologyClient.prototype._get = function (params) {
    return this._send('GET', params);
  };

  // POST keeps the password out of the URL (and out of server access logs).
  SynologyClient.prototype._post = function (params) {
    return this._send('POST', params);
  };

  SynologyClient.prototype._send = function (method, params) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      if (method === 'POST') {
        xhr.open('POST', self.server + '/webapi/entry.cgi', true);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      } else {
        xhr.open('GET', self.url(params), true);
      }
      xhr.timeout = 30000;
      // The NAS is there but overloaded (indexing, updating, a backup…): its web server
      // gives up (499, 5xx, 408) or doesn't answer in time. Not an address problem.
      var busy = function () {
        reject(new SynoError('Your Synology is busy and isn\'t answering right now. Shutter will keep trying.', 'busy'));
      };
      xhr.onload = function () {
        if (xhr.status === 499 || xhr.status === 408 || xhr.status >= 500) return busy();
        if (xhr.status !== 200) {
          reject(new SynoError('The DSM answered with HTTP ' + xhr.status + '. Check the address and port.', 'http'));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new SynoError('That address answered, but it does not look like a Synology DSM.', 'parse'));
        }
      };
      xhr.ontimeout = busy;
      xhr.onerror = function () {
        reject(new SynoError('Cannot reach ' + self.server + '. Check the address, and that the TV is on the same network.', 'network'));
      };
      xhr.send(method === 'POST' ? query(params) : null);
    });
  };

  SynologyClient.prototype.login = function () {
    var self = this;
    if (!self._login) {
      // Sign in the way DSM's own web page does. Some DSMs refuse the
      // "SynologyPhotos" session name with error 402 (seen on DSM 7 with a regular user).
      self._login = self._post({
        api: 'SYNO.API.Auth', version: 7, method: 'login',
        account: self.account, passwd: self.password,
        session: 'webui', format: 'sid', enable_syno_token: 'yes'
      }).then(function (res) {
        if (!res.success) {
          var code = res.error && res.error.code;
          var why = AUTH_ERRORS[code] ? AUTH_ERRORS[code].replace(/\.$/, '') : 'Sign-in failed';
          var detail = 'DSM error ' + code + ', user "' + self.account + '"';
          if (code === 400) detail += ', ' + describePassword(self.password || '');
          throw new SynoError(why + ' (' + detail + ').', code);
        }
        self.sid = res.data.sid;
        self.token = res.data.synotoken || null;
        return self.sid;
      });
      // Forget the in-flight promise once it settles so a later call can retry.
      self._login.then(clear, clear);
    }
    return self._login;
    function clear() { self._login = null; }
  };

  // Authenticated API call. Signs in again once if the session has expired.
  SynologyClient.prototype.request = function (params, retried) {
    var self = this;
    var ready = self.sid ? Promise.resolve(self.sid) : self.login();
    return ready.then(function () {
      return self._get(Object.assign({}, params, self._auth()));
    }).then(function (res) {
      if (res.success) return res.data;
      var code = res.error && res.error.code;
      if (!retried && SESSION_ERRORS.indexOf(code) !== -1) {
        self.sid = null;
        self.token = null;
        return self.request(params, true);
      }
      if (code === 801 && /FotoTeam/.test(params.api)) {
        throw new SynoError('Shared Space is turned off in Synology Photos, or this account has no access to it.', code);
      }
      if (code === 102 || code === 103) {
        throw new SynoError('Synology Photos is not available on this DSM (' + params.api + ').', code);
      }
      if (code === 105) {
        throw new SynoError('This account has no permission to use Synology Photos.', code);
      }
      throw new SynoError('Synology Photos error ' + code + ' (' + params.api + ').', code);
    });
  };

  // Cheap call used to check (and refresh) the session after an image fails.
  SynologyClient.prototype.ping = function () {
    return this.request({ api: 'SYNO.Foto.Browse.Item', version: 1, method: 'list', offset: 0, limit: 1 });
  };

  SynologyClient.prototype.listAlbums = function () {
    var self = this;
    var albums = [];
    // v2 with this category also returns albums shared with the account;
    // older Synology Photos builds only accept the plain v1 call.
    var base = { api: 'SYNO.Foto.Browse.Album', version: 2, method: 'list', category: 'normal_share_with_me', additional: '["thumbnail"]' };

    function page(offset) {
      return self.request(Object.assign({}, base, { offset: offset, limit: 100 })).then(function (data) {
        var list = data.list || [];
        albums = albums.concat(list);
        return list.length === 100 ? page(offset + 100) : albums;
      });
    }

    return page(0).catch(function (err) {
      // Only an API refusal is worth the older version; a slow or unreachable NAS isn't.
      if (base.version === 1 || err.code === 'network' || err.code === 'busy') throw err;
      albums = [];
      base = { api: 'SYNO.Foto.Browse.Album', version: 1, method: 'list', additional: '["thumbnail"]' };
      return page(0);
    }).then(function (list) {
      return list.map(function (a) {
        var thumb = a.additional && a.additional.thumbnail;
        return {
          id: String(a.id), name: a.name || ('Album ' + a.id), count: a.item_count, passphrase: a.passphrase || '',
          // When the album's photos were taken (seconds, wall-clock time like an item's "time").
          startTime: a.start_time || 0, endTime: a.end_time || 0, createTime: a.create_time || 0,
          // Cover as DSM reports it, if it does; otherwise the browser asks for the album's first photo.
          // (Asked for without the passphrase, like the photos; if that fails the browser falls back to coverPhoto.)
          cover: thumb && thumb.unit_id ? { id: thumb.unit_id, cacheKey: thumb.cache_key || '', xlReady: true, team: false, passphrase: '' } : null
        };
      // Newest first: by when the album's latest photo was taken (what its year shows),
      // then when the album was created, then by name.
      }).sort(function (a, b) {
        return (b.endTime || b.startTime) - (a.endTime || a.startTime) ||
          b.createTime - a.createTime || a.name.localeCompare(b.name);
      });
    });
  };

  /*
   * source: { type: 'personal' | 'album' | 'shared', albumId, passphrase }
   * Returns a flat list of photos (videos are skipped).
   */
  /*
   * The ways to ask for a source's photos, in order of preference. An album is asked
   * for by its id (works for the owner) and, if that's refused, by its passphrase
   * (works for albums shared with the account). Never both at once: DSM answers
   * error 120 to album_id + passphrase for an owner's shared album.
   */
  function sourceParams(source) {
    var base = {
      api: source.type === 'shared' ? 'SYNO.FotoTeam.Browse.Item' : 'SYNO.Foto.Browse.Item',
      version: 1, method: 'list',
      additional: '["thumbnail","resolution"]'
    };
    if (source.type !== 'album') return [base];
    var ways = [Object.assign({ album_id: source.albumId }, base)];
    if (source.passphrase) ways.push(Object.assign({ passphrase: source.passphrase }, base));
    return ways;
  }

  // A list entry as a photo, or null for videos.
  function toPhoto(it, team, passphrase) {
    if (it.type && it.type !== 'photo' && it.type !== 'live') return null;
    var thumb = (it.additional && it.additional.thumbnail) || {};
    var res = (it.additional && it.additional.resolution) || {};
    return {
      id: thumb.unit_id || it.id,
      name: it.filename || '',
      cacheKey: thumb.cache_key || '',
      xlReady: thumb.xl !== 'broken',
      time: it.time || 0,
      width: res.width || 0,
      height: res.height || 0,
      team: team,
      passphrase: passphrase || ''
    };
  }

  // Calls the first way DSM accepts; resolves to { params, data }.
  SynologyClient.prototype._firstAccepted = function (ways, extra) {
    var self = this;
    var i = 0;
    function attempt() {
      var params = ways[i++];
      return self.request(Object.assign({}, params, extra)).then(function (data) {
        return { params: params, data: data };
      }, function (err) {
        // Only a refusal from DSM is worth another way; network trouble isn't.
        if (i < ways.length && typeof err.code === 'number') return attempt();
        throw err;
      });
    }
    return attempt();
  };

  SynologyClient.prototype.listPhotos = function (source, onProgress) {
    var self = this;
    var team = source.type === 'shared';
    var params = null;

    var photos = [];
    function page(offset) {
      var paging = { offset: offset, limit: PAGE_SIZE };
      // The first page settles which way of asking works; later pages reuse it.
      var got = params
        ? self.request(Object.assign({}, params, paging)).then(function (data) { return { params: params, data: data }; })
        : self._firstAccepted(sourceParams(source), paging);
      return got.then(function (res) {
        params = res.params;
        var list = res.data.list || [];
        list.forEach(function (it) {
          var photo = toPhoto(it, team, params.passphrase);
          if (photo) photos.push(photo);
        });
        if (onProgress) onProgress(photos.length, photos); // lets the caller start early
        if (list.length === PAGE_SIZE && offset + PAGE_SIZE < MAX_ITEMS) return page(offset + PAGE_SIZE);
        return photos;
      });
    }
    return page(0);
  };

  // The newest photo of a source, for a cover image; null if it has none.
  SynologyClient.prototype.coverPhoto = function (source) {
    return this._firstAccepted(sourceParams(source), { offset: 0, limit: 10 }).then(function (res) {
      var list = res.data.list || [];
      for (var i = 0; i < list.length; i++) {
        var photo = toPhoto(list[i], source.type === 'shared', res.params.passphrase);
        if (photo) return photo;
      }
      return null;
    });
  };

  /*
   * Camera and place of one photo, for the details panel: { camera, lens, exposure, place }
   * (any may be ''). Not part of the photo list, which stays small; asked for on demand.
   */
  SynologyClient.prototype.photoDetails = function (photo) {
    return this.request({
      api: photo.team ? 'SYNO.FotoTeam.Browse.Item' : 'SYNO.Foto.Browse.Item',
      version: 1, method: 'get', id: '[' + photo.id + ']',
      additional: '["exif","address"]', passphrase: photo.passphrase
    }).then(function (data) {
      var it = (data.list || [])[0] || {};
      var exif = (it.additional && it.additional.exif) || {};
      var addr = (it.additional && it.additional.address) || {};
      var aperture = String(exif.aperture || '');
      if (/^[\d.]+$/.test(aperture)) aperture = 'ƒ/' + aperture;
      var focal = String(exif.focal_length || '');
      if (/^[\d.]+$/.test(focal)) focal += ' mm';
      var shutter = String(exif.exposure_time || '');
      if (/^[\d./]+$/.test(shutter)) shutter += ' s';
      var iso = exif.iso ? 'ISO ' + String(exif.iso).replace(/^ISO\s*/i, '') : '';
      var town = addr.city || addr.town || addr.village || addr.county || addr.state || '';
      return {
        camera: exif.camera || '',
        lens: exif.lens || '',
        exposure: [aperture, shutter, focal, iso].filter(Boolean).join(' · '),
        place: [addr.landmark, town, addr.country].filter(Boolean).join(', ')
      };
    });
  };

  // Whether this account can use Shared Space (it may be turned off, or not shared with the account).
  SynologyClient.prototype.hasSharedSpace = function () {
    return this.request({ api: 'SYNO.FotoTeam.Browse.Item', version: 1, method: 'list', offset: 0, limit: 1 })
      .then(function () { return true; }, function () { return false; });
  };


  // URL of the large (1280–1920px, depending on DSM) thumbnail Synology Photos already generated.
  SynologyClient.prototype.thumbnailUrl = function (photo, size) {
    return this.url({
      api: photo.team ? 'SYNO.FotoTeam.Thumbnail' : 'SYNO.Foto.Thumbnail',
      version: 2, method: 'get', mode: 'download', type: 'unit',
      id: photo.id, size: size || 'xl', cache_key: photo.cacheKey,
      passphrase: photo.passphrase, _sid: this.sid, SynoToken: this.token
    });
  };

  // URL of the original file. Larger and slower; HEIC originals may not decode on the TV.
  SynologyClient.prototype.originalUrl = function (photo) {
    return this.url({
      api: photo.team ? 'SYNO.FotoTeam.Download' : 'SYNO.Foto.Download',
      version: 1, method: 'download', unit_id: '[' + photo.id + ']',
      passphrase: photo.passphrase, _sid: this.sid, SynoToken: this.token
    });
  };

  SynologyClient.prototype.logout = function () {
    if (!this.sid) return Promise.resolve();
    var auth = this._auth();
    this.sid = this.token = null;
    return this._get(Object.assign({ api: 'SYNO.API.Auth', version: 7, method: 'logout', session: 'webui' }, auth))
      .catch(function () {});
  };

  global.SynologyClient = SynologyClient;
  global.SynoError = SynoError;
})(window);
