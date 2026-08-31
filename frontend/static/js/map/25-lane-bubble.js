// ===== GP 차선 버블 렌더 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
// ===== Lane bubble (차선 버블) ============================================== //
// upstream 로그만 사용한다 (ServiceDataCollect #1/#2, nGPType):
//   색상      = nVoiceCode -> ToLaneColor()  (65 초록 / 66 분홍 / 67 파랑 / 68 노랑)
//   차로 힌트 = nVoiceCode 의 IDV_RG_* 차로 코드 (예: 97 = 오른쪽 1개 차로)
//   회전      = nTurnCode
//   교차로 이미지 = bCrossImage + nGPType & EXTCROSSTURN
// 차로별 화살표/하이라이트는 넣지 않는다 — nLaneTurnInfo[]/nLaneAvailable[] 를
// 찍는 로그가 upstream 에 없어서 복원이 불가능하다.
const GP_LANE_BUBBLE_LAYER = 'GP Lane Bubble (차선 버블)';

// nVoiceCode 가 구체적인 차로를 지시하는 경우의 차로 배치.
// { total: 표시할 칸 수, lit: 강조할 칸 인덱스, anchor: 미지의 나머지 차로 방향 }
function gpLaneLayoutFromVoiceCode(voiceCode) {
    const code = Number(voiceCode);
    if (!Number.isFinite(code)) return null;

    // 54~63 : n차선
    if (code >= 54 && code <= 63) {
        const n = code - 53;
        return { total: n, lit: [n - 1], anchor: 'right', exact: false };
    }
    // 85~88 : 왼쪽 n번째 차로 / 89~92 : 오른쪽 n번째 차로
    if (code >= 85 && code <= 88) {
        const n = code - 84;
        return { total: n, lit: [n - 1], anchor: 'right', exact: false };
    }
    if (code >= 89 && code <= 92) {
        const n = code - 88;
        return { total: n, lit: [0], anchor: 'left', exact: false };
    }
    // 93~96 : 왼쪽 n개 차로 / 97~100 : 오른쪽 n개 차로
    if (code >= 93 && code <= 96) {
        const n = code - 92;
        return { total: n, lit: Array.from({ length: n }, (_, i) => i), anchor: 'right', exact: false };
    }
    if (code >= 97 && code <= 100) {
        const n = code - 96;
        return { total: n, lit: Array.from({ length: n }, (_, i) => i), anchor: 'left', exact: false };
    }
    // 52 왼쪽차선 / 53 오른쪽차선 / 51 직진방향
    if (code === 52) return { total: 2, lit: [0], anchor: 'right', exact: false };
    if (code === 53) return { total: 2, lit: [1], anchor: 'left', exact: false };
    if (code === 51) return { total: 1, lit: [0], anchor: null, exact: false };
    return null;
}

function buildLaneBubbleHtml(extra, compact = false) {
    const px = (full, small) => (compact ? small : full);
    const colorInfo = GP_LANE_COLORS[Number(extra.lane_color)] || GP_LANE_COLORS[0];
    const glyph = GP_TURN_GLYPHS[Number(extra.turn_code)] || '◆';
    const layout = gpLaneLayoutFromVoiceCode(extra.voice_code);

    let strip;
    if (layout) {
        const cells = [];
        // 총 차로 수는 로그에 없다. 미지의 나머지 차로는 '…' 칸으로 표시한다.
        if (layout.anchor === 'left') {
            cells.push(`<div style="min-width:${px(9, 7)}px;padding:1px;color:rgba(255,255,255,.4);font-size:${px(9, 7)}px;text-align:center">…</div>`);
        }
        for (let i = 0; i < layout.total; i++) {
            const lit = layout.lit.includes(i);
            cells.push(
                `<div style="min-width:${px(13, 11)}px;padding:1px 1px;border-radius:2px;text-align:center;font-size:${px(10, 9)}px;line-height:${px(12, 11)}px;` +
                `background:${lit ? colorInfo.hex : 'rgba(148,163,184,.4)'};color:${lit ? '#fff' : 'rgba(255,255,255,.45)'};` +
                `font-weight:${lit ? 700 : 400}">${lit ? glyph : '·'}</div>`
            );
        }
        if (layout.anchor === 'right') {
            cells.push(`<div style="min-width:${px(9, 7)}px;padding:1px;color:rgba(255,255,255,.4);font-size:${px(9, 7)}px;text-align:center">…</div>`);
        }
        strip = `<div style="display:flex;gap:1px;justify-content:center">${cells.join('')}</div>`;
    } else {
        // 차로 지시가 없는 코드(65~68 색상 차선 등) — 색상 칩 + 회전만
        strip = `<div style="display:flex;gap:4px;align-items:center;justify-content:center">` +
            `<span style="width:${px(14, 11)}px;height:${px(14, 11)}px;line-height:${px(14, 11)}px;border-radius:2px;background:${colorInfo.hex};` +
            `color:#fff;font-size:${px(10, 8)}px;font-weight:700;text-align:center">${glyph}</span></div>`;
    }

    const crossBadge = extra.has_cross_image
        ? `<span style="padding:0 2px;border-radius:2px;background:#7c3aed;color:#fff;font-size:7px">교차로</span>`
        : '';
    const voiceText = extra.voice_code ? gpTurnCodeName(extra.voice_code) : '차로 지시 없음';

    return `<div style="display:inline-block;padding:${px('2px 3px', '1px 2px')};background:rgba(15,23,42,.86);` +
        `border:1px solid ${colorInfo.hex};border-radius:${px(4, 3)}px">` +
        strip +
        `<div style="margin-top:1px;font-size:${px(7, 6)}px;line-height:${px(9, 7)}px;color:#e2e8f0;text-align:center;white-space:nowrap">` +
        `${escapeHtml(colorInfo.name.split(' ')[0])} ${crossBadge}</div>` +
        `<div style="font-size:${px(7, 6)}px;line-height:${px(9, 7)}px;color:#94a3b8;text-align:center;white-space:nowrap">${escapeHtml(voiceText)}</div>` +
        `</div>`;
}

function buildLaneBubbleIcon(extra) {
    const layout = gpLaneLayoutFromVoiceCode(extra.voice_code);
    const width = Math.max(38, ((layout?.total || 1) * 12) + 24);
    return L.divIcon({
        className: '',
        iconSize: [width, 32],
        iconAnchor: [width / 2, 32],
        html: buildLaneBubbleHtml(extra, true)
    });
}

function buildLaneBubblePopup(marker) {
    const extra = marker.extra || {};
    const colorInfo = GP_LANE_COLORS[Number(extra.lane_color)] || GP_LANE_COLORS[0];
    const row = (label, value) => (value === null || value === undefined || value === '')
        ? ''
        : `<tr><td style="padding-right:8px;white-space:nowrap"><strong>${label}</strong></td><td>${value}</td></tr>`;
    const observed = Array.isArray(extra.lane_colors_observed) ? extra.lane_colors_observed : [];

    return `
        <div class="popup-content" style="min-width:280px">
            <div style="font-weight:bold;color:${colorInfo.hex};margin-bottom:6px">차선 버블</div>
            <button type="button" class="gp-guidance-open"
                onclick="openGpGuidanceCard('${marker.id}')">
                안내 화면으로 보기
            </button>
            <div style="margin-bottom:8px">${buildLaneBubbleHtml(extra)}</div>
            <table style="font-size:12px">
                ${row('laneColor', `${gpLaneColorChip(extra.lane_color)} <span style="color:#64748b">(nVoiceCode ${extra.voice_code ?? '-'} → ToLaneColor)</span>`)}
                ${row('nVoiceCode', escapeHtml(gpTurnCodeLabel(extra.voice_code)))}
                ${row('turnCode', escapeHtml(gpTurnCodeLabel(extra.turn_code)))}
                ${row('교차로 이미지', gpCrossImageSummary(extra))}
                ${row('nGPType', escapeHtml(gpTypeLabel(extra.gp_type)))}
                ${row('GPIdx', extra.gp_index)}
                ${row('linkIndex', extra.link_index)}
                ${row('nLinkID', extra.link_id)}
                ${observed.length ? row('주행 중 관측 laneColor', observed.map(gpLaneColorChip).join(', ')) : ''}
                ${row('좌표', `${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}`)}
                ${row('로그 시간', escapeHtml(marker.timestamp_str || '-'))}
            </table>
            <div style="font-size:11px;color:#64748b;margin-top:6px">
                차로별 화살표·하이라이트는 이를 찍는 로그가 없어 표시하지 않습니다.
                '…' 칸은 로그로 알 수 없는 나머지 차로입니다.
            </div>
        </div>
    `;
}

function visualizeLaneBubblesFromLog() {
    if (!Array.isArray(markersData) || markersData.length === 0) return;
    const allBubbles = markersData.filter((m) => m.extra?.lane_bubble);
    // Only voice codes that decode to a lane layout say anything about lanes.
    // The rest (colour-only codes such as 65~68) rendered as a bare colour chip
    // with '차로 지시 없음', which is noise on the map — the same values are
    // still in the GP Guide popups.
    const bubbles = allBubbles.filter((m) => gpLaneLayoutFromVoiceCode(m.extra?.voice_code));
    const skipped = allBubbles.length - bubbles.length;
    if (bubbles.length === 0) {
        if (skipped > 0) console.log(`📊 Lane Bubble: 0개 (차로 지시 없는 ${skipped}개 제외)`);
        return;
    }

    console.log(`📊 Lane Bubble: ${bubbles.length}개${skipped > 0 ? ` (차로 지시 없는 ${skipped}개 제외)` : ''}`);

    // Split per owning route session so the sidebar can nest each set under the
    // route it was parsed from; unresolvable sessions stay on the base layer.
    const sessionNames = routeLayerNameBySessionId();
    const buckets = new Map();
    bubbles.forEach((marker) => {
        const routeLayerName = sessionNames.get(marker.extra?.route_session_id) || null;
        const layerName = routeLayerName
            ? routeChildLayerName(GP_LANE_BUBBLE_LAYER, routeLayerName)
            : GP_LANE_BUBBLE_LAYER;
        if (!buckets.has(layerName)) buckets.set(layerName, []);
        buckets.get(layerName).push(marker);
    });

    buckets.forEach((bucket, layerName) => {
        const group = ensureTmapFeatureGroup(layerName);
        group.clearLayers();
        bucket.forEach((marker) => {
            const layer = L.marker([marker.latitude, marker.longitude], {
                icon: buildLaneBubbleIcon(marker.extra)
            });
            layer.bindPopup(buildLaneBubblePopup(marker));
            group.addLayer(layer);
        });
        syncRouteChildLayerToParent(layerName);
    });
    renderLayerControls();
}
