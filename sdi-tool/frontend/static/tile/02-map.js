// 지도와 격자. 격자는 화면에 보이는 범위만 그린다 - z15 타일은 전 세계에
// 10억 개가 넘으므로 전부 그릴 수 없다.
const BASE_LAYERS = {
    'Tmap': L.tileLayer('http://tlpimg1.tmap.co.kr/tms/1.0.0/hd_tile/{z}/{x}/{-y}.png', {
        maxZoom: 19, attribution: 'Tmap',
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: 'OSM',
    }),
    'Google Maps': L.tileLayer('http://mt0.google.com/vt/lyrs=m&hl=ko&x={x}&y={y}&z={z}', {
        maxZoom: 20, attribution: 'Google',
    }),
};

// 격자 선이 서로 붙어 버리기 전까지만 그린다.
const TILE_GRID_MIN_ZOOM = 12;
const MESH_GRID_MIN_ZOOM = 8;
const GRID_MAX_CELLS = 900;

function tileDim(zoom) {
    return Math.pow(2, zoom);
}

function tileFromLatLng(lat, lng, zoom) {
    const n = tileDim(zoom);
    const latRad = Math.max(Math.min(lat, 85.05112878), -85.05112878) * Math.PI / 180;
    return {
        x: Math.floor((lng + 180) / 360 * n),
        y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n),
    };
}

function tileBounds(x, y, zoom) {
    const n = tileDim(zoom);
    const lat = (ty) => Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
    return L.latLngBounds(
        [lat(y + 1), x / n * 360 - 180],
        [lat(y), (x + 1) / n * 360 - 180],
    );
}

function tileIdOf(x, y) {
    return y * 100000 + x;
}

function initMap() {
    map = L.map('map', {
        center: [37.5665, 126.9780],
        zoom: 15,
        layers: [BASE_LAYERS['Tmap']],
        zoomControl: true,
    });
    L.control.layers(BASE_LAYERS, null, { position: 'topleft' }).addTo(map);

    tileGridLayer = L.layerGroup().addTo(map);
    meshGridLayer = L.layerGroup().addTo(map);
    sdiTileLayer = L.layerGroup().addTo(map);
    sdiMarkerLayer = L.layerGroup().addTo(map);
    targetLayer = L.layerGroup().addTo(map);

    map.on('moveend zoomend', redrawGrids);
    // 줌이 바뀌면 VSM SDI 의 표시 조건(줌 하한)이 달라진다.
    map.on('zoomend', () => refreshVsmPoints());
    map.on('mousemove', onMapHover);
    map.on('click', onMapClick);

    bindLayerToggles();
    window.addEventListener('resize', () => map.invalidateSize());
    redrawGrids();
}

function bindLayerToggles() {
    const pairs = [
        ['toggleTileGrid', () => tileGridLayer],
        ['toggleMeshGrid', () => meshGridLayer],
        ['toggleSdiTiles', () => sdiTileLayer],
        ['toggleSdi', () => sdiMarkerLayer],
    ];
    pairs.forEach(([id, get]) => {
        $(id).addEventListener('change', (event) => {
            if (event.target.checked) {
                map.addLayer(get());
            } else {
                map.removeLayer(get());
            }
        });
    });
}

function redrawGrids() {
    drawTileGrid();
    drawMeshGrid();
}

function drawTileGrid() {
    tileGridLayer.clearLayers();
    const zoom = map.getZoom();
    if (zoom < TILE_GRID_MIN_ZOOM) return;

    const view = map.getBounds();
    const nw = tileFromLatLng(view.getNorth(), view.getWest(), TILE_ZOOM_DEFAULT);
    const se = tileFromLatLng(view.getSouth(), view.getEast(), TILE_ZOOM_DEFAULT);
    const cells = (se.x - nw.x + 1) * (se.y - nw.y + 1);
    if (cells > GRID_MAX_CELLS) return;

    const showLabel = zoom >= 14;
    for (let x = nw.x; x <= se.x; x += 1) {
        for (let y = nw.y; y <= se.y; y += 1) {
            const bounds = tileBounds(x, y, TILE_ZOOM_DEFAULT);
            L.rectangle(bounds, {
                color: '#0ea5e9', weight: 1, opacity: 0.45,
                fill: false, interactive: false,
            }).addTo(tileGridLayer);
            if (showLabel) {
                L.marker(bounds.getNorthWest(), {
                    interactive: false,
                    icon: L.divIcon({
                        className: 'tile-label',
                        html: `${x},${y}`,
                        iconSize: [70, 14],
                        iconAnchor: [-3, -2],
                    }),
                }).addTo(tileGridLayer);
            }
        }
    }
}

// 메시 격자는 서버에서 받아 온다 - Bessel 좌표계 변환이 필요해 브라우저에서
// 다시 구현하지 않는다.
const meshRingCache = new Map();

async function drawMeshGrid() {
    meshGridLayer.clearLayers();
    if (map.getZoom() < MESH_GRID_MIN_ZOOM) return;

    const view = map.getBounds();
    // 메시는 약 11km x 9km 라 화면 네 귀퉁이 + 중심만 물어봐도 대부분 덮인다.
    const probes = [
        [view.getNorth(), view.getWest()], [view.getNorth(), view.getEast()],
        [view.getSouth(), view.getWest()], [view.getSouth(), view.getEast()],
        [view.getCenter().lat, view.getCenter().lng],
    ];

    const rings = await Promise.all(probes.map(([lat, lon]) => fetchMeshRing(lat, lon)));
    const seen = new Set();
    rings.filter(Boolean).forEach((mesh) => {
        if (seen.has(mesh.code)) return;
        seen.add(mesh.code);
        L.polygon(mesh.ring, {
            color: '#7c3aed', weight: 1.4, opacity: 0.7, dashArray: '6 4',
            fill: false, interactive: false,
        }).addTo(meshGridLayer);
        L.marker(mesh.ring[3], {
            interactive: false,
            icon: L.divIcon({
                className: 'mesh-label',
                html: `mesh ${mesh.code}`,
                iconSize: [80, 14],
                iconAnchor: [-4, -3],
            }),
        }).addTo(meshGridLayer);
    });
}

async function fetchMeshRing(lat, lon) {
    try {
        const data = await getJson(API_BASE + `/api/cell?lat=${lat}&lon=${lon}`);
        const mesh = data.mesh;
        meshRingCache.set(mesh.code, mesh.ring);
        return mesh;
    } catch (ex) {
        return null;
    }
}

function onMapHover(event) {
    const { lat, lng } = event.latlng;
    $('curLatLng').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const tile = tileFromLatLng(lat, lng, TILE_ZOOM_DEFAULT);
    $('curTile').textContent = `${tile.x},${tile.y} (id ${tileIdOf(tile.x, tile.y)})`;
    scheduleMeshProbe(lat, lng);
}

// 메시 코드는 좌표 변환이 필요해 서버에 물어본다. 마우스가 멈춘 뒤에만
// 요청해서 hover 마다 호출이 나가지 않게 한다.
let meshProbeTimer = null;
function scheduleMeshProbe(lat, lng) {
    clearTimeout(meshProbeTimer);
    meshProbeTimer = setTimeout(async () => {
        const mesh = await fetchMeshRing(lat, lng);
        $('curMesh').textContent = mesh ? String(mesh.code) : '-';
    }, 120);
}

// 지도(=타일) 아무 데나 클릭하면 그 타일을 조회한다. 이 툴에서 SDI 를 보는
// 기본 동작이라 별도 모드 없이 항상 켜 둔다.
function onMapClick(event) {
    const { lat, lng } = event.latlng;
    $('searchBox').value = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    runSearch();
}
