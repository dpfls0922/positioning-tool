// SDI 마커와 목록. 아이콘은 기존 툴이 VSM 리소스에서 받아 둔 것을 그대로 쓴다.
const SDI_ICON_DIR = '/static/img/sdi/';
const SDI_ICON_ASSET = {
    0: 'SDI_SPEED_ACCIDENT_POS',
    1: 'SDI_SPEED_LIMIT_POS',
    2: 'SDI_SPEED_BLOCK_START_POS',
    3: 'SDI_SPEED_BLOCK_END_POS',
    5: 'SDI_TAIL',
    6: 'SDI_SIGNAL_ACCIDENT_POS',
    7: 'SDI_SPEED_LIMIT_DANGEROUS_AREA',
    8: 'SDI_BOX_SPEED_LIMIT_POS',
    12: 'SDI_CHANGEROAD_POS',
    13: 'SDI_ROAD_CONTROL_POS',
    15: 'SDI_TRAFFICINFO_COLLECT_POS',
    16: 'SDI_CCTV_AREA',
    18: 'SDI_LOAD_BAD_CONTROL_POS',
    19: 'SDI_PARKING_CONTROL_POS',
    21: 'SDI_RAILWAY_CROSSING',
    22: 'SDI_SCHOOL_ZONE_START',
    24: 'SDI_SPEEDBUMP',
    29: 'SDI_FOG_AREA',
    31: 'SDI_ACCIDEDNT_AREA',
    32: 'SDI_SHARP_CURVE_AREA',
    33: 'SDI_SHARP_CURVE_AREA',
    47: 'SDI_ACCIDEDNT_AREA',
    62: 'SDI_ACCIDEDNT_AREA',
    63: 'SDI_ACCIDEDNT_AREA',
    64: 'SDI_ACCIDEDNT_AREA',
    66: 'SDI_REST_PLACE',
};
function sdiAsset(sdiType) {
    return SDI_ICON_ASSET[Number(sdiType)] || null;
}

function sdiIconUrl(sdiType) {
    const asset = sdiAsset(sdiType);
    // 전용 이미지가 없는 타입에 아무 이미지나 붙이면 다른 표지로 읽힌다.
    // 그런 타입은 호출부에서 글자 칩으로 그린다.
    return asset ? SDI_ICON_DIR + asset + '.png' : null;
}

// 타입은 아는데 전용 이미지가 없는 경우엔 이름 두 글자를 딴 칩으로 그린다.
function sdiTypeChipLabel(point) {
    const name = point.sdi_type_name || '';
    return name.slice(0, 2) || String(point.sdi_type);
}

function sdiFigureHtml(point, size) {
    const url = sdiIconUrl(point.sdi_type);
    const limit = Number(point.speed);
    const badge = Number.isFinite(limit) && limit > 0
        ? `<div class="sdi-badge">${limit}</div>` : '';
    if (url) {
        return `<img src="${url}" width="${size}" height="${size}" style="display:block">${badge}`;
    }
    return `<span class="type-chip">${sdiTypeChipLabel(point)}</span>${badge}`;
}

function sdiMarkerIcon(point) {
    const size = 26;
    // 한 번도 선택되지 않은 SDI 는 흐리게 - 타일 안에 있어도 안내는 안 된 것들이다.
    const dim = point.ever_selected ? '' : 'opacity:0.45;';
    return L.divIcon({
        className: '',
        html: `<div class="sdi-pin" style="width:${size}px;height:${size}px;${dim}">`
            + sdiFigureHtml(point, size) + '</div>',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}

function sdiPopupHtml(point) {
    const rows = [
        ['타입', `${point.sdi_type} · ${point.sdi_type_name || '-'}`],
        ['좌표', `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`],
        ['타일', `${point.tile.x},${point.tile.y} (id ${point.tile.id})`],
        ['메시', String(point.mesh_code)],
    ];
    if (point.speed) rows.push(['제한속도', `${point.speed} km/h`]);
    if (point.sdi_code) rows.push(['코드', point.sdi_code]);
    if (point.observation_count) rows.push(['관측', `${point.observation_count}회`]);
    rows.push(['선택', point.ever_selected ? '안내됨' : '안내 안 됨']);
    if (point.skip_reasons.length) rows.push(['제외 사유', point.skip_reasons.join(', ')]);

    return `<div class="sdi-popup"><div class="title">${point.sdi_type_name || 'SDI'}</div>`
        + rows.map(([key, value]) => `<div class="row"><span>${key}</span>${value}</div>`).join('')
        + '</div>';
}

// 로그 SDI 는 개수가 적고 어디를 지났는지가 곧 정보라 전부 그린다.
// (타일 단위로 좁히는 건 VSM 원본 쪽만 한다 - 그쪽은 전국 8만여 건이다)
function renderSdiMarkers(points) {
    sdiMarkerLayer.clearLayers();
    points.forEach((point) => {
        L.marker([point.lat, point.lon], { icon: sdiMarkerIcon(point) })
            .bindPopup(sdiPopupHtml(point))
            .addTo(sdiMarkerLayer);
    });
}

function renderSdiTiles(summary) {
    sdiTileLayer.clearLayers();
    if (!summary) return;
    summary.tiles.forEach((tile) => {
        L.rectangle(tileBounds(tile.x, tile.y, TILE_ZOOM_DEFAULT), {
            color: '#16a34a', weight: 1.5, opacity: 0.8,
            fillColor: '#16a34a', fillOpacity: 0.1,
        })
            .bindTooltip(`타일 ${tile.x},${tile.y} · SDI ${tile.count}개`)
            .on('click', (event) => {
                // 사각형 클릭이 지도 클릭(좌표 검색)까지 타고 올라가지 않게 막는다.
                L.DomEvent.stopPropagation(event);
                $('searchBox').value = `t:${tile.x},${tile.y}`;
                runSearch();
            })
            .addTo(sdiTileLayer);
    });
}

function renderSdiList(points) {
    const card = $('sdiListCard');
    const list = $('sdiList');
    // 로그를 안 올렸으면 이 구역은 아예 두지 않는다(빈 안내문만 남던 자리).
    card.hidden = !sdiSummary;
    if (!sdiSummary) return;
    $('sdiCount').textContent = String(points.length);

    if (!points.length) {
        list.innerHTML = '<div class="empty">이 타일에는 로그 SDI 가 없습니다.</div>';
        return;
    }

    list.innerHTML = points.map((point, index) => {
        const meta = [];
        if (point.speed) meta.push(`${point.speed}km/h`);
        if (point.observation_count) meta.push(`${point.observation_count}회 관측`);
        meta.push(point.ever_selected
            ? '안내됨'
            : '<span class="skipped">안내 안 됨</span>');
        return `<div class="sdi-item" data-index="${index}">`
            + `<span class="sdi-thumb">${sdiFigureHtml(point, 24)}</span>`
            + '<div class="body">'
            + `<div class="name">${point.sdi_type_name || `SDI ${point.sdi_type}`}</div>`
            + `<div class="meta">${meta.join(' · ')}</div>`
            + '</div></div>';
    }).join('');

    list.querySelectorAll('.sdi-item').forEach((node) => {
        node.addEventListener('click', () => {
            const point = points[Number(node.dataset.index)];
            map.setView([point.lat, point.lon], Math.max(map.getZoom(), 17));
            L.popup()
                .setLatLng([point.lat, point.lon])
                .setContent(sdiPopupHtml(point))
                .openOn(map);
        });
    });

}
