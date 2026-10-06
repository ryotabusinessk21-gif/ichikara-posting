"""ルートを地理院タイルに重ねた確認用の画像を作る（out/preview_*.png）。

使い方: python p8_preview.py [区画ID ...]   （省略時は碁盤の目・山沿い・入り組んだ所から自動で3つ）
"""
import io
import json
import math
import sys
import time

import geopandas as gpd
import requests
from PIL import Image, ImageDraw, ImageFont

from common import CRS_LL, OUT, RAW, WORK

Z = 17
TILE = 256
CACHE = RAW / "tiles"


def lonlat_to_px(lon, lat, z=Z):
    n = TILE * 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile(x, y, z=Z):
    p = CACHE / f"{z}_{x}_{y}.png"
    if not p.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        r = requests.get(f"https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
                         headers={"User-Agent": "ichikara-posting-preview/1.0"}, timeout=20)
        p.write_bytes(r.content if r.ok else b"")
        time.sleep(0.05)
    try:
        return Image.open(io.BytesIO(p.read_bytes())).convert("RGB")
    except Exception:
        return Image.new("RGB", (TILE, TILE), "white")


def decode(s):
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append((lat / 1e5, lon / 1e5))
    return out


def render(zid, zones, blocks, routes, font):
    z = zones[zones.id == zid].iloc[0]
    minx, miny, maxx, maxy = z.geometry.bounds
    x0, y1 = lonlat_to_px(minx, miny)
    x1, y0 = lonlat_to_px(maxx, maxy)
    pad = 60
    x0, y0, x1, y1 = int(x0 - pad), int(y0 - pad), int(x1 + pad), int(y1 + pad)
    img = Image.new("RGB", (x1 - x0, y1 - y0), "white")
    for tx in range(x0 // TILE, x1 // TILE + 1):
        for ty in range(y0 // TILE, y1 // TILE + 1):
            img.paste(tile(tx, ty), (tx * TILE - x0, ty * TILE - y0))
    d = ImageDraw.Draw(img, "RGBA")
    P = lambda lon, lat: (lambda p: (p[0] - x0, p[1] - y0))(lonlat_to_px(lon, lat))
    for _, b in blocks[blocks.zone == zid].iterrows():
        for poly in getattr(b.geometry, "geoms", [b.geometry]):
            d.polygon([P(*c) for c in poly.exterior.coords], fill=(46, 157, 91, 40), outline=(46, 157, 91, 160))
    for poly in getattr(z.geometry, "geoms", [z.geometry]):
        d.line([P(*c) for c in poly.exterior.coords], fill=(224, 17, 95, 255), width=3)
    r = routes.get(zid)
    if r:
        for run in r["runs"]:
            pts = [P(lon, lat) for lat, lon in decode(run["enc"])]
            if run["k"] == "p":
                d.line(pts, fill=(224, 17, 95, 200), width=5)
            else:
                for a, b2 in zip(pts[:-1], pts[1:]):
                    d.line([a, b2], fill=(60, 60, 60, 200), width=3)
        sx, sy = P(r["s"][1], r["s"][0])
        d.ellipse([sx - 9, sy - 9, sx + 9, sy + 9], fill=(224, 17, 95, 255), outline="white", width=3)
        d.text((sx + 12, sy - 10), "START", fill="black", font=font)
    d.rectangle([0, 0, img.width, 34], fill=(255, 255, 255, 220))
    d.text((8, 6), f"{zid} {z.label}  {int(z.h)}世帯  ルート{z.route_m / 1000:.1f}km（移動{z.move_m / max(z.route_m, 1):.0%}）",
           fill="black", font=font)
    path = OUT / f"preview_{zid}.png"
    img.save(path)
    return path


def main():
    zones = gpd.read_file(WORK / "zones_routed.gpkg").to_crs(CRS_LL)
    blocks = gpd.read_file(WORK / "blocks_zoned.gpkg").to_crs(CRS_LL)
    routes = json.loads((WORK / "routes.json").read_text(encoding="utf-8"))
    font = ImageFont.truetype("C:/Windows/Fonts/meiryo.ttc", 18)
    ids = sys.argv[1:]
    if not ids:
        pick = lambda prefix: zones[zones.label.str.contains(prefix) & (zones.h > 150)].sort_values("start_dist_m").iloc[0].id
        ids = [pick("松ケ崎"), pick("岩倉長谷町|上高野"), pick("修学院")]
    for i in ids:
        print(render(i, zones, blocks, routes, font))


if __name__ == "__main__":
    main()
