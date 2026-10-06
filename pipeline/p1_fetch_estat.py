"""e-Stat から令和2年国勢調査の境界データ（基本単位区・町丁字等）を取得する。

URL の形式は e-Stat 公式の説明ではなく、統計GISのダウンロード画面が使っているもの。
取得できない場合は README の手順でブラウザから手動ダウンロードし、raw/estat/ に zip を置く。
"""
import hashlib
import io
import json
import zipfile
from datetime import date

import requests

from common import P, RAW

SURVEYS = {
    "B002005212020": "基本単位区（令和2年国勢調査）",
    "A002005212020": "町丁・字等（令和2年国勢調査）",
}
URL = ("https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId={sid}&code={code}"
       "&coordSys=1&format=shape&downloadType=5&datum=2000")


def main():
    dest = RAW / "estat"
    manifest = {}
    for sid, label in SURVEYS.items():
        for code, ward in P["wards"].items():
            url = URL.format(sid=sid, code=code)
            zpath = dest / f"{sid}_{code}.zip"
            if not zpath.exists():
                r = requests.get(url, timeout=60)
                r.raise_for_status()
                if not r.content.startswith(b"PK"):
                    raise SystemExit(f"zip ではない応答: {url}（手動ダウンロードが必要）")
                zpath.write_bytes(r.content)
            data = zpath.read_bytes()
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                z.extractall(dest / f"{sid}_{code}")
                names = z.namelist()
            manifest[f"{sid}_{code}"] = {
                "label": f"{label} {ward}", "url": url, "retrieved": date.today().isoformat(),
                "sha256": hashlib.sha256(data).hexdigest(), "files": names,
            }
            print(f"{sid} {code} {ward}: {len(data)//1024} KB, {names}")
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
