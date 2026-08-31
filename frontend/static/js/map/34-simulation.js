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
            requestId: m.extra?.group_1
        }))
        .sort((a, b) => a.t - b.t);

    simFiredRerouteIds = new Set();
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
        (document.getElementById('map') || document.body).appendChild(el);
    }
    return el;
}

// The SDI / C2X strip, drawn with the same real icons the map markers use so the
// simulation and the map read as one thing.
function simRenderAlerts(state) {
    const el = simEnsureAlertBox();
    const rows = [];

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
    simStackBelowHud(el);
}

// The 구간단속 HUD is only present sometimes and its height depends on how many
// plates it draws, so the strip is placed under whatever is actually there
// rather than at a guessed offset.
function simStackBelowHud(el) {
    const hud = document.getElementById('sdiBlockHud');
    const visible = hud && !hud.classList.contains('hidden');
    const top = visible ? hud.getBoundingClientRect().height + 22 : 14;
    el.style.top = `${top}px`;
    const toast = document.getElementById('simRerouteToast');
    if (toast) toast.style.top = `${top}px`;
}

// A reroute has a time but no place, so it flashes as a toast when playback
// crosses it. Ids already fired are remembered so scrubbing back does not
// re-trigger a burst of them.
function simRenderReroute(state) {
    const toast = document.getElementById('simRerouteToast') || (() => {
        const el = document.createElement('div');
        el.id = 'simRerouteToast';
        el.className = 'sim-reroute-toast hidden';
        (document.getElementById('map') || document.body).appendChild(el);
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
    if (simFollow) {
        simSelfPanning = true;
        map.panTo([state.lat, state.lon], { animate: false });
        simSelfPanning = false;
    }
    refreshSdiBlockHud(state.t);
    simUpdateGuideCard(state);
    simRenderAlerts(state);
    simRenderReroute(state);
    simRenderStatus(state);
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
    simSyncButtons();
}
