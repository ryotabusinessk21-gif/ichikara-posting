"""パイプライン共通: パス・設定・座標系。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
WORK = ROOT / "work"
OUT = ROOT / "out"
CONFIG = ROOT / "config"
DOCS_DATA = ROOT.parent / "docs" / "data"

for d in (RAW / "estat", RAW / "osm", WORK, OUT, DOCS_DATA):
    d.mkdir(parents=True, exist_ok=True)

P = json.loads((CONFIG / "params.json").read_text(encoding="utf-8"))
CRS_LL = "EPSG:4326"
CRS_M = P["crs_metric"]  # JGD2011 平面直角 VI系（京都府）


def bbox_polygon(buffer_m=0):
    """候補範囲の矩形（緯度経度）。buffer_m > 0 なら平面直角で広げて返す。"""
    import geopandas as gpd
    from shapely.geometry import box

    b = P["bbox"]
    g = gpd.GeoSeries([box(b["W"], b["S"], b["E"], b["N"])], crs=CRS_LL)
    if buffer_m:
        g = g.to_crs(CRS_M).buffer(buffer_m).to_crs(CRS_LL)
    return g.iloc[0]


def studio_point():
    from shapely.geometry import Point

    return Point(P["studio"]["lon"], P["studio"]["lat"])


def norm_name(s):
    """町名の表記ゆれ（ヶ/ケ/ヵ・空白）をそろえる。照合専用。"""
    return (s or "").replace("ヶ", "ケ").replace("ヵ", "ケ").replace("　", "").replace(" ", "").strip()


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
