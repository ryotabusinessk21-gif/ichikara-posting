"""ブロックを約200世帯ずつの「区画」にまとめる。

方針
- 区画は町丁の中で作る（町をまたがない）。120世帯未満の小さい区画は、同じ狙いエリアの隣の区画と合わせる
- 大きい町は、世帯数が半分ずつになるように主軸方向で再帰的に二分する。分け目は「区切り」（川・線路・幹線道路）
  をまたぐ所を優先する
- 1ブロックで zone_hi 世帯を超えるものは単独の区画（大型集合住宅の可能性）

出力: work/zones.gpkg（区画）, work/blocks_zoned.gpkg（ブロック→区画）, work/zone_adj.csv
"""
import math
from collections import defaultdict

import geopandas as gpd
import networkx as nx
import numpy as np
import pandas as pd
import shapely

from common import P, WORK

T, LO, HI, SMALL = P["zone_target_households"], P["zone_lo"], P["zone_hi"], P["small_town"]


def load():
    b = gpd.read_file(WORK / "blocks.gpkg")
    b = b[b.SETAI > 0].reset_index(drop=True)
    d = pd.read_csv(WORK / "blocks_dist.csv", dtype={"id": str})
    a = pd.read_csv(WORK / "towns_area.csv", dtype={"cho": str})
    b = b.merge(d, on="id", how="left").merge(a.rename(columns={"area": "tarea"}), on="cho", how="left")
    b["tarea"] = b["tarea"].fillna(0).astype(int)  # 狙いエリア（列名 area は面積と紛らわしいので避ける）
    b["dist_m"] = b["dist_m"].fillna(b["straight_m"] * 1.3)
    b["h"] = b["SETAI"].astype(int)
    c = b.geometry.representative_point()
    b["px"], b["py"] = c.x, c.y
    return b


def adjacency(b):
    adj = pd.read_csv(WORK / "adj.csv", dtype={"a": str, "b": str})
    bar = gpd.read_file(WORK / "barriers.gpkg").to_crs(b.crs)
    tree = shapely.STRtree(bar.geometry.values)
    geom = dict(zip(b.id, b.geometry))
    barrier = []
    for x, y in zip(adj.a, adj.b):
        if x not in geom or y not in geom:
            barrier.append(False)
            continue
        seg = geom[x].boundary.intersection(geom[y].buffer(1.5))
        pt = seg.interpolate(0.5, normalized=True) if seg.length > 0 else \
            shapely.ops.nearest_points(geom[x], geom[y])[0]
        barrier.append(len(tree.query(pt, predicate="dwithin", distance=15)) > 0)
    adj["barrier"] = barrier
    G = nx.Graph()
    G.add_nodes_from(b.id)
    for x, y, s, br in zip(adj.a, adj.b, adj.shared_m, adj.barrier):
        if x in geom and y in geom:
            G.add_edge(x, y, shared=float(s), barrier=bool(br))
    return G


def cut_cost(G, left, right):
    left = set(left)
    s = 0.0
    for u in left:
        for v, e in G[u].items():
            if v in right and not e["barrier"]:
                s += e["shared"]
    return s


def bisect(ids, k, G, h, xy):
    if k <= 1 or len(ids) <= 1:
        return [ids]
    k1 = k // 2
    pts = np.array([xy[i] for i in ids])
    w = np.array([h[i] for i in ids], dtype=float)
    mu = (pts * w[:, None]).sum(0) / w.sum()
    cov = np.cov((pts - mu).T, aweights=w) if len(ids) > 2 else np.eye(2)
    axis = np.linalg.eigh(cov)[1][:, -1]
    order = [ids[i] for i in np.argsort((pts - mu) @ axis)]
    H = w.sum()
    cum, best = 0.0, None
    goal = k1 / k
    for i in range(1, len(order)):
        cum += h[order[i - 1]]
        frac = cum / H
        if abs(frac - goal) > 0.08 and best is not None:
            continue
        left, right = order[:i], set(order[i:])
        cost = 10 * abs(frac - goal) + cut_cost(G, left, right) / 100
        if best is None or cost < best[0]:
            best = (cost, order[:i], order[i:])
    _, L, R = best
    return bisect(L, k1, G, h, xy) + bisect(R, k - k1, G, h, xy)


def repair(parts, G, h):
    """各区画で一番大きいつながり以外を、隣の区画（同じ町）へ移す。"""
    owner = {b: i for i, p in enumerate(parts) for b in p}
    for _ in range(3):
        moved = False
        for i, p in enumerate(parts):
            if len(p) <= 1:
                continue
            comps = sorted(nx.connected_components(G.subgraph(p)), key=lambda c: -sum(h[x] for x in c))
            for comp in comps[1:]:
                nb = {owner[v] for u in comp for v in G[u] if v in owner and owner[v] != i}
                if not nb:
                    continue
                j = min(nb, key=lambda j: sum(h[x] for x in parts[j]))
                for u in comp:
                    parts[i].remove(u)
                    parts[j].append(u)
                    owner[u] = j
                moved = True
        if not moved:
            break
    return [p for p in parts if p]


def zone_town(ids, G, h, xy):
    big = [i for i in ids if h[i] > HI]
    rest = [i for i in ids if h[i] <= HI]
    out = [[i] for i in big]
    if rest:
        H = sum(h[i] for i in rest)
        k = max(1, math.floor(H / T))
        while H / k > HI * 1.1:  # 264 世帯までは1区画として許す
            k += 1
        out += repair(bisect(rest, k, G, h, xy), G, h)
    return out


def main():
    b = load()
    G = adjacency(b)
    h = dict(zip(b.id, b.h))
    xy = dict(zip(b.id, zip(b.px, b.py)))
    area = dict(zip(b.id, b["tarea"]))
    town_of = dict(zip(b.id, b.cho))

    zones = []  # list of block-id lists
    for cho, grp in b.groupby("cho"):
        zones += zone_town(list(grp.id), G, h, xy)

    # 小さい区画を隣とまとめる
    #  1) 区切りをまたがず・同じ狙いエリア  2) 区切りはまたいでよい・同じ狙いエリア  3) ごく小さい区画はエリアも問わない
    def zh(z):
        return sum(h[i] for i in z)

    def merge_pass(zones, limit, allow_barrier, allow_area, max_h):
        while True:
            owner = {bid: zi for zi, z in enumerate(zones) for bid in z}
            done = True
            for zi in sorted(range(len(zones)), key=lambda i: zh(zones[i])):
                z = zones[zi]
                if zh(z) >= limit:
                    break
                if any(h[x] > HI for x in z):
                    continue
                shared = defaultdict(float)
                for u in z:
                    for v, e in G[u].items():
                        zj = owner.get(v)
                        if zj is None or zj == zi:
                            continue
                        if (e["barrier"] and not allow_barrier) or (area[v] != area[u] and not allow_area):
                            continue
                        if any(h[x] > HI for x in zones[zj]):
                            continue
                        shared[zj] += e["shared"] + 1
                cands = [(abs(zh(z) + zh(zones[zj]) - T), -s, zj) for zj, s in shared.items()
                         if zh(z) + zh(zones[zj]) <= max_h]
                if not cands:
                    continue
                zj = min(cands)[2]
                zones[zj] = zones[zj] + z
                del zones[zi]
                done = False
                break
            if done:
                return zones

    zones = merge_pass(zones, LO, False, False, HI * 1.1)
    zones = merge_pass(zones, LO, True, False, HI * 1.1)
    zones = merge_pass(zones, 40, True, True, HI * 1.25)

    # 区画の属性
    names = b.groupby("cho").agg(name=("name", "first"), gakku=("gakku", "first"))
    dup = names.groupby("name").size()
    disp = {cho: (r["name"] if dup[r["name"]] == 1 else f"{r['name']}（{r['gakku']}）") for cho, r in names.iterrows()}
    dist = dict(zip(b.id, b.dist_m))
    geom = dict(zip(b.id, b.geometry))
    rows, bz = [], {}
    split_count = defaultdict(int)
    for z in zones:
        hz = defaultdict(int)
        for x in z:
            hz[town_of[x]] += h[x]
        main_cho = max(hz, key=hz.get)
        split_count[main_cho] += 1
    seq = defaultdict(int)
    zones.sort(key=lambda z: (max({town_of[x] for x in z}, key=lambda c: sum(h[y] for y in z if town_of[y] == c)),
                              min(dist[x] for x in z)))
    for z in zones:
        hz = defaultdict(int)
        for x in z:
            hz[town_of[x]] += h[x]
        towns = sorted(hz, key=hz.get, reverse=True)
        main_cho = towns[0]
        seq[main_cho] += 1
        zid = f"{main_cho}-{seq[main_cho]}"
        if len(towns) == 1:
            label = disp[main_cho] + (f"-{seq[main_cho]}" if split_count[main_cho] > 1 else "")
        elif len(towns) == 2:
            label = f"{disp[towns[0]]}・{disp[towns[1]]}"
        else:
            label = f"{disp[towns[0]]}ほか{len(towns) - 1}町"
        hzone = sum(h[x] for x in z)
        flags = []
        if any(h[x] > HI for x in z):
            flags.append("big")
        if hzone < SMALL:
            flags.append("small")
        sub = G.subgraph(z)
        rows.append({"id": zid, "label": label, "h": hzone, "n_blocks": len(z), "towns": ",".join(towns),
                     "tarea": int(area[z[0]]), "dist_m": float(min(dist[x] for x in z)),
                     "apt": int(b.set_index("id").loc[z, "apt"].sum()),
                     "parts": nx.number_connected_components(sub), "flags": ",".join(flags),
                     "geometry": shapely.union_all([geom[x] for x in z])})
        for x in z:
            bz[x] = zid
    zg = gpd.GeoDataFrame(rows, geometry="geometry", crs=b.crs)
    b["zone"] = b.id.map(bz)

    # 区画どうしの隣接（共有境界の合計・区切りかどうか）
    za = defaultdict(lambda: [0.0, True])
    for u, v, e in G.edges(data=True):
        zu, zv = bz.get(u), bz.get(v)
        if zu and zv and zu != zv:
            k = tuple(sorted((zu, zv)))
            za[k][0] += e["shared"]
            za[k][1] = za[k][1] and e["barrier"]
    pd.DataFrame([(a, c, round(s, 1), int(br)) for (a, c), (s, br) in za.items()],
                 columns=["a", "b", "shared_m", "barrier"]).to_csv(WORK / "zone_adj.csv", index=False)

    zg.to_file(WORK / "zones.gpkg", driver="GPKG")
    b.to_file(WORK / "blocks_zoned.gpkg", driver="GPKG")
    hs = zg.h
    print(f"区画 {len(zg)}（世帯 {int(hs.sum()):,}）、{LO}〜{HI}世帯に入る割合 {((hs >= LO) & (hs <= HI)).mean():.0%}")
    print("世帯数の分布:", hs.describe().round(0).to_dict())
    print("small:", int(zg["flags"].str.contains("small").sum()), " big:", int(zg["flags"].str.contains("big").sum()),
          " 飛び地あり:", int((zg.parts > 1).sum()), " 複数町:", int(zg.towns.str.contains(",").sum()))
    for a, g in zg.groupby("tarea"):
        print(f"  エリア{a}: 区画 {len(g)}・世帯 {int(g.h.sum()):,}")


if __name__ == "__main__":
    main()
