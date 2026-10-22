// 검색 -> /api/resolve -> 지도 이동 + 대상 강조 + 그 타일의 SDI 목록.
async function runSearch() {
    const query = $('searchBox').value.trim();
    if (!query) return;

    setSearchError('');
    try {
        const data = await getJson(API_BASE + `/api/resolve?q=${encodeURIComponent(query)}`);
        currentTarget = data.target;
        currentCell = data.cell;
        applyTarget(data.target);
        renderSdiList(data.sdi);
        refreshVsmPoints();
        refreshTileSdi2(true);
    } catch (ex) {
        currentTarget = null;
        targetLayer.clearLayers();
        $('targetCard').hidden = true;
        $('sdiListCard').hidden = true;
        setSearchError(ex.message);
    }
}

function setSearchError(message) {
    const box = $('searchError');
    box.textContent = message;
    box.hidden = !message;
}

function applyTarget(target) {
    targetLayer.clearLayers();
    // 지도가 감춰진 상태에서 만들어졌거나 창 크기가 바뀐 뒤라면 Leaflet 이 들고
    // 있는 크기가 0 일 수 있다. 그대로 fitBounds 하면 최대 줌으로 튀어 버린다.
    map.invalidateSize();

    const tile = target.tile;
    const bounds = L.latLngBounds(
        [tile.bounds.south, tile.bounds.west],
        [tile.bounds.north, tile.bounds.east],
    );

    target.meshes.forEach((mesh) => {
        L.polygon(mesh.ring, {
            color: '#7c3aed',
            weight: mesh.primary ? 2.5 : 1.5,
            opacity: mesh.primary ? 0.95 : 0.5,
            fillColor: '#7c3aed',
            fillOpacity: mesh.primary ? 0.06 : 0,
            interactive: false,
        }).addTo(targetLayer);
    });

    L.rectangle(bounds, {
        color: '#f97316', weight: 3, opacity: 1,
        fillColor: '#f97316', fillOpacity: 0.12,
        interactive: false,
    }).addTo(targetLayer);

    if (target.point) {
        L.circleMarker([target.point.lat, target.point.lon], {
            radius: 5, color: '#f97316', weight: 2,
            fillColor: '#fff', fillOpacity: 1,
        }).addTo(targetLayer);
    }

    // 검색한 대상이 화면에 들어오게 한다. 타일 하나는 아주 작으므로
    // 메시로 찾았을 때는 메시 전체가 보이도록 맞춘다.
    if (target.matched === 'mesh' && target.meshes.length) {
        const primary = target.meshes.find((mesh) => mesh.primary) || target.meshes[0];
        map.fitBounds(L.polygon(primary.ring).getBounds(), { padding: [40, 40] });
    } else {
        // 타일 경계가 화면 안에 다 들어와야 하므로 줌을 강제로 올리지 않는다.
        map.fitBounds(bounds, { padding: [70, 70] });
    }

    renderTargetInfo(target);
}

const MATCHED_LABEL = { latlon: '위경도', tile: '타일 인덱스', mesh: '메시 코드' };

const asRows = (rows) => rows
    .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('');

// 자주 보는 세 줄만 위에 두고, 좌표/범위/id 는 "자세히" 로 접는다.
function renderTargetInfo(target) {
    const tile = target.tile;
    const meshCodes = target.meshes.map((mesh) => mesh.code);
    const primary = target.meshes.find((mesh) => mesh.primary);
    const others = meshCodes.filter((code) => code !== (primary && primary.code));

    $('targetInfo').innerHTML = asRows([
        ['타일', `${tile.x}, ${tile.y} <span class="sub">z${target.zoom}</span>`],
        ['메시', primary
            ? `${primary.code}${others.length ? ` <span class="sub">+ ${others.join(', ')}</span>` : ''}`
            : meshCodes.join(', ')],
    ]) + renderCellInfo(currentCell);

    const more = [
        ['검색', MATCHED_LABEL[target.matched] || target.matched],
        ['타일 id', String(tile.id)],
        ['중심', `${tile.center.lat.toFixed(6)}, ${tile.center.lon.toFixed(6)}`],
        ['범위', `${tile.bounds.south.toFixed(5)} ~ ${tile.bounds.north.toFixed(5)}<br>`
            + `${tile.bounds.west.toFixed(5)} ~ ${tile.bounds.east.toFixed(5)}`],
    ];
    if (target.point) {
        more.splice(1, 0, ['좌표', `${target.point.lat.toFixed(6)}, ${target.point.lon.toFixed(6)}`]);
    }
    $('targetInfoMore').innerHTML = asRows(more);
    $('targetCard').hidden = false;
}

function copyTargetInfo() {
    if (!currentTarget) return;
    const tile = currentTarget.tile;
    const text = [
        `tile ${tile.x},${tile.y} (id ${tile.id}, z${currentTarget.zoom})`,
        `center ${tile.center.lat.toFixed(6)},${tile.center.lon.toFixed(6)}`,
        `mesh ${currentTarget.meshes.map((mesh) => mesh.code).join(', ')}`,
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => {
        const button = $('copyTileBtn');
        const original = button.textContent;
        button.textContent = '복사했습니다';
        setTimeout(() => { button.textContent = original; }, 1200);
    });
}

function clearTarget() {
    currentTarget = null;
    currentCell = null;
    targetLayer.clearLayers();
    $('targetCard').hidden = true;
    $('sdiListCard').hidden = true;
    $('searchBox').value = '';
    setSearchError('');
    refreshVsmPoints();
    refreshTileSdi2(true);
}

function bindSearch() {
    $('searchBtn').addEventListener('click', runSearch);
    $('searchBox').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') runSearch();
    });
    $('copyTileBtn').addEventListener('click', copyTargetInfo);
    $('clearTargetBtn').addEventListener('click', clearTarget);
    $('legendHelpBtn').addEventListener('click', () => {
        const help = $('legendHelp');
        help.hidden = !help.hidden;
    });
}
