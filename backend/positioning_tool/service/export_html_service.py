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
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.css">
          <script src="https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.js"></script>
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
            .layer-bulk-btns {{
              background: #fff;
              padding: 4px;
              display: flex;
              gap: 4px;
              border-radius: 6px;
            }}
            .layer-bulk-btns button {{
              font-size: 11px;
              padding: 2px 8px;
              cursor: pointer;
              border: 1px solid #cbd5e1;
              border-radius: 4px;
              background: #f8fafc;
            }}
            .layer-bulk-btns button:hover {{ background: #e2e8f0; }}
            #timebar {{
              position: fixed;
              left: 16px;
              right: 16px;
              bottom: 12px;
              z-index: 1000;
              background: rgba(15, 23, 42, 0.85);
              border-radius: 10px;
              padding: 12px 18px 8px;
              color: #e2e8f0;
            }}
            #timeslider {{ margin: 2px 6px 8px; height: 8px; }}
            #timeslider .noUi-connect {{ background: #38bdf8; }}
            #rangeLabel {{ font-size: 11px; text-align: center; display: block; }}
            .time-fine-controls {{ margin-top: 8px; display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }}
            .time-fine-row {{ display: flex; align-items: center; gap: 4px; }}
            .time-fine-name {{ font-size: 11px; font-weight: 600; }}
            .time-fine-btn {{
              font-size: 10px; padding: 2px 5px; cursor: pointer;
              border: 1px solid #475569; border-radius: 4px; background: #1e293b; color: #e2e8f0;
            }}
            .time-fine-btn:hover {{ background: #334155; }}
            .time-fine-input {{
              width: 110px; font-size: 11px; padding: 2px 6px; text-align: center;
              border: 1px solid #475569; border-radius: 4px; background: #0f172a; color: #e2e8f0;
            }}
            .time-fine-input-error {{ border-color: #ef4444; }}
          </style>
        </head>
        <body>
          <div id="map"></div>
          <div id="timebar" style="display:none;">
            <div id="timeslider"></div>
            <span id="rangeLabel"></span>
            <div class="time-fine-controls">
              <div class="time-fine-row">
                <span class="time-fine-name">시작</span>
                <button type="button" class="time-fine-btn" data-handle="0" data-delta="-1000">-1s</button>
                <button type="button" class="time-fine-btn" data-handle="0" data-delta="-100">-0.1s</button>
                <input id="timeStartInput" class="time-fine-input" placeholder="HH:MM:SS.mmm">
                <button type="button" class="time-fine-btn" data-handle="0" data-delta="100">+0.1s</button>
                <button type="button" class="time-fine-btn" data-handle="0" data-delta="1000">+1s</button>
              </div>
              <div class="time-fine-row">
                <span class="time-fine-name">끝</span>
                <button type="button" class="time-fine-btn" data-handle="1" data-delta="-1000">-1s</button>
                <button type="button" class="time-fine-btn" data-handle="1" data-delta="-100">-0.1s</button>
                <input id="timeEndInput" class="time-fine-input" placeholder="HH:MM:SS.mmm">
                <button type="button" class="time-fine-btn" data-handle="1" data-delta="100">+0.1s</button>
                <button type="button" class="time-fine-btn" data-handle="1" data-delta="1000">+1s</button>
              </div>
            </div>
          </div>
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
            const highlightedFilteredGnssIds = new Set();

            function collectHighlightedFilteredGnssIds(coords) {{
              let awaitingFirstNormalFilteredGnss = false;
              for (const coord of Array.isArray(coords) ? coords : []) {{
                if (!coord || coord.type !== 'Filtered GNSS') continue;
                const transition = coord.extra?.gnss_mode_transition;
                const gnssMode = String(coord.extra?.gnss_mode || '').trim();

                if (transition?.from === 'BusSleep' && transition?.to === 'Normal') {{
                  awaitingFirstNormalFilteredGnss = true;
                }}

                if (awaitingFirstNormalFilteredGnss && gnssMode === 'Normal') {{
                  const highlightKey = Number.isFinite(coord.id)
                    ? `id:${{coord.id}}`
                    : `ts:${{coord.timestamp_ms ?? ''}}:${{coord.latitude ?? ''}}:${{coord.longitude ?? ''}}`;
                  highlightedFilteredGnssIds.add(highlightKey);
                  awaitingFirstNormalFilteredGnss = false;
                }}
              }}
            }}
            collectHighlightedFilteredGnssIds(markersData);

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
              if (coordtype === 'Filtered GNSS') {{
                const gnssMode = coord.extra?.gnss_mode;
                if (gnssMode) {{
                  text += `<br>GNSS mode: ${{gnssMode}}`;
                }}
                const transition = coord.extra?.gnss_mode_transition;
                if (transition?.from && transition?.to) {{
                  text += `<br>Mode transition: ${{transition.from}} -> ${{transition.to}}`;
                }}
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

            // Every rendered layer with its group and timestamp for time filtering
            const timeEntries = [];

            markersData.forEach((coord) => {{
              const type = coord.type || 'Unknown';
              if (!overlayGroups[type]) overlayGroups[type] = L.featureGroup();
              const lat = Number(coord.latitude), lon = Number(coord.longitude);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

              const color = coord.color || '#334155';
              const popup = makePopupText(coord);
              let layer;

              if (type === 'Request') {{
                layer = L.marker([lat, lon], {{
                  icon: L.AwesomeMarkers.icon({{
                    icon: 'info-circle',
                    markerColor: 'gray',
                    prefix: 'fa'
                  }})
                }});
              }} else {{
                const highlightKey = Number.isFinite(coord.id)
                  ? `id:${{coord.id}}`
                  : `ts:${{coord.timestamp_ms ?? ''}}:${{coord.latitude ?? ''}}:${{coord.longitude ?? ''}}`;
                const isTransitionHighlight = highlightedFilteredGnssIds.has(highlightKey);
                layer = L.circleMarker([lat, lon], {{
                  radius: isTransitionHighlight ? 7 : 4,
                  color: isTransitionHighlight ? '#22c55e' : color,
                  fillColor: isTransitionHighlight ? '#22c55e' : color,
                  fillOpacity: 0.85,
                  weight: isTransitionHighlight ? 3 : 1
                }});
              }}
              layer.bindPopup(popup).addTo(overlayGroups[type]);
              timeEntries.push({{ layer, group: overlayGroups[type], ts: Number(coord.timestamp_ms) }});
            }});

            linesData.forEach((line) => {{
              const type = line.type || 'Unknown Line';
              // Requested line overlays
              if (!(type === 'GNSS to DR' || type === 'DR to VPM' || type === 'DR Correction')) return;
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
              }} else if (type === 'DR Correction') {{
                color = 'orange';
                weight = 3;
              }}

              let popup = `TYPE: ${{type}}<br>ID: ${{line.id ?? '-'}}<br>TS: ${{line.timestamp_str ?? '-'}}`;
              if (type === 'DR Correction' && line.extra?.reason) {{
                popup += `<br>reason: ${{line.extra.reason}}`;
              }}
              const layer = L.polyline([start, end], {{
                color,
                weight,
                opacity: 0.85
              }}).bindPopup(popup).addTo(overlayGroups[type]);
              timeEntries.push({{ layer, group: overlayGroups[type], ts: Number(line.timestamp_ms) }});
            }});

            Object.keys(overlayGroups).forEach((type) => {{
              overlayGroups[type].addTo(map);
            }});

            L.control.layers(baseLayers, overlayGroups, {{ collapsed: true }}).addTo(map);

            // Select-all / clear-all buttons for the overlay layers
            const BulkLayerControl = L.Control.extend({{
              options: {{ position: 'topright' }},
              onAdd: function () {{
                const div = L.DomUtil.create('div', 'layer-bulk-btns');
                const addBtn = (label, fn) => {{
                  const btn = L.DomUtil.create('button', '', div);
                  btn.type = 'button';
                  btn.textContent = label;
                  L.DomEvent.on(btn, 'click', (e) => {{
                    L.DomEvent.stop(e);
                    fn();
                  }});
                }};
                addBtn('전체선택', () => {{
                  Object.values(overlayGroups).forEach((group) => map.addLayer(group));
                }});
                addBtn('전체해제', () => {{
                  Object.values(overlayGroups).forEach((group) => map.removeLayer(group));
                }});
                L.DomEvent.disableClickPropagation(div);
                return div;
              }}
            }});
            map.addControl(new BulkLayerControl());

            const all = L.featureGroup(Object.values(overlayGroups));
            if (all.getLayers().length > 0) map.fitBounds(all.getBounds().pad(0.1));

            // ---- Timestamp range slider -----------------------------------
            (function initTimeSlider() {{
              if (!window.noUiSlider) return;
              let minTs = Infinity, maxTs = -Infinity;
              timeEntries.forEach((entry) => {{
                if (Number.isFinite(entry.ts)) {{
                  if (entry.ts < minTs) minTs = entry.ts;
                  if (entry.ts > maxTs) maxTs = entry.ts;
                }}
              }});
              if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return;
              if (maxTs <= minTs) maxTs = minTs + 1;

              const bar = document.getElementById('timebar');
              const sliderEl = document.getElementById('timeslider');
              const label = document.getElementById('rangeLabel');
              bar.style.display = 'block';

              const fmt = (ms) => {{
                const d = new Date(ms);
                const pad = (n, w = 2) => String(n).padStart(w, '0');
                return `${{d.getFullYear()}}/${{pad(d.getMonth() + 1)}}/${{pad(d.getDate())}} ` +
                  `${{pad(d.getHours())}}:${{pad(d.getMinutes())}}:${{pad(d.getSeconds())}}.${{pad(d.getMilliseconds(), 3)}}`;
              }};

              noUiSlider.create(sliderEl, {{
                start: [minTs, maxTs],
                connect: true,
                range: {{ min: minTs, max: maxTs }},
                step: 1,
                keyboardSupport: true,
                keyboardDefaultStep: 100
              }});

              // Fine controls: ±nudge buttons and direct time entry
              const setHandle = (handleIndex, valueMs) => {{
                sliderEl.noUiSlider.set(handleIndex === 0 ? [valueMs, null] : [null, valueMs]);
              }};
              document.querySelectorAll('.time-fine-btn').forEach((btn) => {{
                btn.addEventListener('click', () => {{
                  const handleIndex = Number(btn.dataset.handle);
                  const values = sliderEl.noUiSlider.get().map(Number);
                  setHandle(handleIndex, values[handleIndex] + Number(btn.dataset.delta));
                }});
              }});
              const parseTimeInput = (text, referenceMs) => {{
                const trimmed = String(text || '').trim();
                let m = trimmed.match(/^(\\d{{4}})\\/(\\d{{1,2}})\\/(\\d{{1,2}})[ T](\\d{{1,2}}):(\\d{{2}}):(\\d{{2}})(?:\\.(\\d{{1,3}}))?$/);
                if (m) {{
                  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6],
                    +String(m[7] || '0').padEnd(3, '0')).getTime();
                }}
                m = trimmed.match(/^(\\d{{1,2}}):(\\d{{2}}):(\\d{{2}})(?:\\.(\\d{{1,3}}))?$/);
                if (m && Number.isFinite(referenceMs)) {{
                  const d = new Date(referenceMs);
                  d.setHours(+m[1], +m[2], +m[3], +String(m[4] || '0').padEnd(3, '0'));
                  return d.getTime();
                }}
                return NaN;
              }};
              [['timeStartInput', 0], ['timeEndInput', 1]].forEach(([inputId, handleIndex]) => {{
                const input = document.getElementById(inputId);
                input.addEventListener('keydown', (e) => {{
                  if (e.key !== 'Enter') return;
                  const values = sliderEl.noUiSlider.get().map(Number);
                  const parsed = parseTimeInput(input.value, values[handleIndex]);
                  if (!Number.isFinite(parsed)) {{
                    input.classList.add('time-fine-input-error');
                    setTimeout(() => input.classList.remove('time-fine-input-error'), 800);
                    return;
                  }}
                  setHandle(handleIndex, parsed);
                  input.blur();
                }});
              }});

              let pendingRange = null;
              const applyTimeFilter = (lo, hi) => {{
                timeEntries.forEach((entry) => {{
                  const show = !Number.isFinite(entry.ts) || (entry.ts >= lo && entry.ts <= hi);
                  const attached = entry.group.hasLayer(entry.layer);
                  if (show && !attached) entry.group.addLayer(entry.layer);
                  else if (!show && attached) entry.group.removeLayer(entry.layer);
                }});
              }};

              // rAF stalls in hidden tabs — fall back to setTimeout there
              const scheduleFrame = (fn) => {{
                if (document.hidden) setTimeout(fn, 0);
                else requestAnimationFrame(fn);
              }};

              const timeOnly = (ms) => {{
                const d = new Date(ms);
                const pad = (n, w = 2) => String(n).padStart(w, '0');
                return `${{pad(d.getHours())}}:${{pad(d.getMinutes())}}:${{pad(d.getSeconds())}}.${{pad(d.getMilliseconds(), 3)}}`;
              }};

              sliderEl.noUiSlider.on('update', (values) => {{
                const lo = Number(values[0]);
                const hi = Number(values[1]);
                label.textContent = `${{fmt(lo)}} ~ ${{fmt(hi)}}`;
                const startInput = document.getElementById('timeStartInput');
                const endInput = document.getElementById('timeEndInput');
                if (startInput && document.activeElement !== startInput) startInput.value = timeOnly(lo);
                if (endInput && document.activeElement !== endInput) endInput.value = timeOnly(hi);
                const shouldSchedule = pendingRange === null;
                pendingRange = [lo, hi];
                if (shouldSchedule) {{
                  scheduleFrame(() => {{
                    const range = pendingRange;
                    pendingRange = null;
                    applyTimeFilter(range[0], range[1]);
                  }});
                }}
              }});
            }})();
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
