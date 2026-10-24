#!/usr/bin/env python3
"""
Local stand-in for a Synology DSM running Synology Photos, for trying the app
in a desktop browser. Serves the app at http://localhost:8080/ and fakes the
handful of /webapi/entry.cgi calls the app makes.

Sign in with any username and the password "demo".

    python3 dev/mock_server.py [--port 8080] [--session-seconds 0]

--session-seconds N makes sessions expire after N seconds, to exercise re-login.
--list-delay MS waits that long before answering each page of a photo list (a slow NAS).

--showcase serves a made-up demo library with Unsplash photos (dev/showcase.py --fetch),
signs in by itself, and adds dev/showcase.js, which opens #albums or #settings for
screenshots (see dev/screenshots.sh).

--proxy http://<nas>:5000 forwards /webapi/ to a real DSM instead of faking it.
Browsers block calls from this page to the NAS directly (DSM sends no CORS
headers; the TV doesn't enforce CORS), so this lets you test against real data.
In the app, use http://localhost:<port> as the DSM address.
"""
import argparse
import colorsys
import http.server
import json
import os
import random
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(7)


def make_items(start_id, count, start_time):
    items = []
    for i in range(count):
        pid = start_id + i
        portrait = random.random() < 0.3
        w, h = (3024, 4032) if portrait else (4032, 3024)
        items.append({
            "id": pid,
            "filename": "IMG_%04d.jpg" % pid,
            "time": start_time - i * 86400 * 3,
            "type": "video" if i % 17 == 16 else "photo",
            "additional": {
                "thumbnail": {"cache_key": "%d_%d" % (pid, 1700000000), "unit_id": pid,
                              "sm": "ready", "m": "ready", "xl": "ready", "preview": "broken"},
                "resolution": {"width": w, "height": h},
            },
        })
    return items


PERSONAL = make_items(1000, 1234, 1729000000)
TEAM = make_items(5000, 40, 1700000000)
ALBUMS = [
    {"id": 11, "name": "Summer in Lisbon", "items": PERSONAL[10:40]},
    {"id": 12, "name": "Grandma's 90th", "items": PERSONAL[200:212]},
    {"id": 13, "name": "Shared: Ski trip", "items": PERSONAL[400:420], "passphrase": "abc123"},
]
BY_ID = {it["id"]: it for it in PERSONAL + TEAM}
SCENES = {}  # photo id -> showcase scene, when --showcase is on
PHOTOS = {}  # photo id -> showcase photo (dev/showcase.py), used once fetched


def use_showcase():
    global ALBUMS, PERSONAL, TEAM
    import showcase
    ALBUMS, PERSONAL, scenes, photos = showcase.build()
    TEAM = []
    SCENES.update(scenes)
    PHOTOS.update(photos)
    BY_ID.update({it["id"]: it for it in PERSONAL})
SESSIONS = {}


def svg_for(pid, long_edge):
    it = BY_ID.get(pid)
    w, h = it["additional"]["resolution"]["width"], it["additional"]["resolution"]["height"]
    scale = long_edge / max(w, h)
    w, h = int(w * scale), int(h * scale)
    if pid in SCENES:
        import showcase
        return showcase.scene_svg(pid, SCENES[pid], w, h)
    hue = (pid * 0.137) % 1.0
    c1 = "#%02x%02x%02x" % tuple(int(x * 255) for x in colorsys.hls_to_rgb(hue, 0.55, 0.6))
    c2 = "#%02x%02x%02x" % tuple(int(x * 255) for x in colorsys.hls_to_rgb((hue + 0.15) % 1, 0.25, 0.5))
    day = time.strftime("%d %b %Y", time.gmtime(it["time"]))
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs>
<rect width="{w}" height="{h}" fill="url(#g)"/>
<circle cx="{w*0.72}" cy="{h*0.3}" r="{min(w,h)*0.12}" fill="#fff" opacity="0.5"/>
<path d="M0 {h} L{w*0.3} {h*0.55} L{w*0.5} {h*0.75} L{w*0.75} {h*0.45} L{w} {h*0.8} L{w} {h} Z" fill="#000" opacity="0.25"/>
<text x="{w/2}" y="{h/2}" font-family="Helvetica, Arial" font-size="{min(w,h)/7}" fill="#fff" text-anchor="middle" opacity="0.9">#{pid}</text>
<text x="{w/2}" y="{h/2 + min(w,h)/9}" font-family="Helvetica, Arial" font-size="{min(w,h)/22}" fill="#fff" text-anchor="middle" opacity="0.8">{w}×{h} · {day}</text>
</svg>""".encode()


class Handler(http.server.SimpleHTTPRequestHandler):
    session_seconds = 0
    list_delay = 0
    proxy = None
    showcase = False

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/webapi/" in self.path:
            # Never write passwords or session IDs to the log.
            args = tuple(re.sub(r"(passwd|_sid)=[^&\s]*", r"\1=***", a) if isinstance(a, str) else a for a in args)
            super().log_message(fmt, *args)

    def end_headers(self):
        # Only image responses are cacheable; API JSON (login, lists) must never be.
        cacheable = getattr(self, "_cacheable", False)
        self.send_header("Cache-Control", "max-age=3600" if cacheable else "no-store")
        self._cacheable = False
        super().end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if self.proxy and url.path.startswith("/webapi/"):
            return self.forward()
        if self.showcase and url.path in ("/", "/index.html", "/js/config.js"):
            return self.showcase_page(url.path)
        if url.path != "/webapi/entry.cgi":
            return super().do_GET()
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        api, method = q.get("api"), q.get("method")

        if api == "SYNO.API.Auth":
            if method == "login":
                if q.get("passwd") != "demo":
                    return self.json({"success": False, "error": {"code": 400}})
                if q.get("session") == "SynologyPhotos":
                    # Mirror the real DSM that refuses this session name for a regular user.
                    return self.json({"success": False, "error": {"code": 402}})
                sid = "mocksid-" + secrets.token_hex(8)
                SESSIONS[sid] = time.time()
                data = {"sid": sid}
                if q.get("enable_syno_token") == "yes":
                    data["synotoken"] = "mocktoken"
                return self.json({"success": True, "data": data})
            return self.json({"success": True})

        sid = q.get("_sid")
        created = SESSIONS.get(sid)
        expired = created is None or (self.session_seconds and time.time() - created > self.session_seconds)
        if expired:
            if "Thumbnail" in api or "Download" in api:
                self.send_error(403)
                return
            return self.json({"success": False, "error": {"code": 119}})

        if api == "SYNO.Foto.Browse.Album" and method == "list":
            offset, limit = int(q.get("offset", 0)), int(q.get("limit", 100))
            lst = [{"id": a["id"], "name": a["name"], "item_count": len(a["items"]),
                    "passphrase": a.get("passphrase", ""),
                    "start_time": min(i["time"] for i in a["items"]),
                    "end_time": max(i["time"] for i in a["items"])} for a in ALBUMS]
            if self.showcase:
                for entry, a in zip(lst, ALBUMS):
                    it = a["items"][a["cover_index"]]
                    entry["additional"] = {"thumbnail": it["additional"]["thumbnail"]}
            else:
                # Album 11 reports a cover, album 12 a stale one (exercises the app's fallback).
                for entry, unit in ((lst[0], ALBUMS[0]["items"][0]["id"]), (lst[1], 999999)):
                    entry["additional"] = {"thumbnail": {"unit_id": unit, "cache_key": "%d_1" % unit}}
            return self.json({"success": True, "data": {"list": lst[offset:offset + limit]}})

        if api in ("SYNO.Foto.Browse.Item", "SYNO.FotoTeam.Browse.Item") and method == "list":
            if self.list_delay and int(q.get("limit", 0)) > 1:  # not the 1-item session check
                time.sleep(self.list_delay / 1000)
            offset, limit = int(q.get("offset", 0)), int(q.get("limit", 100))
            if "album_id" in q and q.get("passphrase"):
                # Like the real DSM: album_id together with a passphrase is an invalid request.
                return self.json({"success": False, "error": {"code": 120}})
            if "album_id" in q:
                album = next((a for a in ALBUMS if str(a["id"]) == q["album_id"]), None)
                if album is None:
                    return self.json({"success": False, "error": {"code": 641}})
                if album.get("passphrase"):
                    # Stands in for an album someone else shared with this account.
                    return self.json({"success": False, "error": {"code": 642}})
                src = album["items"]
            elif q.get("passphrase"):
                album = next((a for a in ALBUMS if a.get("passphrase") == q["passphrase"]), None)
                if album is None:
                    return self.json({"success": False, "error": {"code": 642}})
                src = album["items"]
            else:
                if "Team" in api and self.showcase:
                    return self.json({"success": False, "error": {"code": 801}})  # no Shared Space
                src = TEAM if "Team" in api else PERSONAL
            return self.json({"success": True, "data": {"list": src[offset:offset + limit]}})

        if api in ("SYNO.Foto.Thumbnail", "SYNO.FotoTeam.Thumbnail"):
            if int(q.get("id", 0)) not in BY_ID:
                return self.json({"success": False, "error": {"code": 803}})
            size = {"sm": 240, "m": 320, "xl": 1920 if self.showcase else 1280}.get(q.get("size"), 1280)
            pid = int(q.get("id", 0))
            if pid in PHOTOS:
                import showcase
                # Full size for the small preview too, so a screenshot taken mid-launch
                # (before the app sharpens to the full photo) is still sharp.
                path = showcase.photo_file(PHOTOS[pid], "xl")
                if path:
                    with open(path, "rb") as f:
                        return self.image(f.read(), "image/jpeg")
            return self.image(svg_for(pid, size))

        if api in ("SYNO.Foto.Download", "SYNO.FotoTeam.Download"):
            pid = int(q.get("unit_id", "[0]").strip("[]"))
            return self.image(svg_for(pid, 4032))

        return self.json({"success": False, "error": {"code": 102}})

    def do_POST(self):
        if self.proxy and urllib.parse.urlparse(self.path).path.startswith("/webapi/"):
            return self.forward()
        # The fake API treats a form POST like a GET with the same parameters.
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        self.path = urllib.parse.urlparse(self.path).path + "?" + body
        return self.do_GET()

    def forward(self):
        data, headers = None, {}
        if self.command == "POST":
            data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            headers["Content-Type"] = self.headers.get("Content-Type", "application/x-www-form-urlencoded")
        try:
            req = urllib.request.Request(self.proxy + self.path, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                status, ctype, body = r.status, r.headers.get("Content-Type", ""), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, body = e.code, e.headers.get("Content-Type", ""), e.read()
        except OSError as e:
            self.send_error(502, str(e))
            return
        self._cacheable = ctype.startswith("image/")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def showcase_page(self, path):
        if path == "/js/config.js":
            with open(os.path.join(ROOT, "js", "config.js")) as f:
                body = f.read() + """
// --showcase: sign in to this mock and play the newest demo album.
Object.assign(window.SYNFRAME_DEFAULTS, {
  server: location.origin, account: 'demo', password: 'demo',
  source: 'album', albumId: '21', albumName: 'Iceland Ring Road',
  order: 'newest', interval: 30, motion: false
});
"""
            ctype = "application/javascript"
        else:
            with open(os.path.join(ROOT, "index.html")) as f:
                body = f.read().replace("</body>", '  <script src="dev/showcase.js"></script>\n</body>')
            ctype = "text/html"
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def image(self, body, ctype="image/svg+xml"):
        self._cacheable = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--session-seconds", type=int, default=0)
    p.add_argument("--list-delay", type=int, default=0)
    p.add_argument("--showcase", action="store_true", help="demo library for screenshots")
    p.add_argument("--proxy", help="forward /webapi/ to this DSM, e.g. http://192.168.1.20:5000")
    args = p.parse_args()
    Handler.session_seconds = args.session_seconds
    Handler.list_delay = args.list_delay
    Handler.proxy = args.proxy.rstrip("/") if args.proxy else None
    if args.showcase:
        Handler.showcase = True
        use_showcase()
    if Handler.proxy:
        print("App at http://localhost:%d/, proxying /webapi/ to %s" % (args.port, Handler.proxy))
    else:
        print("Mock Synology at http://localhost:%d/  (any username, password: demo)" % args.port)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
