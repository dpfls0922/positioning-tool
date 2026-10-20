"""동적 레벨링 탭 페이지.

메인 지도 앱과 달리 독립 문서다(맵 JS 파트들은 전역 스코프를 공유해서
부분 재사용이 불가능하다 — paths.py 주석 참고). Leaflet 만 CDN 으로 얹고
업로드 → /api/dynlevel/parse → 게이트별 레이어 렌더까지 이 파일 하나로 닫는다.
"""


def render_dynlevel_page() -> str:
    return _PAGE_HTML


_PAGE_HTML = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>동적 레벨링 — positioning map</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  /* 본 툴(map.css)의 변수·탭·레이어 행 모양을 그대로 따른다. */
  :root {
    --panel-blue: #2a2d33;
    --panel-blue-dark: #1f2228;
    --surface: #23262b;
    --surface-soft: #1f2228;
    --border: #3a3f46;
    --text: #e6e8eb;
    --muted: #a3a9b3;
    --accent: #86b4f0;
    --accent-strong: #2f6ded;
  }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden;
               font-family: "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif; }
  #container { display: flex; width: 100vw; height: 100vh; background: #e5e7eb; }
  #sidebar { width: 360px; min-width: 360px; display: flex; flex-direction: column;
             background: var(--surface); color: var(--text);
             border-right: 1px solid var(--border); overflow-y: auto; }
  #sidebar-header { background: linear-gradient(120deg, var(--panel-blue), var(--panel-blue-dark));
                    color: #fff; display: flex; align-items: center; padding: 14px 14px; }
  #sidebar-brand { font-weight: 700; letter-spacing: 0.2px; font-size: 14px; }
  .app-tabs { display: flex; flex: 0 0 auto; gap: 0; padding: 0 12px;
              background: var(--surface); border-bottom: 1px solid var(--border); }
  .app-tab { padding: 9px 0 7px; margin-right: 18px; border-bottom: 2px solid transparent;
             color: var(--muted); font-size: 12px; font-weight: 600;
             text-decoration: none; white-space: nowrap; }
  .app-tab:hover { color: var(--text); }
  .app-tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .section { padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .section h3 { margin: 0 0 8px; font-size: 11px; color: var(--muted); font-weight: 700;
                letter-spacing: .04em; text-transform: uppercase; }
  #uploadBtn { width: 100%; padding: 8px 0; border: 0; border-radius: 6px;
               background: var(--accent-strong); color: #fff;
               font-size: 12.5px; font-weight: 600; cursor: pointer; }
  #uploadBtn:hover { filter: brightness(1.08); }
  #uploadBtn:disabled { background: var(--border); cursor: default; }
  #uploadStatus { margin-top: 8px; font-size: 12px; color: var(--muted); word-break: break-all; }
  .layer-row { display: flex; align-items: center; gap: 8px; padding: 4px 2px;
               font-size: 12.5px; cursor: pointer; border-radius: 4px; }
  .layer-row:hover { background: var(--surface-soft); }
  .layer-row input { margin: 0; width: 13px; height: 13px; accent-color: var(--accent); }
  .layer-row.master { border-bottom: 1px solid var(--border); padding-bottom: 7px;
                      margin-bottom: 5px; font-weight: 600; }
  .swatch { width: 8px; height: 8px; border-radius: 999px; display: inline-block;
            box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2); }
  .stat-grid { display: grid; grid-template-columns: auto auto; gap: 3px 10px; font-size: 12.5px; }
  .stat-grid b { color: var(--text); font-weight: 600; text-align: right; }
  #windowList { max-height: 200px; overflow-y: auto; }
  .win-row { padding: 6px 8px; margin: 3px 0; background: var(--surface-soft);
             border: 1px solid var(--border); border-radius: 6px; font-size: 12px;
             cursor: pointer; line-height: 1.5; }
  .win-row:hover { border-color: var(--accent); }
  .muted { color: var(--muted); }
  #map { flex: 1; }
  .leaflet-popup-content { font-size: 12px; line-height: 1.55; }
  /* 튜닝 입력 */
  .tune-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .tune-row input[type=number] { width: 64px; padding: 4px 6px; border-radius: 5px;
      border: 1px solid var(--border); background: var(--surface-soft); color: var(--text); }
  .tune-row button { padding: 5px 12px; border: 0; border-radius: 5px; cursor: pointer;
      background: var(--accent-strong); color: #fff; font-size: 12px; font-weight: 600; }
  .tune-row button:disabled { background: var(--border); }
  /* 타임라인 슬라이더 */
  .time-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin: 4px 0; }
  .time-row input[type=range] { flex: 1; accent-color: var(--accent); }
  .time-row .tlabel { width: 58px; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="container">
  <div id="sidebar">
    <div id="sidebar-header"><span id="sidebar-brand">positioning map</span></div>
    <nav class="app-tabs">
      <a class="app-tab" href="/">포지셔닝</a>
      <a class="app-tab" href="/sdi">SDI 검색</a>
      <a class="app-tab active" href="/dynlevel">동적 레벨링</a>
    </nav>

    <div class="section">
      <h3>DLT 업로드</h3>
      <input id="fileInput" type="file" accept=".dlt,.log,.txt" style="display:none">
      <button id="uploadBtn">DLT 파일 선택 · 분석</button>
      <div id="uploadStatus">[SENSOR]/[DRE]/[DR] 로그가 담긴 DLT 를 올리면
        주행 중 게이트 판정과 동적 레벨링 추정을 지도에 그립니다.</div>
    </div>

    <div class="section">
      <h3>튜닝</h3>
      <div class="tune-row">
        <span>발동 유지 시간</span>
        <input id="holdSeconds" type="number" min="0" max="60" step="0.5" value="3.0">
        <span>초</span>
        <button id="retuneBtn" disabled>재계산</button>
      </div>
      <div class="muted" style="font-size:11.5px; margin-top:6px">
        게이트 4개가 이 시간 이상 연속 유지돼야 발동. 서버에 보관된 마지막
        파일로 재계산하므로 재업로드가 필요 없습니다.
      </div>
    </div>

    <div class="section">
      <h3>타임라인 필터</h3>
      <div class="time-row"><span class="tlabel" id="timeFromLabel">--:--:--</span>
        <input id="timeFrom" type="range" min="0" max="1000" value="0"></div>
      <div class="time-row"><span class="tlabel" id="timeToLabel">--:--:--</span>
        <input id="timeTo" type="range" min="0" max="1000" value="1000"></div>
    </div>

    <div class="section">
      <h3>레이어 (게이트별)</h3>
      <div id="layerRows"></div>
    </div>

    <div class="section">
      <h3>요약</h3>
      <div id="statsBox" class="stat-grid muted">아직 분석 전</div>
    </div>

    <div class="section">
      <h3>발동(valid) 윈도우 — 클릭하면 이동</h3>
      <div id="windowList" class="muted">아직 분석 전</div>
    </div>

    <div class="section muted" style="font-size:11.5px; line-height:1.6">
      모든 신호는 상시 LPF(τ=1s, VectorLowPassFilter 방식) 통과.
      게이트: 주행 v&gt;3m/s · 등속 |dv/dt|&lt;0.3m/s²(WheelCircumference 차속 미분) ·
      직진 |ω_z|&lt;1°/s · 동역학 보상 후 ||a|-g|&lt;1.0m/s².
      직진 B(StraightnessDetector)는 비교용 — 발동 판정에는 직진 A만 사용.
      발동 시 사용값은 순시값이 아니라 게이트 진입 후 누적 평균(정차 leveling과 동일 방식).
    </div>
  </div>
  <div id="map"></div>
</div>

<script>
'use strict';

const map = L.map('map', { preferCanvas: true }).setView([37.5665, 126.9780], 13);
const baseLayers = {
  'Tmap': L.tileLayer('http://tlpimg1.tmap.co.kr/tms/1.0.0/hd_tile/{z}/{x}/{-y}.png',
                      { maxZoom: 19, attribution: 'Tmap' }),
  'Google Maps': L.tileLayer('http://mt0.google.com/vt/lyrs=m&hl=ko&x={x}&y={y}&z={z}',
                             { maxZoom: 21, attribution: 'Google' }),
  'Google Hybrid': L.tileLayer('http://mt0.google.com/vt/lyrs=y&hl=ko&x={x}&y={y}&z={z}',
                               { maxZoom: 21, attribution: 'Google' }),
  'OSM': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                     { maxZoom: 19, attribution: 'OSM' }),
};
baseLayers['Tmap'].addTo(map);
L.control.layers(baseLayers, null, { collapsed: true }).addTo(map);

/* 게이트 레이어 — 전부 채워진 원. 반경을 층층이 줄여 겹쳐 그리면(큰 원이
   아래) 한 점에서 어떤 게이트까지 만족하는지 동심원 색 띠로 읽힌다. */
const LAYERS = [
  { key: 'base',        label: '전체 DR 궤적',              color: '#9aa0a6', radius: 2 },
  { key: 'const_speed', label: '등속 (|dv/dt|<0.3)',        color: '#4a6cf7', radius: 7 },
  { key: 'straight',    label: '직진 A — 자이로 (|ω_z|<1°/s)', color: '#f7a04a', radius: 5.5 },
  { key: 'straight_sd', label: '직진 B — StraightnessDetector (5m heading<3°)', color: '#ffd60a', radius: 4.2 },
  { key: 'norm_ok',     label: '중력 크기 OK (보상 후 |a|≈g)', color: '#b04af7', radius: 3 },
  { key: 'valid',       label: '모두 만족 + 유지 → 발동',      color: '#19b955', radius: 1.8 },
];
/* 이벤트 레이어 — 게이트 원과 같은 채운 원 스타일, 크기만 한 단계 위. */
const EVENT_LAYERS = [
  { key: 'stationary_resets', label: '정차 Reset (실제 SetRollPitch 이벤트)', color: '#e845d0', radius: 8 },
  { key: 'activations',       label: '동적 레벨링 발동 시점 (오프라인 재현)',  color: '#0a8f3c', radius: 8 },
];
const ALL_LAYERS = LAYERS.concat(EVENT_LAYERS);
const groups = {};
ALL_LAYERS.forEach(l => { groups[l.key] = L.layerGroup().addTo(map); });
const layerChecks = {};
let lastRes = null;
let firstDraw = true;

function renderLayerRows() {
  const box = document.getElementById('layerRows');
  box.innerHTML = '';

  // 마스터 체크박스 — 전체 켜기/끄기
  const master = document.createElement('label');
  master.className = 'layer-row master';
  const mcb = document.createElement('input');
  mcb.type = 'checkbox';
  mcb.checked = true;
  mcb.onchange = () => {
    ALL_LAYERS.forEach(l => {
      layerChecks[l.key].checked = mcb.checked;
      if (mcb.checked) map.addLayer(groups[l.key]); else map.removeLayer(groups[l.key]);
    });
  };
  const mtxt = document.createElement('span');
  mtxt.textContent = '전체 켜기 / 끄기';
  master.append(mcb, mtxt);
  box.appendChild(master);

  ALL_LAYERS.forEach(l => {
    const row = document.createElement('label');
    row.className = 'layer-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.onchange = () => {
      if (cb.checked) map.addLayer(groups[l.key]); else map.removeLayer(groups[l.key]);
      mcb.checked = ALL_LAYERS.every(x => layerChecks[x.key].checked);
    };
    layerChecks[l.key] = cb;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = l.color;
    const txt = document.createElement('span');
    txt.textContent = l.label;
    row.append(cb, sw, txt);
    box.appendChild(row);
  });
}
renderLayerRows();

function fmtTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function popupHtml(p) {
  const yn = v => v ? '<b style="color:#19b955">O</b>' : '<span style="color:#c33">X</span>';
  return '<b>' + fmtTime(p.t_ms) + '</b><br>' +
    'v=' + p.v + ' m/s (WheelCircumference 로그) · dv/dt=' + p.vdot + ' m/s²<br>' +
    'ω_z=' + p.gyro_z + '°/s ([DRE] Input)<br>' +
    '순시 추정(LPF): roll=' + p.roll_dyn + '° pitch=' + p.pitch_dyn + '°<br>' +
    (p.roll_win !== undefined
      ? '<b>발동 시 사용값(구간 누적 평균): roll=' + p.roll_win + '° pitch=' + p.pitch_win + '°</b><br>'
      : '') +
    (p.dr_roll !== undefined ? 'DR 자세(비교): roll=' + p.dr_roll + '° pitch=' + p.dr_pitch + '°<br>' : '') +
    '등속 ' + yn(p.const_speed) +
    ' · 직진A(자이로) ' + yn(p.straight) +
    ' · 직진B(SD) ' + yn(p.straight_sd) +
    ' · 중력 ' + yn(p.norm_ok) +
    ' · 발동 ' + yn(p.valid);
}

/* ── 타임라인 필터 ─────────────────────────────────────── */
const timeFrom = document.getElementById('timeFrom');
const timeTo = document.getElementById('timeTo');
let timeMin = 0, timeMax = 1;

function sliderToMs(v) { return timeMin + (timeMax - timeMin) * (v / 1000); }

function currentRange() {
  let a = sliderToMs(+timeFrom.value), b = sliderToMs(+timeTo.value);
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

function updateTimeLabels() {
  const [a, b] = currentRange();
  document.getElementById('timeFromLabel').textContent = fmtTime(a);
  document.getElementById('timeToLabel').textContent = fmtTime(b);
}

function initTimeSlider(points) {
  timeMin = points[0].t_ms;
  timeMax = points[points.length - 1].t_ms;
  timeFrom.value = 0;
  timeTo.value = 1000;
  updateTimeLabels();
}

let redrawTimer = null;
function onTimeChange() {
  updateTimeLabels();
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => redraw(false), 120);
}
timeFrom.oninput = onTimeChange;
timeTo.oninput = onTimeChange;

/* ── 렌더 ─────────────────────────────────────────────── */
function drawPoints(points, fit) {
  LAYERS.forEach(l => groups[l.key].clearLayers());
  /* 레이어 단위로 순서대로 그린다(큰 원 레이어가 아래) — 점 단위로 섞어 그리면
     이웃 점의 큰 원이 앞 점의 작은 원을 덮어 동심원 띠가 깨진다. */
  LAYERS.forEach(l => {
    points.forEach(p => {
      if (l.key !== 'base' && !p[l.key]) return;
      L.circleMarker([p.lat, p.lon], {
        radius: l.radius, stroke: false, fill: true,
        fillColor: l.color, fillOpacity: 1,
      }).bindPopup(popupHtml(p)).addTo(groups[l.key]);
    });
  });
  if (fit && points.length)
    map.fitBounds(points.map(p => [p.lat, p.lon]), { padding: [30, 30], animate: false });
}

function drawEvents(res, rangeMs) {
  EVENT_LAYERS.forEach(l => groups[l.key].clearLayers());
  const inRange = ev => ev.lat !== undefined &&
    ev.t_ms >= rangeMs[0] && ev.t_ms <= rangeMs[1];

  const style = l => ({ radius: l.radius, stroke: false, fill: true,
                        fillColor: l.color, fillOpacity: 1 });

  const resetLayer = EVENT_LAYERS[0], actLayer = EVENT_LAYERS[1];
  (res.stationary_resets || []).filter(inRange).forEach(ev => {
    L.circleMarker([ev.lat, ev.lon], style(resetLayer)).bindPopup(
      '<b>정차 Reset — SetRollPitchFromAccelerometer</b><br>' +
      fmtTime(ev.t_ms) + '<br>' +
      'roll: ' + ev.before_roll + '° → <b>' + ev.after_roll + '°</b><br>' +
      'pitch: ' + ev.before_pitch + '° → <b>' + ev.after_pitch + '°</b><br>' +
      'heading: ' + ev.heading + '°'
    ).addTo(groups.stationary_resets);
  });
  (res.activations || []).filter(inRange).forEach(ev => {
    L.circleMarker([ev.lat, ev.lon], style(actLayer)).bindPopup(
      '<b>동적 레벨링 발동 (오프라인 재현)</b><br>' +
      fmtTime(ev.t_ms) + ' — 게이트 ' + ev.hold_seconds + 's 유지 후<br>' +
      '초기화 값(구간 누적 평균):<br>' +
      'roll=<b>' + ev.roll_init + '°</b> pitch=<b>' + ev.pitch_init + '°</b>'
    ).addTo(groups.activations);
  });
}

function redraw(fit) {
  if (!lastRes) return;
  const [a, b] = currentRange();
  const pts = lastRes.points.filter(p => p.t_ms >= a && p.t_ms <= b);
  drawPoints(pts, fit);
  drawEvents(lastRes, [a, b]);
}

function renderStats(stats) {
  const box = document.getElementById('statsBox');
  box.classList.remove('muted');
  box.innerHTML =
    '<span>주행 시간</span><b>' + stats.moving_seconds + ' s</b>' +
    '<span>발동 가능 시간</span><b>' + stats.valid_seconds + ' s</b>' +
    '<span>주행 대비 커버리지</span><b>' + (stats.valid_ratio_of_moving * 100).toFixed(0) + ' %</b>' +
    '<span>발동 윈도우</span><b>' + stats.window_count + ' 개</b>' +
    '<span>유지 시간 설정</span><b>' + stats.hold_seconds_used + ' s</b>' +
    '<span>센서 레이트</span><b>' + stats.sample_rate_hz + ' Hz</b>';
}

function renderWindows(windows, points) {
  const box = document.getElementById('windowList');
  box.classList.remove('muted');
  box.innerHTML = windows.length ? '' : '발동 윈도우 없음';
  windows.forEach(w => {
    const row = document.createElement('div');
    row.className = 'win-row';
    row.innerHTML = '<b>' + fmtTime(w.start_ms) + '</b> ~ <b>' + fmtTime(w.end_ms) + '</b>'
      + ' (' + w.duration_s + 's)<br><span class="muted">roll ' + w.roll_mean
      + '° · pitch ' + w.pitch_mean + '°</span>';
    row.onclick = () => {
      const pts = points.filter(p => p.t_ms >= w.start_ms && p.t_ms <= w.end_ms);
      if (pts.length) map.fitBounds(pts.map(p => [p.lat, p.lon]), { padding: [60, 60], maxZoom: 17 });
    };
    box.appendChild(row);
  });
}

function applyResult(res, fileName) {
  lastRes = res;
  res.stats.hold_seconds_used = res.thresholds.valid_hold_seconds;
  statusBox.textContent = (fileName ? fileName + ' — ' : '') + '포인트 '
    + res.points.length + '개, ' + res.elapsed_ms + 'ms';
  if (res.points.length) initTimeSlider(res.points);
  redraw(firstDraw);
  firstDraw = false;
  renderStats(res.stats);
  renderWindows(res.windows, res.points);
  document.getElementById('retuneBtn').disabled = false;
}

/* ── 업로드 / 재계산 ──────────────────────────────────── */
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const statusBox = document.getElementById('uploadStatus');
const retuneBtn = document.getElementById('retuneBtn');
let lastFileName = '';

uploadBtn.onclick = () => fileInput.click();
fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;
  uploadBtn.disabled = true;
  statusBox.textContent = file.name + ' 업로드 중…';

  const fd = new FormData();
  fd.append('file', file);
  fd.append('hold_seconds', document.getElementById('holdSeconds').value);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/dynlevel/parse');
  xhr.upload.onprogress = e => {
    if (e.lengthComputable)
      statusBox.textContent = file.name + ' 업로드 ' + Math.round(e.loaded / e.total * 100) + '%';
  };
  xhr.onload = () => {
    uploadBtn.disabled = false;
    let res;
    try { res = JSON.parse(xhr.responseText); }
    catch (err) { statusBox.textContent = '응답 파싱 실패 (' + xhr.status + ')'; return; }
    if (!res.ok) { statusBox.textContent = '분석 실패: ' + (res.error || xhr.status); return; }
    lastFileName = file.name;
    firstDraw = true;
    applyResult(res, file.name);
  };
  xhr.onerror = () => { uploadBtn.disabled = false; statusBox.textContent = '업로드 실패'; };
  xhr.send(fd);
  fileInput.value = '';
};

retuneBtn.onclick = () => {
  retuneBtn.disabled = true;
  statusBox.textContent = '재계산 중…';
  fetch('/api/dynlevel/retune?hold_seconds='
        + encodeURIComponent(document.getElementById('holdSeconds').value), { method: 'POST' })
    .then(r => r.json())
    .then(res => {
      if (!res.ok) { statusBox.textContent = '재계산 실패: ' + (res.error || ''); retuneBtn.disabled = false; return; }
      applyResult(res, lastFileName);
    })
    .catch(() => { statusBox.textContent = '재계산 실패'; retuneBtn.disabled = false; });
};
</script>
</body>
</html>
"""
