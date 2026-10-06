"""町ごとに狙いエリア（1〜5、0=その他）を割り当て、本人確認用の一覧と地図を出す。

出力
- work/towns_area.csv     : cho → area（p5 以降で使う）
- out/target_towns.csv    : 確認用の一覧（エリア・学区・町名・世帯数・距離・境界際かどうか）
- out/target_towns.html   : 確認用の地図（公開しない）
上書きは config/target_towns_override.csv（cho,area）。
"""
import json

import geopandas as gpd
import pandas as pd

from common import CONFIG, CRS_LL, OUT, WORK

NEAR = 0.0014  # 境界の目安線から約150m以内は「要確認」


def match(rule, gakku, lat, lon):
    if rule.get("gakku") and gakku not in rule["gakku"]:
        return False
    for k, v in (("lat_min", lat), ("lon_min", lon)):
        if k in rule and v < rule[k]:
            return False
    for k, v in (("lat_max", lat), ("lon_max", lon)):
        if k in rule and v > rule[k]:
            return False
    return True


def borderline(rules, lat, lon):
    for r in rules:
        for k in ("lat_min", "lat_max"):
            if k in r and abs(lat - r[k]) < NEAR:
                return True
        for k in ("lon_min", "lon_max"):
            if k in r and abs(lon - r[k]) < NEAR * 1.2:
                return True
    return False


def main():
    cfg = json.loads((CONFIG / "target_areas.json").read_text(encoding="utf-8"))
    blocks = gpd.read_file(WORK / "blocks.gpkg")
    dist = pd.read_csv(WORK / "blocks_dist.csv", dtype={"id": str})
    blocks = blocks.merge(dist, on="id", how="left")
    b = blocks[blocks.SETAI > 0].copy()
    rp = b.representative_point().to_crs(CRS_LL)
    b["lat"], b["lon"] = rp.y.values, rp.x.values
    b["w_lat"], b["w_lon"], b["w_dist"] = b.lat * b.SETAI, b.lon * b.SETAI, b.dist_m.fillna(b.straight_m * 1.3) * b.SETAI
    t = b.groupby("cho").agg(gakku=("gakku", "first"), name=("name", "first"), setai=("SETAI", "sum"),
                             n_blocks=("id", "size"), w_lat=("w_lat", "sum"), w_lon=("w_lon", "sum"),
                             w_dist=("w_dist", "sum")).reset_index()
    t["lat"], t["lon"] = t.w_lat / t.setai, t.w_lon / t.setai
    t["dist_m"] = (t.w_dist / t.setai).round(0)

    areas, rules_hit = [], []
    for _, r in t.iterrows():
        a, why = 0, ""
        for i, rule in enumerate(cfg["rules"]):
            if match(rule, r.gakku, r.lat, r.lon):
                a, why = rule["area"], f"rule{i + 1}"
                break
        areas.append(a)
        rules_hit.append(why)
    t["area"], t["rule"] = areas, rules_hit
    t["borderline"] = [borderline(cfg["rules"], la, lo) and r.gakku in sum((x["gakku"] for x in cfg["rules"]), [])
                       for la, lo, (_, r) in zip(t.lat, t.lon, t.iterrows())]

    ov = CONFIG / "target_towns_override.csv"
    if ov.exists():
        o = pd.read_csv(ov, dtype={"cho": str})
        for _, r in o.iterrows():
            t.loc[t.cho == r.cho, ["area", "rule"]] = [int(r.area), "override"]

    t["area_name"] = t.area.astype(str).map(cfg["areas"]).fillna("その他")
    t[["cho", "area"]].to_csv(WORK / "towns_area.csv", index=False)
    cols = ["area", "area_name", "gakku", "name", "setai", "n_blocks", "dist_m", "rule", "borderline", "cho", "lat", "lon"]
    t.sort_values(["area", "dist_m"])[cols].round({"lat": 5, "lon": 5}).to_csv(OUT / "target_towns.csv", index=False,
                                                                                encoding="utf-8-sig")

    print("エリア別の世帯数（2020年国勢調査）")
    for a, g in t.groupby("area"):
        print(f"  {a} {cfg['areas'].get(str(a), 'その他')}: {int(g.setai.sum()):,} 世帯 / {len(g)} 町")
    print(f"狙いエリア合計: {int(t[t.area > 0].setai.sum()):,} 世帯")
    print(f"要確認（境界際）: {int((t.borderline & (t.setai > 0)).sum())} 町")
    make_map(blocks, t, cfg)


def make_map(blocks, t, cfg):
    import folium

    colors = {0: "#bbbbbb", 1: "#e6194b", 2: "#3cb44b", 3: "#4363d8", 4: "#f58231", 5: "#911eb4"}
    town_shapes = blocks[blocks.SETAI > 0].dissolve(by="cho").reset_index()[["cho", "geometry"]]
    town_shapes = town_shapes.merge(t[["cho", "area", "area_name", "gakku", "name", "setai", "borderline"]], on="cho")
    town_shapes = town_shapes.to_crs(CRS_LL)
    town_shapes["geometry"] = town_shapes.simplify(0.00003)
    m = folium.Map(location=[35.058, 135.785], zoom_start=14, tiles=None)
    folium.TileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
                     attr="出典：国土地理院 地理院タイル（淡色地図）", name="地理院").add_to(m)
    folium.GeoJson(
        town_shapes.__geo_interface__,
        style_function=lambda f: {"fillColor": colors[f["properties"]["area"]], "color":
                                  "#000" if f["properties"]["borderline"] else colors[f["properties"]["area"]],
                                  "weight": 2 if f["properties"]["borderline"] else 0.6,
                                  "fillOpacity": 0.45 if f["properties"]["area"] else 0.15},
        tooltip=folium.GeoJsonTooltip(["area_name", "gakku", "name", "setai"],
                                      aliases=["エリア", "学区", "町名", "世帯"]),
    ).add_to(m)
    folium.Marker([35.0635824, 135.7924374], tooltip="スタジオ", icon=folium.Icon(color="red", icon="star")).add_to(m)
    legend = "".join(f"<div><span style='background:{colors[int(k)]};display:inline-block;width:12px;height:12px'></span> "
                     f"{k} {v}</div>" for k, v in cfg["areas"].items())
    m.get_root().html.add_child(folium.Element(
        f"<div style='position:fixed;top:10px;right:10px;z-index:9999;background:#fff;padding:8px;font:13px sans-serif;"
        f"border:1px solid #999'>{legend}<div>灰色: その他／太枠: 境界際（要確認）</div></div>"))
    m.save(str(OUT / "target_towns.html"))


if __name__ == "__main__":
    main()
