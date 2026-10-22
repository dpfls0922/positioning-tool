// 도로 레이어 타일의 SDI2(진짜 타입, 후면 포함) + CAM_REF_LINK(구간단속 경로).
// 선택한 타일 주변 3x3 을 서버(/api/tile/sdi2)에서 받아 그린다.
// 서버는 SDI2 스택을 우선 쓰고, 구버전 맵이라 없으면 SDI 스택으로 폴백한다.
let tileSdi2Layer = null;          // SDI2 마커
let camRefLayer = null;            // CAM_REF_LINK 구간 경로
let tileSdi2Data = null;           // 마지막 /api/tile/sdi2 응답
let tileSdi2Loading = false;
const tileSdi2HiddenTypes = new Set();   // 분류 필터에서 끈 타입들

function tileSdi2Icon(point) {
    const zoom = map.getZoom();
    const size = vsmPointSize(zoom, point.exact);
    const url = safeDriveIconUrl(point.type);
    const badge = point.speed_limit && zoom >= 14
        ? `<div class="sdi-badge">${point.speed_limit}</div>` : '';
    let cls = point.exact ? 'sdi-pin' : 'sdi-pin ahead';
    if (point.rear) cls += size >= 17 ? ' rear rear-tag' : ' rear';
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

function tileSdi2Popup(point, stackCode) {
    const rows = [
        ['타입', `${point.type} · ${point.type_name}`],
        ['지점', point.exact ? '설치점' : '안내점'],
    ];
    if (point.speed_limit) rows.push(['제한속도', `${point.speed_limit} km/h`]);
    rows.push(['좌표', `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`]);
    rows.push(['방위각', `${point.angle}°`]);
    rows.push(['PT_ID', String(point.pt_id)]);
    rows.push(['링크', String(point.link_id)]);
    rows.push(['출처', `${stackCode} 스택 (도로 타일)`]);
    return `<div class="sdi-popup"><div class="title">${point.type_name}`
        + (point.rear ? ' <span style="color:#e11d48">후면</span>' : '') + '</div>'
        + rows.map(([k, v]) => `<div class="row"><span>${k}</span>${v}</div>`).join('')
        + '</div>';
}

// 클릭으로 선택한 구간(GROUP_ID). 선택된 구간은 파란 실선으로 하이라이트.
let selectedSectionId = null;

function sectionPolyline(section, baseColor) {
    const selected = section.group_id === selectedSectionId;
    const name = (section.start_type && SDI2_SECTION_NAMES[section.start_type]) || '구간단속';
    const line = L.polyline(section.path, {
        pane: 'sectionPane',
        color: selected ? '#2563eb' : baseColor,
        weight: selected ? 7 : 4,
        opacity: selected ? 0.95 : 0.8,
        lineCap: 'round',
        lineJoin: 'round',
        dashArray: selected ? null : '1 9',
    });
    line.bindTooltip(`${name} 구간`
        + (section.distance_m ? ` · ${(section.distance_m / 1000).toFixed(1)} km` : '')
        + (section.speed_limit ? ` · 제한 ${section.speed_limit} km/h` : '')
        + (section.end_type ? '' : '<br><span class="sub">종점 카메라가 지도 데이터에 없는 구간</span>')
        + `<br><span class="sub">GROUP_ID ${section.group_id} · 클릭하여 ${selected ? '해제' : '하이라이트'}</span>`);
    line.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        selectedSectionId = selected ? null : section.group_id;
        renderTileSdi2();
        renderNational();
    });
    return line;
}

// 종점 카메라가 데이터에 없어 스냅하지 못한 구간의 끝 표식.
function sectionEndMarker(section) {
    if (section.end_type) return null;
    const end = section.path[section.path.length - 1];
    return L.circleMarker(end, {
        pane: 'sectionPane', radius: 5, color: '#e11d48', weight: 2,
        fillColor: '#fff', fillOpacity: 1,
    }).bindTooltip('단속 종료 지점 - 종점 카메라(SDI)가 지도 데이터에 없음');
}

// 구간 시점 타입 -> 구간 이름
const SDI2_SECTION_NAMES = {
    22: '구간단속',
    27: '가변단속',
    48: '후면신호과속구간단속',
    50: '후면구간단속',
    52: '신호과속구간단속',
};

// 분류(타입별) 체크박스 목록. 현재 데이터에 있는 타입만, 건수와 함께 보여준다.
function renderTileSdi2Cats() {
    const box = $('tileSdi2Cats');
    if (!box) return;
    if (!tileSdi2Data || !$('toggleTileSdi2').checked) {
        box.hidden = true;
        return;
    }

    const counts = new Map();
    tileSdi2Data.points.forEach((p) => {
        const entry = counts.get(p.type) || { name: p.type_name, count: 0, rear: p.rear };
        entry.count += 1;
        counts.set(p.type, entry);
    });
    if (!counts.size) {
        box.hidden = true;
        return;
    }

    const rows = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([type, info]) =>
        `<label><input type="checkbox" class="sdi2-cat" data-type="${type}"`
        + `${tileSdi2HiddenTypes.has(type) ? '' : ' checked'}>`
        + `${info.rear ? '<span style="color:#e11d48">' : ''}${info.name} (${type})`
        + `${info.rear ? '</span>' : ''} · ${info.count}건</label>`);
    box.innerHTML = '<div class="cats-tools"><a href="#" data-act="all">모두 켜기</a>'
        + '<a href="#" data-act="none">모두 끄기</a></div>' + rows.join('');
    box.hidden = false;

    box.querySelectorAll('.sdi2-cat').forEach((check) => {
        check.addEventListener('change', () => {
            const type = Number(check.dataset.type);
            if (check.checked) tileSdi2HiddenTypes.delete(type);
            else tileSdi2HiddenTypes.add(type);
            renderTileSdi2();
        });
    });
    box.querySelectorAll('.cats-tools a').forEach((a) => {
        a.addEventListener('click', (ev) => {
            ev.preventDefault();
            if (a.dataset.act === 'all') tileSdi2HiddenTypes.clear();
            else counts.forEach((_, type) => tileSdi2HiddenTypes.add(type));
            renderTileSdi2();
            renderTileSdi2Cats();
        });
    });
}

// 받은 데이터를 현재 토글/분류 필터에 맞춰 다시 그린다 (재조회 없음).
function renderTileSdi2() {
    if (!tileSdi2Layer) return;
    const hintBox = $('tileSdi2Hint');
    tileSdi2Layer.clearLayers();
    camRefLayer.clearLayers();

    if (!$('toggleTileSdi2').checked || !tileSdi2Data) {
        hintBox.hidden = true;
        $('tileSdi2Cats').hidden = true;
        return;
    }

    const data = tileSdi2Data;
    const stackCode = data.layer.sdi_stack || 'SDI2';
    const shown = data.points.filter((p) => p.lat !== null && !tileSdi2HiddenTypes.has(p.type));
    shown.forEach((point) => {
        L.marker([point.lat, point.lon], { icon: tileSdi2Icon(point) })
            .bindPopup(tileSdi2Popup(point, stackCode))
            .addTo(tileSdi2Layer);
    });

    let sectionCount = 0;
    if ($('toggleCamRef').checked) {
        data.sections.forEach((section) => {
            // 시점 타입을 분류 필터에서 껐으면 그 구간 경로도 같이 숨긴다.
            if (section.start_type && tileSdi2HiddenTypes.has(section.start_type)) return;
            sectionCount += 1;
            sectionPolyline(section, section.rear ? '#e11d48' : '#ea580c').addTo(camRefLayer);
            const endMark = sectionEndMarker(section);
            if (endMark) endMark.addTo(camRefLayer);
        });
    }

    const tile = currentTarget ? currentTarget.tile : null;
    const rear = data.points.filter((p) => p.rear).length;
    const stackNote = stackCode === 'SDI2' ? '' : ' <span class="sub">(SDI2 없음 - SDI 폴백)</span>';
    hintBox.innerHTML = (tile ? `타일 ${tile.x},${tile.y} 주변 3×3` : '')
        + ` · ${stackCode} <b>${fmtNum(shown.length)}/${fmtNum(data.points.length)}건</b>${stackNote}`
        + (rear ? ` · <span style="color:#e11d48">후면 <b>${rear}건</b></span>` : '')
        + ` · 구간 <b>${sectionCount}개</b>`
        + `<br><span class="sub">타일 ${data.layer.tile_version} · sdi ${data.layer.sdi_version}</span>`;
    hintBox.hidden = false;
}

async function refreshTileSdi2(refetch = false) {
    if (!tileSdi2Layer) return;

    if (!$('toggleTileSdi2').checked || !currentTarget) {
        tileSdi2Data = null;
        renderTileSdi2();
        return;
    }
    if (!refetch && tileSdi2Data) {
        renderTileSdi2();
        return;
    }
    if (tileSdi2Loading) return;
    tileSdi2Loading = true;
    try {
        const tile = currentTarget.tile;
        tileSdi2Data = await getJson(API_BASE + `/api/tile/sdi2?x=${tile.x}&y=${tile.y}&r=1`);
        renderTileSdi2();
        renderTileSdi2Cats();
    } catch (ex) {
        const hintBox = $('tileSdi2Hint');
        hintBox.innerHTML = ex.message;
        hintBox.hidden = false;
    } finally {
        tileSdi2Loading = false;
    }
}

// ===== 전국 후면·구간단속 =====
// /api/tile/national - SAFE_DRIVE_DB의 구간단속 위치로 후보 타일(약 1,500장)을
// 골라 SDI2/CAM_REF_LINK 를 전국 단위로 모은 것. 최초 호출만 오래 걸린다(~1분).
let natData = null;
let natLoading = false;
let natRearLayer = null;      // 전국 후면 SDI 마커
let natSectionLayer = null;   // 전국 구간단속 경로
let natCellLayer = null;      // 셀 밀도(후면/구간 수)

const NAT_CELL_STEPS = [
    { upto: 1, color: '#fecaca' },
    { upto: 2, color: '#fca5a5' },
    { upto: 4, color: '#f87171' },
    { upto: 7, color: '#ef4444' },
    { upto: Infinity, color: '#b91c1c' },
];

function natEnabledTypes() {
    const enabled = new Set();
    document.querySelectorAll('#natRearCats .nat-rear-cat').forEach((box) => {
        if (!box.checked) return;
        box.dataset.types.split(',').forEach((t) => enabled.add(Number(t)));
    });
    return enabled;
}

function renderNational() {
    if (!natRearLayer) return;
    const hintBox = $('natHint');
    natRearLayer.clearLayers();
    natSectionLayer.clearLayers();
    natCellLayer.clearLayers();

    const rearOn = $('toggleNatRear').checked;
    const cellsOn = $('toggleNatCells').checked;
    $('natRearCats').hidden = !rearOn;

    if (!natData || (!rearOn && !cellsOn)) {
        hintBox.hidden = !natLoading;
        return;
    }

    const enabled = natEnabledTypes();
    let rearShown = 0;
    if (rearOn) {
        natData.points.forEach((point) => {
            if (!point.rear || point.lat === null || !enabled.has(point.type)) return;
            rearShown += 1;
            L.marker([point.lat, point.lon], { icon: tileSdi2Icon(point) })
                .bindPopup(tileSdi2Popup(point, natData.layer.sdi_stack || 'SDI2'))
                .addTo(natRearLayer);
        });
    }

    let sectionShown = 0;
    natData.sections.forEach((section) => {
        // 전국 레이어에서는 후면 구간만 그린다 (일반 구간은 선택 타일 조회에서).
        if (!rearOn || !section.rear) return;
        if (section.start_type && !enabled.has(section.start_type)) return;
        sectionShown += 1;
        sectionPolyline(section, '#e11d48').addTo(natSectionLayer);
        const endMark = sectionEndMarker(section);
        if (endMark) endMark.addTo(natSectionLayer);
    });

    if (cellsOn) {
        natData.cells.forEach((cell) => {
            const count = cell.section_count + cell.rear_count;
            const step = NAT_CELL_STEPS.find((entry) => count <= entry.upto);
            L.polygon(cell.ring, {
                color: '#b91c1c', weight: 1, opacity: 0.5,
                fillColor: step.color, fillOpacity: 0.35,
            })
                .bindTooltip(`셀 ${cell.key} · 메시 ${cell.mesh}`
                    + `<br>구간단속 ${cell.section_count}개 · 후면 SDI ${cell.rear_count}건`)
                .on('click', (event) => onMapClick(event))
                .addTo(natCellLayer);
        });
    }

    const rearTotal = natData.points.filter((p) => p.rear).length;
    const rearSecTotal = natData.sections.filter((s) => s.rear).length;
    hintBox.innerHTML = `전국 후면 SDI <b>${fmtNum(rearTotal)}건</b>`
        + ` · 후면 구간 <b>${rearSecTotal}개</b>`
        + (rearOn ? `<br>표시: 후면 ${fmtNum(rearShown)}건 · 구간 ${fmtNum(sectionShown)}개` : '')
        + `<br><span class="sub">후보 타일 ${fmtNum(natData.tile_count)}장 기준`
        + ' · 후면 지점단속(40/41)은 구간단속 주변 타일에서 발견된 것만</span>';
    hintBox.hidden = false;
}

async function ensureNational() {
    if (natData || natLoading) {
        renderNational();
        return;
    }
    natLoading = true;
    const hintBox = $('natHint');
    hintBox.innerHTML = '전국 타일 스캔 중… (최초 1회 약 1분, 이후 캐시)';
    hintBox.hidden = false;
    try {
        natData = await getJson(API_BASE + '/api/tile/national');
    } catch (ex) {
        hintBox.innerHTML = ex.message;
        natLoading = false;
        return;
    }
    natLoading = false;
    renderNational();
}

function onNatToggle() {
    const anyOn = $('toggleNatRear').checked || $('toggleNatCells').checked;
    if (anyOn && !natData) ensureNational();
    else renderNational();
}

// 푸터에 도로 레이어 conf 정보를 띄운다. 마우스를 올리면 앱 레이어/스택 전체 목록.
async function renderRoadTileStatus() {
    const box = $('roadTileStatus');
    if (!box) return;
    try {
        const st = await getJson(API_BASE + '/api/tile/status');
        const stacks = (st.stacks || []).map((s) => `${s.id} ${s.code} ${s.name}`).join('\n');
        const layersList = (st.app_layers || []).map((l) => `${l.id} ${l.name} v${l.version}`).join('\n');
        box.innerHTML = ` · ${st.layer_name} v${st.layer_version}`
            + ` <span class="tag">타일 ${st.tile_version}</span>`
            + ` · SDI 스택: ${st.sdi_stack}`;
        box.title = `TMAP_AUTO_BENZ.conf 레이어\n${layersList}\n\n도로 레이어 스택 (sdiVersion ${st.sdi_version})\n${stacks}`;
    } catch (ex) {
        box.innerHTML = ' · <span class="vsm-error">도로 레이어 conf 조회 실패</span>';
        box.title = ex.message;
    }
}

function bindRoadTile() {
    // 구간 경로 전용 pane - 마커(pane z600)보다 위에 그려 밀집 지역에서도 보이게 한다.
    map.createPane('sectionPane');
    map.getPane('sectionPane').style.zIndex = 620;
    camRefLayer = L.layerGroup().addTo(map);
    tileSdi2Layer = L.layerGroup().addTo(map);
    natCellLayer = L.layerGroup().addTo(map);
    natSectionLayer = L.layerGroup().addTo(map);
    natRearLayer = L.layerGroup().addTo(map);
    $('toggleTileSdi2').addEventListener('change', () => {
        renderTileSdi2();
        renderTileSdi2Cats();
        if ($('toggleTileSdi2').checked && !tileSdi2Data) refreshTileSdi2(true);
    });
    $('toggleCamRef').addEventListener('change', renderTileSdi2);
    $('toggleNatRear').addEventListener('change', () => {
        // 전국 후면 레이어를 켜면 타일 SDI2 마커는 겹쳐 보이므로 기본으로 끈다.
        if ($('toggleNatRear').checked && $('toggleTileSdi2').checked) {
            $('toggleTileSdi2').checked = false;
            renderTileSdi2();
            renderTileSdi2Cats();
        }
        onNatToggle();
    });
    $('toggleNatCells').addEventListener('change', onNatToggle);
    document.querySelectorAll('#natRearCats .nat-rear-cat').forEach((box) => {
        box.addEventListener('change', renderNational);
    });
    document.querySelectorAll('#natRearCats .cats-tools a').forEach((a) => {
        a.addEventListener('click', (ev) => {
            ev.preventDefault();
            const on = a.dataset.act === 'all';
            document.querySelectorAll('#natRearCats .nat-rear-cat').forEach((box) => {
                box.checked = on;
            });
            renderNational();
        });
    });
    // 줌이 바뀌면 마커 크기를 다시 계산한다 (데이터는 캐시 그대로).
    map.on('zoomend', () => { renderTileSdi2(); renderNational(); });
    renderRoadTileStatus();
}
