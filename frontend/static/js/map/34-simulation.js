// ===== 모의주행 시뮬레이션 ===================================================== //
//
// Replays the drive as the navigation would have shown it: the car avatar
// (CAVATAR3D, the real asset) moves along the VPM track pointing along its
// heading, the map follows, and the 구간단속 HUD and guidance card fire at the
// moments they actually fired in the log.
//
// VPM is the positioning output the device finally used, and every sample
// carries heading and speed, so it is the track. Playback is driven by the
// samples' own timestamps rather than a fixed step, which is what makes the
// motion match the recorded speed.

const SIM_AVATAR_ICON = '/static/img/hud/cavatar.png';
// Navigation grows the avatar as you zoom in; a fixed size looks like a speck at
// z18 and swamps the road at z13. Height in px, keyed by zoom.
const SIM_AVATAR_HEIGHT_BY_ZOOM = [
    [13, 22], [15, 30], [16, 38], [17, 46], [18, 54], [19, 64]
];

function simAvatarHeight() {
    const zoom = map.getZoom();
    let height = SIM_AVATAR_HEIGHT_BY_ZOOM[0][1];
    SIM_AVATAR_HEIGHT_BY_ZOOM.forEach(([z, h]) => { if (zoom >= z) height = h; });
    return height;
}
const SIM_SPEEDS = [0.5, 1, 2, 3, 5, 10, 20];
// A guide point counts as "coming up" within this distance ahead.
const SIM_GUIDE_LOOKAHEAD_M = 120;
// Navigation announces a camera well before a passing hazard, so the ranges
// differ by kind rather than sharing one number.
const SIM_SDI_LOOKAHEAD_M = 600;
const SIM_EVENT_LOOKAHEAD_M = 400;
// A reroute is a moment, not a place: it shows as a toast for this long.
const SIM_REROUTE_TOAST_MS = 4000;

let simTrack = [];
let simGuidePoints = [];
let simSdiPoints = [];
let simEventPoints = [];
let simReroutes = [];
let simRouteEpochs = [];
let simRouteLayerNames = [];
let simRouteHiddenFor = null;
let simRouteSavedActive = null;
let simParkingSpans = [];
let simShadeTimeline = [];
let simAutoSkipStops = false;
let simFeedbackPoints = [];
let simTrackCumM = [];
// 정차로 볼 속도 상한과, 그보다 오래 멈춰야 '정차'로 취급할 시간
const SIM_STOP_SPEED_KMH = 2;
const SIM_STOP_MIN_MS = 4000;
let simFiredRerouteIds = new Set();
let simRerouteToast = null;
let simRerouteToastUntil = 0;
let simRunning = false;
let simSpeed = 1;
let simTimeMs = 0;
let simRafId = null;
let simLastFrameAt = 0;
let simAvatarMarker = null;
let simFollow = true;
let simShownGuideId = null;

function simMetresBetween(a, b) {
    const dLat = (b.lat - a.lat) * 111320;
    const dLon = (b.lon - a.lon) * 111320 * Math.cos(a.lat * DEG2RAD);
    return Math.hypot(dLat, dLon);
}

function buildSimTrack() {
    const rows = (markersData || [])
        .filter((m) => m.type === 'VPM' && Number.isFinite(m.timestamp_ms))
        .map((m) => ({
            lat: m.latitude,
            lon: m.longitude,
            heading: Number.isFinite(m.heading) ? m.heading : 0,
            speed: Number(m.extra?.Speed) || 0,
            t: m.timestamp_ms
        }))
        .sort((a, b) => a.t - b.t);
    simTrack = rows;

    simGuidePoints = (markersData || [])
        .filter((m) => m.extra?.gp_guide)
        .map((m) => ({
            id: m.id, lat: m.latitude, lon: m.longitude,
            turnCode: m.extra.turn_code,
            gpType: Number(m.extra.gp_type) || 0,
            voiceCode: m.extra.voice_code,
        }));

    simSdiPoints = (markersData || [])
        .filter((m) => m.extra?.sdi_event)
        .map((m) => ({
            id: m.id, lat: m.latitude, lon: m.longitude,
            type: m.extra.sdi_type, name: m.extra.sdi_type_name,
            speed: m.extra.speed, selected: m.extra.ever_selected !== false
        }));

    simEventPoints = (markersData || [])
        .filter((m) => m.extra?.guide_event)
        .map((m) => ({
            id: m.id, lat: m.latitude, lon: m.longitude,
            kind: m.extra.event_type,
            typeCode: m.extra.event_type_code,
            name: m.extra.name || ''
        }));

    // 경로 재탐색: each Request marker is one, with its reason in group_2_text.
    simReroutes = (markersData || [])
        .filter((m) => m.type === 'Request' && Number.isFinite(m.timestamp_ms))
        .map((m) => ({
            id: m.id, t: m.timestamp_ms,
            reason: m.extra?.group_2_text || '재탐색',
            requestId: m.extra?.group_1,
            sessionId: m.extra?.route_session_id
        }))
        .sort((a, b) => a.t - b.t);

    // 주차장 구간(DR 의 parking_state)과 맵매칭 피드백 시점.
    const dr = (markersData || [])
        .filter((m) => m.type === 'DR-based' && Number.isFinite(m.timestamp_ms))
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    simParkingSpans = [];
    dr.forEach((m) => {
        const inLot = m.extra?.parking_state === 'ParkingLot';
        const last = simParkingSpans[simParkingSpans.length - 1];
        if (inLot && last && m.timestamp_ms - last.end < 15000) last.end = m.timestamp_ms;
        else if (inLot) simParkingSpans.push({ start: m.timestamp_ms, end: m.timestamp_ms });
    });
    simFeedbackPoints = dr
        .filter((m) => m.extra?.mm_feedback)
        .map((m) => ({ t: m.timestamp_ms, reason: m.extra.mm_feedback_reason || '' }));

    simFiredRerouteIds = new Set();
    // 남은거리 표시용 누적 거리 (m). rows[i] 까지 달린 거리.
    simTrackCumM = new Array(rows.length).fill(0);
    for (let i = 1; i < rows.length; i++) {
        simTrackCumM[i] = simTrackCumM[i - 1] + simMetresBetween(rows[i - 1], rows[i]);
    }
    buildSimLanePoints();
    // 마커는 레이어가 다시 그려질 수 있으니 재생 시점에 다시 수집한다.
    simMarkerTargets = [];

    // Which route layer is live at a given moment. Each Request starts a session,
    // so the active one is the newest request at or before that time; replaying a
    // reroute should swap the drawn route rather than pile another on top.
    simRouteLayerNames = [...new Set((linesData || [])
        .filter((l) => l?.type === 'Route Info')
        .map((l) => getRouteInfoLayerName(l)))];
    const sessionByName = routeLayerNameBySessionId();
    simRouteEpochs = simReroutes
        .map((r) => ({ t: r.t, layer: sessionByName.get(r.sessionId) || null }))
        .filter((e) => e.layer);

    return rows.length;
}

// Shortest-arc heading interpolation; a naive lerp spins the avatar the wrong
// way across the 0/360 boundary.
function simLerpHeading(a, b, ratio) {
    let delta = ((b - a + 540) % 360) - 180;
    return (a + delta * ratio + 360) % 360;
}

function simStateAt(timeMs) {
    if (simTrack.length === 0) return null;
    if (timeMs <= simTrack[0].t) return { ...simTrack[0], index: 0 };
    const last = simTrack[simTrack.length - 1];
    if (timeMs >= last.t) return { ...last, index: simTrack.length - 1 };

    let lo = 0;
    let hi = simTrack.length - 1;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (simTrack[mid].t <= timeMs) lo = mid; else hi = mid;
    }
    const a = simTrack[lo];
    const b = simTrack[hi];
    const span = b.t - a.t;
    const ratio = span > 0 ? (timeMs - a.t) / span : 0;
    return {
        lat: a.lat + (b.lat - a.lat) * ratio,
        lon: a.lon + (b.lon - a.lon) * ratio,
        heading: simLerpHeading(a.heading, b.heading, ratio),
        speed: a.speed + (b.speed - a.speed) * ratio,
        t: timeMs,
        index: lo
    };
}

function simAvatarIcon(heading) {
    const h = simAvatarHeight();
    const w = Math.round(h * 47 / 72);   // asset aspect ratio
    const box = Math.ceil(Math.hypot(w, h));   // room for the rotated image
    return L.divIcon({
        className: '',
        iconSize: [box, box],
        iconAnchor: [box / 2, box / 2],
        html: `<div style="width:${box}px;height:${box}px;display:flex;align-items:center;justify-content:center;
                 transform:rotate(${heading}deg);transform-origin:center">
                 <img src="${SIM_AVATAR_ICON}" width="${w}" height="${h}"
                      style="display:block;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))" alt=""></div>`
    });
}

function simEnsureAvatar() {
    if (!simAvatarMarker) {
        simAvatarMarker = L.marker([0, 0], { icon: simAvatarIcon(0), zIndexOffset: 2000, interactive: false });
    }
    if (!map.hasLayer(simAvatarMarker)) simAvatarMarker.addTo(map);
    return simAvatarMarker;
}

// Opens the guidance card for the nearest guide point ahead, and only when it
// changes — reopening every frame would make the card flicker.
function simUpdateGuideCard(state) {
    let best = null;
    let bestDist = Infinity;
    simGuidePoints.forEach((gp) => {
        const d = simMetresBetween({ lat: state.lat, lon: state.lon }, gp);
        if (d < bestDist) { bestDist = d; best = gp; }
    });
    if (best && bestDist <= SIM_GUIDE_LOOKAHEAD_M) {
        if (simShownGuideId !== best.id) {
            simShownGuideId = best.id;
            openGpGuidanceCard(best.id);
        }
    } else if (simShownGuideId !== null) {
        simShownGuideId = null;
        closeGpGuidanceCard();
    }
}

// Only things ahead are announced. Bearing to the point is compared against the
// current heading; anything more than 90 degrees off has already been passed.
function simIsAhead(state, point) {
    const dLat = point.lat - state.lat;
    const dLon = (point.lon - state.lon) * Math.cos(state.lat * DEG2RAD);
    if (dLat === 0 && dLon === 0) return true;
    const bearing = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    let diff = Math.abs(((bearing - state.heading + 540) % 360) - 180);
    return diff <= 90;
}

function simNearestAhead(state, points, maxDist) {
    let best = null;
    let bestDist = Infinity;
    points.forEach((p) => {
        const d = simMetresBetween({ lat: state.lat, lon: state.lon }, p);
        if (d > maxDist || d >= bestDist) return;
        if (!simIsAhead(state, p)) return;
        best = p;
        bestDist = d;
    });
    return best ? { point: best, dist: bestDist } : null;
}

function simFormatDistance(metres) {
    return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres / 10) * 10}m`;
}

function simEnsureAlertBox() {
    let el = document.getElementById('simAlerts');
    if (!el) {
        el = document.createElement('div');
        el.id = 'simAlerts';
        el.className = 'sim-alerts';
        naviStack().appendChild(el);
    }
    return el;
}

// The SDI / C2X strip, drawn with the same real icons the map markers use so the
// simulation and the map read as one thing.
function setSimShadeTimeline(timeline) {
    simShadeTimeline = Array.isArray(timeline) ? timeline : [];
}

// 터널/지하차도 샘플은 GPS 주기마다 찍히므로, 최근 몇 초 안에 샘플이 있으면 그
// 구간에 있는 것으로 본다(구간을 벗어나면 로그가 끊긴다).
const SIM_SHADE_MAX_AGE_MS = 4000;

function simCurrentShade(timeMs) {
    if (simShadeTimeline.length === 0) return null;
    let lo = 0;
    let hi = simShadeTimeline.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (simShadeTimeline[mid].timestamp_ms <= timeMs) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (found < 0) return null;
    const sample = simShadeTimeline[found];
    return (timeMs - sample.timestamp_ms) <= SIM_SHADE_MAX_AGE_MS ? sample : null;
}

function simInParkingLot(timeMs) {
    return simParkingSpans.some((sp) => timeMs >= sp.start && timeMs <= sp.end);
}

// Feedback that landed within a couple of seconds of now, so the chip appears at
// the moment the correction happened rather than lingering.
function simRecentFeedback(timeMs) {
    for (let i = simFeedbackPoints.length - 1; i >= 0; i -= 1) {
        const f = simFeedbackPoints[i];
        if (f.t <= timeMs && timeMs - f.t <= 2500) return f;
        if (f.t < timeMs - 2500) break;
    }
    return null;
}

// Start of the stop the car is currently in, or null when moving. Used for both
// the 정차 chip and the skip button.
function simCurrentStop(timeMs) {
    const idx = simTrack.findIndex((p) => p.t >= timeMs);
    if (idx < 0) return null;
    if (simTrack[idx].speed > SIM_STOP_SPEED_KMH) return null;
    let start = idx;
    while (start > 0 && simTrack[start - 1].speed <= SIM_STOP_SPEED_KMH) start -= 1;
    let end = idx;
    while (end < simTrack.length - 1 && simTrack[end + 1].speed <= SIM_STOP_SPEED_KMH) end += 1;
    const span = simTrack[end].t - simTrack[start].t;
    if (span < SIM_STOP_MIN_MS) return null;
    return { start: simTrack[start].t, end: simTrack[end].t, resumeAt: simTrack[Math.min(end + 1, simTrack.length - 1)].t };
}

function simSetAutoSkip(on) {
    simAutoSkipStops = !!on;
    simSyncButtons();
    // 이미 정차 안에 있으면 켜는 즉시 넘어가야 한다.
    if (simAutoSkipStops) simSkipStop();
}

function simSkipStop() {
    const stop = simCurrentStop(simTimeMs);
    if (!stop) return;
    simTimeMs = stop.resumeAt;
    simApply(simStateAt(simTimeMs));
}

// 지도를 클릭해 그 지점에서 가장 가까운 VPM 샘플로 이동한다. 진행바로 시간을
// 맞추는 것보다 '이 지점부터 보고 싶다'는 의도에 바로 대응한다.
let simPickMode = false;

function simSetPickMode(on) {
    simPickMode = !!on;
    const el = document.getElementById('map');
    if (el) el.style.cursor = simPickMode ? 'crosshair' : '';
    simSyncButtons();
}

function simSeekToLatLng(latlng) {
    if (simTrack.length === 0) return;
    let best = null;
    let bestDist = Infinity;
    simTrack.forEach((p) => {
        const d = simMetresBetween({ lat: latlng.lat, lon: latlng.lng }, p);
        if (d < bestDist) { bestDist = d; best = p; }
    });
    if (!best) return;
    simSeekTo(best.t);
    simSetPickMode(false);
}

function simSeekTo(timeMs) {
    if (simTrack.length === 0) return;
    const lo = simTrack[0].t;
    const hi = simTrack[simTrack.length - 1].t;
    simTimeMs = Math.min(Math.max(timeMs, lo), hi);
    simApply(simStateAt(simTimeMs));
}

// 구간단속 구간은 주행 중 잠깐이라 슬라이더로 찾기 어렵다 — 바로 보내준다.
function simSeekToBlockSection() {
    if (!sdiBlockTimeline.length) return;
    simSeekTo(sdiBlockTimeline[0].timestamp_ms + 1000);
}

function simRenderAlerts(state) {
    const el = simEnsureAlertBox();
    const rows = [];

    // 주차장 안에서는 실제 내비도 안내를 멈춘다. 지오메트리상 600m 안에 있다는
    // 이유로 지상 도로의 과속방지턱·스쿨존이 뜨는 것을 막는다.
    if (simInParkingLot(state.t)) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }

    const sdi = simNearestAhead(state, simSdiPoints, SIM_SDI_LOOKAHEAD_M);
    if (sdi) {
        const asset = SDI_ICON_ASSET[Number(sdi.point.type)];
        const icon = asset
            ? `<img src="${SDI_ICON_DIR}${asset}.png" width="26" height="26" alt="">`
            : buildSdiSignHtml(sdi.point.type, sdi.point.speed, 26);
        rows.push(`<div class="sim-alert${sdi.point.selected ? '' : ' muted'}">
            <div class="sim-alert-icon">${icon}</div>
            <div class="sim-alert-text">
                <div class="sim-alert-name">${escapeHtml(sdi.point.name || 'SDI')}</div>
                ${sdi.point.speed ? `<div class="sim-alert-sub">제한 ${sdi.point.speed} km/h</div>` : ''}
            </div>
            <div class="sim-alert-dist">${simFormatDistance(sdi.dist)}</div>
        </div>`);
    }

    const event = simNearestAhead(state, simEventPoints, SIM_EVENT_LOOKAHEAD_M);
    if (event) {
        const asset = C2X_EVENT_ASSET[Number(event.point.typeCode)];
        const icon = asset
            ? `<img src="${C2X_ICON_DIR}${encodeURIComponent(asset.file)}" width="24" height="24" alt="">`
            : `<img src="${MFS_ICON_DIR}${mfsIconFile(event.point.name)}" width="24" height="24" alt="">`;
        const label = asset ? asset.label : (event.point.name || event.point.kind);
        rows.push(`<div class="sim-alert">
            <div class="sim-alert-icon">${icon}</div>
            <div class="sim-alert-text">
                <div class="sim-alert-name">${escapeHtml(label)}</div>
                <div class="sim-alert-sub">${escapeHtml(event.point.kind)}</div>
            </div>
            <div class="sim-alert-dist">${simFormatDistance(event.dist)}</div>
        </div>`);
    }

    el.innerHTML = rows.join('');
    el.classList.toggle('hidden', rows.length === 0);
}


// A reroute has a time but no place, so it flashes as a toast when playback
// crosses it. Ids already fired are remembered so scrubbing back does not
// re-trigger a burst of them.
function simRenderReroute(state) {
    const toast = document.getElementById('simRerouteToast') || (() => {
        const el = document.createElement('div');
        el.id = 'simRerouteToast';
        el.className = 'sim-reroute-toast hidden';
        naviStack().appendChild(el);
        return el;
    })();

    const due = simReroutes.find((r) => !simFiredRerouteIds.has(r.id)
        && r.t <= state.t && (state.t - r.t) < 2000);
    if (due) {
        simFiredRerouteIds.add(due.id);
        toast.innerHTML = `<i class="fa fa-refresh"></i>`
            + `<span>경로 재탐색 · <b>${escapeHtml(due.reason)}</b></span>`
            + `<span class="sim-reroute-id">${escapeHtml(String(due.requestId ?? ''))}</span>`;
        toast.classList.remove('hidden');
        simRerouteToastUntil = state.t + SIM_REROUTE_TOAST_MS;
    } else if (state.t > simRerouteToastUntil) {
        toast.classList.add('hidden');
    }
}

// ===== 주행 중 마커 노출 (실차 내비 방식) ==================================
// 실제 내비는 경로 위의 모든 안내지점을 처음부터 다 띄우지 않는다. 다가오면
// 나타나서 커지고, 지나가면 흐려져 사라진다. 모의주행 중에는 같은 규칙으로
// 지도 마커를 제어하고, 정지하면 원래대로 되돌린다.
//   idle   : 아직 멀다 — 거의 안 보임
//   live   : 안내 구간에 들어옴 — 제 색으로 보임
//   focus  : 지금 다가가는 가장 가까운 것 — 링 강조
//   passed : 막 지나갔다 — 흐려지며 빠짐
const SIM_MARKER_REVEAL_M = 400;    // 이 거리 안으로 들어오면 나타난다
const SIM_MARKER_FOCUS_M = 150;     // 이 거리 안이면 강조
const SIM_MARKER_PASSED_M = 120;    // 지나친 뒤 이 거리까지는 '지나감'으로 남긴다
const SIM_MARKER_TICK_MS = 180;     // 프레임마다 DOM 을 만지지 않도록 간격을 둔다

// 제어 대상 레이어 — 경로별 하위 레이어( 'base ▸ Route Info N' )도 함께 잡는다.
const SIM_MARKER_LAYER_BASES = [
    GP_CROSS_IMAGE_LAYER,
    GP_TURN_ONLY_LAYER,
    GP_LANE_COLOR_LAYER,
    GP_LANE_BUBBLE_LAYER,
    'SDI Events',
    'C2X Events',
    'Tmap Incidents (MFS)',
];

let simMarkerTargets = [];
let simMarkerTick = 0;
let simMarkerStyled = false;

function simIsControlledLayerName(name) {
    if (typeof name !== 'string') return false;
    const owner = routeChildLayerOwner(name);
    const base = owner ? name.slice(0, name.length - owner.length - ROUTE_CHILD_SEPARATOR.length) : name;
    return SIM_MARKER_LAYER_BASES.includes(base);
}

function simCollectMarkerTargets() {
    simMarkerTargets = [];
    Object.entries(featureGroups || {}).forEach(([name, group]) => {
        if (!simIsControlledLayerName(name) || typeof group.eachLayer !== 'function') return;
        group.eachLayer((layer) => {
            if (typeof layer.getLatLng !== 'function') return;
            const ll = layer.getLatLng();
            if (!ll) return;
            simMarkerTargets.push({ layer, lat: ll.lat, lon: ll.lng, state: null });
        });
    });
    return simMarkerTargets.length;
}

const SIM_MARKER_CLASSES = ['sim-marker-idle', 'sim-marker-live', 'sim-marker-focus', 'sim-marker-passed'];

function simSetMarkerState(target, next) {
    if (target.state === next) return;
    const el = typeof target.layer.getElement === 'function' ? target.layer.getElement() : null;
    if (!el) { target.state = null; return; }   // 화면에 없으면 다음 틱에 다시 시도
    el.classList.remove(...SIM_MARKER_CLASSES);
    if (next) el.classList.add(`sim-marker-${next}`);
    target.state = next;
}

function simUpdateMarkerReveal(state, force = false) {
    const now = performance.now();
    if (!force && now - simMarkerTick < SIM_MARKER_TICK_MS) return;
    simMarkerTick = now;

    if (simMarkerTargets.length === 0) simCollectMarkerTargets();
    simMarkerStyled = true;

    // 가장 가까운 '전방' 마커 하나만 focus 로 올린다.
    let focusTarget = null;
    let focusDist = Infinity;
    const here = { lat: state.lat, lon: state.lon };

    simMarkerTargets.forEach((target) => {
        target._dist = simMetresBetween(here, target);
        target._ahead = simIsAhead(state, target);
        if (target._ahead && target._dist <= SIM_MARKER_FOCUS_M && target._dist < focusDist) {
            focusDist = target._dist;
            focusTarget = target;
        }
    });

    simMarkerTargets.forEach((target) => {
        let next;
        if (target === focusTarget) next = 'focus';
        else if (target._ahead && target._dist <= SIM_MARKER_REVEAL_M) next = 'live';
        else if (!target._ahead && target._dist <= SIM_MARKER_PASSED_M) next = 'passed';
        else next = 'idle';
        simSetMarkerState(target, next);
    });
}

function simClearMarkerReveal() {
    if (!simMarkerStyled) return;
    simMarkerTargets.forEach((target) => simSetMarkerState(target, null));
    simMarkerTargets = [];
    simMarkerStyled = false;
}


// ===== 차로 안내 (Benz MBUX / BMW 방식의 하단 lane assistant) ================
// 로그에서 복원 가능한 것만 쓴다: nVoiceCode 가 지시하는 차로 배치와 색, nTurnCode.
// 실차 UI 처럼 화면 하단 가운데에 차로 띠를 놓고, 다가오는 동안 거리 바를 채운다.
const SIM_LANE_LOOKAHEAD_M = 350;
let simLanePoints = [];

function buildSimLanePoints() {
    simLanePoints = (markersData || [])
        .filter((m) => m.extra?.lane_bubble && gpLaneLayoutFromVoiceCode(m.extra?.voice_code))
        .map((m) => ({
            id: m.id,
            lat: m.latitude,
            lon: m.longitude,
            extra: m.extra,
        }));
    return simLanePoints.length;
}

function simEnsureLaneAssist() {
    let el = document.getElementById('simLaneAssist');
    if (!el) {
        el = document.createElement('div');
        el.id = 'simLaneAssist';
        el.className = 'sim-lane-assist hidden';
        // 지도 위에 얹되 heading-up 회전과 무관하게 화면 하단에 고정한다.
        (document.getElementById('main-content') || document.body).appendChild(el);
    }
    return el;
}

function simRenderLaneAssist(state) {
    const el = simEnsureLaneAssist();

    // 주차장 안에서는 실차도 차로 안내를 하지 않는다.
    if (simInParkingLot(state.t)) {
        el.classList.add('hidden');
        return;
    }

    const found = simNearestAhead(state, simLanePoints, SIM_LANE_LOOKAHEAD_M);
    if (!found) {
        el.classList.add('hidden');
        return;
    }

    const extra = found.point.extra || {};
    const layout = gpLaneLayoutFromVoiceCode(extra.voice_code);
    if (!layout) {
        el.classList.add('hidden');
        return;
    }

    const colorInfo = GP_LANE_COLORS[Number(extra.lane_color)] || GP_LANE_COLORS[0];
    const glyph = GP_TURN_GLYPHS[Number(extra.turn_code)] || '↑';

    const cells = [];
    if (layout.anchor === 'left') cells.push('<div class="sim-lane-cell unknown">·</div>');
    for (let i = 0; i < layout.total; i++) {
        const lit = layout.lit.includes(i);
        cells.push(
            `<div class="sim-lane-cell${lit ? ' lit' : ''}"`
            + (lit ? ` style="--lane-accent:${colorInfo.hex}"` : '')
            + `>${lit ? glyph : '↑'}</div>`
        );
    }
    if (layout.anchor === 'right') cells.push('<div class="sim-lane-cell unknown">·</div>');

    // 남은 거리를 바로 채운다 (가까워질수록 100%) — BMW 의 접근 표시와 같은 감각.
    const progress = Math.max(0, Math.min(1, 1 - (found.dist / SIM_LANE_LOOKAHEAD_M)));

    el.innerHTML =
        `<div class="sim-lane-head">`
        + `<span class="sim-lane-title">차로 안내</span>`
        + `<span class="sim-lane-dist">${simFormatDistance(found.dist)}</span>`
        + `</div>`
        + `<div class="sim-lane-strip">${cells.join('')}</div>`
        + `<div class="sim-lane-progress"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>`
        + `<div class="sim-lane-sub">${escapeHtml(gpTurnCodeName(extra.voice_code) || '')}`
        + (extra.has_cross_image ? ` <span class="sim-lane-badge">교차로</span>` : '')
        + `</div>`;
    el.classList.remove('hidden');
}

function simApply(state) {
    if (!state) return;
    simLastHeading = state.heading;
    simEnsureAvatar()
        .setLatLng([state.lat, state.lon])
        .setIcon(simAvatarIcon(state.heading));
    if (simFollow) simFollowTo(state);
    refreshSdiBlockHud(state.t);
    simUpdateGuideCard(state);
    simRenderAlerts(state);
    simRenderLaneAssist(state);
    simUpdateMarkerReveal(state);
    simRenderReroute(state);
    simApplyActiveRoute(state);
    simRenderStatus(state);
}

// Panning every frame fires Leaflet's moveend 60 times a second, and moveend is
// wired to the marker culling (100k+ markers) and the road viewport query — that
// storm is what made the map judder. The camera instead holds still until the
// avatar drifts out of a dead zone near the centre, which is also how a
// navigation map behaves.
// 카메라 추적. 예전에는 40px 데드존을 벗어날 때마다 0.8초 ease-out 팬을 한 번씩
// 걸었는데, 그러면 '멈춤 → 훅 따라붙음 → 멈춤' 이 반복돼 눈에 확 띄게 끊긴다.
// 대신 팬 지속시간보다 짧은 간격으로 '선형' 팬을 계속 이어 붙인다. 이징이 없으니
// 앞 팬이 끝나는 순간 다음 팬이 같은 속도로 받아 등속으로 흐르고, moveend 는
// 초당 4회 정도만 발생해 마커 컬링/도로 조회를 몰아치지 않는다.
const SIM_FOLLOW_TICK_MS = 240;        // 다음 팬을 거는 간격
const SIM_FOLLOW_DURATION_S = 0.30;    // 팬 지속 — 간격보다 길게 잡아 사이가 비지 않게
const SIM_FOLLOW_SNAP_PX = 260;        // 스크럽/점프로 이만큼 벌어지면 애니메이션 없이 붙인다

let simFollowLastPanAt = 0;

function simFollowTo(state) {
    const target = map.latLngToContainerPoint([state.lat, state.lon]);
    const centre = map.latLngToContainerPoint(map.getCenter());
    const gap = target.distanceTo(centre);

    // 타임라인을 끌어 옮긴 직후처럼 크게 벌어진 경우는 애니메이션이 의미가 없다.
    if (gap > SIM_FOLLOW_SNAP_PX) {
        map.setView([state.lat, state.lon], map.getZoom(), { animate: false });
        simFollowLastPanAt = performance.now();
        return;
    }

    // 이미 중심에 거의 붙어 있으면(정차 등) 굳이 팬을 걸지 않는다 — 1px 떨림 방지.
    if (gap < 2) return;

    const now = performance.now();
    if (now - simFollowLastPanAt < SIM_FOLLOW_TICK_MS) return;
    simFollowLastPanAt = now;

    map.panTo([state.lat, state.lon], {
        animate: true,
        duration: SIM_FOLLOW_DURATION_S,
        easeLinearity: 1        // 선형 — 팬을 이어 붙였을 때 등속으로 보이게 한다
    });
}

// Shows only the route that was live at this moment. The layers people had
// toggled on are remembered so stopping the simulation puts the map back.
function simApplyActiveRoute(state) {
    if (simRouteLayerNames.length === 0) return;
    let active = null;
    simRouteEpochs.forEach((e) => { if (e.t <= state.t) active = e.layer; });
    if (active === simRouteHiddenFor) return;

    if (simRouteSavedActive === null) {
        simRouteSavedActive = simRouteLayerNames.filter((n) => activeGroups.has(n));
    }
    simRouteHiddenFor = active;
    simRouteLayerNames.forEach((name) => {
        const group = featureGroups[name];
        if (!group) return;
        const show = name === active;
        if (show && !map.hasLayer(group)) { map.addLayer(group); activeGroups.add(name); }
        if (!show && map.hasLayer(group)) { map.removeLayer(group); activeGroups.delete(name); }
    });
    renderLayerControls();
}

function simRestoreRoutes() {
    if (simRouteSavedActive === null) return;
    simRouteLayerNames.forEach((name) => {
        const group = featureGroups[name];
        if (!group) return;
        const show = simRouteSavedActive.includes(name);
        if (show && !map.hasLayer(group)) { map.addLayer(group); activeGroups.add(name); }
        if (!show && map.hasLayer(group)) { map.removeLayer(group); activeGroups.delete(name); }
    });
    simRouteSavedActive = null;
    simRouteHiddenFor = null;
    renderLayerControls();
}

function simRenderStatus(state) {
    const el = document.getElementById('simStatus');
    if (!el || !state) return;
    const total = simTrack[simTrack.length - 1].t - simTrack[0].t;
    const done = state.t - simTrack[0].t;
    el.querySelector('[data-role="clock"]').textContent = new Date(state.t)
        .toTimeString().slice(0, 8);
    el.querySelector('[data-role="speed"]').textContent = `${Math.round(state.speed)} km/h`;
    const bar = el.querySelector('[data-role="bar"]');
    if (bar) bar.style.width = `${total > 0 ? (done / total) * 100 : 0}%`;

    simRenderStateStrip(state);
}

let simStateStripKey = null;

function simEnsureStateStrip() {
    let el = document.getElementById('simStateStrip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'simStateStrip';
        el.className = 'sim-state-strip hidden';
        // 클릭 대상이 다시 만들어져도 살아남도록 컨테이너에 위임한다.
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="skip-stop"]')) simSkipStop();
        });
        // 안내 스택과 분리된 고정 슬롯에 둔다 — 위쪽 안내가 늘거나 줄어도
        // 상태 카드의 위치가 흔들리지 않는다.
        (document.getElementById('main-content') || document.body).appendChild(el);
    }
    return el;
}

// 정차 / 주차장 / 맵매칭 피드백 상태를 안내 UI 와 같은 자리에 표시한다.
//
// 어떤 상태가 떠 있는지(구조)가 바뀔 때만 DOM 을 다시 만들고, 남은 초처럼 매
// 프레임 변하는 값은 텍스트만 갈아 끼운다. 초가 바뀔 때마다 innerHTML 을 다시
// 쓰면 '건너뛰기' 버튼이 mousedown 과 mouseup 사이에 파괴돼 클릭이 사라진다.
function simRenderStateStrip(state) {
    const el = simEnsureStateStrip();
    const stop = simCurrentStop(state.t);
    const inLot = simInParkingLot(state.t);
    const shade = simCurrentShade(state.t);
    const fb = simRecentFeedback(state.t);

    const key = [stop ? (simAutoSkipStops ? 'stopAuto' : 'stop') : '', inLot ? 'lot' : '',
        shade ? 'shade' + shade.facil : '', fb ? 'fb' : ''].join('|');
    if (key !== simStateStripKey) {
        simStateStripKey = key;
        // 네 상태 모두 같은 카드 구조(아이콘 · 제목/부제 · 우측 값 또는 버튼)를
        // 쓰고, 좌측 색 띠만 상태별로 다르다.
        const card = (cls, icon, name, sub, right) => '<div class="sim-state ' + cls + '">'
            + '<div class="sim-state-icon"><i class="fa ' + icon + '"></i></div>'
            + '<div class="sim-state-text"><div class="sim-state-name">' + name + '</div>'
            + '<div class="sim-state-sub">' + sub + '</div></div>'
            + (right || '') + '</div>';

        const parts = [];
        if (stop) {
            parts.push(card('sim-state-stop', 'fa-pause', '정차 중',
                simAutoSkipStops
                    ? '자동 건너뛰기 켜짐'
                    : '남은 <span data-role="stop-left">-</span>초',
                simAutoSkipStops
                    ? ''
                    : '<button type="button" class="sim-state-btn" data-action="skip-stop">건너뛰기</button>'));
        }
        if (inLot) {
            parts.push(card('sim-state-lot', 'fa-building', '주차장 주행 중', '안내 없음'));
        }
        if (shade) {
            // 터널·지하차도는 GPS 음영 — DR 이 위치를 끌고 가는 구간이다.
            parts.push(card('sim-state-shade', 'fa-arrow-circle-right',
                escapeHtml(shade.facil_name) + ' 주행 중', 'GPS 음영 · DR 유지',
                '<div class="sim-state-value"><span data-role="shade-left">-</span></div>'));
        }
        if (fb) {
            parts.push(card('sim-state-fb', 'fa-magnet', '맵매칭 피드백',
                '<span data-role="fb-kind"></span>'));
        }
        el.innerHTML = parts.join('');
        el.classList.toggle('hidden', parts.length === 0);
    }

    if (stop && !simAutoSkipStops) {
        const left = el.querySelector('[data-role="stop-left"]');
        const secs = String(Math.max(0, Math.round((stop.end - state.t) / 1000)));
        if (left && left.textContent !== secs) left.textContent = secs;
    }
    if (shade) {
        const left = el.querySelector('[data-role="shade-left"]');
        const text = shade.length_to_end + 'm';
        if (left && left.textContent !== text) left.textContent = text;
    }
    if (fb) {
        const kindEl = el.querySelector('[data-role="fb-kind"]');
        const kind = /heading only/.test(fb.reason) ? 'heading 보정' : '위치 보정';
        if (kindEl && kindEl.textContent !== kind) {
            kindEl.textContent = kind;
            kindEl.title = fb.reason;
        }
    }
}

// requestAnimationFrame stops in a hidden tab, so the first frame after coming
// back reports the whole time away. Clamping keeps that from teleporting the
// avatar down the route; playback just resumes where it paused.
const SIM_MAX_FRAME_MS = 250;

function simFrame(now) {
    if (!simRunning) return;
    const rawDelta = simLastFrameAt ? (now - simLastFrameAt) : 0;
    const deltaMs = Math.min(Math.max(rawDelta, 0), SIM_MAX_FRAME_MS);
    simLastFrameAt = now;
    simTimeMs += deltaMs * simSpeed;

    // 자동 건너뛰기: 정차를 만나면 다음 주행 샘플로 시간을 밀어버린다. 재생 중에만
    // 동작하므로 진행바나 위치 선택으로 정차 구간을 직접 살펴보는 것은 그대로 된다.
    if (simAutoSkipStops) {
        const stop = simCurrentStop(simTimeMs);
        if (stop && stop.resumeAt > simTimeMs) simTimeMs = stop.resumeAt;
    }

    const end = simTrack[simTrack.length - 1].t;
    if (simTimeMs >= end) {
        simTimeMs = end;
        simApply(simStateAt(simTimeMs));
        simPause();
        return;
    }
    simApply(simStateAt(simTimeMs));
    simRafId = requestAnimationFrame(simFrame);
}

// Called whenever a parse result is rendered, so a newly loaded log replaces the
// track instead of replaying the previous one.
function resetSimulationForNewData() {
    simPause();
    simTrack = [];
    simGuidePoints = [];
    simSdiPoints = [];
    simEventPoints = [];
    simReroutes = [];
    simFiredRerouteIds = new Set();
    simShownGuideId = null;
    simTimeMs = 0;
    if (simAvatarMarker && map.hasLayer(simAvatarMarker)) map.removeLayer(simAvatarMarker);
    closeGpGuidanceCard();
    document.getElementById('simAlerts')?.classList.add('hidden');
    document.getElementById('simRerouteToast')?.classList.add('hidden');
    document.getElementById('simStateStrip')?.classList.add('hidden');
    document.getElementById('simLaneAssist')?.classList.add('hidden');
    simClearMarkerReveal();
    simLanePoints = [];
    simStateStripKey = null;
    simRestoreRoutes();
    simRouteEpochs = [];
    simRouteLayerNames = [];
    simSyncButtons();
}

function simPlay() {
    if (simTrack.length === 0 && buildSimTrack() === 0) return;
    if (simTimeMs < simTrack[0].t || simTimeMs >= simTrack[simTrack.length - 1].t) {
        simTimeMs = simTrack[0].t;
    }
    simRunning = true;
    simLastFrameAt = 0;
    simSyncButtons();
    simRafId = requestAnimationFrame(simFrame);
}

function simPause() {
    simRunning = false;
    if (simRafId) cancelAnimationFrame(simRafId);
    simRafId = null;
    simSyncButtons();
}

function simStop() {
    simPause();
    simTimeMs = simTrack.length ? simTrack[0].t : 0;
    if (simAvatarMarker && map.hasLayer(simAvatarMarker)) map.removeLayer(simAvatarMarker);
    closeGpGuidanceCard();
    simShownGuideId = null;
    refreshSdiBlockHud(NaN);
    document.getElementById('simAlerts')?.classList.add('hidden');
    document.getElementById('simRerouteToast')?.classList.add('hidden');
    document.getElementById('simLaneAssist')?.classList.add('hidden');
    simClearMarkerReveal();
    simFiredRerouteIds = new Set();
    simRestoreRoutes();
    simSyncButtons();
}

function simSetSpeed(multiplier) {
    simSpeed = SIM_SPEEDS.includes(multiplier) ? multiplier : 1;
    simSyncButtons();
}

function simSyncButtons() {
    const playBtn = document.getElementById('simPlayBtn');
    if (playBtn) {
        playBtn.innerHTML = simRunning ? '<i class="fa fa-pause"></i>' : '<i class="fa fa-play"></i>';
        playBtn.title = simRunning ? '일시정지' : '재생';
    }
    document.querySelectorAll('.sim-speed-btn').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.speed) === simSpeed);
    });
    const followBtn = document.getElementById('simFollowBtn');
    if (followBtn) followBtn.classList.toggle('active', simFollow);
    const pickBtn = document.getElementById('simPickBtn');
    if (pickBtn) pickBtn.classList.toggle('active', simPickMode);
    const autoBtn = document.getElementById('simAutoSkipBtn');
    if (autoBtn) autoBtn.classList.toggle('active', simAutoSkipStops);
}

let simLastHeading = 0;

// Panning during playback should win, the way dragging a navigation map drops it
// out of follow mode — but only for real gestures.
//
// 예전에는 '우리가 팬 중인가' 를 시간 플래그로 들고 있었는데, 카메라 추적이
// 등속으로 계속 팬을 이어 붙이게 바뀌면서 그 플래그가 사실상 항상 켜져 있어
// 재생 중 사용자가 끌어도 follow 가 풀리지 않게 된다. Leaflet 의 dragstart 는
// 프로그램 팬(panTo/setView)에서는 발생하지 않으므로, 실제 포인터가 눌려 있는지만
// 보면 사용자 제스처를 정확히 구분할 수 있다.
let simUserPointerActive = false;

function simBindMapGestures() {
    const container = map.getContainer();
    const pointerDown = () => { simUserPointerActive = true; };
    const pointerUp = () => { simUserPointerActive = false; };
    container.addEventListener('pointerdown', pointerDown, true);
    container.addEventListener('touchstart', pointerDown, { capture: true, passive: true });
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerUp, true);
    window.addEventListener('touchend', pointerUp, true);

    map.on('click', (e) => {
        if (simPickMode) simSeekToLatLng(e.latlng);
    });
    map.on('dragstart', () => {
        if (!simUserPointerActive) return;
        if (simFollow) {
            simFollow = false;
            simSyncButtons();
        }
    });
    // Re-render the avatar at the new size when the zoom changes.
    map.on('zoomend', () => {
        if (simAvatarMarker && map.hasLayer(simAvatarMarker)) {
            simAvatarMarker.setIcon(simAvatarIcon(simLastHeading));
        }
    });
}

function initSimulation() {
    simBindMapGestures();
    document.getElementById('simPlayBtn')?.addEventListener('click', () => {
        if (simRunning) simPause(); else simPlay();
    });
    document.getElementById('simStopBtn')?.addEventListener('click', simStop);
    document.getElementById('simFollowBtn')?.addEventListener('click', () => {
        simFollow = !simFollow;
        simSyncButtons();
    });
    document.querySelectorAll('.sim-speed-btn').forEach((btn) => {
        btn.addEventListener('click', () => simSetSpeed(Number(btn.dataset.speed)));
    });
    document.getElementById('simBlockSeekBtn')?.addEventListener('click', simSeekToBlockSection);
    document.getElementById('simPickBtn')?.addEventListener('click', () => simSetPickMode(!simPickMode));
    document.getElementById('simAutoSkipBtn')?.addEventListener('click', () => simSetAutoSkip(!simAutoSkipStops));

    // 진행바를 눌러/끌어서 원하는 지점으로 이동
    const track = document.getElementById('simProgress');
    if (track) {
        const seekFromEvent = (e) => {
            if (simTrack.length === 0) return;
            const rect = track.getBoundingClientRect();
            // 패널이 닫혀 있으면 폭이 0이라 비율이 NaN 이 된다.
            if (!(rect.width > 0)) return;
            const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
            const lo = simTrack[0].t;
            const hi = simTrack[simTrack.length - 1].t;
            simSeekTo(lo + (hi - lo) * ratio);
        };
        let dragging = false;
        track.addEventListener('pointerdown', (e) => {
            dragging = true;
            // Seek first: pointer capture is a convenience for dragging outside
            // the bar and must not be able to swallow the click itself.
            seekFromEvent(e);
            try { track.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }
        });
        track.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
        track.addEventListener('pointerup', (e) => {
            dragging = false;
            try {
                if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
            } catch (_) { /* 무시 */ }
        });
    }
    simSyncButtons();
}
