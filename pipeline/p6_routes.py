"""区画ごとに「一筆書き」のポスティングルートを作る（郵便配達の巡回路＝ルート探索問題）。

1. 道路網を 40m 以下の区間に細かく切る
2. 区画に面した「配る道」（住宅地の道で、25m 以内に建物がある区間）を集める
3. 離れた道のかたまりは最短経路でつなぎ、奇数本の道が集まる交差点は最短の組み合わせで結ぶ（往復が最小になる）
4. スタジオに一番近い点から一筆書き（オイラー路）にし、最後の「移動だけ」の部分は削る

出力: work/routes.json（区画→ルート）、work/zones_routed.gpkg（ルート長などを追加）
© OpenStreetMap contributors（ODbL）
"""
import json
import math
import time

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import substring

from common import CRS_LL, CRS_M, P, RAW, WORK, studio_point

POST_HW = {"residential", "living_street", "unclassified", "tertiary", "tertiary_link", "secondary",
           "secondary_link", "primary", "primary_link", "service", "pedestrian", "footway"}
WIDE_HW = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"}
SEG = P["max_seg_m"]
SERVE = P["serve_dist_m"]
BLD_DIST = 25
TO_LL = Transformer.from_crs(CRS_M, CRS_LL, always_xy=True)
NODES, XY = [], (None, None)


def as_list(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return []
    if isinstance(v, list):
        return v
    s = str(v)
    if s.startswith("["):
        return [x.strip(" '\"") for x in s.strip("[]").split(",")]
    return [s]


def postable(d):
    hw = set(as_list(d.get("highway")))
    if not hw & POST_HW:
        return False
    if set(as_list(d.get("footway"))) & {"sidewalk", "crossing"}:
        return False
    if set(as_list(d.get("service"))) & {"parking_aisle", "drive-through"}:
        return False
    if set(as_list(d.get("access"))) & {"private", "no"}:
        return False
    if "yes" in as_list(d.get("area")):
        return False
    return True


def build_graph():
    G = ox.load_graphml(RAW / "osm" / "walk.graphml")
    U = ox.convert.to_undirected(ox.project_graph(G, to_crs=CRS_M))
    S = nx.MultiGraph()
    for n, d in U.nodes(data=True):
        S.add_node(n, x=d["x"], y=d["y"])
    pieces = []
    for u, v, k, d in U.edges(keys=True, data=True):
        ux, uy, vx, vy = U.nodes[u]["x"], U.nodes[u]["y"], U.nodes[v]["x"], U.nodes[v]["y"]
        geom = d.get("geometry") or LineString([(ux, uy), (vx, vy)])
        c0, c1 = geom.coords[0], geom.coords[-1]
        if math.hypot(c0[0] - ux, c0[1] - uy) > math.hypot(c1[0] - ux, c1[1] - uy):
            geom = LineString(list(geom.coords)[::-1])
        L = geom.length
        n = max(1, math.ceil(L / SEG))
        hw = as_list(d.get("highway"))
        post = postable(d)
        wide = bool(set(hw) & WIDE_HW)
        prev = u
        for i in range(n):
            seg = substring(geom, i * L / n, (i + 1) * L / n) if n > 1 else geom
            nxt = v if i == n - 1 else f"s{u}_{v}_{k}_{i}"
            if nxt != v:
                S.add_node(nxt, x=seg.coords[-1][0], y=seg.coords[-1][1])
            key = S.add_edge(prev, nxt, length=max(seg.length, 0.1), geometry=seg, post=post, wide=wide, src=prev)
            pieces.append((prev, nxt, key))
            prev = nxt
    return S, pieces


def poly_encode(coords):
    """Google の Encoded Polyline（緯度経度・小数5桁）。"""
    out, plat, plon = [], 0, 0
    for lat, lon in coords:
        for val, prev in ((round(lat * 1e5), plat), (round(lon * 1e5), plon)):
            d = val - prev
            d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20:
                out.append(chr((0x20 | (d & 0x1F)) + 63))
                d >>= 5
            out.append(chr(d + 63))
        plat, plon = round(lat * 1e5), round(lon * 1e5)
    return "".join(out)


def oriented(S, u, v, k):
    d = S.edges[u, v, k]
    g = d["geometry"]
    return list(g.coords) if d["src"] == u else list(g.coords)[::-1]


def add_path(H, L, path, kind):
    for a, b in zip(path[:-1], path[1:]):
        k = min(L[a][b], key=lambda kk: L[a][b][kk]["length"])
        d = L.edges[a, b, k]
        H.add_edge(a, b, length=d["length"], geometry=d["geometry"], src=d["src"], kind=kind)


def route_zone(S, zone_poly, cand_idx, piece_arr, studio_dist):
    req = []
    for i in cand_idx:
        u, v, k = piece_arr[i]
        g = S.edges[u, v, k]["geometry"]
        pts = [g.interpolate(f, normalized=True) for f in (0, 0.25, 0.5, 0.75, 1)]
        near = sum(zone_poly.distance(p) <= SERVE for p in pts)
        if near >= 3:
            req.append((u, v, k))
    if not req:
        return None
    H = nx.MultiGraph()
    inner = zone_poly.buffer(-6)
    for u, v, k in req:
        d = S.edges[u, v, k]
        times = 2 if d["wide"] and inner.contains(d["geometry"].interpolate(0.5, normalized=True)) else 1
        for _ in range(times):
            H.add_edge(u, v, length=d["length"], geometry=d["geometry"], src=d["src"], kind="p")

    # 移動用のネットワーク（区画の周り 400m）
    minx, miny, maxx, maxy = zone_poly.buffer(400).bounds
    m = (XY[0] >= minx) & (XY[0] <= maxx) & (XY[1] >= miny) & (XY[1] <= maxy)
    local_nodes = [NODES[i] for i in np.nonzero(m)[0]]
    L = S.subgraph(local_nodes)
    jumps = 0

    def straight(a, b):
        nonlocal jumps
        jumps += 1
        pa, pb = (S.nodes[a]["x"], S.nodes[a]["y"]), (S.nodes[b]["x"], S.nodes[b]["y"])
        H.add_edge(a, b, length=math.dist(pa, pb), geometry=LineString([pa, pb]), src=a, kind="m")

    # 1) 離れたかたまりをつなぐ（最小全域木）
    comps = [list(c) for c in nx.connected_components(H)]
    if len(comps) > 1:
        C = nx.Graph()
        info = {}
        for i, ci in enumerate(comps):
            dist, paths = nx.multi_source_dijkstra(L, set(ci) & set(L.nodes), cutoff=4000, weight="length")
            for j, cj in enumerate(comps):
                if j <= i:
                    continue
                best = min(((dist[n], n) for n in cj if n in dist), default=None)
                if best:
                    C.add_edge(i, j, weight=best[0])
                    info[(i, j)] = ("path", paths[best[1]])
                else:
                    a, b = min(((math.dist((S.nodes[x]["x"], S.nodes[x]["y"]), (S.nodes[y]["x"], S.nodes[y]["y"])), x, y)
                                for x in ci[:50] for y in cj[:50]))[1:]
                    C.add_edge(i, j, weight=1e6)
                    info[(i, j)] = ("jump", (a, b))
        for i, j in nx.minimum_spanning_edges(C, data=False):
            kind, val = info[(min(i, j), max(i, j))]
            if kind == "path":
                add_path(H, L, val, "m")
            else:
                straight(*val)

    # 2) 奇数次数の交差点を最短で組み合わせる
    odd = [n for n in H.nodes if H.degree(n) % 2]
    if odd:
        K = nx.Graph()
        paths = {}
        for a in odd:
            dist, pth = nx.single_source_dijkstra(L, a, cutoff=4000, weight="length") if a in L else ({}, {})
            for b in odd:
                if b == a or K.has_edge(a, b):
                    continue
                if b in dist:
                    K.add_edge(a, b, weight=dist[b])
                    paths[(a, b)] = pth[b]
                else:
                    pa, pb = (S.nodes[a]["x"], S.nodes[a]["y"]), (S.nodes[b]["x"], S.nodes[b]["y"])
                    K.add_edge(a, b, weight=math.dist(pa, pb) * 3 + 1e4)
        for a, b in nx.min_weight_matching(K, weight="weight"):
            p = paths.get((a, b)) or (paths.get((b, a))[::-1] if paths.get((b, a)) else None)
            if p:
                add_path(H, L, p, "m")
            else:
                straight(a, b)

    start = min(H.nodes, key=lambda n: studio_dist.get(n, float("inf")))
    circuit = list(nx.eulerian_circuit(H, source=start, keys=True))
    while circuit and H.edges[circuit[-1]]["kind"] == "m":
        circuit.pop()
    runs, cur_kind, cur = [], None, []
    post_m = move_m = 0.0
    for u, v, k in circuit:
        d = H.edges[u, v, k]
        coords = list(d["geometry"].coords) if d["src"] == u else list(d["geometry"].coords)[::-1]
        if d["kind"] == "p":
            post_m += d["length"]
        else:
            move_m += d["length"]
        if d["kind"] != cur_kind:
            if cur:
                runs.append((cur_kind, cur))
            cur_kind, cur = d["kind"], coords[:]
        else:
            cur += coords[1:]
    if cur:
        runs.append((cur_kind, cur))
    end = circuit[-1][1] if circuit else start
    req_set = {(min(str(u), str(v)), max(str(u), str(v))) for u, v, _ in req}
    walked = {(min(str(u), str(v)), max(str(u), str(v))) for u, v, _ in circuit}
    covered = len(req_set & walked) / len(req_set)
    return {"runs": runs, "start": start, "end": end, "post_m": post_m, "move_m": move_m,
            "n_req": len(req), "covered": covered, "jumps": jumps}


def to_ll(coords):
    xs, ys = zip(*coords)
    lon, lat = TO_LL.transform(xs, ys)
    return list(zip(lat, lon))


def main():
    t0 = time.time()
    S, pieces = build_graph()
    print(f"graph: {S.number_of_nodes()} nodes, {len(pieces)} pieces ({time.time() - t0:.0f}s)")
    piece_arr = np.array(pieces, dtype=object)
    geoms = np.array([S.edges[u, v, k]["geometry"] for u, v, k in pieces])
    post = np.array([S.edges[u, v, k]["post"] for u, v, k in pieces])
    bld = gpd.read_file(WORK / "buildings.gpkg")
    btree = shapely.STRtree(bld.geometry.values)
    has_bld = np.zeros(len(pieces), dtype=bool)
    hit = btree.query(geoms, predicate="dwithin", distance=BLD_DIST)
    has_bld[np.unique(hit[0])] = True
    ok = post & has_bld
    print(f"配る道の候補: {ok.sum()} / {len(pieces)} 区間（住宅地の道 {post.sum()}、建物あり {has_bld.sum()}）")
    ptree = shapely.STRtree(geoms)

    sp = gpd.GeoSeries([studio_point()], crs=CRS_LL).to_crs(CRS_M).iloc[0]
    global NODES, XY
    xs = np.array([d["x"] for _, d in S.nodes(data=True)])
    ys = np.array([d["y"] for _, d in S.nodes(data=True)])
    nodes = list(S.nodes)
    NODES, XY = nodes, (xs, ys)
    src = nodes[int(np.argmin((xs - sp.x) ** 2 + (ys - sp.y) ** 2))]
    studio_dist = nx.single_source_dijkstra_path_length(S, src, weight="length")

    zones = gpd.read_file(WORK / "zones.gpkg")
    out, attrs = {}, []
    for n_done, (_, z) in enumerate(zones.iterrows()):
        cand = [i for i in ptree.query(z.geometry, predicate="dwithin", distance=SERVE) if ok[i]]
        r = route_zone(S, z.geometry, cand, piece_arr, studio_dist) if cand else None
        if not r:
            attrs.append((z.id, 0, 0, 0, None, float(z.dist_m), 0, 1.0, 0))
            continue
        runs = [{"k": k, "enc": poly_encode(to_ll(c))} for k, c in r["runs"]]
        s_ll = to_ll([(S.nodes[r["start"]]["x"], S.nodes[r["start"]]["y"])])[0]
        e_ll = to_ll([(S.nodes[r["end"]]["x"], S.nodes[r["end"]]["y"])])[0]
        out[z.id] = {"s": [round(s_ll[0], 5), round(s_ll[1], 5)], "e": [round(e_ll[0], 5), round(e_ll[1], 5)],
                     "runs": runs}
        attrs.append((z.id, round(r["post_m"]), round(r["move_m"]), r["n_req"], s_ll,
                      round(studio_dist.get(r["start"], z.dist_m)), r["jumps"], r["covered"], 1))
        if n_done % 50 == 0:
            print(f"  {n_done}/{len(zones)} ({time.time() - t0:.0f}s)")
    (WORK / "routes.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    a = {x[0]: x for x in attrs}
    zones["post_m"] = zones.id.map(lambda i: a[i][1])
    zones["move_m"] = zones.id.map(lambda i: a[i][2])
    zones["route_m"] = zones.post_m + zones.move_m
    zones["n_req"] = zones.id.map(lambda i: a[i][3])
    zones["start_dist_m"] = zones.id.map(lambda i: a[i][5])
    zones["jumps"] = zones.id.map(lambda i: a[i][6])
    zones["covered"] = zones.id.map(lambda i: a[i][7])
    zones["has_route"] = zones.id.map(lambda i: a[i][8])
    zones.to_file(WORK / "zones_routed.gpkg", driver="GPKG")
    rz = zones[zones.has_route == 1]
    print(f"ルートあり {len(rz)}/{len(zones)}、配る道100%通過 {int((rz.covered >= 0.999).sum())}、"
          f"直線つなぎあり {int((rz.jumps > 0).sum())}")
    print("ルート長(m):", rz.route_m.describe().round(0).to_dict())
    print("移動だけの割合:", (rz.move_m / rz.route_m).describe().round(2).to_dict())
    print(f"合計 {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
