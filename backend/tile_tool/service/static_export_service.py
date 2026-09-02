"""조회 결과를 파일 하나짜리 HTML 로 내보낸다.

서버 없이 더블클릭해서 여는 용도라 데이터를 전부 HTML 안에 박아 넣는다.
(Leaflet 과 배경지도 타일만 인터넷이 필요하다 - 웹 UI 도 마찬가지다)
"""

import json
import os

from backend.tile_tool.service.lookup_service import format_text


# eSAFEDRIVE_GGUIDE_TYPE -> 내비 리소스 파일명. 웹 UI(06-vsm.js)와 같은 표다.
SAFE_DRIVE_ASSET = {
    1: "SDI_SPEED_LIMIT_POS", 2: "SDI_SPEED_LIMIT_DANGEROUS_AREA",
    3: "SDI_LOAD_BAD_CONTROL_POS", 4: "SDI_SIGNAL_ACCIDENT_POS",
    5: "SDI_SPEED_ACCIDENT_POS", 7: "SDI_PARKING_CONTROL_POS",
    8: "SDI_ROAD_CONTROL_POS", 9: "SDI_TRAFFICINFO_COLLECT_POS",
    10: "SDI_ACCIDEDNT_AREA", 11: "SDI_SHARP_CURVE_AREA", 12: "SDI_FOG_AREA",
    13: "SDI_REST_PLACE", 17: "SDI_LOAD_BAD_CONTROL_POS", 18: "SDI_SPEEDBUMP",
    19: "SDI_SCHOOL_ZONE_START", 20: "SDI_RAILWAY_CROSSING",
    21: "SDI_CHANGEROAD_POS", 22: "SDI_SPEED_BLOCK_START_POS",
    23: "SDI_SPEED_BLOCK_END_POS", 24: "SDI_LOAD_BAD_CONTROL_POS",
    25: "SDI_CCTV_AREA", 26: "SDI_ACCIDEDNT_AREA", 27: "SDI_SPEED_BLOCK_START_POS",
    28: "SDI_SPEED_BLOCK_END_POS", 30: "SDI_BOX_SPEED_LIMIT_POS",
    31: "SDI_REST_PLACE", 32: "SDI_SCHOOL_ZONE_START", 33: "SDI_SCHOOL_ZONE_START",
    40: "SDI_SPEED_LIMIT_POS", 41: "SDI_SPEED_ACCIDENT_POS",
    48: "SDI_SPEED_BLOCK_START_POS", 49: "SDI_SPEED_BLOCK_END_POS",
    50: "SDI_SPEED_BLOCK_START_POS", 51: "SDI_SPEED_BLOCK_END_POS",
    52: "SDI_SPEED_BLOCK_START_POS", 53: "SDI_SPEED_BLOCK_END_POS",
}


def _icon_data_uri(asset_dir, asset):
    """아이콘을 data: URI 로 박는다. 파일 하나로 끝나야 하기 때문이다."""
    import base64
    path = os.path.join(asset_dir, f"{asset}.png")
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return "data:image/png;base64," + base64.b64encode(handle.read()).decode("ascii")


def write_html(result, out_path, asset_dir):
    used = {SAFE_DRIVE_ASSET.get(point["type"]) for point in result["points"]}
    icons = {}
    for asset in used:
        if not asset:
            continue
        uri = _icon_data_uri(asset_dir, asset)
        if uri:
            icons[asset] = uri

    payload = {
        "target": result["target"],
        "cell": result["cell"],
        "points": result["points"],
        "source": result["source"],
        "assets": {str(k): v for k, v in SAFE_DRIVE_ASSET.items()},
        "icons": icons,
    }

    tile = result["target"]["tile"]
    title = f"타일 {tile['x']},{tile['y']} SDI"
    html = _TEMPLATE.format(
        title=title,
        payload=json.dumps(payload, ensure_ascii=False),
        summary=format_text(result).replace("&", "&amp;").replace("<", "&lt;"),
    )
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(html)
    return out_path


_TEMPLATE = """<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif;
    color: #1f2937; background: #f1f5f9; }}
  #app {{ display: flex; height: 100%; }}
  #side {{ width: 400px; flex: 0 0 400px; padding: 16px; overflow-y: auto;
    border-right: 1px solid #e2e8f0; background: #fff; }}
  h1 {{ margin: 0 0 4px; font-size: 16px; }}
  .sub {{ margin: 0 0 14px; font-size: 12px; color: #64748b; }}
  pre {{ margin: 0; font-size: 11.5px; line-height: 1.65; white-space: pre-wrap;
    word-break: break-all; color: #334155; }}
  #map {{ flex: 1 1 auto; }}
  .pin {{ position: relative; }}
  .pin img {{ display: block; }}
  .pin.ahead {{ opacity: 0.55; }}
  .pin .badge {{ position: absolute; right: -3px; bottom: -3px; min-width: 14px;
    height: 14px; padding: 0 2px; border-radius: 7px; background: #fff;
    border: 1.5px solid #dc2626; color: #111827; font-size: 9px; font-weight: 800;
    line-height: 11px; text-align: center; box-sizing: border-box; }}
  .chip {{ display: grid; place-items: center; width: 100%; height: 100%;
    border-radius: 6px; background: #fff; border: 1.5px solid #2f6ded;
    color: #2563eb; font-size: 10px; font-weight: 800; }}
  .pop {{ font-size: 12px; line-height: 1.6; }}
  .pop b {{ display: block; margin-bottom: 4px; font-size: 13px; }}
  .pop span {{ display: inline-block; width: 58px; color: #64748b; }}
</style>
</head>
<body>
<div id="app">
  <aside id="side">
    <h1>{title}</h1>
    <p class="sub">서버 없이 열리는 단독 파일입니다. 배경지도만 인터넷을 씁니다.</p>
    <pre>{summary}</pre>
  </aside>
  <div id="map"></div>
</div>
<script>
const DATA = {payload};

const tile = DATA.target.tile;
const b = tile.bounds;
const map = L.map('map');
L.tileLayer('http://tlpimg1.tmap.co.kr/tms/1.0.0/hd_tile/{{z}}/{{x}}/{{-y}}.png',
  {{ maxZoom: 19, attribution: 'Tmap' }}).addTo(map);

L.polygon(DATA.cell.ring, {{ color: '#7c3aed', weight: 2, dashArray: '6 4',
  fill: false, interactive: false }}).addTo(map);
L.rectangle([[b.south, b.west], [b.north, b.east]], {{ color: '#f97316', weight: 3,
  fillColor: '#f97316', fillOpacity: 0.1, interactive: false }}).addTo(map);

DATA.points.forEach((p) => {{
  const size = p.exact ? 30 : 22;
  const asset = DATA.assets[String(p.type)];
  const uri = asset && DATA.icons[asset];
  const badge = p.speed_limit ? `<div class="badge">${{p.speed_limit}}</div>` : '';
  const body = uri
    ? `<img src="${{uri}}" width="${{size}}" height="${{size}}">${{badge}}`
    : `<span class="chip">${{(p.type_name || '').slice(0, 2)}}</span>${{badge}}`;
  L.marker([p.lat, p.lon], {{ icon: L.divIcon({{
      className: '',
      html: `<div class="pin${{p.exact ? '' : ' ahead'}}" style="width:${{size}}px;height:${{size}}px">${{body}}</div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  }}) }})
    .bindPopup(`<div class="pop"><b>${{p.type_name}}</b>`
      + `<div><span>지점</span>${{p.exact ? '설치점' : '안내점'}}</div>`
      + (p.speed_limit ? `<div><span>제한속도</span>${{p.speed_limit}} km/h</div>` : '')
      + `<div><span>좌표</span>${{p.lat.toFixed(6)}}, ${{p.lon.toFixed(6)}}</div>`
      + `<div><span>방위각</span>${{p.angle}}&deg;</div>`
      + `<div><span>원본</span><code>${{p.raw}}</code></div></div>`)
    .addTo(map);
}});

map.fitBounds([[b.south, b.west], [b.north, b.east]], {{ padding: [50, 50] }});
</script>
</body>
</html>
"""
