"""国勢調査の基本単位区（ブロック）と町丁を整える。

出力
- work/blocks.gpkg  : 候補範囲内のブロック（世帯数 > 0 のものが計画対象）
- work/towns.gpkg   : 町丁（学区・町名・世帯数・ブロック数）
- work/adj.csv      : 計画対象ブロックの隣接関係（共有境界の長さ）
- out/p2_check.txt  : 町丁ごとの世帯数がブロック合計と一致するかの検査
"""
import glob
import json

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from common import CONFIG, CRS_M, OUT, P, RAW, WORK, bbox_polygon

WARDS = ["26101", "26103"]  # 上京区（26102）は狙いエリアから遠いので候補から外す
GAKKU = json.loads((CONFIG / "gakku.json").read_text(encoding="utf-8"))


def split_name(city, s_name):
    """S_NAME（学区＋町名）を (学区, 町名) に分ける。"""
    s_name = s_name or ""
    for g in sorted(set(GAKKU.get(city[-5:], [])), key=len, reverse=True):
        if s_name.startswith(g) and len(s_name) > len(g):
            return g, s_name[len(g):]
    return "", s_name


def read(sid):
    frames = [gpd.read_file(f, encoding="cp932") for w in WARDS
              for f in glob.glob(str(RAW / "estat" / f"{sid}_{w}" / "*.shp"))]
    g = pd.concat(frames, ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs=frames[0].crs)
    g = g[g["HCODE"] == 8101].copy()  # 水面調査区（8154）を除く
    g["CITY5"] = g["PREF"].astype(str).str.zfill(2) + g["CITY"].astype(str).str.zfill(3)
    return g


def build_towns():
    a = read("A002005212020")
    a["cho"] = a["CITY5"] + a["S_AREA"].astype(str)
    # 同じ町丁が複数の図形（En）に分かれている場合は一つにまとめる（En≥2 の SETAI は 0）
    t = a.dissolve(by="cho", aggfunc={"S_NAME": "first", "SETAI": "sum", "JINKO": "sum", "KBSUM": "max",
                                      "CITY5": "first"}).reset_index()
    t[["gakku", "name"]] = [split_name(c, s) for c, s in zip(t["CITY5"], t["S_NAME"])]
    return t


def build_blocks():
    b = read("B002005212020")
    b["cho"] = b["CITY5"] + b["KIHON1"].astype(str) + b["KIHON2"].astype(str)
    b["apt"] = b["KIGO_A"].notna().astype(int)
    # 階で分割された集合住宅など、図形が完全に同じものは一つのブロックにまとめる
    b["gkey"] = [shapely.normalize(g).wkb for g in b.geometry]
    agg = b.groupby("gkey").agg(id=("KEY_CODE", "min"), SETAI=("SETAI", "sum"), JINKO=("JINKO", "sum"),
                                apt=("apt", "max"), cho=("cho", "first"), CITY5=("CITY5", "first"),
                                S_NAME=("S_NAME", "first"), n_rows=("KEY_CODE", "size")).reset_index()
    geom = b.drop_duplicates("gkey").set_index("gkey").geometry
    agg = gpd.GeoDataFrame(agg.drop(columns="gkey"), geometry=geom.loc[agg["gkey"]].values, crs=b.crs)
    agg["id"] = agg["id"].astype(str)
    return agg, b


def main():
    towns = build_towns()
    blocks, raw = build_blocks()

    # 検査: 町丁ごとに ブロック合計＝町丁の世帯数、ブロック数＝KBSUM
    bs = raw.groupby("cho").agg(setai=("SETAI", "sum"), n=("KEY_CODE", "size"))
    chk = towns.set_index("cho")[["S_NAME", "SETAI", "KBSUM"]].join(bs, how="outer")
    bad = chk[(chk["SETAI"].fillna(-1) != chk["setai"].fillna(-1))]
    lines = [f"町丁 {len(towns)}、ブロック（行）{len(raw)}、まとめた後 {len(blocks)}",
             f"世帯数 合計: 町丁 {int(towns.SETAI.sum())} / ブロック {int(raw.SETAI.sum())}",
             f"世帯数が一致しない町丁: {len(bad)}"]
    lines += [f"  {i} {r.S_NAME} 町丁={r.SETAI} ブロック計={r.setai}" for i, r in bad.head(30).iterrows()]
    nb = chk[(chk["KBSUM"].fillna(-1) != chk["n"].fillna(-1))]
    lines.append(f"ブロック数が KBSUM と一致しない町丁: {len(nb)}（参考。分割された単位区で差が出る）")

    # 候補範囲で切る（代表点が範囲内のもの）
    bb = bbox_polygon()
    blocks = blocks[blocks.representative_point().within(bb)].copy()
    towns = towns[towns.cho.isin(blocks.cho)].copy()

    blocks = blocks.to_crs(CRS_M)
    towns = towns.to_crs(CRS_M)
    blocks["area_m2"] = blocks.area.round(0)
    blocks["apt"] = np.where((blocks["apt"] == 1) | ((blocks["SETAI"] >= 80) & (blocks["area_m2"] < 3000)), 1, 0)
    blocks = blocks.merge(towns[["cho", "gakku", "name"]], on="cho", how="left")
    blocks["big"] = (blocks["SETAI"] > P["zone_hi"]).astype(int)
    lines.append(f"候補範囲内: 町丁 {len(towns)}、ブロック {len(blocks)}（世帯あり {int((blocks.SETAI > 0).sum())}）、"
                 f"世帯 {int(blocks.SETAI.sum())}")
    lines.append(f"集合住宅の印: {int(blocks.apt.sum())}、1ブロックで {P['zone_hi']} 世帯超: {int(blocks.big.sum())}")

    # 隣接（計画対象＝世帯ありのブロック同士）。境界が 8m 以上接するか、25m 以内なら隣とみなす
    pb = blocks[blocks.SETAI > 0].reset_index(drop=True)
    tree = shapely.STRtree(pb.geometry.values)
    left, right = tree.query(pb.geometry.values, predicate="dwithin", distance=25)
    pairs = [(i, j) for i, j in zip(left, right) if i < j]
    rows = []
    for i, j in pairs:
        gi, gj = pb.geometry.iat[i], pb.geometry.iat[j]
        shared = gi.boundary.intersection(gj.buffer(1.5)).length
        rows.append((pb.id.iat[i], pb.id.iat[j], round(shared, 1), round(gi.distance(gj), 1)))
    adj = pd.DataFrame(rows, columns=["a", "b", "shared_m", "gap_m"])
    adj = adj[(adj.shared_m >= 8) | (adj.gap_m <= 25)]
    lines.append(f"隣接ペア: {len(adj)}")

    blocks.to_file(WORK / "blocks.gpkg", driver="GPKG")
    towns.to_file(WORK / "towns.gpkg", driver="GPKG")
    adj.to_csv(WORK / "adj.csv", index=False)
    (OUT / "p2_check.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
