"""画面用のデータ（docs/data/*.json）を書き出す。座標は小数5桁（約1m）に丸め、形を簡略化して軽くする。"""
import gzip
import hashlib
import json
import math
from datetime import datetime, timezone

import geopandas as gpd
import pandas as pd
from shapely.geometry import mapping

from common import CONFIG, CRS_LL, CRS_M, DOCS_DATA, P, RAW, WORK, studio_point, write_json


def rnd(obj, nd=5):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, (list, tuple)):
        return [rnd(x, nd) for x in obj]
    if isinstance(obj, dict):
        return {k: rnd(v, nd) for k, v in obj.items()}
    return obj


def feature(geom, props):
    return {"type": "Feature", "geometry": rnd(mapping(geom)), "properties": props}


def main():
    zones = gpd.read_file(WORK / "zones_routed.gpkg")
    blocks = gpd.read_file(WORK / "blocks_zoned.gpkg")
    zadj = pd.read_csv(WORK / "zone_adj.csv")
    areas = json.loads((CONFIG / "target_areas.json").read_text(encoding="utf-8"))["areas"]
    sp = gpd.GeoSeries([studio_point()], crs=CRS_LL).to_crs(CRS_M).iloc[0]

    nb = {}
    for a, b, s, br in zadj.itertuples(index=False):
        nb.setdefault(a, []).append([b, round(s), int(br)])
        nb.setdefault(b, []).append([a, round(s), int(br)])

    lp_m = zones.geometry.representative_point()
    lp_ll = gpd.GeoSeries(lp_m, crs=CRS_M).to_crs(CRS_LL)
    zgeom = zones.geometry.simplify(2.0, preserve_topology=True).to_crs(CRS_LL)
    zfeats = []
    for i, z in zones.iterrows():
        dx, dy = lp_m.iat[i].x - sp.x, lp_m.iat[i].y - sp.y
        em = z.route_m / P["walk_m_per_min"] + z.h * P["rate_default"] * P["sec_per_flyer"] / 60
        zfeats.append(feature(zgeom.iat[i], {
            "id": z.id, "l": z.label, "h": int(z.h), "a": int(z.tarea), "d": int(z.start_dist_m),
            "b": round((math.degrees(math.atan2(dx, dy)) + 360) % 360, 1), "nb": nb.get(z.id, []),
            "f": z["flags"] or "", "apt": int(z.apt), "rm": int(z.route_m), "pm": int(z.post_m), "mm": int(z.move_m),
            "em": round(em), "ok": int(z.has_route), "t": z.towns.split(","),
            "lp": [round(lp_ll.iat[i].y, 5), round(lp_ll.iat[i].x, 5)]}))

    bgeom = blocks.geometry.simplify(1.5, preserve_topology=True).to_crs(CRS_LL)
    bfeats = [feature(bgeom.iat[i], {"id": b.id, "z": b.zone, "h": int(b.SETAI), "apt": int(b.apt)})
              for i, b in blocks.iterrows()]

    # 町（学区は同じ町名が他の学区にもある場合だけ付ける）
    blocks["wd"] = blocks.dist_m * blocks.SETAI
    t = blocks.groupby("cho").agg(n=("name", "first"), g=("gakku", "first"), a=("tarea", "first"),
                                  h=("SETAI", "sum"), wd=("wd", "sum"))
    dup = t.groupby("n").size()
    zt = blocks.groupby("cho")["zone"].apply(lambda s: sorted(set(s)))
    towns = {cho: {"n": r.n, "g": r.g if dup[r.n] > 1 else "", "a": int(r.a), "h": int(r.h),
                   "d": int(r.wd / r.h) if r.h else 0, "z": zt[cho]} for cho, r in t.iterrows()}

    routes = json.loads((WORK / "routes.json").read_text(encoding="utf-8"))
    manifest = json.loads((RAW / "estat" / "manifest.json").read_text(encoding="utf-8"))
    files = {
        "zones.json": {"type": "FeatureCollection", "features": zfeats},
        "blocks.json": {"type": "FeatureCollection", "features": bfeats},
        "towns.json": towns,
        "routes.json": routes,
    }
    ver = hashlib.sha256(json.dumps([files["zones.json"], files["blocks.json"]], ensure_ascii=False).encode()).hexdigest()[:8]
    files["plan.json"] = {
        "target_flyers": P["target_flyers"], "flyers_per_outing": P["flyers_per_outing"],
        "rate_default": P["rate_default"], "walk_m_per_min": P["walk_m_per_min"], "sec_per_flyer": P["sec_per_flyer"],
        "studio": P["studio"], "areas": {**areas, "0": "その他"},
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "data_version": ver,
        "totals": {"zones": len(zones), "households": int(zones.h.sum()), "blocks": len(blocks)},
        "sources": [
            {"name": "令和2年国勢調査 小地域（基本単位区・町丁字等）境界データ", "by": "政府統計の総合窓口(e-Stat)",
             "retrieved": next(iter(manifest.values()))["retrieved"],
             "urls": sorted({v["url"] for v in manifest.values()})},
            {"name": "道路・建物", "by": "© OpenStreetMap contributors（ODbL）"},
            {"name": "背景地図", "by": "国土地理院 地理院タイル（淡色地図）"},
        ],
    }
    for name, obj in files.items():
        write_json(DOCS_DATA / name, obj)
        raw = (DOCS_DATA / name).read_bytes()
        print(f"{name:12s} {len(raw) / 1024:7.0f} KB  gzip {len(gzip.compress(raw)) / 1024:6.0f} KB")


if __name__ == "__main__":
    main()
