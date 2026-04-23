import json
import os
import re
from textwrap import dedent

from backend.positioning_tool.service.paths import PATHS


def _safe_part(value: str) -> str:
    value = value.strip()
    value = re.sub(r"[^\w\-\.]+", "_", value)
    return value.strip("_") or "log"


def detect_issue_id(text: str | None) -> str | None:
    if not text:
        return None
    m = re.search(r"\b([A-Za-z]+-\d+)\b", text)
    if not m:
        return None
    return m.group(1).upper()


def render_simple_export_html(markers_data: list[dict], lines_data: list[dict], result_name: str) -> str:
    markers_json = json.dumps(markers_data, ensure_ascii=False)
    lines_json = json.dumps(lines_data, ensure_ascii=False)
    title = f"result_{result_name}"
    return dedent(
        f"""\
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>{title}</title>
          <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
          <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css" />
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/Leaflet.awesome-markers/2.0.2/leaflet.awesome-markers.css" />
          <script src="https://cdnjs.cloudflare.com/ajax/libs/Leaflet.awesome-markers/2.0.2/leaflet.awesome-markers.min.js"></script>
          <style>
            html, body {{ margin: 0; height: 100%; font-family: Pretendard, sans-serif; }}
            #map {{ width: 100%; height: 100%; }}
            .leaflet-control-layers {{
              font-size: 12px;
              border-radius: 10px;
            }}
            .leaflet-control-layers label {{
              font-size: 12px;
            }}
          </style>
        </head>
        <body>
          <div id="map"></div>
          <script>
            const map = L.map('map').setView([37.5665, 126.9780], 15);
            const baseLayers = {{
              "OpenStreetMap": L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
              }}),
              "Google Maps": L.tileLayer('https://mt0.google.com/vt/lyrs=m&hl=ko&x={{x}}&y={{y}}&z={{z}}', {{
                maxZoom: 22,
                attribution: 'Google Maps'
              }}),
              "Google Satellite": L.tileLayer('https://mt0.google.com/vt/lyrs=s&hl=ko&x={{x}}&y={{y}}&z={{z}}', {{
                maxZoom: 22,
                attribution: 'Google Satellite'
              }}),
              "Tmap": L.tileLayer('http://tlpimg1.tmap.co.kr/tms/1.0.0/hd_tile/{{z}}/{{x}}/{{-y}}.png', {{
                maxZoom: 19,
                attribution: 'Tmap'
              }})
            }};
            baseLayers["Tmap"].addTo(map);

            const markersData = {markers_json};
            const linesData = {lines_json};
            const overlayGroups = {{}};
            const GOOD_MATCH_STATES = new Set(['MATCH_OK_TRANSIENT', 'MATCH_OK_GOOD']);

            function makePopupText(coord) {{
              const coordtype = coord.type || 'Unknown';
              const dltId = Number.isFinite(coord?.dlt_id) ? coord.dlt_id : '-';
              const markerId = Number.isFinite(coord?.id) ? coord.id : '-';
              const lat = Number(coord?.latitude);
              const lon = Number(coord?.longitude);
              const ts = coord?.timestamp_str ? coord.timestamp_str : '-';

              const latText = Number.isFinite(lat) ? lat.toFixed(6) : '-';
              const lonText = Number.isFinite(lon) ? lon.toFixed(6) : '-';
              let text = `DLT: ${{dltId}}<br>ID: ${{markerId}}<br>TS: ${{ts}}<br>${{latText}}, ${{lonText}}`;

              if (coord.heading !== null && coord.heading !== undefined) {{
                text += `<br>Heading: ${{Number(coord.heading).toFixed(2)}}°`;
              }}
              if (coord.extra && coord.extra.Speed !== undefined) {{
                const speed = Number(coord.extra.Speed);
                text += `<br>Speed: ${{Number.isFinite(speed) ? speed.toFixed(2) : coord.extra.Speed}}`;
              }}

              if (coordtype === 'DR-based') {{
                text += `<br>isDRGps: ${{coord.extra?.isDRGps ?? ''}}`;
              }}
              if (coordtype === 'Request') {{
                text += `<br>${{coord.extra?.group_1 ?? ''}} ${{coord.extra?.group_2_text ?? ''}}`;
              }}
              if (coordtype === 'Route Match' || coordtype === 'Road Match') {{
                const state = coord.extra?.match_state || '';
                if (state && !GOOD_MATCH_STATES.has(state)) {{
                  text += `<br>${{state}}`;
                }}
              }}
              return text;
            }}

            markersData.forEach((coord) => {{
              const type = coord.type || 'Unknown';
              if (!overlayGroups[type]) overlayGroups[type] = L.featureGroup();
              const lat = Number(coord.latitude), lon = Number(coord.longitude);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

              const color = coord.color || '#334155';
              const popup = makePopupText(coord);

              if (type === 'Request') {{
                L.marker([lat, lon], {{
                  icon: L.AwesomeMarkers.icon({{
                    icon: 'info-circle',
                    markerColor: 'gray',
                    prefix: 'fa'
                  }})
                }}).bindPopup(popup).addTo(overlayGroups[type]);
              }} else {{
                L.circleMarker([lat, lon], {{
                  radius: 4,
                  color: color,
                  fillColor: color,
                  fillOpacity: 0.85,
                  weight: 1
                }}).bindPopup(popup).addTo(overlayGroups[type]);
              }}
            }});

            linesData.forEach((line) => {{
              const type = line.type || 'Unknown Line';
              // Requested line overlays
              if (!(type === 'GNSS to DR' || type === 'DR to VPM')) return;
              if (!overlayGroups[type]) overlayGroups[type] = L.featureGroup();

              const start = line.start || [];
              const end = line.end || [];
              if (start.length < 2 || end.length < 2) return;

              let color = '#64748b';
              let weight = 2;
              if (type === 'GNSS to DR') {{
                color = '#f59e0b';
                weight = 2;
              }} else if (type === 'DR to VPM') {{
                color = '#9ca3af';
                weight = 1;
              }}

              const popup = `TYPE: ${{type}}<br>ID: ${{line.id ?? '-'}}<br>TS: ${{line.timestamp_str ?? '-'}}`;
              L.polyline([start, end], {{
                color,
                weight,
                opacity: 0.85
              }}).bindPopup(popup).addTo(overlayGroups[type]);
            }});

            Object.keys(overlayGroups).forEach((type) => {{
              overlayGroups[type].addTo(map);
            }});

            L.control.layers(baseLayers, overlayGroups, {{ collapsed: true }}).addTo(map);

            const all = L.featureGroup(Object.values(overlayGroups));
            if (all.getLayers().length > 0) map.fitBounds(all.getBounds().pad(0.1));
          </script>
        </body>
        </html>
        """
    )


def write_simple_export_html(
    markers_data: list[dict],
    lines_data: list[dict],
    result_name: str,
    issue_id: str | None = None,
    out_dir: str | None = None,
) -> str:
    out_dir = out_dir or PATHS.project_root
    os.makedirs(out_dir, exist_ok=True)

    final_issue = issue_id or detect_issue_id(result_name) or "NOISSUE"
    safe_issue = _safe_part(final_issue)
    filename = f"result_{safe_issue}.html"
    out_path = os.path.join(out_dir, filename)

    html = render_simple_export_html(markers_data, lines_data, _safe_part(result_name or "log"))
    with open(out_path, "w", encoding="utf-8") as file:
        file.write(html)
    return out_path
