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
const SIM_SPEEDS = [1, 2, 3];
// A guide point counts as "coming up" within this distance ahead.
const SIM_GUIDE_LOOKAHEAD_M = 120;

let simTrack = [];
let simGuidePoints = [];
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
    return L.divIcon({
        className: '',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
        html: `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;
                 transform:rotate(${heading}deg);transform-origin:center">
                 <img src="${SIM_AVATAR_ICON}" width="26" height="40"
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

function simApply(state) {
    if (!state) return;
    simEnsureAvatar()
        .setLatLng([state.lat, state.lon])
        .setIcon(simAvatarIcon(state.heading));
    if (simFollow) map.panTo([state.lat, state.lon], { animate: false });
    refreshSdiBlockHud(state.t);
    simUpdateGuideCard(state);
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

function initSimulation() {
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
