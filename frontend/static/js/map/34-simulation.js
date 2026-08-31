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
const SIM_SPEEDS = [1, 2, 3];
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
let simFeedbackPoints = [];
let simHeadingUp = false;
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
        .map((m) => ({ id: m.id, lat: m.latitude, lon: m.longitude }));

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
    const shown = simHeadingUp ? 0 : heading;
    const h = simAvatarHeight();
    const w = Math.round(h * 47 / 72);   // asset aspect ratio
    const box = Math.ceil(Math.hypot(w, h));   // room for the rotated image
    return L.divIcon({
        className: '',
        iconSize: [box, box],
        iconAnchor: [box / 2, box / 2],
        html: `<div style="width:${box}px;height:${box}px;display:flex;align-items:center;justify-content:center;
                 transform:rotate(${shown}deg);transform-origin:center">
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

function simSkipStop() {
    const stop = simCurrentStop(simTimeMs);
    if (!stop) return;
    simTimeMs = stop.resumeAt;
    simApply(simStateAt(simTimeMs));
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
        el.innerHTML = `<div class="sim-alert muted">
            <div class="sim-alert-icon"><i class="fa fa-product-hunt"></i></div>
            <div class="sim-alert-text"><div class="sim-alert-name">주차장 주행 중</div>
            <div class="sim-alert-sub">안내 없음</div></div></div>`;
        el.classList.remove('hidden');
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
    simRenderReroute(state);
    simApplyActiveRoute(state);
    simApplyHeadingUp(state);
    simRenderStatus(state);
}

// Panning every frame fires Leaflet's moveend 60 times a second, and moveend is
// wired to the marker culling (100k+ markers) and the road viewport query — that
// storm is what made the map judder. The camera instead holds still until the
// avatar drifts out of a dead zone near the centre, which is also how a
// navigation map behaves.
const SIM_FOLLOW_DEADZONE_PX = 70;
const SIM_FOLLOW_MIN_INTERVAL_MS = 120;

let simLastPanAt = 0;

function simFollowTo(state) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - simLastPanAt < SIM_FOLLOW_MIN_INTERVAL_MS) return;

    const target = map.latLngToContainerPoint([state.lat, state.lon]);
    const centre = map.latLngToContainerPoint(map.getCenter());
    if (target.distanceTo(centre) < SIM_FOLLOW_DEADZONE_PX) return;

    simLastPanAt = now;
    simSelfPanning = true;
    // 애니메이션 없이 옮기면 데드존을 벗어날 때마다 화면이 툭툭 끊긴다.
    // 짧게 이징을 주면 moveend 는 팬 1회당 한 번만 나면서 움직임은 부드럽다.
    map.panTo([state.lat, state.lon], { animate: true, duration: 0.45, easeLinearity: 0.4 });
    setTimeout(() => { simSelfPanning = false; }, 500);
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

    // 정차 / 주차장 / 맵매칭 피드백은 지도 위가 아니라 여기 한 줄에 모은다.
    const chips = document.getElementById('simChips');
    if (!chips) return;
    const parts = [];
    const stop = simCurrentStop(state.t);
    if (stop) {
        const left = Math.max(0, Math.round((stop.end - state.t) / 1000));
        parts.push(`<button type="button" class="sim-chip sim-chip-stop" data-action="skip-stop">`
            + `<i class="fa fa-pause-circle"></i> 정차 ${left}s · 건너뛰기</button>`);
    }
    if (simInParkingLot(state.t)) {
        parts.push('<span class="sim-chip sim-chip-lot">주차장</span>');
    }
    const fb = simRecentFeedback(state.t);
    if (fb) {
        const kind = /heading only/.test(fb.reason) ? 'heading 보정' : '위치 보정';
        parts.push(`<span class="sim-chip sim-chip-fb" title="${escapeHtml(fb.reason)}">`
            + `<i class="fa fa-magnet"></i> MM 피드백 · ${kind}</span>`);
    }
    chips.innerHTML = parts.join('');
    chips.classList.toggle('hidden', parts.length === 0);
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
    simFiredRerouteIds = new Set();
    simRestoreRoutes();
    simSyncButtons();
}

function simSetSpeed(multiplier) {
    simSpeed = SIM_SPEEDS.includes(multiplier) ? multiplier : 1;
    simSyncButtons();
}

// Leaflet has no rotation, so the map element itself is rotated and scaled up so
// its corners still cover the viewport. The UI overlays live outside #map, and
// the avatar is drawn unrotated because the map now carries the heading.
function simApplyHeadingUp(state) {
    const el = document.getElementById('map');
    if (!el) return;
    if (!simHeadingUp) {
        el.style.transform = '';
        el.classList.remove('map-heading-up');
        return;
    }
    el.classList.add('map-heading-up');
    el.style.transform = `scale(1.5) rotate(${-(state ? state.heading : 0)}deg)`;
}

function simToggleHeadingUp() {
    simHeadingUp = !simHeadingUp;
    simApplyHeadingUp(simTrack.length ? simStateAt(simTimeMs) : null);
    if (simAvatarMarker && map.hasLayer(simAvatarMarker)) {
        simAvatarMarker.setIcon(simAvatarIcon(simLastHeading));
    }
    simSyncButtons();
    map.invalidateSize();
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
    const rotBtn = document.getElementById('simHeadingUpBtn');
    if (rotBtn) rotBtn.classList.toggle('active', simHeadingUp);
}

let simLastHeading = 0;

// Panning during playback should win, the way dragging a navigation map drops it
// out of follow mode. Only user gestures count — the follow panTo must not
// switch itself off, so it is flagged while it runs.
let simSelfPanning = false;

function simBindMapGestures() {
    map.on('dragstart', () => {
        if (simSelfPanning) return;
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
    document.getElementById('simHeadingUpBtn')?.addEventListener('click', simToggleHeadingUp);
    document.getElementById('simBlockSeekBtn')?.addEventListener('click', simSeekToBlockSection);
    document.getElementById('simChips')?.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="skip-stop"]')) simSkipStop();
    });

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
