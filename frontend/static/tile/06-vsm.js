// SAFE_DRIVE_DB(VSM 원본) 를 그린다. 서버가 뜰 때 이미 읽어 두므로 여기서는
// 표시만 담당한다.
let sdiCellLayer = null;      // 셀 밀도(개수)
let vsmPointLayer = null;     // 선택한 타일 안의 SDI
let vsmStatus = null;
let vsmCellsLoading = false;
let vsmPointsLoading = false;

// SDI 는 늘 메시(= SDI 셀, 7.5분 x 5분, 약 11 x 9 km) 단위로 그린다. 타일은
// 약 1.2 km 라 그 안의 SDI 만 보면 주변 맥락이 안 보인다. 타일은 패널의 정보와
// 지도의 주황 사각형으로만 남는다.
// 메시 하나가 화면에 들어오는 줌이 화면 폭에 따라 z10 언저리다.
const VSM_POINT_MIN_ZOOM = 10;

// 개수에 따른 색. 도심 셀이 1000건을 넘으므로 구간을 넓게 잡는다.
const CELL_FILL_MAX_ZOOM = 12;

const CELL_STEPS = [
    { upto: 50, color: '#dbeafe' },
    { upto: 150, color: '#bfdbfe' },
    { upto: 350, color: '#93c5fd' },
    { upto: 700, color: '#60a5fa' },
    { upto: Infinity, color: '#2f6ded' },
];

function cellColor(count) {
    return CELL_STEPS.find((step) => count <= step.upto).color;
}

// eSAFEDRIVE_GGUIDE_TYPE -> 내비 리소스 이미지.
// 전용 이미지가 없는 타입은 여기 없고, 이름 글자 칩으로 그려진다.
const SAFE_DRIVE_ASSET = {
    1: 'SDI_SPEED_LIMIT_POS',            // 과속(고정식)
    2: 'SDI_SPEED_LIMIT_DANGEROUS_AREA', // 과속(이동식)
    3: 'SDI_LOAD_BAD_CONTROL_POS',       // 과적
    4: 'SDI_SIGNAL_ACCIDENT_POS',        // 신호
    5: 'SDI_SPEED_ACCIDENT_POS',         // 신호과속
    7: 'SDI_PARKING_CONTROL_POS',        // 주차단속
    8: 'SDI_ROAD_CONTROL_POS',           // 갓길감시
    9: 'SDI_TRAFFICINFO_COLLECT_POS',    // 교통정보 수집
    10: 'SDI_ACCIDEDNT_AREA',            // 사고다발지역
    11: 'SDI_SHARP_CURVE_AREA',          // 급커브지역
    12: 'SDI_FOG_AREA',                  // 안개지역
    13: 'SDI_REST_PLACE',                // 고속도로 휴게소
    17: 'SDI_LOAD_BAD_CONTROL_POS',      // 유해물질 단속
    18: 'SDI_SPEEDBUMP',                 // 과속방지턱
    19: 'SDI_SCHOOL_ZONE_START',         // 어린이보호구역
    20: 'SDI_RAILWAY_CROSSING',          // 철길건널목
    21: 'SDI_CHANGEROAD_POS',            // 끼어들기 금지
    22: 'SDI_SPEED_BLOCK_START_POS',     // 구간단속 시점
    23: 'SDI_SPEED_BLOCK_END_POS',       // 구간단속 종점
    24: 'SDI_LOAD_BAD_CONTROL_POS',      // 적재불량 단속
    25: 'SDI_CCTV_AREA',                 // 방범용 CCTV
    26: 'SDI_ACCIDEDNT_AREA',            // 보행자 사고다발
    27: 'SDI_SPEED_BLOCK_START_POS',     // 가변단속 시점
    28: 'SDI_SPEED_BLOCK_END_POS',       // 가변단속 종점
    30: 'SDI_BOX_SPEED_LIMIT_POS',       // 박스형 이동식
    31: 'SDI_REST_PLACE',                // 졸음쉼터
    32: 'SDI_SCHOOL_ZONE_START',         // 어린이보호구역 시점
    33: 'SDI_SCHOOL_ZONE_START',         // 어린이보호구역 종점
    40: 'SDI_SPEED_LIMIT_POS',           // 후면 과속단속
    41: 'SDI_SPEED_ACCIDENT_POS',        // 후면 신호과속단속
    48: 'SDI_SPEED_BLOCK_START_POS',
    49: 'SDI_SPEED_BLOCK_END_POS',
    50: 'SDI_SPEED_BLOCK_START_POS',
    51: 'SDI_SPEED_BLOCK_END_POS',
    52: 'SDI_SPEED_BLOCK_START_POS',
    53: 'SDI_SPEED_BLOCK_END_POS',
};

function safeDriveIconUrl(type) {
    const asset = SAFE_DRIVE_ASSET[Number(type)];
    return asset ? SDI_ICON_DIR + asset + '.png' : null;
}

function renderVsmStatus() {
    const box = $('vsmStatus');
    if (!vsmStatus) {
        box.innerHTML = '<span class="vsm-error">SAFE_DRIVE_DB 를 불러오지 못했습니다.</span>';
        return;
    }
    box.innerHTML = `SAFE_DRIVE_DB ${vsmStatus.version}`
        + ` <span class="tag">${vsmStatus.server}</span>`
        + ` · 전국 ${fmtNum(vsmStatus.record_total)}건 / ${fmtNum(vsmStatus.cell_count)}셀`;
}

// --- 셀 밀도 ---
async function refreshSdiCells() {
    if (!vsmStatus || vsmCellsLoading) return;
    vsmCellsLoading = true;
    try {
        const b = map.getBounds();
        const data = await getJson(API_BASE + '/api/vsm/cells'
            + `?south=${b.getSouth()}&west=${b.getWest()}&north=${b.getNorth()}&east=${b.getEast()}`);
        // 가까이 들어가면 셀 하나가 화면을 덮어 밀도색이 배경지도만 가린다.
        const filled = map.getZoom() <= CELL_FILL_MAX_ZOOM;
        sdiCellLayer.clearLayers();
        data.cells.forEach((cell) => {
            L.polygon(cell.ring, {
                color: '#2f6ded', weight: filled ? 1 : 1.5, opacity: 0.5,
                fillColor: cellColor(cell.count),
                fillOpacity: filled ? 0.3 : 0,
                fill: true,
            })
                // 클릭은 지도로 흘려보낸다 - 어디를 눌러도 그 타일이 조회되는 게
                // 이 툴의 기본 동작이다. 호버 툴팁만 셀이 담당한다.
                .bindTooltip(`SDI 셀 ${cell.key} · 메시 ${cell.mesh}<br>SDI ${fmtNum(cell.count)}건`)
                .on('click', (event) => onMapClick(event))
                .addTo(sdiCellLayer);
        });
    } catch (ex) {
        // 아직 못 받았거나 범위 밖 - 조용히 넘어간다.
    } finally {
        vsmCellsLoading = false;
    }
}

// --- 선택한 타일의 SDI ---
// 메시 하나를 통째로 보면 1,000건이 넘어 원래 크기로는 서로 덮는다.
// 줌에 맞춰 줄여서 개수는 유지하되 형태가 남게 한다.
function vsmPointSize(zoom, exact) {
    if (zoom >= 15) return exact ? 30 : 22;
    if (zoom >= 13) return exact ? 24 : 18;
    if (zoom >= 12) return exact ? 17 : 13;
    return exact ? 12 : 9;
}

function vsmPointIcon(point) {
    const zoom = map.getZoom();
    const size = vsmPointSize(zoom, point.exact);
    const url = safeDriveIconUrl(point.type);
    // 제한속도 배지는 작게 그리면 읽히지도 않고 아이콘만 가린다.
    const badge = point.speed_limit && zoom >= 14
        ? `<div class="sdi-badge">${point.speed_limit}</div>` : '';
    // 설치점이 아닌 것(안내점)은 흐리게. 카메라 하나에 보통 둘씩 붙는다.
    const cls = point.exact ? 'sdi-pin' : 'sdi-pin ahead';
    const body = url
        ? `<img src="${url}" width="${size}" height="${size}" style="display:block">${badge}`
        : `<span class="type-chip${size < 17 ? ' dot' : ''}">`
          + `${size < 17 ? '' : (point.type_name || '').slice(0, 2)}</span>${badge}`;
    return L.divIcon({
        className: '',
        html: `<div class="${cls}" style="width:${size}px;height:${size}px">${body}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}

function vsmPointPopup(point) {
    const rows = [
        ['타입', `${point.type} · ${point.type_name}`],
        ['지점', point.exact ? '설치점' : '안내점'],
    ];
    if (point.speed_limit) rows.push(['제한속도', `${point.speed_limit} km/h`]);
    rows.push(['좌표', `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`]);
    rows.push(['방위각', `${point.angle}°`]);
    rows.push(['셀', String(point.cell)]);
    rows.push(['원본', `<code>${point.raw}</code>`]);
    return '<div class="sdi-popup"><div class="title">'
        + `${point.type_name}</div>`
        + rows.map(([k, v]) => `<div class="row"><span>${k}</span>${v}</div>`).join('')
        + '</div>';
}

function setVsmPointHint(message) {
    const box = $('vsmPointHint');
    box.innerHTML = message || '';
    box.hidden = !message;
}

async function refreshVsmPoints() {
    if (!vsmPointLayer) return;

    if (!vsmStatus || !$('toggleVsmPoints').checked) {
        vsmPointLayer.clearLayers();
        setVsmPointHint('');
        return;
    }
    if (!currentTarget) {
        // 안내 문구는 검색 카드의 입력 형식 쪽이 맡는다.
        vsmPointLayer.clearLayers();
        setVsmPointHint('');
        return;
    }
    if (!currentCell) {
        vsmPointLayer.clearLayers();
        setVsmPointHint('');
        return;
    }
    if (map.getZoom() < VSM_POINT_MIN_ZOOM) {
        vsmPointLayer.clearLayers();
        setVsmPointHint(`줌 ${VSM_POINT_MIN_ZOOM} 이상에서 표시됩니다 (현재 ${map.getZoom()}).`);
        return;
    }
    if (vsmPointsLoading) return;

    vsmPointsLoading = true;
    try {
        const data = await getJson(API_BASE + `/api/vsm/points?cell=${currentCell.key}`);
        const exactOnly = $('toggleExactOnly').checked;
        const shown = exactOnly ? data.points.filter((p) => p.exact) : data.points;

        vsmPointLayer.clearLayers();
        shown.forEach((point) => {
            L.marker([point.lat, point.lon], { icon: vsmPointIcon(point) })
                .bindPopup(vsmPointPopup(point))
                .addTo(vsmPointLayer);
        });

        const exact = data.points.filter((p) => p.exact).length;
        setVsmPointHint(data.points.length
            ? `메시 ${currentCell.mesh} SDI <b>${fmtNum(data.points.length)}건</b>`
              + ` · 설치점 <b>${exact}건</b>`
              + (exactOnly ? ' <span class="sub">(설치점만)</span>' : '')
            : `메시 ${currentCell.mesh} 에는 SDI 가 없습니다.`);
    } catch (ex) {
        setVsmPointHint(ex.message);
    } finally {
        vsmPointsLoading = false;
    }
}

// 조회 결과 카드에 그 타일이 속한 SDI 셀을 덧붙인다.
function renderCellInfo(cell) {
    if (!cell) return '';
    const count = cell.count === null
        ? '<span class="sub">-</span>'
        : (cell.in_db ? `${fmtNum(cell.count)}건` : '<span class="sub">DB 에 없는 셀</span>');
    return `<dt>SDI 셀</dt><dd>${cell.key} · ${count}</dd>`;
}

async function refreshVsm() {
    await Promise.all([refreshSdiCells(), refreshVsmPoints()]);
}

function bindVsm() {
    sdiCellLayer = L.layerGroup().addTo(map);
    vsmPointLayer = L.layerGroup().addTo(map);
    $('toggleSdiCells').addEventListener('change', (event) => {
        if (event.target.checked) { map.addLayer(sdiCellLayer); refreshSdiCells(); }
        else map.removeLayer(sdiCellLayer);
    });
    $('toggleVsmPoints').addEventListener('change', (event) => {
        if (event.target.checked) map.addLayer(vsmPointLayer);
        else map.removeLayer(vsmPointLayer);
        refreshVsmPoints();
    });
    $('toggleExactOnly').addEventListener('change', refreshVsmPoints);
    map.on('moveend', refreshVsm);
}
