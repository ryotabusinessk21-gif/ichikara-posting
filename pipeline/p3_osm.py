"""OpenStreetMap から歩行用の道路網と「区切り」（川・地上の線路・幹線道路）を取る。

出力
- raw/osm/walk.graphml       : 歩行ネットワーク（緯度経度）
- work/barriers.gpkg         : 区切りの線
- work/stations.gpkg         : 駅（目印）
- work/blocks_dist.csv       : ブロックごとのスタジオからの道のり距離・直線距離・方角
© OpenStreetMap contributors（ODbL）
"""
import math

import geopandas as gpd
import networkx as nx
import osmnx as ox
import pandas as pd

from common import CRS_LL, CRS_M, P, RAW, WORK, bbox_polygon, studio_point

ox.settings.use_cache = True
ox.settings.cache_folder = str(RAW / "osm" / "cache")
ox.settings.log_console = False
ox.settings.useful_tags_way = list(ox.settings.useful_tags_way) + ["footway", "access", "service", "tunnel", "area"]


def main():
    poly = bbox_polygon(P["osm_buffer_m"])
    G = ox.graph_from_polygon(poly, network_type="walk", simplify=True, retain_all=True)
    ox.save_graphml(G, RAW / "osm" / "walk.graphml")
    print("walk graph:", G.number_of_nodes(), "nodes", G.number_of_edges(), "edges")

    # 区切り: 川・水路、地上の線路（地下鉄を除く）、幹線道路
    feats = ox.features_from_polygon(poly, tags={"waterway": ["river", "canal"],
                                                 "railway": ["rail", "light_rail"],
                                                 "highway": ["trunk", "primary", "secondary"]})
    feats = feats[feats.geometry.type.isin(["LineString", "MultiLineString"])].copy()
    if "tunnel" in feats:
        feats = feats[feats["tunnel"].fillna("no") != "yes"]
    feats["kind"] = feats.apply(lambda r: "water" if isinstance(r.get("waterway"), str) else
                                ("rail" if isinstance(r.get("railway"), str) else "road"), axis=1)
    keep = [c for c in ["name", "ref", "kind", "geometry"] if c in feats.columns]
    feats[keep].reset_index(drop=True).to_file(WORK / "barriers.gpkg", driver="GPKG")
    print("barriers:", feats["kind"].value_counts().to_dict())

    st = ox.features_from_polygon(poly, tags={"railway": "station"})
    st = st[st.geometry.type == "Point"][[c for c in ["name", "geometry"] if c in st.columns]]
    st.reset_index(drop=True).to_file(WORK / "stations.gpkg", driver="GPKG")
    print("stations:", ", ".join(sorted(st["name"].dropna().unique())))

    # スタジオからの道のり距離（無向・平面直角）
    Gp = ox.project_graph(G, to_crs=CRS_M)
    U = ox.convert.to_undirected(Gp)
    sp = gpd.GeoSeries([studio_point()], crs=CRS_LL).to_crs(CRS_M).iloc[0]
    src = ox.distance.nearest_nodes(U, sp.x, sp.y)
    dist = nx.single_source_dijkstra_path_length(U, src, weight="length")

    blocks = gpd.read_file(WORK / "blocks.gpkg")
    rp = blocks.representative_point()
    nodes = ox.distance.nearest_nodes(U, rp.x.values, rp.y.values)
    nx_ = pd.Series({n: d for n, d in U.nodes(data=True)})
    out = []
    for bid, p, n in zip(blocks["id"], rp, nodes):
        nd = U.nodes[n]
        snap = math.hypot(nd["x"] - p.x, nd["y"] - p.y)
        dx, dy = p.x - sp.x, p.y - sp.y
        out.append((bid, round(dist.get(n, float("nan")) + snap, 0), round(math.hypot(dx, dy), 0),
                    round((math.degrees(math.atan2(dx, dy)) + 360) % 360, 1)))
    pd.DataFrame(out, columns=["id", "dist_m", "straight_m", "bearing"]).to_csv(WORK / "blocks_dist.csv", index=False)
    print("distances done; unreachable:", sum(1 for r in out if r[1] != r[1]))


if __name__ == "__main__":
    main()
