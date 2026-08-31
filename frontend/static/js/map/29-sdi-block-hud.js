// ===== 구간단속 HUD — 실제 내비게이션 표시 재현 ============================== //
//
// While inside a 구간단속 section the navigation UI shows two plates, 평균속도 and
// 남은거리, drawn on block_speed_bg / block_distance_bg. Those two files are the
// real assets and all three values come from the log:
//
//   onDriveStatusChanged SDIBlock:0->1 ... Speed:60 Avg:53 Dist:2157
//   GetSDIInfo[i] [Type:4, speed:0, blockspeed:60, isBlock:1]
//
// The HUD follows the timeline rather than showing one frozen frame: it picks
// the newest sample at or before the slider's current end, and hides itself when
// that moment is outside a section.

const SDI_BLOCK_HUD_DIR = '/static/img/hud/';

// One column on the map holding the HUD, the guidance card and the simulation
// alerts. They used to be positioned independently and ended up scattered.
function naviStack() {
    let el = document.getElementById('naviStack');
    if (!el) {
        el = document.createElement('div');
        el.id = 'naviStack';
        // Lives outside #map so the heading-up rotation does not rotate the UI.
        (document.getElementById('main-content') || document.body).appendChild(el);
    }
    return el;
}
// A section sample is only meaningful for a moment near it; beyond this the
// drive has left the section (the log stops sampling once outside).
const SDI_BLOCK_HUD_MAX_AGE_MS = 5000;

let sdiBlockTimeline = [];
let sdiBlockHudEl = null;

function setSdiBlockTimeline(timeline) {
    sdiBlockTimeline = Array.isArray(timeline) ? timeline : [];
}

// Newest sample at or before `timeMs`, or null when that moment is not in a
// section. Binary search — the timeline runs to a few hundred samples and this
// is called on every slider update.
function sdiBlockSampleAt(timeMs) {
    if (sdiBlockTimeline.length === 0 || !Number.isFinite(timeMs)) return null;
    let lo = 0;
    let hi = sdiBlockTimeline.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sdiBlockTimeline[mid].timestamp_ms <= timeMs) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (found < 0) return null;
    const sample = sdiBlockTimeline[found];
    return (timeMs - sample.timestamp_ms) <= SDI_BLOCK_HUD_MAX_AGE_MS ? sample : null;
}

function ensureSdiBlockHud() {
    if (sdiBlockHudEl) return sdiBlockHudEl;
    const el = document.createElement('div');
    el.id = 'sdiBlockHud';
    el.className = 'sdi-block-hud hidden';
    el.innerHTML = `
        <div class="sdi-block-hud-limit">
            <div class="sdi-block-hud-sign"><span data-role="limit">–</span></div>
            <div class="sdi-block-hud-caption">구간단속</div>
        </div>
        <div class="sdi-block-hud-plates">
            <div class="sdi-block-hud-plate" style="background-image:url('${SDI_BLOCK_HUD_DIR}block_speed.png')">
                <span data-role="avg">–</span>
            </div>
            <div class="sdi-block-hud-plate" style="background-image:url('${SDI_BLOCK_HUD_DIR}block_distance.png')">
                <span data-role="dist">–</span>
            </div>
        </div>`;
    naviStack().appendChild(el);
    sdiBlockHudEl = el;
    return el;
}

function formatBlockDistance(metres) {
    if (!Number.isFinite(metres)) return '–';
    return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${metres}m`;
}

function refreshSdiBlockHud(timeMs) {
    if (sdiBlockTimeline.length === 0) {
        if (sdiBlockHudEl) sdiBlockHudEl.classList.add('hidden');
        return;
    }
    const el = ensureSdiBlockHud();
    const sample = sdiBlockSampleAt(timeMs);
    if (!sample) {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    el.querySelector('[data-role="limit"]').textContent =
        Number.isFinite(sample.block_speed) && sample.block_speed > 0 ? sample.block_speed : '–';
    el.querySelector('[data-role="avg"]').textContent =
        Number.isFinite(sample.avg_speed) ? sample.avg_speed : '–';
    el.querySelector('[data-role="dist"]').textContent = formatBlockDistance(sample.remain_dist);
    // Over the section limit is the one state worth calling out.
    el.classList.toggle('over',
        Number.isFinite(sample.block_speed) && sample.avg_speed > sample.block_speed);
}
