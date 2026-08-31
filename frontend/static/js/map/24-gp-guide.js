// ===== GP(안내지점) 마커 · 팝업 · 시각화 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
// ===== GP (Guide Point) / turnCode 시각화 ==================================== //
// 로그 원본: navisdk CRGDataCollector / CRGPlayer / CNaviModule
//   ServiceDataCollect nGPType:%d, nTurnCode:%d, nLinkID:%d      (링크별 1회)
//   [LANE_COLOR] store GP (new) GPIdx:%d, linkIndex:%d, ...      (GP 생성)
//   GetRenderData pGuidePoint [%3d] gpType %d, turnCode: %5d, vertexEnd %5d
//   [LANE_COLOR] linkIndex:%d, guidePointIndex:%d, ... laneColor:%d, ...  (주행 중)
const GP_CROSS_IMAGE_LAYER = 'GP Guide (교차로 이미지)';
const GP_TURN_ONLY_LAYER = 'GP Guide (이미지 없음)';
const GP_LANE_COLOR_LAYER = 'GP Lane Color (주행)';

// nGPType 비트 플래그 (rgdata_def.h RG_GPTYPE)
const GP_TYPE_FLAG_LABELS = [
    [0x00000001, 'POSITION_S (출발지)'],
    [0x00000002, 'POSITION_E (목적지)'],
    [0x00000010, 'POSITION_V (경유지)'],
    [0x00010000, 'TURN (회전 안내)'],
    [0x00020000, 'EXTCROSSTURN (복잡교차로)'],
    [0x00100000, 'ROTARY_IN'],
    [0x00200000, 'ROTARY_INNER'],
    [0x00400000, 'ROTARY_OUT'],
    [0x01000000, 'IC'],
    [0x02000000, 'JC'],
    [0x04000000, 'SA (휴게소)'],
    [0x08000000, 'TOLL (톨게이트)'],
    [0x10000000, 'EV_STATION']
];
const GP_TYPE_TURN = 0x00010000;
const GP_TYPE_EXTCROSSTURN = 0x00020000;

// LaneColor enum (rgdata_def.h) — 차선 버블 색상
const GP_LANE_COLORS = {
    0: { name: 'NONE', hex: '#64748b' },
    1: { name: 'GREEN (초록)', hex: '#22c55e' },
    2: { name: 'PINK (분홍)', hex: '#ec4899' },
    3: { name: 'BLUE (파랑)', hex: '#3b82f6' },
    4: { name: 'YELLOW (노랑)', hex: '#eab308' }
};

// IDV_RG_* 코드 (rg_def.h) — turnCode / nVoiceCode / ucSndCode 가 모두 이 코드계
const GP_TURN_CODE_NAMES = {
    1: '도곽에 의한 점', 2: '타일에 의한 점', 3: '고속도로 안내없음',
    4: '일반도로 안내없음', 5: '특수한 경우 안내없음',
    6: 'Y자 오른쪽 안내없음', 7: 'Y자 왼쪽 안내없음',
    11: '직진', 12: '좌회전', 13: '우회전', 14: 'U-turn', 15: 'P-turn',
    16: '8시 방향 좌회전', 17: '10시 방향 좌회전',
    18: '2시 방향 우회전', 19: '4시 방향 우회전',
    43: '오른쪽', 44: '왼쪽',
    51: '직진방향', 52: '왼쪽차선', 53: '오른쪽차선',
    65: '초록색 차선', 66: '분홍색 차선', 67: '파란색 차선', 68: '노란색 차선',
    69: '왼쪽 길', 70: '오른쪽 길',
    71: '첫번째 출구', 72: '두번째 출구',
    73: '첫번째 오른쪽 길', 74: '두번째 오른쪽 길',
    75: '첫번째 왼쪽 길', 76: '두번째 왼쪽 길',
    77: '왼쪽 출구', 78: '오른쪽 출구',
    80: '하이패스 좌측', 81: '하이패스 우측', 82: '하이패스 중앙',
    101: '오른쪽방향 고속도로 입구', 102: '왼쪽방향 고속도로 입구', 103: '직진방향 고속도로 입구',
    104: '오른쪽방향 고속도로 출구', 105: '왼쪽방향 고속도로 출구', 106: '직진방향 고속도로 출구',
    111: '오른쪽방향 도시고속 입구', 112: '왼쪽방향 도시고속 입구', 113: '직진방향 도시고속 입구',
    114: '오른쪽방향 도시고속 출구', 115: '왼쪽방향 도시고속 출구', 116: '직진방향 도시고속 출구',
    117: '오른쪽 도로', 118: '왼쪽 도로', 119: '지하도로', 120: '고가도로',
    121: '터널', 122: '교량', 123: '지하도로 옆', 124: '고가도로 옆',
    150: '졸음 쉼터', 151: '휴게소', 152: '휴게소 진입',
    153: '톨게이트(고속)', 154: '톨게이트(일반)', 160: '전기차 추천 충전소',
    170: 'Ferry 진입', 171: 'Ferry 진출',
    181: '목적지 직진방향', 182: '목적지 왼쪽방향', 183: '목적지 오른쪽방향', 184: '경유지',
    191: '제한속도', 192: '사고다발', 193: '급커브', 194: '낙석주의',
    195: '경찰청 차로 안내', 196: '경찰청 차로 안내2',
    200: '출발지', 201: '목적지', 202: '다음 안내까지 직진', 203: '건너편 목적지',
    210: '경로 진입', 220: '고속도로에 있습니까?', 221: '도시고속도로에 있습니까?',
    222: '고가도로에 있습니까?', 223: '지하도로에 있습니까?',
    249: '톨게이트', 250: '경로안내 종료'
};
(function fillRepeatedTurnCodeNames() {
    for (let i = 1; i <= 12; i++) {
        GP_TURN_CODE_NAMES[30 + i] = `${i}시 방향`;              // 31~42
        GP_TURN_CODE_NAMES[130 + i] = `${i}시방향`;              // 131~142
        GP_TURN_CODE_NAMES[230 + i] = `회전교차로 ${i}시방향`;    // 231~242
    }
    for (let i = 1; i <= 10; i++) GP_TURN_CODE_NAMES[53 + i] = `${i}차선`;   // 54~63
    for (let i = 1; i <= 4; i++) {
        GP_TURN_CODE_NAMES[84 + i] = `왼쪽 ${i}번째 차로`;        // 85~88
        GP_TURN_CODE_NAMES[88 + i] = `오른쪽 ${i}번째 차로`;      // 89~92
        GP_TURN_CODE_NAMES[92 + i] = `왼쪽 ${i}개 차로`;          // 93~96
        GP_TURN_CODE_NAMES[96 + i] = `오른쪽 ${i}개 차로`;        // 97~100
    }
    for (let i = 1; i <= 9; i++) GP_TURN_CODE_NAMES[160 + i] = `경로시작 ${i}시방향`;
    GP_TURN_CODE_NAMES[172] = '경로시작 12시방향';
    GP_TURN_CODE_NAMES[251] = '경로시작 10시방향';
    GP_TURN_CODE_NAMES[252] = '경로시작 11시방향';
})();

const GP_TURN_GLYPHS = (() => {
    const glyphs = {};
    const assign = (codes, glyph) => codes.forEach((code) => { glyphs[code] = glyph; });
    assign([3, 4, 5, 6, 7], '·');
    assign([11, 51, 103, 106, 113, 116, 181, 202], '↑');
    assign([12, 16, 17, 44, 52, 77, 102, 105, 112, 115, 118, 182], '↰');
    assign([13, 18, 19, 43, 53, 78, 101, 104, 111, 114, 117, 183], '↱');
    assign([14], '↩');
    assign([15], '↪');
    assign([150, 151, 152], '☕');
    assign([153, 154, 249], '₩');
    assign([160], '⚡');
    assign([200], 'S');
    assign([201], 'E');
    assign([184], 'V');
    return glyphs;
})();

function gpTurnCodeName(turnCode) {
    const code = Number(turnCode);
    if (!Number.isFinite(code)) return '-';
    // nVoiceCode / ucSndCode 는 필터에서 걸러지면 0 이 된다 (안내 코드 아님)
    if (code === 0) return '없음';
    return GP_TURN_CODE_NAMES[code] || '정의 없음';
}

function gpTurnCodeLabel(turnCode) {
    const code = Number(turnCode);
    if (!Number.isFinite(code)) return '-';
    return `${code} (${gpTurnCodeName(code)})`;
}

function gpTypeFlagNames(gpType) {
    const value = Number(gpType) || 0;
    return GP_TYPE_FLAG_LABELS.filter(([mask]) => (value & mask) === mask).map(([, label]) => label);
}

// nGPType 은 비트 플래그라 == 비교가 아니라 마스크로 판정한다.
function gpTypeLabel(gpType) {
    const value = Number(gpType) || 0;
    const flags = gpTypeFlagNames(value);
    const hex = `0x${(value >>> 0).toString(16).toUpperCase()}`;
    if (flags.length === 0) return `${value} (${hex}) · GPTYPE_NON — 안내 없음`;
    return `${value} (${hex}) · ${flags.join(' | ')}`;
}

function gpMarkerColor(gpType) {
    const value = Number(gpType) || 0;
    if (value & GP_TYPE_EXTCROSSTURN) return '#7c3aed';   // 복잡교차로 이미지 있음
    if (value & GP_TYPE_TURN) return '#0d9488';           // 일반 회전 GP
    return '#94a3b8';                                     // 안내 없는 통과 링크
}

function buildGpMarkerIcon(extra) {
    const gpType = Number(extra.gp_type) || 0;
    const color = gpMarkerColor(gpType);
    const glyph = GP_TURN_GLYPHS[Number(extra.turn_code)] || '◆';
    const isCross = !!(gpType & GP_TYPE_EXTCROSSTURN);
    const size = 14;
    const badge = extra.gp_index !== null && extra.gp_index !== undefined
        ? `<div style="margin-top:1px;padding:0 2px;background:rgba(15,23,42,.75);color:#fff;font-size:7px;font-weight:600;border-radius:5px;white-space:nowrap">GP ${extra.gp_index}</div>`
        : '';
    return L.divIcon({
        className: '',
        iconSize: [size, size + (badge ? 9 : 0)],
        iconAnchor: [size / 2, size / 2],
        html:
            `<div style="display:flex;flex-direction:column;align-items:center">` +
            `<div style="width:${size}px;height:${size}px;line-height:${size}px;text-align:center;` +
            `background:${color};color:#fff;border-radius:${isCross ? '3px' : '50%'};` +
            `font-size:10px;font-weight:700;` +
            `border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)">${glyph}</div>` +
            badge +
            `</div>`
    });
}

function gpLaneColorChip(laneColor) {
    const info = GP_LANE_COLORS[Number(laneColor)] || GP_LANE_COLORS[0];
    return `<span style="display:inline-flex;align-items:center;gap:4px">` +
        `<i style="width:9px;height:9px;border-radius:50%;background:${info.hex};display:inline-block;border:1px solid #fff"></i>` +
        `${escapeHtml(info.name)}</span>`;
}

// 교차로 이미지 유무는 서로 다른 3개 신호로 나뉜다:
//   nGPType & EXTCROSSTURN — 이 GP에 교차로 이미지가 붙었는가 (최종 결과)
//   bCrossImage #1/#2      — GetCrossImageData 결과와 직진 필터 통과 여부
//   usImgID / ucImgAvailable — 실제 이미지 리소스가 있는가
function gpCrossImageSummary(extra) {
    const gpType = Number(extra.gp_type) || 0;
    const hasFlag = !!(gpType & GP_TYPE_EXTCROSSTURN);
    const raw = extra.cross_image_raw;
    const filtered = extra.cross_image;
    const parts = [];

    if (hasFlag) {
        parts.push('<strong style="color:#7c3aed">있음</strong> (EXTCROSSTURN)');
    } else if (raw === 1 && filtered === 0) {
        // 직진(turnCode 11)이거나 nVoiceCode 가 0이면 GP로 넣지 않는다
        parts.push('<strong>없음</strong> — 교차로 데이터는 있으나 필터에서 제외 (#1 1 → #2 0)');
    } else if (raw === undefined || raw === null) {
        parts.push('<strong>없음</strong> — offsetExtCross 없음 (교차로 데이터 자체가 없음)');
    } else {
        parts.push('<strong>없음</strong>');
    }

    if (extra.cross_img_code) parts.push(`imgID ${extra.cross_img_code}`);
    if (extra.cross_img_available !== undefined && extra.cross_img_available !== null) {
        parts.push(Number(extra.cross_img_available) ? '리소스 사용가능' : '리소스 없음');
    }
    return parts.join(' · ');
}

// ===========================================================================
// Navigation-style guidance card.
//
// tbt_1st_*.png in app/_res/image is NOT indexed by turnCode, and only 14 of
// its 36 slots have artwork — basic turns exist only as a left and a right
// arrow, with no U-turn, P-turn or clock-direction variants. So each turnCode is
// mapped to the slot whose artwork actually depicts it (verified by rendering
// every slot), and codes with no matching artwork keep the arrow glyph instead
// of borrowing a wrong picture.
// ===========================================================================
const TBT_ICON_DIR = '/static/img/tbt/';

const TBT_TURN_IMAGE = {
    12: 'tbt_03.png',          // 좌회전
    13: 'tbt_02.png',          // 우회전
    // 고속도로 / 도시고속 입구·출구: IN/OUT shield + approach direction
    101: 'tbt_16.png', 102: 'tbt_14.png', 103: 'tbt_12.png',   // 입구 우/좌/직진
    104: 'tbt_17.png', 105: 'tbt_15.png', 106: 'tbt_13.png',   // 출구 우/좌/직진
    111: 'tbt_16.png', 112: 'tbt_14.png', 113: 'tbt_12.png',
    114: 'tbt_17.png', 115: 'tbt_15.png', 116: 'tbt_13.png',
    117: 'tbt_31.png',         // 오른쪽 도로
    118: 'tbt_31_mirror.png',  // 왼쪽 도로 — mirrored, no left-hand asset exists
    120: 'tbt_36.png',         // 고가도로
    121: 'tbt_29.png',         // 터널
    233: 'tbt_33.png'          // 직진(임시)
};

function tbtImageForTurnCode(turnCode) {
    return TBT_TURN_IMAGE[Number(turnCode)] || null;
}

let gpGuidanceCardEl = null;

function closeGpGuidanceCard() {
    if (gpGuidanceCardEl) {
        gpGuidanceCardEl.remove();
        gpGuidanceCardEl = null;
    }
}

// Opened from the GP popup. Shows what the device would have drawn at this guide
// point: the turn figure, the lane bubble, and the values behind both.
// Keyed by the marker's own id, not gp_index: gp_index is absent in real logs
// (every GP in a 3.6GB sample had it null), and String(undefined) matched the
// first GP every time, so every card showed the same guide point.
function openGpGuidanceCard(markerId) {
    const wanted = String(markerId);
    const marker = (markersData || []).find((m) =>
        (m.extra?.gp_guide || m.extra?.lane_bubble) && String(m.id) === wanted);
    if (!marker) return;

    closeGpGuidanceCard();
    const extra = marker.extra || {};
    const gpType = Number(extra.gp_type) || 0;
    const image = tbtImageForTurnCode(extra.turn_code);
    const glyph = GP_TURN_GLYPHS[Number(extra.turn_code)] || '◆';
    const turnName = gpTurnCodeName(extra.turn_code) || gpTurnCodeLabel(extra.turn_code);

    const figure = image
        ? `<img src="${TBT_ICON_DIR}${image}" width="72" height="72" style="display:block" alt="">`
        : `<div style="width:72px;height:72px;display:flex;align-items:center;justify-content:center;
             font-size:44px;line-height:1;color:#f8fafc">${glyph}</div>`;

    const laneBubble = (gpType & GP_TYPE_TURN)
        ? buildLaneBubbleHtml(extra)
        : '<div style="color:#94a3b8;font-size:11px">차선 버블 없음 (GPTYPE_TURN 아님)</div>';

    const el = document.createElement('div');
    el.className = 'gp-guidance-card';
    el.innerHTML = `
        <div class="gp-guidance-head">
            <span>안내 화면 재현</span>
            <button type="button" class="gp-guidance-close" aria-label="닫기">✕</button>
        </div>
        <div class="gp-guidance-body">
            <div class="gp-guidance-turn">
                ${figure}
                <div class="gp-guidance-turn-text">
                    <div class="gp-guidance-turn-name">${escapeHtml(turnName)}</div>
                    <div class="gp-guidance-turn-sub">
                        ${extra.gp_index === null || extra.gp_index === undefined
                            ? '' : `GP ${extra.gp_index} · `}turnCode ${extra.turn_code ?? '-'}
                        ${image ? '' : ' · 해당 TBT 이미지 없음'}
                    </div>
                </div>
            </div>
            <div class="gp-guidance-lane">${laneBubble}</div>
            <div class="gp-guidance-meta">
                <span>nLinkID ${extra.link_id ?? '-'}</span>
                <span>linkIndex ${extra.link_index ?? '-'}</span>
                <span>${escapeHtml(gpTypeLabel(gpType))}</span>
            </div>
        </div>`;
    el.querySelector('.gp-guidance-close').onclick = closeGpGuidanceCard;
    naviStack().appendChild(el);
    gpGuidanceCardEl = el;
}

/** 팝업 행. 값이 없으면 줄 자체를 만들지 않는다. */
function gpRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="mk-row"><span class="mk-key">${label}</span><span class="mk-val">${value}</span></div>`;
}

function buildGpGuidePopup(marker) {
    const extra = marker.extra || {};
    const gpType = Number(extra.gp_type) || 0;
    const color = gpMarkerColor(gpType);
    const isTurn = !!(gpType & GP_TYPE_TURN);
    const title = gpType & GP_TYPE_EXTCROSSTURN
        ? '복잡교차로 GP'
        : (isTurn ? '회전 GP' : '통과 링크');

    // 자주 보는 값만 위로. 원시 필드는 아래 '상세' 안에 접어둔다.
    const primary = [
        gpRow('안내', escapeHtml(gpTurnCodeLabel(extra.turn_code))),
        isTurn ? gpRow('차선색', gpLaneColorChip(extra.lane_color)) : '',
        gpRow('교차로', gpCrossImageSummary(extra)),
        gpRow('링크', extra.link_id !== undefined && extra.link_id !== null
            ? `${extra.link_id}${extra.link_ordinal !== undefined && extra.link_ordinal !== null ? ` <span class="gp-dim">(순번 ${extra.link_ordinal})</span>` : ''}`
            : ''),
        gpRow('좌표', `${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}`),
        gpRow('시간', escapeHtml(marker.timestamp_str || '-'))
    ].join('');

    const laneColors = Array.isArray(extra.lane_colors) ? extra.lane_colors : [];
    const crossImageDetail = extra.cross_image === null || extra.cross_image === undefined
        ? ''
        : gpRow('bCrossImage', `${extra.cross_image}${extra.cross_image_raw !== undefined && extra.cross_image_raw !== extra.cross_image
            ? ` <span class="gp-dim">(필터 전 ${extra.cross_image_raw})</span>` : ''}`);

    const details = [
        gpRow('nGPType', escapeHtml(gpTypeLabel(gpType))),
        gpRow('GPIdx', extra.gp_index),
        gpRow('TVAS GPIdx', extra.render_gp_index),
        gpRow('linkIndex', extra.link_index),
        crossImageDetail,
        gpRow('nVoiceCode', extra.voice_code === null || extra.voice_code === undefined
            ? '' : escapeHtml(gpTurnCodeLabel(extra.voice_code))),
        gpRow('ucSndCode', extra.snd_code === null || extra.snd_code === undefined
            ? '' : escapeHtml(gpTurnCodeLabel(extra.snd_code))),
        gpRow('이미지 ID', extra.cross_img_code),
        gpRow('이미지 사용', extra.cross_img_available),
        gpRow('vertexEnd', extra.vertex_end),
        gpRow('관측 laneColor', laneColors.length ? laneColors.map(gpLaneColorChip).join(' ') : ''),
        gpRow('위치 근거', escapeHtml(String(extra.position_source || '-'))
            + (extra.link_ordinal_from_log ? ' <span class="gp-dim">— nLinkID가 맵 링크ID가 아니라 순번</span>' : '')),
        gpRow('관측 위치', extra.observed_gap_m === null || extra.observed_gap_m === undefined
            ? '' : `${Number(extra.observed_lat).toFixed(6)}, ${Number(extra.observed_lon).toFixed(6)}`
                + ` <span class="${extra.observed_gap_m > 50 ? 'gp-warn' : 'gp-ok'}">(차이 ${extra.observed_gap_m}m)</span>`),
        gpRow('경로', escapeHtml(String(extra.route_session_name || extra.route_session_id || '-')))
    ].filter(Boolean).join('');

    return `
        <div class="mk-popup gp-popup">
            <div class="mk-head">
                <span class="mk-head-id" style="color:${color}">${escapeHtml(title)}</span>
                <span class="mk-head-type">GP ${extra.gp_index ?? '-'}</span>
            </div>
            ${isTurn ? `<div class="gp-bubble-preview">${buildLaneBubbleHtml(extra)}</div>` : ''}
            <div class="mk-rows">${primary}</div>
            <button type="button" class="gp-guidance-open" onclick="openGpGuidanceCard('${marker.id}')">
                안내 화면으로 보기
            </button>
            ${details ? `<div class="mk-rows mk-rows-extra">${details}</div>` : ''}
        </div>
    `;
}

function buildGpLaneColorPopup(marker) {
    const extra = marker.extra || {};
    const info = GP_LANE_COLORS[Number(extra.lane_color)] || GP_LANE_COLORS[0];

    const primary = [
        gpRow('차선색', gpLaneColorChip(extra.lane_color)),
        gpRow('nVoiceCode', escapeHtml(gpTurnCodeLabel(extra.voice_code))),
        gpRow('좌표', `${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}`),
        gpRow('시간', escapeHtml(marker.timestamp_str || '-'))
    ].join('');

    const details = [
        gpRow('gpTurnCode', escapeHtml(gpTurnCodeLabel(extra.turn_code))),
        gpRow('guidePointIdx', extra.gp_index),
        gpRow('linkIndex', extra.link_index),
        gpRow('gpLinkIndex', extra.gp_link_index)
    ].filter(Boolean).join('');

    return `
        <div class="mk-popup gp-popup">
            <div class="mk-head">
                <span class="mk-head-id" style="color:${info.hex}">차선 버블 색상</span>
                <span class="mk-head-type">주행 중</span>
            </div>
            <div class="mk-rows">${primary}</div>
            ${extra.link_mismatch
                ? '<div class="gp-mismatch">gpLinkIndex ≠ linkIndex — GP 매핑 확인 필요</div>'
                : ''}
            ${details ? `<div class="mk-rows mk-rows-extra">${details}</div>` : ''}
        </div>
    `;
}

function visualizeGpGuideFromLog() {
    if (!Array.isArray(markersData) || markersData.length === 0) return;

    const gpMarkers = markersData.filter((m) => m.extra?.gp_guide);
    const laneMarkers = markersData.filter((m) => m.extra?.gp_lane_color);
    if (gpMarkers.length === 0 && laneMarkers.length === 0) return;

    // 교차로 이미지 유무는 nGPType 의 EXTCROSSTURN 플래그로 갈린다
    const crossImageMarkers = gpMarkers.filter((m) => (Number(m.extra.gp_type) || 0) & GP_TYPE_EXTCROSSTURN);
    const turnOnlyMarkers = gpMarkers.filter((m) => {
        const gpType = Number(m.extra.gp_type) || 0;
        return (gpType & GP_TYPE_TURN) && !(gpType & GP_TYPE_EXTCROSSTURN);
    });
    console.log(`📊 GP Guide: 교차로이미지 ${crossImageMarkers.length}개, 이미지없음 ${turnOnlyMarkers.length}개, ` +
        `주행 laneColor ${laneMarkers.length}개`);

    const addTo = (layerName, list, popupBuilder, iconBuilder) => {
        if (list.length === 0) return null;
        const group = ensureTmapFeatureGroup(layerName);
        group.clearLayers();
        list.forEach((marker) => {
            const layer = iconBuilder
                ? L.marker([marker.latitude, marker.longitude], { icon: iconBuilder(marker.extra) })
                : L.circleMarker([marker.latitude, marker.longitude], {
                    radius: 5,
                    color: marker.color || '#64748b',
                    weight: 2,
                    fill: marker.fill !== false,
                    fillColor: marker.color || '#64748b',
                    fillOpacity: 0.85,
                    pane: 'markerPane'
                });
            layer.bindPopup(popupBuilder(marker));
            group.addLayer(layer);
        });
        return group;
    };

    // Each GP kind is split per owning route session so the sidebar can nest it
    // under that route. Markers whose session cannot be resolved (no matching
    // 'Route Info' line) stay on the unsuffixed layer as a top-level row.
    const sessionNames = routeLayerNameBySessionId();
    const perSession = (list) => {
        const buckets = new Map();
        list.forEach((marker) => {
            const routeLayerName = sessionNames.get(marker.extra?.route_session_id) || null;
            if (!buckets.has(routeLayerName)) buckets.set(routeLayerName, []);
            buckets.get(routeLayerName).push(marker);
        });
        return buckets;
    };

    [
        [GP_CROSS_IMAGE_LAYER, crossImageMarkers, buildGpGuidePopup, buildGpMarkerIcon],
        [GP_TURN_ONLY_LAYER, turnOnlyMarkers, buildGpGuidePopup, buildGpMarkerIcon],
        [GP_LANE_COLOR_LAYER, laneMarkers, buildGpLaneColorPopup, null]
    ].forEach(([baseName, list, popupBuilder, iconBuilder]) => {
        perSession(list).forEach((bucket, routeLayerName) => {
            const layerName = routeLayerName ? routeChildLayerName(baseName, routeLayerName) : baseName;
            addTo(layerName, bucket, popupBuilder, iconBuilder);
            syncRouteChildLayerToParent(layerName);
        });
    });

    renderLayerControls();
}

/** GP 에서 그려지는 차선 버블 그림. 회전 GP 에서만 나온다. */
function buildGpBubbleSection(extra) {
    const gpType = Number(extra?.gp_type) || 0;
    if (!(gpType & GP_TYPE_TURN)) return '';
    return `<div class="gp-bubble-preview">${buildLaneBubbleHtml(extra)}</div>`;
}

// Route Info 링크 팝업에 붙는 GP 요약 — 해당 링크에서 안내엔진이 내린 결정
function buildRouteGuideSection(guide) {
    if (!guide) {
        return `<div class="gp-section"><div class="gp-section-title">GP 로그 없음</div>`
            + `<div class="gp-dim">이 링크의 ServiceDataCollect 미수집</div></div>`;
    }

    const gpType = Number(guide.gp_type) || 0;
    const color = gpMarkerColor(gpType);
    const isTurn = !!(gpType & GP_TYPE_TURN);
    const title = gpType & GP_TYPE_EXTCROSSTURN
        ? '복잡교차로 GP'
        : (isTurn ? '회전 GP' : '안내 없음 (통과 링크)');

    const primary = [
        gpRow('안내', escapeHtml(gpTurnCodeLabel(guide.turn_code))),
        isTurn && guide.lane_color !== undefined ? gpRow('차선색', gpLaneColorChip(guide.lane_color)) : '',
        gpRow('교차로', gpCrossImageSummary(guide))
    ].join('');

    const observed = Array.isArray(guide.lane_colors_observed) ? guide.lane_colors_observed : [];
    const details = [
        gpRow('nGPType', escapeHtml(gpTypeLabel(gpType))),
        gpRow('GPIdx', guide.gp_index),
        gpRow('linkIndex', guide.link_index),
        gpRow('nVoiceCode', guide.voice_code === null || guide.voice_code === undefined
            ? '' : escapeHtml(gpTurnCodeLabel(guide.voice_code))),
        gpRow('관측 laneColor', observed.length ? observed.map(gpLaneColorChip).join(' ') : '')
    ].filter(Boolean).join('');

    return `
        <div class="gp-section gp-popup">
            <div class="gp-section-title" style="color:${color}">GP · ${escapeHtml(title)}</div>
            ${buildGpBubbleSection(guide)}
            <div class="mk-rows">${primary}</div>
            ${details ? `<div class="mk-rows mk-rows-extra">${details}</div>` : ''}
        </div>
    `;
}

