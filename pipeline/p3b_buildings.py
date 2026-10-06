"""OpenStreetMap の建物（重心点）を取る。山道・公園の遊歩道など、家のない道を「配る道」から外すのに使う。

出力: work/buildings.gpkg（点）
© OpenStreetMap contributors（ODbL）
"""
import geopandas as gpd
import osmnx as ox

from common import CRS_M, P, RAW, WORK, bbox_polygon

ox.settings.use_cache = True
ox.settings.cache_folder = str(RAW / "osm" / "cache")
ox.settings.log_console = False


def main():
    poly = bbox_polygon(P["osm_buffer_m"])
    f = ox.features_from_polygon(poly, tags={"building": True})
    f = f[f.geometry.type.isin(["Polygon", "MultiPolygon", "Point"])]
    pts = gpd.GeoDataFrame({"building": f["building"].astype(str).values},
                           geometry=f.to_crs(CRS_M).geometry.representative_point().values, crs=CRS_M)
    pts.to_file(WORK / "buildings.gpkg", driver="GPKG")
    print("buildings:", len(pts), pts["building"].value_counts().head(8).to_dict())


if __name__ == "__main__":
    main()
