"""
Demo library for `mock_server.py --showcase`, used for the README screenshots: made-up
albums with photos from Unsplash (free under the Unsplash License; credited in the
README). The photos aren't in the repo: fetch them with

    python3 dev/showcase.py --fetch

Without them, the albums show generated landscape scenes instead.
"""
import calendar
import os
import random
import subprocess
import sys
import urllib.request

PHOTO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "showcase-photos")

# key: (images.unsplash.com id, photographer, photo page[, crop: Unsplash's crop
# parameters for the 16:9 cut, when the middle isn't the best part])
PHOTOS = {
    "vestrahorn": ("photo-1511300636408-a63a89df3482", "Luca Micheli",
                   "https://unsplash.com/photos/ruWkmt3nU58"),
    "iceland-river": ("photo-1778872782874-22257be2fc9a", "35MM North",
                      "https://unsplash.com/photos/W3_MIcf4nyE"),
    "swiss-pass": ("photo-1785660935138-ef17af9187fb", "Chris Weiher",
                   "https://unsplash.com/photos/tFo8WNjvX9I", "focalpoint&fp-y=0.6"),  # the hotel sits low
    "friends-selfie": ("photo-1758272134088-d3d58d939d12", "Vitaly Gariev",
                       "https://unsplash.com/photos/-WBVWFBfoEc"),
    "kyoto": ("photo-1707474893587-a37a9cf1b555", "Omkar Jori",
              "https://unsplash.com/photos/YbcX7QktfjA"),
    "st-michaels-mount": ("photo-1780406021291-815acc0bcf4e", "BEN ELLIOTT",
                          "https://unsplash.com/photos/-EHDvg8o_zE"),
    "wadi-rum": ("photo-1558985040-ed4d5029dd50", "Rita",
                 "https://unsplash.com/photos/IDYdmpjQXZQ"),
    "aurora": ("photo-1488415032361-b7e238421f1b", "Jonatan Pie",
               "https://unsplash.com/photos/EvKBHBGgaUo"),
    "cabin": ("photo-1695668265347-772eb97ebbbf", "Michael Kahn",
              "https://unsplash.com/photos/B6IIw00D1gA"),
    "tokyo-night": ("photo-1551641506-ee5bf4cb45f1", "Jezael Melgoza",
                    "https://unsplash.com/photos/_noSmX8Kgoo"),
    "hong-kong-rain": ("photo-1502099530544-2b61cbaed85c", "Nic Low",
                       "https://unsplash.com/photos/DdQkVaQbSsg"),
    "espresso": ("photo-1771423424255-bbd49b82dbbe", "Marko Alpner",
                 "https://unsplash.com/photos/pRzbLPQOnwM"),
    "making-coffee": ("photo-1579265898841-79c7890d69cf", "Pete Willis",
                      "https://unsplash.com/photos/QfTpbOey94s"),
    # City people, for the film strip screenshot.
    "city-walkway": ("photo-1454923634634-bd1614719a7b", "Timon Studler",
                     "https://unsplash.com/photos/ABGaVhJxwDQ"),
    "shibuya-crossing": ("photo-1528642474498-1af0c17fd8c3", "Ryoji Iwata",
                         "https://unsplash.com/photos/IBaVuZsJJTo"),
    "pedestrian-lane": ("photo-1517732306149-e8f829eb588a", "Jacek Dylag",
                        "https://unsplash.com/photos/PMxT0XtQ--A"),
    "sunset-street": ("photo-1713217130346-1629ca151547", "Kirill Fokin",
                      "https://unsplash.com/photos/XCy9Ah0mSWA"),
    "busy-street": ("photo-1493794179168-82ca7cb00437", "Jezael Melgoza",
                    "https://unsplash.com/photos/KbR06h9dNQw"),
    "crossing": ("photo-1518890714631-19d0b2fed537", "Jesus Kiteque",
                 "https://unsplash.com/photos/9_C0iq8C0oY"),
}


def photo_file(key, size):
    """The fetched photo for `key` at 'xl' (1920 px) or 'm' (320 px), or None."""
    path = os.path.join(PHOTO_DIR, "%s-%s.jpg" % (key, size))
    return path if os.path.exists(path) else None


def fetch():
    os.makedirs(PHOTO_DIR, exist_ok=True)
    for key, (pid, by, page, *crop) in PHOTOS.items():
        xl = os.path.join(PHOTO_DIR, key + "-xl.jpg")
        if not os.path.exists(xl):
            url = "https://images.unsplash.com/%s?w=1920&h=1080&fit=crop&q=82&fm=jpg" % pid
            if crop:
                url += "&crop=" + crop[0]
            urllib.request.urlretrieve(url, xl)
            # The small preview, like Synology's 'm' thumbnail (macOS sips).
            subprocess.run(["sips", "-Z", "320", xl, "--out", os.path.join(PHOTO_DIR, key + "-m.jpg")],
                           check=True, capture_output=True)
        print("%-18s %s  (photo by %s)" % (key, page, by))

# name, scenes to pick from, year, month, photo count, photos (the first is the cover)
ALBUM_DEFS = [
    ("Iceland Ring Road", ["coast", "aurora", "alpine", "lake"], 2025, 9, 214, ["iceland-river", "vestrahorn"]),
    ("Swiss Alps", ["alpine", "lake", "alpine"], 2025, 7, 96, ["swiss-pass"]),
    ("Lake Como Weekend", ["lake", "lake", "forest"], 2025, 5, 48, ["friends-selfie"]),
    ("Autumn in Kyoto", ["autumn", "autumn", "lake"], 2024, 11, 132, ["kyoto"]),
    ("Cornwall Coast", ["coast", "coast", "forest"], 2024, 8, 67, ["st-michaels-mount"]),
    ("Wadi Rum", ["desert", "desert"], 2024, 3, 54, ["wadi-rum"]),
    ("Lapland Winter", ["aurora", "aurora", "lake"], 2024, 1, 88, ["aurora"]),
    ("Summer at the Cabin", ["forest", "lake", "forest"], 2023, 7, 120, ["cabin"]),
    # Not only landscapes: city nights and coffee at home.
    ("Tokyo After Dark", ["aurora", "lake"], 2025, 11, 163, ["tokyo-night"]),
    ("Espresso", ["forest", "autumn"], 2025, 10, 41, ["espresso"]),
    ("Hong Kong in the Rain", ["aurora", "lake"], 2025, 6, 77, ["hong-kong-rain"]),
    ("Latte Art Practice", ["autumn", "forest"], 2025, 4, 29, ["making-coffee"]),
    # Played in the film strip screenshot. Old, so it sits at the end of the album grid
    # (off the album grid screenshot).
    ("City Streets", ["lake"], 2023, 5, 36,
     ["city-walkway", "shibuya-crossing", "pedestrian-lane", "sunset-street", "busy-street", "crossing"]),
]
FILMSTRIP_ALBUM = "City Streets"

PALETTES = {
    # sky top, sky middle, horizon, sun
    "sunset": ("#1d2b5a", "#b4527a", "#f6a25b", "#ffd88a"),
    "dawn": ("#27365f", "#8d86b8", "#f2c4a0", "#fff1d6"),
    "day": ("#2f6fc0", "#7fb6e8", "#d9eefc", "#fffbe8"),
    "dusk": ("#0e1430", "#3b2f6b", "#c0677c", "#ffc48a"),
    "night": ("#03060f", "#0a1733", "#173057", None),
}
SCENE_SKIES = {
    "coast": ["sunset", "dawn", "day"],
    "alpine": ["dawn", "day", "sunset"],
    "lake": ["dawn", "sunset", "day", "dusk"],
    "autumn": ["day", "dawn", "sunset"],
    "forest": ["dawn", "day", "dusk"],
    "desert": ["sunset", "dusk", "day"],
    "aurora": ["night"],
}


def _hex(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def _mix(a, b, t):
    a, b = _hex(a), _hex(b)
    return "#%02x%02x%02x" % tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _ridge(rnd, w, h, base, amp, n, smooth=False):
    """A filled skyline from the left edge to the right, `base` px from the top."""
    xs = [w * i / n for i in range(n + 1)]
    ys = [base - amp * (0.35 + 0.65 * rnd.random()) for _ in xs]
    if not smooth:
        pts = " ".join("L%.1f %.1f" % (x, y) for x, y in zip(xs, ys))
        return "M0 %d %s L%d %d Z" % (h, pts, w, h)
    d = "M0 %d L0 %.1f" % (h, ys[0])
    for i in range(1, len(xs)):
        mx, my = (xs[i - 1] + xs[i]) / 2, (ys[i - 1] + ys[i]) / 2
        d += " Q%.1f %.1f %.1f %.1f" % (xs[i - 1], ys[i - 1], mx, my)
    return d + " L%d %.1f L%d %d Z" % (w, ys[-1], w, h)


def scene_svg(pid, scene, w, h):
    """scene: a key of SCENE_SKIES, optionally with a sky, e.g. 'coast:sunset'."""
    rnd = random.Random(pid * 7919)
    scene, _, sky = scene.partition(":")
    sky = sky or rnd.choice(SCENE_SKIES[scene])
    top, mid, hor, sun = PALETTES[sky]
    dark = "#10141f" if sky in ("night", "dusk") else "#1b2333"
    horizon = h * rnd.uniform(0.55, 0.66)
    water = scene in ("lake", "coast")
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (w, h, w, h),
           "<defs>",
           '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/>'
           '<stop offset="0.55" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient>' % (top, mid, hor),
           '<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/>'
           '<stop offset="1" stop-color="%s"/></linearGradient>' % (_mix(hor, dark, 0.35), _mix(top, dark, 0.6)),
           '<radialGradient id="glow"><stop offset="0" stop-color="%s" stop-opacity="0.9"/>'
           '<stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>' % (sun or "#ffffff", sun or "#ffffff"),
           '<radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/>'
           '<stop offset="1" stop-color="#000" stop-opacity="0.35"/></radialGradient>',
           '<filter id="soft" x="-20%%" y="-50%%" width="140%%" height="200%%"><feGaussianBlur stdDeviation="%d"/></filter>' % max(4, w // 90),
           "</defs>",
           '<rect width="%d" height="%d" fill="url(#sky)"/>' % (w, h)]

    if sky == "night":
        for _ in range(int(w * h / 9000)):
            out.append('<circle cx="%.0f" cy="%.0f" r="%.1f" fill="#fff" opacity="%.2f"/>' % (
                rnd.uniform(0, w), rnd.uniform(0, horizon * 0.9), rnd.uniform(0.4, 1.4) * w / 1280, rnd.uniform(0.3, 0.9)))
    if scene == "aurora":
        for k in range(3):
            y0 = horizon * rnd.uniform(0.25, 0.55)
            d = "M%.0f %.0f" % (-w * 0.1, y0)
            for i in range(1, 7):
                d += " Q%.0f %.0f %.0f %.0f" % (w * (i - 0.5) / 6, y0 + rnd.uniform(-1, 1) * h * 0.12, w * i / 6, y0 + rnd.uniform(-0.5, 0.5) * h * 0.08)
            color = rnd.choice(["#5df2a6", "#46e0c0", "#9cf27a", "#b07af2"]) if k else "#57f0a0"
            out.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.0f" opacity="%.2f" filter="url(#soft)"/>' % (
                d, color, h * rnd.uniform(0.04, 0.09), rnd.uniform(0.3, 0.6)))
    if sun:
        sx, sy = w * rnd.uniform(0.2, 0.8), horizon - h * rnd.uniform(0.04, 0.22)
        if sky == "day":
            sy = h * rnd.uniform(0.1, 0.25)
        out.append('<circle cx="%.0f" cy="%.0f" r="%.0f" fill="url(#glow)"/>' % (sx, sy, h * 0.45))
        out.append('<circle cx="%.0f" cy="%.0f" r="%.0f" fill="%s" opacity="0.95"/>' % (sx, sy, h * 0.045, sun))
    else:
        sx = w / 2

    # Land: far layers lighter (haze), near layers darker.
    layers = {"alpine": 4, "desert": 3, "coast": 2, "lake": 3}.get(scene, 3)
    for i in range(layers):
        t = (i + 1) / layers
        color = _mix(_mix(hor, mid, 0.3), dark, 0.25 + 0.7 * t)
        if scene == "desert":
            color = _mix(_mix(hor, "#c8743a", 0.6), "#3a1f1a", 0.2 + 0.6 * t)
        if scene == "aurora":
            color = _mix("#5a6e8c", "#0a1222", 0.3 + 0.65 * t)
        base = horizon + (0 if water else h * 0.1 * i)
        if scene == "alpine":
            amp, n, smooth = h * (0.42 - 0.08 * i), rnd.randint(5, 9), False
        elif scene == "desert":
            amp, n, smooth = h * 0.10, rnd.randint(3, 5), True
        elif scene == "coast":
            amp, n, smooth = h * (0.16 - 0.05 * i), rnd.randint(4, 7), i > 0
        else:
            amp, n, smooth = h * (0.22 - 0.05 * i), rnd.randint(4, 8), True
        if water:
            amp *= 0.7
        path = _ridge(rnd, w, h, base, amp, n, smooth)
        if scene == "alpine" and i < 2:
            gid = "snow%d" % i
            out.append('<linearGradient id="%s" gradientUnits="userSpaceOnUse" x1="0" y1="%.0f" x2="0" y2="%.0f">'
                       '<stop offset="0.06" stop-color="#f4f6fb"/><stop offset="0.24" stop-color="%s"/></linearGradient>' % (
                           gid, base - amp, base, color))
            out.append('<path d="%s" fill="url(#%s)"/>' % (path, gid))
        else:
            out.append('<path d="%s" fill="%s"/>' % (path, color))
        if water:
            break

    if water:
        out.append('<rect x="0" y="%.0f" width="%d" height="%.0f" fill="url(#sea)"/>' % (horizon, w, h - horizon))
        if sun:
            for k in range(14):
                y = horizon + (h - horizon) * (k + 0.5) / 14
                out.append('<ellipse cx="%.0f" cy="%.0f" rx="%.0f" ry="%.1f" fill="%s" opacity="%.2f"/>' % (
                    sx + rnd.uniform(-1, 1) * w * 0.01, y, w * (0.02 + 0.006 * k) * rnd.uniform(0.6, 1.4), h * 0.003, sun, 0.55 - k * 0.03))
        if scene == "coast":
            # A headland on one side, sloping down into the sea.
            top = horizon - h * rnd.uniform(0.06, 0.14)
            d = "M0 %d L0 %.0f L%.0f %.0f L%.0f %.0f C%.0f %.0f %.0f %.0f %.0f %d Z" % (
                h, top, w * 0.18, top - h * 0.02, w * 0.3, top + h * 0.03,
                w * 0.42, top + h * 0.12, w * 0.46, h * 0.86, w * 0.62, h)
            flip = ' transform="translate(%d 0) scale(-1 1)"' % w if rnd.random() < 0.5 else ""  # or on the right
            out.append('<path d="%s" fill="%s"%s/>' % (d, _mix(dark, "#000000", 0.2), flip))
    if scene in ("forest", "autumn", "lake"):
        tree_base = h * (0.97 if scene != "lake" else 0.99)
        count = {"forest": 26, "autumn": 18, "lake": 9}[scene]
        for _ in range(count):
            x = rnd.uniform(-0.02, 1.02) * w
            th = h * rnd.uniform(0.18, 0.36) * (0.6 if scene == "lake" else 1)
            y = tree_base - rnd.uniform(0, h * 0.06)
            if scene == "autumn":
                c = rnd.choice(["#c4532f", "#e08a32", "#d9672e", "#a8382a", "#e9b04a"])
                r = th * 0.32
                out.append('<rect x="%.0f" y="%.0f" width="%.0f" height="%.0f" fill="#2a1a16"/>' % (x - r * 0.08, y - th * 0.5, r * 0.16, th * 0.5))
                out.append('<circle cx="%.0f" cy="%.0f" r="%.0f" fill="%s" opacity="0.95"/>' % (x, y - th * 0.62, r, c))
            else:
                c = _mix(dark, "#000000", 0.25)
                out.append('<path d="M%.0f %.0f L%.0f %.0f L%.0f %.0f Z" fill="%s"/>' % (
                    x - th * 0.18, y, x, y - th, x + th * 0.18, y, c))
    out.append('<rect width="%d" height="%d" fill="url(#vig)"/>' % (w, h))
    out.append("</svg>")
    return "\n".join(out).encode()


def build(start_id=20000):
    """Returns (albums, all_photos, scene_of, photo_of) in the mock server's shapes."""
    rnd = random.Random(42)
    albums, everything, scene_of, photo_of = [], [], {}, {}
    pid = start_id
    for n, (name, scenes, year, month, count, photos) in enumerate(ALBUM_DEFS):
        days = calendar.monthrange(year, month)[1]
        end = calendar.timegm((year, month, min(days, 6 + rnd.randint(0, 18)), 18, 30, 0))
        items = []
        for i in range(count):
            # The newest album's first photo is the slideshow screenshot: a wide sunset coast.
            portrait = False if (n == 0 and i == 0) else rnd.random() < 0.25
            w, h = (3024, 4032) if portrait else (4032, 3024)
            if n == 0 and i == 0:
                w, h = 4032, 2268  # 16:9, so it fills the screen
            scene = "coast:sunset" if (n == 0 and i == 0) else rnd.choice(scenes)
            scene_of[pid] = scene
            if n == 0 and i == 0:
                photo_of[pid] = "vestrahorn"  # the slideshow screenshot
            elif n == 0 and i == 1:
                photo_of[pid] = photos[0]  # the album's cover (item 1)
            else:
                # In turn, so neighbours in the film strip differ (item 1 is the cover).
                photo_of[pid] = photos[i % len(photos)]
            if pid in photo_of:
                w, h = 4032, 2268  # the photos are fetched at 16:9
            items.append({
                "id": pid,
                "filename": "IMG_%04d.jpg" % (pid % 10000),
                "time": end - i * 3600 * 5,
                "type": "photo",
                "additional": {
                    "thumbnail": {"cache_key": "%d_%d" % (pid, 1700000000), "unit_id": pid,
                                  "sm": "ready", "m": "ready", "xl": "ready", "preview": "broken"},
                    "resolution": {"width": w, "height": h},
                },
            })
            pid += 1
        albums.append({"id": 21 + n, "name": name, "items": items, "cover_index": 1})
        everything.extend(items)
    everything.sort(key=lambda it: -it["time"])
    return albums, everything, scene_of, photo_of


if __name__ == "__main__" and "--fetch" in sys.argv:
    fetch()
