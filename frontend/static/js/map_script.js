const map = L.map('map', { preferCanvas: true }).setView([37.5665, 126.9780], 15);
const highlightLayer = L.layerGroup().addTo(map);
const roadCanvasRenderer = L.canvas({ padding: 0.25 });

const baseLayers = {
    "Google Maps": L.tileLayer('http://mt0.google.com/vt/lyrs=m&hl=ko&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        attribution: 'Google Maps'
    }),
    "Google Satellite": L.tileLayer('http://mt0.google.com/vt/lyrs=s&hl=ko&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        attribution: 'Google Satellite'
    }),
    "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 25,
        attribution: '&copy; OpenStreetMap contributors'
    }),
    "Tmap": L.tileLayer('http://tlpimg1.tmap.co.kr/tms/1.0.0/hd_tile/{z}/{x}/{-y}.png', {
        maxZoom: 19,
        attribution: 'Tmap'
    })
};

const overlays = {};
const featureGroups = {};
const slider = document.getElementById('slider');
let layerControl = null;
let baseLayerInitialized = false;

let markers = [];
let polylines = [];
let requestGroups = {};
let activeGroups = new Set();
let layerOrder = [];
let draggedLayerName = null;
let currentResultName = 'result';
let isLayerTreeExpanded = true;
const layerCountOverride = {};

const ROAD_LINK_LAYER = 'Road Link';
const ROAD_NODE_LAYER = 'Road Node';
let roadLinkGeoLayer = null;
let roadNodeGeoLayer = null;
let roadLinkFeatureCount = 0;
let roadNodeFeatureCount = 0;
const ROAD_RENDER_MIN_ZOOM = 16;
let roadMinZoom = ROAD_RENDER_MIN_ZOOM;
let roadLabelZoom = 17;
let roadShapeMetaByKind = { link: null, node: null };
let roadShapePendingLoad = false;
let roadShapeLoading = false;
let roadShapeLoaded = false;
let roadLinkRenderCount = 0;
let roadNodeRenderCount = 0;
const ROAD_LABEL_BIND_LIMIT = 3000;
const ROAD_LINK_QUERY_LIMIT = 12000;
const ROAD_NODE_QUERY_LIMIT = 8000;

const ROAD_LINK_RULES = [
    { key: 'default', label: '일반', color: '#45c976', weight: 2.1 },
    { key: 'tunnel', label: '터널', color: '#57d3c4', weight: 2.1 },
    { key: 'parkingRoad', label: '단지내도로', color: '#f59e0b', weight: 2.1 },
    { key: 'underpass', label: '하부도로(지하도로)', color: '#7c9cff', weight: 2.1 },
    { key: 'overpass', label: '상부도로(고가차도)', color: '#b58cff', weight: 2.1 }
];
const ROAD_LINK_CLASSIFIER_KEYS = ['parkingRoad', 'underpass', 'overpass', 'tunnel'];
const ROAD_NODE_RULES = [
    { key: 'default', label: '노드', color: '#22c3d6' }
];
const DEFAULT_ROAD_LINK_STYLE_FIELDS = [
    'LINK_ID', 'IDXNAME', 'ROAD_CATE', 'LINK_FACIL', 'ST_ND_ID', 'ED_ND_ID',
    'LENGTH', 'ROAD_NO', 'LANE', 'SPEEDLH', 'ONEWAY', 'KEY', 'ROADSTATE',
    'ROADLEVEL', 'LINK_CATE', 'ST_DIR', 'ED_DIR'
];
const roadLinkRuleMap = ROAD_LINK_RULES.reduce((acc, rule) => {
    acc[rule.key] = rule;
    return acc;
}, {});
const roadNodeRuleMap = ROAD_NODE_RULES.reduce((acc, rule) => {
    acc[rule.key] = rule;
    return acc;
}, {});
const roadLinkRuleEnabled = ROAD_LINK_RULES.reduce((acc, rule) => {
    acc[rule.key] = true;
    return acc;
}, {});
const roadNodeRuleEnabled = ROAD_NODE_RULES.reduce((acc, rule) => {
    acc[rule.key] = true;
    return acc;
}, {});
let roadLinkRenderedRuleCounts = {};
let roadNodeRenderedRuleCounts = {};

let roadShapeWorker = null;
let roadShapeQueryRequestId = 0;
let roadShapeLastRenderedRequestId = 0;
let roadQueryDebounceTimer = null;
let roadLabelEnabledForRender = false;
let roadLinkIdLabelEnabled = true;
const ROAD_WORKER_VERSION = Date.now();
let roadShapeAttrRequestSeq = 0;
const roadShapeAttrRequests = new Map();
let roadCustomLinkRuleSeq = 1;
let roadCustomLinkRules = [];
let roadLinkFieldNames = DEFAULT_ROAD_LINK_STYLE_FIELDS.slice();
let roadShapeLocalGroupsByKind = { link: [], node: [] };
let roadLinkBaseStyles = createDefaultRoadLinkBaseStyles();
let roadNodeStyleConfig = {
    radius: 3.2,
    color: '#22c3d6',
    stroke: '#0f8aa6',
    weight: 1
};

const EARTH_RADIUS = 6371000.0;
const DEG2RAD = Math.PI / 180.0;

let distancePickMode = false;
let distanceSelectionMode = 'map';
let pickedDistancePoints = [];
let distanceMarkers = [];
let distanceLabelMarkers = [];
let distanceLine = null;
let distancePreviewLine = null;
let radiusPickMode = false;
let radiusSelectionMode = 'map';
let radiusCenterPoint = null;
let radiusCenterMarker = null;
let radiusCircle = null;
let radiusGuideLine = null;
let radiusDrawState = 'idle';
let radiusDeleteMarker = null;
let parsingProgressTimer = null;
let parsingProgressValue = 0;

const ROAD_SHAPE_CACHE_DIR = 'road_shape_cache_v1';
const ROAD_SHAPE_MANIFEST_SUFFIX = '.manifest.json';
const ROAD_LINK_BASE_STYLE_STORAGE_KEY = 'road_link_base_style_v1';
let roadShapeCacheDirHandlePromise = null;

function init() {
    map.zoomControl.remove();
    initSlider(minTs, maxTs);
    drawPolygons();
    renderFromCurrentData();

    initSidebar();
    initUploadPanel();
    initToolPanels();

    bind('searchButton', 'click', handleDltSearch);
    bind('idSearchButton', 'click', handleIdSearch);
    bind('toolZoomInBtn', 'click', () => map.zoomIn());
    bind('toolZoomOutBtn', 'click', () => map.zoomOut());
    bind('distancePickToggle', 'click', toggleDistancePickMode);
    bind('distancePickReset', 'click', resetDistanceSelection);
    bind('distanceCalcInput', 'click', handleInputDistanceCalculation);
    bind('distanceMode', 'change', handleDistanceModeChange);
    bind('radiusMode', 'change', handleRadiusModeChange);
    bind('radiusPickToggle', 'click', toggleRadiusPickMode);
    bind('radiusApplyButton', 'click', handleRadiusApplyInput);

    document.getElementById('searchBox')?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleDltSearch();
    });
    document.getElementById('idSearchBox')?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleIdSearch();
    });

    ['lat1Input', 'lon1Input', 'lat2Input', 'lon2Input'].forEach(id => {
        document.getElementById(id)?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") handleInputDistanceCalculation();
        });
    });
    ['radiusLatInput', 'radiusLonInput', 'radiusMeterInput'].forEach(id => {
        document.getElementById(id)?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") handleRadiusApplyInput();
        });
    });

    map.on('overlayadd', handleOverlayAdd);
    map.on('overlayremove', handleOverlayRemove);
    map.on('zoomend', handleRoadZoomChanged);
    map.on('moveend', handleRoadZoomChanged);

    map.on('click', (e) => {
        highlightLayer.clearLayers();
        if (distancePickMode && distanceSelectionMode === 'map') {
            handleMapDistancePick(e.latlng);
        }
        if (radiusPickMode && radiusSelectionMode === 'map') {
            handleMapRadiusPick(e.latlng);
        }
    });
    map.on('mousemove', (e) => {
        if (distancePickMode && distanceSelectionMode === 'map') {
            updateDistancePreviewLine(e.latlng);
        }
        if (radiusPickMode && radiusDrawState === 'drawing') {
            updateRadiusPreview(e.latlng, false);
        }
    });
    map.on('contextmenu', (e) => {
        let handled = false;

        if (distancePickMode) {
            handled = true;
            distancePickMode = false;
            setDistancePickButtonState();
            if (distancePreviewLine) {
                map.removeLayer(distancePreviewLine);
                distancePreviewLine = null;
            }
            if (pickedDistancePoints.length === 1) {
                pickedDistancePoints = [];
                clearDistanceVisuals();
                const resultEl = document.getElementById('distanceResult');
                if (resultEl) resultEl.textContent = '거리 결과: 선택 종료(우클릭).';
            }
        }

        if (radiusPickMode) {
            handled = true;
            if (radiusDrawState === 'drawing') {
                updateRadiusPreview(e.latlng, true);
            }
            radiusDrawState = 'idle';
            radiusPickMode = false;
            setRadiusPickButtonState();
        }

        if (handled) {
            L.DomEvent.stop(e);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && radiusPickMode) {
            resetRadiusSelection(false);
            setRadiusResultText('반경 결과: 취소됨(ESC).');
        }
    });

    updateMap();
}

function initSlider(min, max) {
    const startMin = Number.isFinite(min) ? min : 0;
    const startMaxRaw = Number.isFinite(max) ? max : 1;
    const startMax = startMaxRaw <= startMin ? (startMin + 1) : startMaxRaw;

    if (slider.noUiSlider) {
        slider.noUiSlider.destroy();
    }

    noUiSlider.create(slider, {
        start: [startMin, startMax],
        connect: true,
        range: { min: startMin, max: startMax },
        step: 100
    });
    slider.noUiSlider.on('update', updateMap);
    updateRangeLabel(startMin, startMax);
}

function renderFromCurrentData() {
    resetVisualization();
    drawMarkers(markersData);
    drawPolylines(linesData);
    addControlLayers();
    renderLayerControls();
    focusOnInitialView();
    updateMap();
}

function focusOnInitialView() {
    const validCoords = markersData.filter(coord =>
        Number.isFinite(coord.latitude) &&
        Number.isFinite(coord.longitude)
    );
    if (validCoords.length === 0) {
        fitToBounds(featureGroups);
        return;
    }

    const firstCoord = validCoords
        .slice()
        .sort((a, b) => {
            const idA = Number.isFinite(a.id) ? a.id : Number.MAX_SAFE_INTEGER;
            const idB = Number.isFinite(b.id) ? b.id : Number.MAX_SAFE_INTEGER;
            if (idA !== idB) return idA - idB;
            const dltA = Number.isFinite(a.dlt_id) ? a.dlt_id : Number.MAX_SAFE_INTEGER;
            const dltB = Number.isFinite(b.dlt_id) ? b.dlt_id : Number.MAX_SAFE_INTEGER;
            return dltA - dltB;
        })[0];

    map.setView([firstCoord.latitude, firstCoord.longitude], 17);
}

function latLonDistanceMeters(lat1, lon1, lat2, lon2) {
    const localX = -(((lon2 - lon1) * DEG2RAD) * Math.cos(DEG2RAD * lat1)) * EARTH_RADIUS;
    const localY = ((lat2 - lat1) * DEG2RAD) * EARTH_RADIUS;
    return Math.sqrt((localX * localX) + (localY * localY));
}

function updateDistanceResult(pointA, pointB, sourceLabel) {
    const resultEl = document.getElementById('distanceResult');
    if (!resultEl) return;

    const dist = latLonDistanceMeters(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
    resultEl.innerHTML = `거리 결과 (${sourceLabel}): <strong>${dist.toFixed(2)} m</strong><br>` +
        `${formatDistancePoint(pointA, 'A')} / ${formatDistancePoint(pointB, 'B')}`;
}

function updateDistanceResultForPath(sourceLabel) {
    const resultEl = document.getElementById('distanceResult');
    if (!resultEl) return;
    if (!Array.isArray(pickedDistancePoints) || pickedDistancePoints.length < 2) {
        setDistanceGuideMessage();
        return;
    }

    let total = 0;
    for (let i = 1; i < pickedDistancePoints.length; i += 1) {
        const prev = pickedDistancePoints[i - 1];
        const curr = pickedDistancePoints[i];
        total += latLonDistanceMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    }
    resultEl.innerHTML = `거리 결과 (${sourceLabel}): <strong>${total.toFixed(2)} m</strong><br>` +
        `점 ${pickedDistancePoints.length}개 · 우클릭으로 선택 종료`;
}

function setDistancePreviewResult(previewMeters) {
    const resultEl = document.getElementById('distanceResult');
    if (!resultEl) return;
    if (!Array.isArray(pickedDistancePoints) || pickedDistancePoints.length === 0) return;

    let total = 0;
    for (let i = 1; i < pickedDistancePoints.length; i += 1) {
        const prev = pickedDistancePoints[i - 1];
        const curr = pickedDistancePoints[i];
        total += latLonDistanceMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    }
    const segmentText = Number.isFinite(previewMeters)
        ? `상대거리: <strong>${previewMeters.toFixed(2)} m</strong><br>`
        : '';
    resultEl.innerHTML = `${segmentText}총거리: <strong>${total.toFixed(2)} m</strong><br>` +
        `점 ${pickedDistancePoints.length}개 · 우클릭으로 선택 종료`;
}

function clearDistanceVisuals() {
    distanceMarkers.forEach(marker => map.removeLayer(marker));
    distanceMarkers = [];
    distanceLabelMarkers.forEach(marker => map.removeLayer(marker));
    distanceLabelMarkers = [];

    if (distanceLine) {
        map.removeLayer(distanceLine);
        distanceLine = null;
    }
    if (distancePreviewLine) {
        map.removeLayer(distancePreviewLine);
        distancePreviewLine = null;
    }
}

function drawDistanceVisuals() {
    clearDistanceVisuals();

    if (pickedDistancePoints.length === 0) return;

    pickedDistancePoints.forEach((point, idx) => {
        const isStart = idx === 0;
        const marker = L.circleMarker([point.lat, point.lon], {
            radius: 7,
            color: '#7c3aed',
            fillColor: '#ffffff',
            fillOpacity: 0.98,
            weight: 4
        }).addTo(map);
        if (isStart) marker.bindPopup('A');
        distanceMarkers.push(marker);
    });

    if (pickedDistancePoints.length < 2) return;

    const latlngs = pickedDistancePoints.map((point) => [point.lat, point.lon]);
    distanceLine = L.polyline(latlngs, {
        color: '#7c3aed',
        weight: 3,
        opacity: 0.9
    }).addTo(map);

    let cumulative = 0;
    for (let i = 1; i < pickedDistancePoints.length; i += 1) {
        const prev = pickedDistancePoints[i - 1];
        const curr = pickedDistancePoints[i];
        cumulative += latLonDistanceMeters(prev.lat, prev.lon, curr.lat, curr.lon);

        const label = L.marker([curr.lat, curr.lon], {
            icon: L.divIcon({
                className: 'distance-segment-label-wrapper',
                html: `<span class="distance-segment-label">${Math.round(cumulative)}m</span>`,
                iconSize: [0, 0],
                iconAnchor: [-2, 18]
            }),
            interactive: false,
            keyboard: false
        }).addTo(map);
        distanceLabelMarkers.push(label);
    }
}

function setDistancePickButtonState() {
    const toggleBtn = document.getElementById('distancePickToggle');
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('active', distancePickMode);
    toggleBtn.textContent = distancePickMode ? '선택 중지' : '선택 시작';
}

function toggleDistancePickMode() {
    distancePickMode = !distancePickMode;
    setDistancePickButtonState();
    setDistanceGuideMessage();
}

function resetDistanceSelection() {
    pickedDistancePoints = [];
    distancePickMode = false;
    setDistancePickButtonState();
    clearDistanceVisuals();

    const resultEl = document.getElementById('distanceResult');
    if (resultEl) {
        resultEl.textContent = '거리 결과: -';
    }
}

function updateDistancePreviewLine(latlng) {
    if (!distancePickMode || distanceSelectionMode !== 'map') return;
    if (!latlng || !Array.isArray(pickedDistancePoints) || pickedDistancePoints.length === 0) return;

    const last = pickedDistancePoints[pickedDistancePoints.length - 1];
    const meters = latLonDistanceMeters(last.lat, last.lon, latlng.lat, latlng.lng);
    if (!Number.isFinite(meters) || meters <= 0) return;

    if (distancePreviewLine) {
        map.removeLayer(distancePreviewLine);
        distancePreviewLine = null;
    }
    distancePreviewLine = L.polyline([[last.lat, last.lon], [latlng.lat, latlng.lng]], {
        color: '#d946ef',
        weight: 3,
        opacity: 0.9,
        dashArray: '8, 6'
    }).addTo(map);

    setDistancePreviewResult(meters);
}

function handleMapDistancePick(latlng) {
    if (distancePreviewLine) {
        map.removeLayer(distancePreviewLine);
        distancePreviewLine = null;
    }

    pickedDistancePoints.push(buildDistancePoint(latlng.lat, latlng.lng, 'map'));
    drawDistanceVisuals();

    if (pickedDistancePoints.length === 1) {
        setDistanceGuideMessage();
        return;
    }

    updateDistanceResultForPath('지도 점 선택');
}

function parseCoordinateInput(id, min, max) {
    const value = parseFloat(document.getElementById(id)?.value);
    if (!Number.isFinite(value) || value < min || value > max) return null;
    return value;
}

function handleInputDistanceCalculation() {
    const lat1 = parseCoordinateInput('lat1Input', -90, 90);
    const lon1 = parseCoordinateInput('lon1Input', -180, 180);
    const lat2 = parseCoordinateInput('lat2Input', -90, 90);
    const lon2 = parseCoordinateInput('lon2Input', -180, 180);

    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) {
        const resultEl = document.getElementById('distanceResult');
        if (resultEl) {
            resultEl.textContent = '거리 결과: 위도/경도 값을 올바르게 입력하세요.';
        }
        return;
    }

    pickedDistancePoints = [
        buildDistancePoint(lat1, lon1, 'input'),
        buildDistancePoint(lat2, lon2, 'input')
    ];
    drawDistanceVisuals();
    updateDistanceResult(pickedDistancePoints[0], pickedDistancePoints[1], '좌표 입력');
    map.fitBounds([[lat1, lon1], [lat2, lon2]], { padding: [20, 20] });
}

function buildDistancePoint(lat, lon, source, marker = null) {
    return { lat, lon, source, marker };
}

function formatDistancePoint(point, fallbackLabel) {
    if (!point) return fallbackLabel;

    if (point.source === 'marker' && point.marker && point.marker.data) {
        const d = point.marker.data;
        const type = d.type || 'Unknown';
        const id = d.id ?? '-';
        return `${fallbackLabel}[${type} / ID:${id}](${point.lat.toFixed(6)}, ${point.lon.toFixed(6)})`;
    }

    return `${fallbackLabel}(${point.lat.toFixed(6)}, ${point.lon.toFixed(6)})`;
}

function setDistanceGuideMessage() {
    const resultEl = document.getElementById('distanceResult');
    if (!resultEl) return;

    if (!distancePickMode) return;
    if (pickedDistancePoints.length === 0) {
        resultEl.textContent = distanceSelectionMode === 'marker'
            ? '거리 결과: 마커를 클릭해 첫 번째 점(A)을 선택하세요.'
            : '거리 결과: 지도에서 첫 번째 점(A)을 선택하세요.';
        return;
    }

    resultEl.textContent = distanceSelectionMode === 'marker'
        ? '거리 결과: 마커를 계속 클릭해 경로를 추가하세요. 우클릭으로 종료.'
        : '거리 결과: 지도에서 점을 계속 선택하세요. 우클릭으로 종료.';
}

function handleDistanceModeChange() {
    const modeEl = document.getElementById('distanceMode');
    if (!modeEl) return;

    distanceSelectionMode = modeEl.value === 'marker' ? 'marker' : 'map';
    resetDistanceSelection();
}

function setRadiusPickButtonState() {
    const toggleBtn = document.getElementById('radiusPickToggle');
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('active', radiusPickMode);
    toggleBtn.textContent = radiusPickMode ? '선택 중지' : '중심 선택';
}

function handleRadiusModeChange() {
    const modeEl = document.getElementById('radiusMode');
    if (!modeEl) return;
    radiusSelectionMode = modeEl.value === 'marker' ? 'marker' : 'map';
    resetRadiusSelection(false);
}

function toggleRadiusPickMode() {
    radiusPickMode = !radiusPickMode;
    setRadiusPickButtonState();
    if (radiusPickMode) {
        radiusDrawState = 'await_center';
        setRadiusResultText(radiusSelectionMode === 'marker'
            ? '반경 결과: 중심 마커를 선택하세요. 이후 지도에서 반경 끝점을 클릭하세요.'
            : '반경 결과: 중심점을 클릭하세요. 이후 반경 끝점을 클릭해 확정하세요.');
    } else {
        radiusDrawState = 'idle';
    }
}

function resetRadiusSelection(resetInputs = true) {
    radiusPickMode = false;
    radiusDrawState = 'idle';
    setRadiusPickButtonState();
    radiusCenterPoint = null;

    if (radiusCenterMarker) {
        map.removeLayer(radiusCenterMarker);
        radiusCenterMarker = null;
    }
    if (radiusCircle) {
        map.removeLayer(radiusCircle);
        radiusCircle = null;
    }
    if (radiusGuideLine) {
        map.removeLayer(radiusGuideLine);
        radiusGuideLine = null;
    }
    if (radiusDeleteMarker) {
        map.removeLayer(radiusDeleteMarker);
        radiusDeleteMarker = null;
    }
    if (resetInputs) {
        const latInput = document.getElementById('radiusLatInput');
        const lonInput = document.getElementById('radiusLonInput');
        if (latInput) latInput.value = '';
        if (lonInput) lonInput.value = '';
    }
    setRadiusResultText('반경 결과: -');
}

function setRadiusResultText(text) {
    const resultEl = document.getElementById('radiusResult');
    if (resultEl) resultEl.textContent = text;
}

function setRadiusCenter(lat, lon) {
    radiusCenterPoint = { lat, lon };
    const latInput = document.getElementById('radiusLatInput');
    const lonInput = document.getElementById('radiusLonInput');
    if (latInput) latInput.value = lat.toFixed(6);
    if (lonInput) lonInput.value = lon.toFixed(6);

    if (radiusCenterMarker) map.removeLayer(radiusCenterMarker);
    if (radiusCircle) {
        map.removeLayer(radiusCircle);
        radiusCircle = null;
    }
    if (radiusGuideLine) {
        map.removeLayer(radiusGuideLine);
        radiusGuideLine = null;
    }
    if (radiusDeleteMarker) {
        map.removeLayer(radiusDeleteMarker);
        radiusDeleteMarker = null;
    }
    radiusCenterMarker = L.circleMarker([lat, lon], {
        radius: 6,
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.9,
        weight: 2
    }).addTo(map);
}

function drawRadiusCircle(centerLat, centerLon, radiusMeters) {
    if (radiusCircle) map.removeLayer(radiusCircle);
    radiusCircle = L.circle([centerLat, centerLon], {
        radius: radiusMeters,
        color: '#7c3aed',
        fillColor: '#a78bfa',
        fillOpacity: 0.2,
        weight: 2
    }).addTo(map);
}

function drawRadiusGuideLine(centerLat, centerLon, edgeLat, edgeLon) {
    if (radiusGuideLine) map.removeLayer(radiusGuideLine);
    radiusGuideLine = L.polyline([[centerLat, centerLon], [edgeLat, edgeLon]], {
        color: '#d946ef',
        weight: 3,
        opacity: 0.95
    }).addTo(map);
}

function placeRadiusDeleteHandle() {
    if (!radiusCircle) return;
    if (radiusDeleteMarker) {
        map.removeLayer(radiusDeleteMarker);
        radiusDeleteMarker = null;
    }

    const center = radiusCircle.getLatLng();
    const topLat = radiusCircle.getBounds().getNorth();
    radiusDeleteMarker = L.marker([topLat, center.lng], {
        icon: L.divIcon({
            className: 'radius-delete-icon-wrapper',
            html: '<button class="radius-delete-icon" title="반경 삭제" type="button">×</button>',
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        }),
        keyboard: false
    }).addTo(map);

    radiusDeleteMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        resetRadiusSelection(false);
    });
}

function updateRadiusPreview(edgeLatLng, finalize) {
    if (!radiusCenterPoint) return;

    const radiusMeters = latLonDistanceMeters(
        radiusCenterPoint.lat,
        radiusCenterPoint.lon,
        edgeLatLng.lat,
        edgeLatLng.lng
    );
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return;

    drawRadiusCircle(radiusCenterPoint.lat, radiusCenterPoint.lon, radiusMeters);
    drawRadiusGuideLine(radiusCenterPoint.lat, radiusCenterPoint.lon, edgeLatLng.lat, edgeLatLng.lng);
    if (finalize) placeRadiusDeleteHandle();
    setRadiusMetricInfo(radiusMeters, finalize);
}

function setRadiusMetricInfo(radiusMeters, finalized) {
    const prefix = finalized ? '반경 결과(확정)' : '반경 프리뷰';
    const hint = (finalized && radiusPickMode)
        ? '<br><span style="font-size:11px;color:#64748b;">다음 중심점을 클릭하거나 우클릭으로 종료하세요.</span>'
        : '';
    const resultEl = document.getElementById('radiusResult');
    if (!resultEl) return;
    resultEl.innerHTML =
        `${prefix}: <strong>${radiusMeters.toFixed(1)} m</strong>${hint}`;
}

function handleMapRadiusPick(latlng) {
    if (radiusDrawState === 'await_center') {
        setRadiusCenter(latlng.lat, latlng.lng);
        radiusDrawState = 'drawing';
        setRadiusResultText('반경 결과: 반경 끝점을 클릭해 확정하세요.');
        return;
    }
    if (radiusDrawState === 'drawing') {
        updateRadiusPreview(latlng, true);
        radiusDrawState = 'await_center';
    }
}

function handleMarkerRadiusPick(marker) {
    const latlng = marker.getLatLng();
    if (!latlng) return;
    if (radiusDrawState !== 'await_center') return;
    setRadiusCenter(latlng.lat, latlng.lng);
    radiusDrawState = 'drawing';
    setRadiusResultText('반경 결과: 지도에서 반경 끝점을 클릭해 확정하세요.');
}

function handleRadiusApplyInput() {
    const lat = parseCoordinateInput('radiusLatInput', -90, 90);
    const lon = parseCoordinateInput('radiusLonInput', -180, 180);
    const radiusMeters = parseFloat(document.getElementById('radiusMeterInput')?.value);

    if (lat === null || lon === null || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
        setRadiusResultText('반경 결과: 중심 좌표와 반경(m)을 올바르게 입력하세요.');
        return;
    }

    setRadiusCenter(lat, lon);
    drawRadiusCircle(lat, lon, radiusMeters);
    if (radiusGuideLine) {
        map.removeLayer(radiusGuideLine);
        radiusGuideLine = null;
    }
    placeRadiusDeleteHandle();
    setRadiusMetricInfo(radiusMeters, true);
    map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] });
}

function handleMarkerDistancePick(marker) {
    const latlng = marker.getLatLng();
    if (!latlng) return;

    pickedDistancePoints.push(buildDistancePoint(latlng.lat, latlng.lng, 'marker', marker));
    if (distancePreviewLine) {
        map.removeLayer(distancePreviewLine);
        distancePreviewLine = null;
    }
    drawDistanceVisuals();

    if (pickedDistancePoints.length < 2) {
        setDistanceGuideMessage();
        return;
    }

    updateDistanceResultForPath('마커 선택');
}

function attachMarkerDistancePick(marker) {
    marker.on('click', (e) => {
        let picked = false;
        if (distancePickMode && distanceSelectionMode === 'marker') {
            handleMarkerDistancePick(marker);
            picked = true;
        }
        if (radiusPickMode && radiusSelectionMode === 'marker') {
            handleMarkerRadiusPick(marker);
            picked = true;
        }
        if (picked) L.DomEvent.stopPropagation(e);
    });
}

function bind(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
}

function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const btnClose = document.getElementById('btnCloseSidebar');
    const refreshMapSize = () => {
        // Sidebar width transition finishes around 200ms.
        // Invalidate twice to avoid right-edge clipping.
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => map.invalidateSize(), 220);
    };

    const syncSidebarToggle = () => {
        if (!sidebar || !btnClose) return;
        btnClose.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
    };

    if (btnClose) {
        btnClose.onclick = function () {
            sidebar?.classList.toggle('collapsed');
            syncSidebarToggle();
            refreshMapSize();
        };
    }
    syncSidebarToggle();
}

function initUploadPanel() {
    bind('parseUploadButton', 'click', handleUploadAndParse);
    bind('parseLinkShpButton', 'click', () => handleUploadRoadShape('link'));
    bind('parseNodeShpButton', 'click', () => handleUploadRoadShape('node'));
    bind('clearShpButton', 'click', handleClearRoadShape);
    bind('addLinkStyleRuleButton', 'click', handleAddLinkStyleRule);
    bind('applyNodeStyleButton', 'click', applyRoadNodeStyleConfig);
    bind('layerCtxClose', 'click', closeLayerContextMenu);

    bindFileSelectionSummary('logFileInput', 'logFileNameText', false);
    bindFileSelectionSummary('linkShpFolderInput', 'linkShpFileText', true);
    bindFileSelectionSummary('nodeShpFolderInput', 'nodeShpFileText', true);

    loadRoadLinkBaseStylesFromStorage();

    const nodeColorInput = document.getElementById('nodeColorInput');
    const nodeStrokeInput = document.getElementById('nodeStrokeInput');
    const nodeRadiusInput = document.getElementById('nodeRadiusInput');
    const nodeWeightInput = document.getElementById('nodeWeightInput');
    if (nodeColorInput) nodeColorInput.value = roadNodeStyleConfig.color;
    if (nodeStrokeInput) nodeStrokeInput.value = roadNodeStyleConfig.stroke;
    if (nodeRadiusInput) nodeRadiusInput.value = String(roadNodeStyleConfig.radius);
    if (nodeWeightInput) nodeWeightInput.value = String(roadNodeStyleConfig.weight);

    const exportBtn = document.getElementById('exportHtmlMenuButton');
    if (exportBtn) exportBtn.disabled = !(Array.isArray(markersData) && markersData.length > 0);

    syncRoadLinkRuleEnabledState();
    renderCustomLinkRuleList();
    renderLinkStyleFieldOptions();
    setUploadProgress(0, '대기 중', false);
    const persistenceState = isRoadShapeOpfsAvailable() ? '영구 캐시 ON' : '영구 캐시 OFF';
    updateRoadShapeStateText(roadShapeMetaByKind, `로컬 업로드 모드 (${persistenceState}) | zoom ${roadMinZoom}+에서 표시`);
    void restoreRoadShapeFromLocalDb();
}

function createDefaultRoadLinkBaseStyles() {
    return ROAD_LINK_RULES.reduce((acc, rule) => {
        acc[rule.key] = {
            color: rule.color || '#45c976',
            weight: clampRoadLinkWeight(rule.weight)
        };
        return acc;
    }, {});
}

function clampRoadLinkWeight(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 2.1;
    return Math.max(0.5, Math.min(12, num));
}

function normalizeRoadColor(value, fallback = '#45c976') {
    const str = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(str) ? str : fallback;
}

function normalizeRoadLinkBaseStyles(raw) {
    const defaults = createDefaultRoadLinkBaseStyles();
    const normalized = { ...defaults };
    if (!raw || typeof raw !== 'object') return normalized;

    Object.keys(defaults).forEach((key) => {
        const source = raw[key];
        if (!source || typeof source !== 'object') return;
        const base = defaults[key];
        normalized[key] = {
            color: normalizeRoadColor(source.color, base.color),
            weight: clampRoadLinkWeight(source.weight)
        };
    });
    return normalized;
}

function loadRoadLinkBaseStylesFromStorage() {
    const defaults = createDefaultRoadLinkBaseStyles();
    roadLinkBaseStyles = { ...defaults };
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(ROAD_LINK_BASE_STYLE_STORAGE_KEY);
        if (!raw) return;
        roadLinkBaseStyles = normalizeRoadLinkBaseStyles(JSON.parse(raw));
    } catch (_) {
        roadLinkBaseStyles = { ...defaults };
    }
}

function saveRoadLinkBaseStylesToStorage() {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(
            ROAD_LINK_BASE_STYLE_STORAGE_KEY,
            JSON.stringify(normalizeRoadLinkBaseStyles(roadLinkBaseStyles))
        );
    } catch (_) {
        // Ignore quota/storage errors.
    }
}

function ensureRoadLinkBaseStyle(ruleKey) {
    const defaults = createDefaultRoadLinkBaseStyles();
    const fallback = defaults[ruleKey] || defaults.default;
    if (!roadLinkBaseStyles || typeof roadLinkBaseStyles !== 'object') {
        roadLinkBaseStyles = { ...defaults };
    }
    if (!roadLinkBaseStyles[ruleKey] || typeof roadLinkBaseStyles[ruleKey] !== 'object') {
        roadLinkBaseStyles[ruleKey] = { ...fallback };
    }
    return roadLinkBaseStyles[ruleKey];
}

function updateRoadLinkBaseStyle(ruleKey, patch) {
    if (!ruleKey || !patch || typeof patch !== 'object') return;
    const defaults = createDefaultRoadLinkBaseStyles();
    const fallback = defaults[ruleKey] || defaults.default;
    const current = ensureRoadLinkBaseStyle(ruleKey);

    if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
        current.color = normalizeRoadColor(patch.color, fallback.color);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'weight')) {
        current.weight = clampRoadLinkWeight(patch.weight);
    }

    saveRoadLinkBaseStylesToStorage();
    refreshRoadLayerStyles();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    renderLayerControls();
}

function isRoadShapeOpfsAvailable() {
    return typeof navigator !== 'undefined'
        && !!navigator.storage
        && typeof navigator.storage.getDirectory === 'function';
}

function getRoadShapeManifestName(kind) {
    return `${kind}${ROAD_SHAPE_MANIFEST_SUFFIX}`;
}

function toRoadShapeCacheFileToken(value) {
    const token = String(value || 'shape')
        .trim()
        .replace(/[^0-9a-zA-Z._-]+/g, '_')
        .slice(0, 72);
    return token || 'shape';
}

async function getRoadShapeCacheDirHandle(create = true) {
    if (!isRoadShapeOpfsAvailable()) return null;

    if (roadShapeCacheDirHandlePromise) {
        try {
            return await roadShapeCacheDirHandlePromise;
        } catch (_) {
            roadShapeCacheDirHandlePromise = null;
        }
    }

    const openPromise = (async () => {
        const root = await navigator.storage.getDirectory();
        if (!create) {
            try {
                return await root.getDirectoryHandle(ROAD_SHAPE_CACHE_DIR);
            } catch (err) {
                if (err?.name === 'NotFoundError') return null;
                throw err;
            }
        }
        return root.getDirectoryHandle(ROAD_SHAPE_CACHE_DIR, { create: true });
    })();

    if (create) roadShapeCacheDirHandlePromise = openPromise;
    const handle = await openPromise;
    if (!create && handle) roadShapeCacheDirHandlePromise = Promise.resolve(handle);
    return handle;
}

async function writeRoadShapeCacheFile(fileName, payload) {
    const dir = await getRoadShapeCacheDirHandle(true);
    if (!dir) throw new Error('브라우저 파일 캐시를 사용할 수 없습니다. (OPFS 미지원)');

    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
}

async function readRoadShapeCacheFile(fileName, asText = false) {
    const dir = await getRoadShapeCacheDirHandle(false);
    if (!dir) return null;
    try {
        const handle = await dir.getFileHandle(fileName);
        const file = await handle.getFile();
        return asText ? file.text() : file.arrayBuffer();
    } catch (err) {
        if (err?.name === 'NotFoundError') return null;
        throw err;
    }
}

async function removeRoadShapeCacheFile(fileName) {
    const dir = await getRoadShapeCacheDirHandle(false);
    if (!dir) return;
    try {
        await dir.removeEntry(fileName);
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
    }
}

async function loadRoadShapeManifest(kind) {
    const manifestText = await readRoadShapeCacheFile(getRoadShapeManifestName(kind), true);
    if (!manifestText) return null;
    try {
        return JSON.parse(manifestText);
    } catch (_) {
        return null;
    }
}

async function loadRoadShapeKindFromLocalDb(kind) {
    if (!isRoadShapeOpfsAvailable()) return null;

    const manifest = await loadRoadShapeManifest(kind);
    if (!manifest) return null;
    const groupMetas = Array.isArray(manifest?.groups) ? manifest.groups : [];
    if (groupMetas.length === 0) {
        return {
            kind,
            meta: manifest.meta || null,
            groups: [],
            manifest
        };
    }

    const groups = [];
    for (let i = 0; i < groupMetas.length; i += 1) {
        const meta = groupMetas[i];
        const shpFile = String(meta?.shpFile || '').trim();
        if (!shpFile) continue;

        const shpBuf = await readRoadShapeCacheFile(shpFile, false);
        if (!(shpBuf instanceof ArrayBuffer)) continue;

        let dbfBuf = null;
        const dbfFile = String(meta?.dbfFile || '').trim();
        if (dbfFile) {
            const dbfLoaded = await readRoadShapeCacheFile(dbfFile, false);
            if (dbfLoaded instanceof ArrayBuffer) {
                dbfBuf = dbfLoaded;
            }
        }

        groups.push({
            kind,
            name: String(meta?.name || `${kind}_shape`),
            shpBuf,
            dbfBuf,
            prjText: typeof meta?.prjText === 'string' ? meta.prjText : '',
            cpgText: typeof meta?.cpgText === 'string' ? meta.cpgText : ''
        });
    }

    return {
        kind,
        meta: manifest.meta || null,
        groups,
        manifest
    };
}

async function saveRoadShapeKindToLocalDb(kind, meta, groups) {
    if (!isRoadShapeOpfsAvailable()) return;

    const normalizedGroups = Array.isArray(groups) ? groups : [];
    const oldManifest = await loadRoadShapeManifest(kind);
    const oldGroupMetas = Array.isArray(oldManifest?.groups)
        ? oldManifest.groups
        : [];

    const newManifestGroups = [];
    for (let i = 0; i < normalizedGroups.length; i += 1) {
        const group = normalizedGroups[i];
        const safeName = toRoadShapeCacheFileToken(group?.name || `${kind}_${i + 1}`);
        const shpFile = `${kind}_${i}_${safeName}.shp.bin`;
        const dbfFile = group?.dbfBuf instanceof ArrayBuffer ? `${kind}_${i}_${safeName}.dbf.bin` : '';

        if (!(group?.shpBuf instanceof ArrayBuffer)) continue;
        await writeRoadShapeCacheFile(shpFile, group.shpBuf);
        if (dbfFile) {
            await writeRoadShapeCacheFile(dbfFile, group.dbfBuf);
        }

        newManifestGroups.push({
            name: String(group?.name || `${kind}_shape`),
            prjText: typeof group?.prjText === 'string' ? group.prjText : '',
            cpgText: typeof group?.cpgText === 'string' ? group.cpgText : '',
            shpFile,
            dbfFile
        });
    }

    const manifest = {
        kind,
        meta: meta || null,
        updated_at: new Date().toISOString(),
        groups: newManifestGroups
    };
    await writeRoadShapeCacheFile(getRoadShapeManifestName(kind), JSON.stringify(manifest));

    const preservedFiles = new Set([getRoadShapeManifestName(kind)]);
    newManifestGroups.forEach((groupMeta) => {
        preservedFiles.add(groupMeta.shpFile);
        if (groupMeta.dbfFile) preservedFiles.add(groupMeta.dbfFile);
    });

    const oldFiles = new Set();
    oldGroupMetas.forEach((groupMeta) => {
        const oldShp = String(groupMeta?.shpFile || '').trim();
        const oldDbf = String(groupMeta?.dbfFile || '').trim();
        if (oldShp) oldFiles.add(oldShp);
        if (oldDbf) oldFiles.add(oldDbf);
    });
    for (const fileName of oldFiles) {
        if (!preservedFiles.has(fileName)) {
            await removeRoadShapeCacheFile(fileName);
        }
    }
}

async function clearRoadShapeLocalDb() {
    if (!isRoadShapeOpfsAvailable()) return;
    const root = await navigator.storage.getDirectory();
    try {
        await root.removeEntry(ROAD_SHAPE_CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
    }
    roadShapeCacheDirHandlePromise = null;
}

async function restoreRoadShapeFromLocalDb() {
    try {
        const [linkRecord, nodeRecord] = await Promise.all([
            loadRoadShapeKindFromLocalDb('link'),
            loadRoadShapeKindFromLocalDb('node')
        ]);

        const linkGroups = Array.isArray(linkRecord?.groups) ? linkRecord.groups : [];
        const nodeGroups = Array.isArray(nodeRecord?.groups) ? nodeRecord.groups : [];
        if (linkGroups.length === 0 && nodeGroups.length === 0) return;

        roadShapeLocalGroupsByKind = {
            link: linkGroups,
            node: nodeGroups
        };
        roadShapeMetaByKind = {
            link: linkRecord?.meta || null,
            node: nodeRecord?.meta || null
        };
        roadShapePendingLoad = true;
        roadShapeLoading = false;
        updateRoadShapeStateText(roadShapeMetaByKind, `로컬 캐시 복원됨 | zoom ${roadMinZoom}+에서 표시`);
        handleRoadZoomChanged();
    } catch (_) {
        // Ignore restore failure and continue in upload-only mode.
    }
}

function bindFileSelectionSummary(inputId, outputId, asFolder = false) {
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    if (!input || !output) return;

    const update = () => {
        const files = Array.from(input.files || []);
        if (files.length === 0) {
            output.textContent = asFolder ? '폴더 미선택' : '선택된 파일 없음';
            return;
        }
        if (!asFolder) {
            output.textContent = files[0].name || '선택된 파일';
            return;
        }
        const firstPath = files[0]?.webkitRelativePath || files[0]?.name || '';
        const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : 'folder';
        output.textContent = `${folderName} / ${files.length}개 파일`;
    };

    input.addEventListener('change', update);
    update();
}

function toUpperKey(value) {
    return String(value || '').trim().toUpperCase();
}

function findRoadPropValue(props, propKey) {
    if (!props || !propKey) return undefined;
    if (Object.prototype.hasOwnProperty.call(props, propKey)) return props[propKey];
    const upper = toUpperKey(propKey);
    if (Object.prototype.hasOwnProperty.call(props, upper)) return props[upper];

    const keys = Object.keys(props);
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (toUpperKey(key) === upper) return props[key];
    }
    return undefined;
}

function normalizeRuleMatchValue(value) {
    const str = String(value ?? '').trim();
    const num = Number(str);
    if (str !== '' && Number.isFinite(num)) return num;
    return str.toLowerCase();
}

function matchesCustomLinkRule(rule, props) {
    if (!rule || !props) return false;
    const propValue = findRoadPropValue(props, rule.propKey);
    if (propValue === undefined || propValue === null || propValue === '') return false;

    const propNum = Number(propValue);
    if (typeof rule.normalizedValue === 'number' && Number.isFinite(propNum)) {
        return propNum === rule.normalizedValue;
    }
    return String(propValue).trim().toLowerCase() === String(rule.normalizedValue);
}

function getCustomRoadLinkRuleKey(rule) {
    const seq = Number(rule?.seq);
    if (!Number.isFinite(seq)) return '';
    return `custom:${seq}`;
}

function normalizeUniqueRoadFieldNames(values) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(values)) return out;
    values.forEach((value) => {
        const name = String(value || '').trim();
        if (!name) return;
        const upper = toUpperKey(name);
        if (seen.has(upper)) return;
        seen.add(upper);
        out.push(name);
    });
    return out;
}

function getRoadLinkStyleFieldOptions() {
    const merged = normalizeUniqueRoadFieldNames([
        ...DEFAULT_ROAD_LINK_STYLE_FIELDS,
        ...roadLinkFieldNames,
        ...roadCustomLinkRules.map((rule) => rule?.propKey)
    ]);
    return merged.sort((a, b) => a.localeCompare(b));
}

function renderLinkStyleFieldOptions(selectedKey = '') {
    const select = document.getElementById('linkStylePropSelect');
    if (!select) return;

    const current = String(selectedKey || select.value || '').trim();
    const options = getRoadLinkStyleFieldOptions();

    select.innerHTML = '<option value="">필드 선택</option>';
    options.forEach((fieldName) => {
        const option = document.createElement('option');
        option.value = fieldName;
        option.textContent = fieldName;
        select.appendChild(option);
    });

    if (current && options.includes(current)) {
        select.value = current;
    }
}

function syncRoadLinkRuleEnabledState() {
    const valid = new Set(ROAD_LINK_RULES.map((rule) => rule.key));
    roadCustomLinkRules.forEach((rule) => {
        const customKey = getCustomRoadLinkRuleKey(rule);
        if (customKey) valid.add(customKey);
    });

    Object.keys(roadLinkRuleEnabled).forEach((key) => {
        if (!valid.has(key)) delete roadLinkRuleEnabled[key];
    });

    roadCustomLinkRules.forEach((rule) => {
        const customKey = getCustomRoadLinkRuleKey(rule);
        if (!customKey) return;
        if (typeof roadLinkRuleEnabled[customKey] !== 'boolean') {
            roadLinkRuleEnabled[customKey] = true;
        }
    });
}

function getRoadWorkerRequestedLinkProps() {
    const keys = new Set(DEFAULT_ROAD_LINK_STYLE_FIELDS);
    roadLinkFieldNames.forEach((fieldName) => {
        keys.add(fieldName);
        keys.add(toUpperKey(fieldName));
    });
    roadCustomLinkRules.forEach((rule) => {
        if (rule?.propKey) {
            keys.add(toUpperKey(rule.propKey));
            keys.add(rule.propKey);
        }
    });
    return Array.from(keys);
}

function syncRoadShapeWorkerQueryKeys() {
    if (!roadShapeWorker) return;
    roadShapeWorker.postMessage({
        type: 'setQueryKeys',
        linkPropKeys: getRoadWorkerRequestedLinkProps()
    });
}

function refreshRoadLayerStyles() {
    if (roadLinkGeoLayer) {
        roadLinkGeoLayer.setStyle((feature) => getRoadLinkStyle(feature?.properties || {}));
    }
    if (roadNodeGeoLayer) {
        roadNodeGeoLayer.eachLayer((layer) => {
            if (typeof layer.setStyle !== 'function') return;
            layer.setStyle(getRoadNodeStyle(layer?.feature?.properties || {}));
        });
    }
}

function renderCustomLinkRuleList() {
    const list = document.getElementById('linkStyleRuleList');
    if (!list) return;

    if (!Array.isArray(roadCustomLinkRules) || roadCustomLinkRules.length === 0) {
        list.innerHTML = '<div class="style-rule-empty">규칙 없음 (기본 색상 규칙 사용 중)</div>';
        return;
    }

    list.innerHTML = '';
    roadCustomLinkRules.forEach((rule, index) => {
        const row = document.createElement('div');
        row.className = 'style-rule-item';
        row.innerHTML = `
            <span class="style-rule-chip" style="background:${escapeHtml(rule.color)};"></span>
            <span class="style-rule-text">${escapeHtml(`${index + 1}. ${rule.propKey} = ${rule.rawValue} / ${rule.weight}px`)}</span>
            <button type="button" class="style-rule-remove">삭제</button>
        `;

        const removeBtn = row.querySelector('.style-rule-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                roadCustomLinkRules = roadCustomLinkRules.filter((item) => item.seq !== rule.seq);
                syncRoadLinkRuleEnabledState();
                renderCustomLinkRuleList();
                renderLinkStyleFieldOptions();
                syncRoadShapeWorkerQueryKeys();
                refreshRoadLayerStyles();
                renderLayerControls();
                if (roadShapeLoaded) scheduleRoadViewportQuery();
            });
        }
        list.appendChild(row);
    });
}

function handleAddLinkStyleRule() {
    const propInput = document.getElementById('linkStylePropSelect');
    const valueInput = document.getElementById('linkStyleValueInput');
    const colorInput = document.getElementById('linkStyleColorInput');
    const weightInput = document.getElementById('linkStyleWeightInput');

    const propKey = String(propInput?.value || '').trim();
    const rawValue = String(valueInput?.value || '').trim();
    const color = String(colorInput?.value || '#8b5cf6').trim() || '#8b5cf6';
    const weightRaw = Number(weightInput?.value);
    const weight = Number.isFinite(weightRaw) ? Math.max(0.5, Math.min(12, weightRaw)) : 2.1;

    if (!propKey || rawValue === '') {
        setUploadProgress(0, '스타일 규칙은 속성명/값을 모두 입력해야 합니다.', false);
        return;
    }

    const normalizedValue = normalizeRuleMatchValue(rawValue);
    roadCustomLinkRules.push({
        seq: roadCustomLinkRuleSeq++,
        propKey,
        rawValue,
        normalizedValue,
        color,
        weight
    });
    syncRoadLinkRuleEnabledState();
    renderCustomLinkRuleList();
    renderLinkStyleFieldOptions(propKey);
    syncRoadShapeWorkerQueryKeys();
    refreshRoadLayerStyles();
    renderLayerControls();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    setUploadProgress(100, `링크 스타일 규칙 추가: ${propKey}=${rawValue}`, false);
}

function applyRoadNodeStyleConfig() {
    const colorInput = document.getElementById('nodeColorInput');
    const strokeInput = document.getElementById('nodeStrokeInput');
    const radiusInput = document.getElementById('nodeRadiusInput');
    const weightInput = document.getElementById('nodeWeightInput');

    const color = String(colorInput?.value || '#22c3d6').trim() || '#22c3d6';
    const stroke = String(strokeInput?.value || '#0f8aa6').trim() || '#0f8aa6';
    const radiusRaw = Number(radiusInput?.value);
    const weightRaw = Number(weightInput?.value);

    roadNodeStyleConfig = {
        color,
        stroke,
        radius: Number.isFinite(radiusRaw) ? Math.max(1, Math.min(12, radiusRaw)) : 3.2,
        weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(5, weightRaw)) : 1
    };
    refreshRoadLayerStyles();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    setUploadProgress(100, '노드 스타일 적용 완료', false);
}

function initToolPanels() {
    const panelMap = {
        toolUploadBtn: 'uploadPanel',
        toolExportBtn: 'exportPanel',
        toolDistanceBtn: 'distancePanel',
        toolRadiusBtn: 'radiusPanel',
        toolPlaybackBtn: 'playbackPanel',
        toolLegendBtn: 'legendPanel'
    };
    Object.entries(panelMap).forEach(([btnId, panelId]) => {
        bind(btnId, 'click', () => toggleToolPanel(panelId, btnId));
    });
    document.querySelectorAll('.panel-close-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const panelId = btn.getAttribute('data-close-panel');
            closeToolPanel(panelId);
        });
    });
    bind('exportHtmlMenuButton', 'click', () => handleExportHtmlFromMenu());
    bind('toolBackdrop', 'click', closeAllToolPanels);
}

function toggleToolPanel(panelId, buttonId) {
    const panel = document.getElementById(panelId);
    const button = document.getElementById(buttonId);
    if (!panel || !button) return;

    const isHidden = panel.classList.contains('hidden');
    closeAllToolPanels();
    if (!isHidden) return;

    panel.classList.remove('hidden');
    button.classList.add('active');
    document.getElementById('toolBackdrop')?.classList.add('active');
}

function closeToolPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('hidden');
    syncToolButtonState();
}

function closeAllToolPanels() {
    ['uploadPanel', 'exportPanel', 'distancePanel', 'radiusPanel', 'playbackPanel', 'legendPanel']
        .forEach((panelId) => document.getElementById(panelId)?.classList.add('hidden'));
    syncToolButtonState();
}

function syncToolButtonState() {
    const mapping = {
        toolUploadBtn: 'uploadPanel',
        toolExportBtn: 'exportPanel',
        toolDistanceBtn: 'distancePanel',
        toolRadiusBtn: 'radiusPanel',
        toolPlaybackBtn: 'playbackPanel',
        toolLegendBtn: 'legendPanel'
    };
    Object.entries(mapping).forEach(([btnId, panelId]) => {
        const panel = document.getElementById(panelId);
        document.getElementById(btnId)?.classList.toggle('active', !!panel && !panel.classList.contains('hidden'));
    });
    const hasOpenPanel = Object.values(mapping).some((panelId) => {
        const panel = document.getElementById(panelId);
        return panel && !panel.classList.contains('hidden');
    });
    document.getElementById('toolBackdrop')?.classList.toggle('active', hasOpenPanel);
}

function setUploadProgress(percent, status, parsingMode = false) {
    const bar = document.getElementById('uploadProgressBar');
    const statusEl = document.getElementById('uploadStatusText');
    const wrap = document.getElementById('uploadProgressWrap');

    if (wrap) wrap.classList.toggle('parsing', parsingMode);
    if (bar) {
        const pct = Math.max(0, Math.min(100, percent));
        bar.style.width = `${pct}%`;
        // indeterminate 모드: percent가 0이고 parsingMode이면 striped animation
        if (parsingMode && pct > 0 && pct < 100) {
            bar.classList.add('progress-active');
            bar.classList.remove('progress-indeterminate');
        } else if (parsingMode && pct === 0) {
            bar.classList.add('progress-indeterminate');
            bar.classList.remove('progress-active');
            bar.style.width = '100%';
        } else {
            bar.classList.remove('progress-active', 'progress-indeterminate');
        }
    }
    if (statusEl && status) statusEl.textContent = status;
}

function setShapeLoadingProgress(status) {
    // SHP 로딩 중: indeterminate bar + 상태 텍스트
    const bar = document.getElementById('uploadProgressBar');
    const statusEl = document.getElementById('uploadStatusText');
    const wrap = document.getElementById('uploadProgressWrap');
    if (wrap) wrap.classList.add('parsing');
    if (bar) {
        bar.classList.add('progress-indeterminate');
        bar.classList.remove('progress-active');
        bar.style.width = '100%';
    }
    if (statusEl && status) statusEl.textContent = status;
}

function clearParsingProgressTimer() {
    if (parsingProgressTimer) {
        clearInterval(parsingProgressTimer);
        parsingProgressTimer = null;
    }
}

function startParsingProgress() {
    clearParsingProgressTimer();
    parsingProgressValue = 0;
    setUploadProgress(parsingProgressValue, '파싱 중 0%', true);
    parsingProgressTimer = setInterval(() => {
        parsingProgressValue = Math.min(95, parsingProgressValue + (parsingProgressValue < 60 ? 6 : 2));
        setUploadProgress(parsingProgressValue, `파싱 중 ${parsingProgressValue}%`, true);
        if (parsingProgressValue >= 95) {
            clearParsingProgressTimer();
        }
    }, 180);
}

function finishParsingProgress(success = true, statusText = '완료') {
    clearParsingProgressTimer();
    if (success) {
        setUploadProgress(100, statusText, false);
        return;
    }
    setUploadProgress(0, statusText, false);
}

function handleUploadAndParse() {
    const fileInput = document.getElementById('logFileInput');
    const parseButton = document.getElementById('parseUploadButton');
    const file = fileInput?.files?.[0];

    if (!file) {
        setUploadProgress(0, '대기 중', false);
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    if (parseButton) parseButton.disabled = true;
    setUploadProgress(5, '업로드 준비 중', false);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/parse-log', true);

    xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const ratio = event.loaded / event.total;
        const progress = Math.round(ratio * 100);
        setUploadProgress(progress, `업로드 중 ${Math.round(ratio * 100)}%`, false);
    };
    xhr.upload.onload = () => {
        setUploadProgress(100, '업로드 완료', false);
        startParsingProgress();
    };

    xhr.onload = () => {
        if (parseButton) parseButton.disabled = false;

        let response = null;
        try {
            response = JSON.parse(xhr.responseText);
        } catch (e) {
            finishParsingProgress(false, '실패: 응답 파싱 오류');
            return;
        }

        if (xhr.status < 200 || xhr.status >= 300 || !response?.ok) {
            finishParsingProgress(false, `실패: ${response?.error || '업로드/파싱 오류'}`);
            return;
        }

        markersData = response.coords || [];
        linesData = response.lines || [];
        currentResultName = response.result_name || 'result';
        minTs = Number.isFinite(response.min_timestamp_ms) ? response.min_timestamp_ms : 0;
        maxTs = Number.isFinite(response.max_timestamp_ms) ? response.max_timestamp_ms : 1;
        maxId = Number.isFinite(response.max_id) ? response.max_id : 1;

        initSlider(minTs, maxTs);
        renderFromCurrentData();
        if (roadShapeLoaded) {
            scheduleRoadViewportQuery();
        } else if (roadShapePendingLoad) {
            handleRoadZoomChanged();
        }
        setTimeout(() => renderLayerControls(), 0);
        const exportBtn = document.getElementById('exportHtmlMenuButton');
        if (exportBtn) exportBtn.disabled = false;
        finishParsingProgress(true, '완료');
    };

    xhr.onerror = () => {
        if (parseButton) parseButton.disabled = false;
        finishParsingProgress(false, '실패: 네트워크 오류');
    };

    xhr.send(formData);
}

async function handleUploadRoadShape(kind) {
    const config = (kind === 'node')
        ? {
            inputId: 'nodeShpFolderInput',
            buttonId: 'parseNodeShpButton',
            label: '노드'
        }
        : {
            inputId: 'linkShpFolderInput',
            buttonId: 'parseLinkShpButton',
            label: '링크'
        };

    const fileInput = document.getElementById(config.inputId);
    const parseButton = document.getElementById(config.buttonId);
    const files = Array.from(fileInput?.files || []);
    if (files.length === 0) {
        setUploadProgress(0, `${config.label} SHP 폴더를 선택하세요.`, false);
        return;
    }

    const validationError = validateRoadShapeFolderSelection(files, config.label);
    if (validationError) {
        setUploadProgress(0, validationError, false);
        return;
    }

    if (parseButton) parseButton.disabled = true;
    setUploadProgress(10, `${config.label} SHP 읽는 중...`, false);

    try {
        const folderName = deriveFolderName(files);
        roadMinZoom = ROAD_RENDER_MIN_ZOOM;
        setUploadProgress(35, `${config.label} Shape 로컬 준비 중...`, false);

        const groups = await buildRoadShapeGroupsFromFiles(kind, files);
        roadShapeLocalGroupsByKind = {
            ...roadShapeLocalGroupsByKind,
            [kind]: groups
        };
        roadShapeMetaByKind = {
            ...roadShapeMetaByKind,
            [kind]: makeLocalRoadShapeMeta(kind, folderName, files, roadMinZoom)
        };
        await saveRoadShapeKindToLocalDb(kind, roadShapeMetaByKind[kind], groups);
        roadShapePendingLoad = true;
        roadShapeLoading = false;
        const persistenceState = isRoadShapeOpfsAvailable() ? '영구 캐시 ON' : '영구 캐시 OFF';
        updateRoadShapeStateText(
            roadShapeMetaByKind,
            `${config.label} 로컬 업로드 완료 (${persistenceState}), zoom ${roadMinZoom}+에서 표시`
        );
        handleRoadZoomChanged();
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Shapefile 파싱 실패';
        setUploadProgress(0, `실패: ${message}`, false);
    } finally {
        if (parseButton) parseButton.disabled = false;
    }
}

async function handleClearRoadShape() {
    const clearBtn = document.getElementById('clearShpButton');
    if (clearBtn) clearBtn.disabled = true;
    try {
        removeRoadShapeLayers();
        roadShapeMetaByKind = { link: null, node: null };
        roadShapeLocalGroupsByKind = { link: [], node: [] };
        roadShapePendingLoad = false;
        roadShapeLoading = false;
        await clearRoadShapeLocalDb();
        renderLayerControls();
        updateRoadShapeStateText(roadShapeMetaByKind);
        setUploadProgress(100, '로컬 Shape 삭제 완료', false);
    } catch (err) {
        const message = err instanceof Error ? err.message : '로컬 Shape 삭제 실패';
        setUploadProgress(0, `실패: ${message}`, false);
    } finally {
        if (clearBtn) clearBtn.disabled = false;
    }
}

function makeLocalRoadShapeMeta(kind, folderName, files, minZoom) {
    const totalBytes = Array.isArray(files)
        ? files.reduce((acc, file) => acc + Number(file?.size || 0), 0)
        : 0;
    return {
        kind,
        source: 'local',
        folder_name: folderName || `${kind}_shape`,
        file_name: `${kind}_local_folder`,
        min_zoom: minZoom,
        updated_at: new Date().toISOString().slice(0, 19),
        size_bytes: totalBytes,
        entry_count: Array.isArray(files) ? files.length : 0
    };
}

function deriveFolderName(files) {
    const firstPath = files[0]?.webkitRelativePath || '';
    if (firstPath.includes('/')) {
        return firstPath.split('/')[0] || 'road_shape';
    }
    return 'road_shape';
}

function getRoadShapeFolderRoot(files) {
    const roots = new Set();
    files.forEach((file) => {
        const relPath = String(file?.webkitRelativePath || '').trim();
        if (!relPath || !relPath.includes('/')) return;
        roots.add(relPath.split('/')[0]);
    });
    if (roots.size !== 1) return '';
    return Array.from(roots)[0] || '';
}

function validateRoadShapeFolderSelection(files, label) {
    if (!Array.isArray(files) || files.length === 0) {
        return `${label} SHP 폴더를 선택하세요.`;
    }

    const folderRoot = getRoadShapeFolderRoot(files);
    if (!folderRoot) {
        return `${label}는 폴더 선택 업로드만 지원합니다. (.shp/.shx/.dbf 포함 폴더 선택)`;
    }

    const grouped = groupRoadShapeFiles(files);
    if (grouped.length === 0) {
        return `${label} 폴더에서 .shp 파일을 찾지 못했습니다.`;
    }

    for (let i = 0; i < grouped.length; i += 1) {
        const group = grouped[i];
        if (!group.shp) continue;
        if (!group.shx || !group.dbf) {
            const missing = [];
            if (!group.shx) missing.push('.shx');
            if (!group.dbf) missing.push('.dbf');
            return `${label} SHP 세트 불완전: ${group.name}에 ${missing.join(', ')}가 없습니다.`;
        }
    }

    return '';
}

function groupRoadShapeFiles(files) {
    const groups = new Map();
    files.forEach((file) => {
        const relPath = (file?.webkitRelativePath || file?.name || '').trim();
        if (!relPath) return;
        const normalizedPath = relPath.replace(/\\/g, '/');
        const lower = normalizedPath.toLowerCase();
        const dot = lower.lastIndexOf('.');
        if (dot <= 0) return;

        const ext = lower.slice(dot + 1);
        if (!['shp', 'dbf', 'prj', 'cpg', 'shx'].includes(ext)) return;

        const base = lower.slice(0, dot);
        if (!groups.has(base)) {
            groups.set(base, {
                name: normalizedPath.split('/').pop()?.replace(/\.[^.]+$/, '') || base,
                shp: null,
                shx: null,
                dbf: null,
                prj: null,
                cpg: null
            });
        }

        const g = groups.get(base);
        if (ext === 'shp') g.shp = file;
        if (ext === 'shx') g.shx = file;
        if (ext === 'dbf') g.dbf = file;
        if (ext === 'prj') g.prj = file;
        if (ext === 'cpg') g.cpg = file;
    });

    return Array.from(groups.values()).filter((g) => !!g.shp);
}

async function buildRoadShapeGroupsFromFiles(kind, files) {
    const grouped = groupRoadShapeFiles(files);
    if (grouped.length === 0) {
        throw new Error('유효한 SHP 그룹이 없습니다.');
    }

    const groups = [];
    const kindLabel = kind === 'node' ? '노드' : '링크';
    for (let i = 0; i < grouped.length; i += 1) {
        const group = grouped[i];
        updateRoadShapeStateText(
            roadShapeMetaByKind,
            `${kindLabel} 파일 읽는 중 ${i + 1}/${grouped.length}: ${group.name}`
        );

        const shpBuf = await group.shp.arrayBuffer();
        let dbfBuf = null;
        if (group.dbf) {
            dbfBuf = await group.dbf.arrayBuffer();
        }

        let prjText = '';
        let cpgText = '';
        try { prjText = group.prj ? await group.prj.text() : ''; } catch (_) {}
        try { cpgText = group.cpg ? await group.cpg.text() : ''; } catch (_) {}

        groups.push({
            kind,
            name: group.name,
            shpBuf,
            dbfBuf,
            prjText,
            cpgText
        });
    }

    return groups;
}

function cloneRoadShapeGroupsForWorker() {
    const groups = [];
    ['link', 'node'].forEach((kind) => {
        const sourceGroups = Array.isArray(roadShapeLocalGroupsByKind?.[kind]) ? roadShapeLocalGroupsByKind[kind] : [];
        sourceGroups.forEach((group) => {
            const shpBuf = group?.shpBuf instanceof ArrayBuffer ? group.shpBuf.slice(0) : null;
            const dbfBuf = group?.dbfBuf instanceof ArrayBuffer ? group.dbfBuf.slice(0) : null;
            if (!(shpBuf instanceof ArrayBuffer)) return;
            groups.push({
                kind,
                name: group?.name || `${kind}_shape`,
                shpBuf,
                dbfBuf,
                prjText: typeof group?.prjText === 'string' ? group.prjText : '',
                cpgText: typeof group?.cpgText === 'string' ? group.cpgText : ''
            });
        });
    });
    return groups;
}

async function loadRoadShapeOnDemand() {
    if (roadShapeLoading || !roadShapePendingLoad) return;
    if (map.getZoom() < roadMinZoom) return;
    await loadRoadShapeOnDemandForced();
}

async function loadRoadShapeOnDemandForced() {
    if (roadShapeLoading || !roadShapePendingLoad) return;
    roadShapeLoading = true;
    updateRoadShapeStateText(roadShapeMetaByKind, '레이어 로딩 중...');
    setShapeLoadingProgress('SHP 파일 읽는 중...');
    try {
        terminateRoadShapeWorker();
        roadShapeWorker = new Worker(`/static/js/road_shape_worker.js?v=${ROAD_WORKER_VERSION}`);
        roadShapeWorker.onmessage = handleRoadShapeWorkerMessage;
        roadShapeWorker.onerror = () => {
            roadShapeLoading = false;
            roadShapePendingLoad = false;
            roadShapeLoaded = false;
            updateRoadShapeStateText(roadShapeMetaByKind, '로드 실패: Worker 오류');
        };
        syncRoadShapeWorkerQueryKeys();

        const groups = cloneRoadShapeGroupsForWorker();
        if (!Array.isArray(groups) || groups.length === 0) {
            throw new Error('로컬 Shape 데이터가 없습니다. Link/Node 폴더를 업로드하세요.');
        }
        const transferables = [];
        groups.forEach((group) => {
            if (group.shpBuf instanceof ArrayBuffer) transferables.push(group.shpBuf);
            if (group.dbfBuf instanceof ArrayBuffer) transferables.push(group.dbfBuf);
        });
        roadShapeWorker.postMessage({ type: 'loadGroups', groups }, transferables);
    } catch (e) {
        roadShapeLoading = false;
        roadShapePendingLoad = false;
        roadShapeLoaded = false;
        terminateRoadShapeWorker();
        const message = e instanceof Error ? e.message : '레이어 로드 실패';
        if (message.includes('로컬 Shape 데이터가 없습니다')) {
            updateRoadShapeStateText(roadShapeMetaByKind, '업로드된 로컬 Shape가 없습니다');
        }
        updateRoadShapeStateText(roadShapeMetaByKind, `로드 실패: ${message}`);
    } finally {
        // Worker 기반 로딩에서는 ready/error에서 상태를 정리합니다.
    }
}

function handleRoadShapeWorkerMessage(event) {
    const data = event.data || {};

    if (data.type === 'progress') {
        const pct = Number.isFinite(data.pct) ? data.pct : 0;
        updateRoadShapeStateText(roadShapeMetaByKind, data.msg || 'Shape 처리 중...');
        setShapeLoadingProgress(data.msg || 'Shape 처리 중...');
        return;
    }

    if (data.type === 'ready') {
        roadShapeLoading = false;
        roadShapeLoaded = true;
        roadShapePendingLoad = false;
        roadLinkFeatureCount = Number(data.linkCount || 0);
        roadNodeFeatureCount = Number(data.nodeCount || 0);
        roadLinkFieldNames = normalizeUniqueRoadFieldNames([
            ...DEFAULT_ROAD_LINK_STYLE_FIELDS,
            ...(Array.isArray(data.linkFieldNames) ? data.linkFieldNames : [])
        ]);
        syncRoadLinkRuleEnabledState();
        renderLinkStyleFieldOptions();
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        roadLinkRenderedRuleCounts = {};
        roadNodeRenderedRuleCounts = {};
        layerCountOverride[ROAD_LINK_LAYER] = roadLinkFeatureCount;
        layerCountOverride[ROAD_NODE_LAYER] = roadNodeFeatureCount;
        ensureRoadShapeLayers();
        renderLayerControls();
        queryRoadViewport();
        setUploadProgress(100, 'Shape 로드 완료', false);
        if (roadLinkFeatureCount === 0) {
            updateRoadShapeStateText(roadShapeMetaByKind, '로드됨: 링크 0개 (SHP 타입/좌표계 확인 필요)');
            return;
        }
        const linkMode = data.linkCoordMode || 'none';
        const nodeMode = data.nodeCoordMode || 'none';
        const attrDesc = (data.linkAttrAvailable || data.nodeAttrAvailable)
            ? '속성팝업 사용 가능'
            : '속성팝업 제한(대용량 DBF 생략)';
        updateRoadShapeStateText(
            roadShapeMetaByKind,
            `로드 완료 (링크 ${roadLinkFeatureCount.toLocaleString()}, 노드 ${roadNodeFeatureCount.toLocaleString()}) | mode L:${linkMode} N:${nodeMode} | ${attrDesc}`
        );
        return;
    }

    if (data.type === 'queryResult') {
        const reqId = Number(data.requestId || 0);
        if (reqId < roadShapeLastRenderedRequestId) return;
        roadShapeLastRenderedRequestId = reqId;
        renderRoadViewportFeatures(data.links || [], data.nodes || []);
        const matchedLinks = Number.isFinite(data.linkMatched) ? data.linkMatched : roadLinkFeatureCount;
        const matchedNodes = Number.isFinite(data.nodeMatched) ? data.nodeMatched : roadNodeFeatureCount;
        const extra = (matchedLinks === 0 && matchedNodes === 0)
            ? '현재 화면에 데이터 없음 (지도 위치 확인)'
            : `표시 중 (링크 ${roadLinkRenderCount}/${matchedLinks}/${roadLinkFeatureCount}, 노드 ${roadNodeRenderCount}/${matchedNodes}/${roadNodeFeatureCount})`;
        updateRoadShapeStateText(roadShapeMetaByKind, extra);
        return;
    }

    if (data.type === 'error') {
        roadShapeLoading = false;
        roadShapePendingLoad = false;
        roadShapeLoaded = false;
        terminateRoadShapeWorker();
        setUploadProgress(0, `로드 실패: ${data.message || '알 수 없는 오류'}`, false);
        updateRoadShapeStateText(roadShapeMetaByKind, `로드 실패: ${data.message || '알 수 없는 오류'}`);
        return;
    }

    if (data.type === 'attrs') {
        const reqId = Number(data.requestId || 0);
        const resolver = roadShapeAttrRequests.get(reqId);
        if (resolver) {
            roadShapeAttrRequests.delete(reqId);
            resolver(data.props || {});
        }
    }
}

function terminateRoadShapeWorker() {
    if (roadShapeWorker) {
        try { roadShapeWorker.terminate(); } catch (_) {}
        roadShapeWorker = null;
    }
    roadShapeAttrRequests.clear();
    roadShapeQueryRequestId = 0;
    roadShapeLastRenderedRequestId = 0;
    if (roadQueryDebounceTimer) {
        clearTimeout(roadQueryDebounceTimer);
        roadQueryDebounceTimer = null;
    }
}

function requestRoadShapeAttrs(kind, index) {
    return new Promise((resolve) => {
        if (!roadShapeWorker || !Number.isFinite(index) || index < 0) {
            resolve({});
            return;
        }

        const requestId = ++roadShapeAttrRequestSeq;
        roadShapeAttrRequests.set(requestId, resolve);
        roadShapeWorker.postMessage({ type: 'attrs', requestId, kind, index });

        setTimeout(() => {
            if (!roadShapeAttrRequests.has(requestId)) return;
            roadShapeAttrRequests.delete(requestId);
            resolve({});
        }, 2500);
    });
}

function getRoadFeatureIndex(feature) {
    const raw = feature?._shpIndex ?? feature?.properties?._shpIndex;
    const index = Number(raw);
    return Number.isFinite(index) ? index : null;
}

function toRoadInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : null;
}

function classifyRoadLinkRule(props) {
    const roadCate = toRoadInt(findRoadPropValue(props, 'ROAD_CATE'));
    const linkFacil = toRoadInt(findRoadPropValue(props, 'LINK_FACIL'));
    if (roadCate === 11) return 'parkingRoad';
    if (linkFacil === 4) return 'underpass';
    if (linkFacil === 3) return 'overpass';
    if (linkFacil === 2) return 'tunnel';
    return 'default';
}

function classifyRoadNodeRule() {
    return 'default';
}

function getRoadLinkResolvedRule(props) {
    if (Array.isArray(roadCustomLinkRules) && roadCustomLinkRules.length > 0) {
        for (let i = 0; i < roadCustomLinkRules.length; i += 1) {
            const customRule = roadCustomLinkRules[i];
            if (!matchesCustomLinkRule(customRule, props)) continue;
            const customKey = getCustomRoadLinkRuleKey(customRule);
            return {
                key: customKey || 'default',
                label: `${customRule.propKey}=${customRule.rawValue}`,
                color: customRule.color || '#8b5cf6',
                weight: Number(customRule.weight) || 2.1,
                isCustom: true
            };
        }
    }

    const builtInKey = classifyRoadLinkRule(props);
    const builtInRule = roadLinkRuleMap[builtInKey] || roadLinkRuleMap.default;
    const baseStyle = roadLinkBaseStyles?.[builtInRule?.key || 'default'] || {};
    return {
        key: builtInRule?.key || 'default',
        label: builtInRule?.label || '일반',
        color: normalizeRoadColor(baseStyle.color, builtInRule?.color || '#45c976'),
        weight: clampRoadLinkWeight(baseStyle.weight ?? builtInRule?.weight ?? 2.1),
        isCustom: false
    };
}

function isRoadLinkRuleEnabled(ruleKey) {
    return roadLinkRuleEnabled[ruleKey] !== false;
}

function isRoadNodeRuleEnabled(ruleKey) {
    return roadNodeRuleEnabled[ruleKey] !== false;
}

function attachRoadShapePopup(feature, layer, kind, title) {
    const baseProps = { ...(feature?.properties || {}) };
    const shpIndex = getRoadFeatureIndex(feature);
    if (Number.isFinite(shpIndex)) {
        baseProps.SHP_INDEX = shpIndex + 1;
    }

    layer.on('click', (event) => {
        if (!layer.getPopup()) {
            layer.bindPopup('', { maxWidth: 420, autoPan: false, keepInView: false });
        }

        const clickLat = Number(event?.latlng?.lat);
        const clickLon = Number(event?.latlng?.lng);
        const popupBaseProps = { ...baseProps };
        if (Number.isFinite(clickLat) && Number.isFinite(clickLon)) {
            popupBaseProps.CLICK_LAT = clickLat.toFixed(6);
            popupBaseProps.CLICK_LON = clickLon.toFixed(6);
        }

        const loadingProps = { ...popupBaseProps, 상태: '속성 조회 중...' };
        layer.setPopupContent(makeRoadPopupContent(loadingProps, title));
        layer.openPopup(event?.latlng);

        if (!Number.isFinite(shpIndex)) return;

        requestRoadShapeAttrs(kind, shpIndex).then((attrs) => {
            const attrObj = (attrs && typeof attrs === 'object') ? attrs : {};
            const merged = Object.keys(attrObj).length > 0
                ? { ...popupBaseProps, ...attrObj }
                : popupBaseProps;
            layer.setPopupContent(makeRoadPopupContent(merged, title));
        });
    });
}

function ensureRoadShapeLayers() {
    if (!roadLinkGeoLayer) {
        roadLinkGeoLayer = L.geoJSON(null, {
            renderer: roadCanvasRenderer,
            style: (feature) => getRoadLinkStyle(feature?.properties || {}),
            onEachFeature: (feature, layer) => {
                const props = feature?.properties || {};
                const labelText = pickRoadLabelText(feature, props);
                if (roadLabelEnabledForRender && labelText) {
                    layer.bindTooltip(labelText, {
                        permanent: true,
                        direction: 'center',
                        className: 'road-link-label'
                    });
                }
                attachRoadShapePopup(feature, layer, 'link', 'Road Link');
            }
        });
        addLayerToGroup(ROAD_LINK_LAYER, roadLinkGeoLayer);
    }

    if (!roadNodeGeoLayer) {
        roadNodeGeoLayer = L.geoJSON(null, {
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                renderer: roadCanvasRenderer,
                ...getRoadNodeStyle(feature?.properties || {})
            }),
            onEachFeature: (feature, layer) => {
                attachRoadShapePopup(feature, layer, 'node', 'Road Node');
            }
        });
        addLayerToGroup(ROAD_NODE_LAYER, roadNodeGeoLayer);
    }

    if (!layerOrder.includes(ROAD_LINK_LAYER)) layerOrder.push(ROAD_LINK_LAYER);
    if (!layerOrder.includes(ROAD_NODE_LAYER)) layerOrder.push(ROAD_NODE_LAYER);
    activeGroups.add(ROAD_LINK_LAYER);
    activeGroups.add(ROAD_NODE_LAYER);
}

function queryRoadViewport() {
    if (!roadShapeWorker || !roadShapeLoaded) return;

    const zoom = map.getZoom();
    if (zoom < roadMinZoom) {
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        return;
    }

    const limits = getRoadQueryLimits(zoom);

    const bounds = map.getBounds();
    roadShapeWorker.postMessage({
        type: 'query',
        requestId: ++roadShapeQueryRequestId,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        includeLinks: activeGroups.has(ROAD_LINK_LAYER),
        includeNodes: activeGroups.has(ROAD_NODE_LAYER),
        linkPropKeys: getRoadWorkerRequestedLinkProps(),
        maxLinks: limits.maxLinks,
        maxNodes: limits.maxNodes
    });
}

function getRoadQueryLimits(zoom) {
    if (zoom <= 11) {
        return { maxLinks: 1800, maxNodes: 900 };
    }
    if (zoom <= 13) {
        return { maxLinks: 4500, maxNodes: 1800 };
    }
    if (zoom <= 15) {
        return { maxLinks: 9000, maxNodes: 3000 };
    }
    if (zoom <= 16) {
        return { maxLinks: 4500, maxNodes: 1800 };
    }
    if (zoom <= 17) {
        return { maxLinks: 8000, maxNodes: 3200 };
    }
    return { maxLinks: ROAD_LINK_QUERY_LIMIT, maxNodes: ROAD_NODE_QUERY_LIMIT };
}

function scheduleRoadViewportQuery() {
    if (roadQueryDebounceTimer) clearTimeout(roadQueryDebounceTimer);
    roadQueryDebounceTimer = setTimeout(() => {
        roadQueryDebounceTimer = null;
        queryRoadViewport();
    }, 80);
}

function renderRoadViewportFeatures(linkFeatures, nodeFeatures) {
    ensureRoadShapeLayers();
    if (map.getZoom() < roadMinZoom) {
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        return;
    }

    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];
    const sourceNodes = Array.isArray(nodeFeatures) ? nodeFeatures : [];

    const resolvedLinkEntries = sourceLinks.map((feature) => {
        const props = feature?.properties || {};
        return {
            feature,
            rule: getRoadLinkResolvedRule(props)
        };
    });

    const linkRuleCounts = {};
    resolvedLinkEntries.forEach((entry) => {
        const ruleKey = entry.rule?.key || 'default';
        linkRuleCounts[ruleKey] = (linkRuleCounts[ruleKey] || 0) + 1;
    });
    roadLinkRenderedRuleCounts = linkRuleCounts;

    const visibleLinks = sourceLinks.filter((feature) => {
        const props = feature?.properties || {};
        const resolvedRule = getRoadLinkResolvedRule(props);
        return isRoadLinkRuleEnabled(resolvedRule.key);
    });
    const visibleNodes = sourceNodes.filter((feature) => {
        const props = feature?.properties || {};
        return isRoadNodeRuleEnabled(classifyRoadNodeRule(props));
    });

    roadNodeRenderedRuleCounts = { default: visibleNodes.length };

    roadLabelEnabledForRender =
        roadLinkIdLabelEnabled &&
        map.getZoom() >= roadLabelZoom &&
        visibleLinks.length > 0 &&
        visibleLinks.length <= ROAD_LABEL_BIND_LIMIT;

    if (roadLinkGeoLayer) {
        roadLinkGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_LINK_LAYER) && visibleLinks.length > 0) {
            roadLinkGeoLayer.addData({ type: 'FeatureCollection', features: visibleLinks });
        }
    }

    if (roadNodeGeoLayer) {
        roadNodeGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_NODE_LAYER) && visibleNodes.length > 0) {
            roadNodeGeoLayer.addData({ type: 'FeatureCollection', features: visibleNodes });
        }
    }

    roadLinkRenderCount = visibleLinks.length;
    roadNodeRenderCount = visibleNodes.length;
}

function formatRoadShapeMetaForState(kindLabel, meta) {
    if (!meta || typeof meta !== 'object') return `${kindLabel}: 없음`;
    const name = meta.folder_name || meta.file_name || '-';
    const sizeBytes = Number(meta.size_bytes || 0);
    const sizeMb = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB` : '-';
    const updatedAt = meta.updated_at || '-';
    return `${kindLabel}: ${name} (${sizeMb}, ${updatedAt})`;
}

function updateRoadShapeStateText(metaByKind, extraMessage = '') {
    const el = document.getElementById('roadShapeStateText');
    if (!el) return;
    const linkMeta = metaByKind?.link || null;
    const nodeMeta = metaByKind?.node || null;
    if (!linkMeta && !nodeMeta) {
        el.textContent = extraMessage ? `저장된 파일 없음 | ${extraMessage}` : '저장된 파일 없음';
        return;
    }
    const parts = [
        formatRoadShapeMetaForState('Link', linkMeta),
        formatRoadShapeMetaForState('Node', nodeMeta)
    ];
    const suffix = extraMessage ? ` | ${extraMessage}` : '';
    el.textContent = `${parts.join(' | ')}${suffix}`;
}

function removeRoadShapeLayers() {
    if (featureGroups[ROAD_LINK_LAYER]) {
        map.removeLayer(featureGroups[ROAD_LINK_LAYER]);
        delete featureGroups[ROAD_LINK_LAYER];
    }
    if (featureGroups[ROAD_NODE_LAYER]) {
        map.removeLayer(featureGroups[ROAD_NODE_LAYER]);
        delete featureGroups[ROAD_NODE_LAYER];
    }
    delete overlays[ROAD_LINK_LAYER];
    delete overlays[ROAD_NODE_LAYER];
    delete layerCountOverride[ROAD_LINK_LAYER];
    delete layerCountOverride[ROAD_NODE_LAYER];
    activeGroups.delete(ROAD_LINK_LAYER);
    activeGroups.delete(ROAD_NODE_LAYER);
    layerOrder = layerOrder.filter((name) => name !== ROAD_LINK_LAYER && name !== ROAD_NODE_LAYER);

    roadLinkGeoLayer = null;
    roadNodeGeoLayer = null;
    roadLinkFeatureCount = 0;
    roadNodeFeatureCount = 0;
    roadLinkRenderCount = 0;
    roadNodeRenderCount = 0;
    roadLinkRenderedRuleCounts = {};
    roadNodeRenderedRuleCounts = {};
    roadShapeLoaded = false;
    terminateRoadShapeWorker();
}

function handleRoadZoomChanged() {
    const zoom = map.getZoom();
    const showRoad = zoom >= roadMinZoom;

    if (roadShapePendingLoad && !roadShapeLoaded && !roadShapeLoading) {
        if (showRoad) {
            void loadRoadShapeOnDemand();
        }
        return;
    }

    if (roadShapeLoaded) {
        if (showRoad) {
            scheduleRoadViewportQuery();
            return;
        }
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        updateRoadShapeStateText(roadShapeMetaByKind, `zoom ${roadMinZoom}+에서만 표시`);
    }
}

function pickRoadLabelText(feature, props) {
    const shpIndex = getRoadFeatureIndex(feature);
    return (
        findRoadPropValue(props, 'LINK_ID') ??
        findRoadPropValue(props, 'IDXNAME') ??
        findRoadPropValue(props, 'ID') ??
        findRoadPropValue(props, 'LINK') ??
        (Number.isFinite(shpIndex) ? `#${shpIndex + 1}` : '') ??
        ''
    ).toString();
}

function getRoadLinkStyle(props) {
    const resolvedRule = getRoadLinkResolvedRule(props);
    return {
        color: resolvedRule.color || '#45c976',
        weight: Number(resolvedRule.weight) || 2.1,
        opacity: resolvedRule.isCustom ? 0.96 : 0.92
    };
}

function getRoadNodeStyle() {
    return {
        radius: roadNodeStyleConfig.radius,
        color: roadNodeStyleConfig.stroke,
        fillColor: roadNodeStyleConfig.color,
        fillOpacity: 0.88,
        weight: roadNodeStyleConfig.weight
    };
}

function getRoadPopupFieldSpecs(title) {
    if (title === 'Road Link') {
        return [
            { label: 'LINK_ID', keys: ['LINK_ID', 'LINBK_ID', 'LINBKID'] },
            { label: 'IDXNAME', keys: ['IDXNAME', 'LIDXNAME'] },
            { label: 'LANE', keys: ['LANE'] },
            { label: 'LENGTH', keys: ['LENGTH'] },
            { label: 'ONEWAY', keys: ['ONEWAY'] },
            { label: 'ROAD_CATE', keys: ['ROAD_CATE', 'ROADCATE'] },
            { label: 'LINK_CATE', keys: ['LINK_CATE', 'LINCATE'] },
            { label: 'LINK_FACIL', keys: ['LINK_FACIL', 'LINKFACIL'] },
            { label: 'ST_ND_ID', keys: ['ST_ND_ID', 'ST_NODE_ID'] },
            { label: 'ED_ND_ID', keys: ['ED_ND_ID', 'ED_NODE_ID'] },
            { label: 'CLICK_LAT', keys: ['CLICK_LAT'] },
            { label: 'CLICK_LON', keys: ['CLICK_LON'] }
        ];
    }

    return [
        { label: 'NODE_ID', keys: ['NODE_ID', 'ND_ID', 'ID'] },
        { label: 'ST_ND_ID', keys: ['ST_ND_ID', 'ST_NODE_ID', 'ST_ND_IDM'] },
        { label: 'ED_ND_ID', keys: ['ED_ND_ID', 'ED_NODE_ID'] },
        { label: 'LINK_ID', keys: ['LINK_ID', 'LINBK_ID', 'LINBKID'] },
        { label: 'IDXNAME', keys: ['IDXNAME', 'LIDXNAME'] },
        { label: 'CLICK_LAT', keys: ['CLICK_LAT'] },
        { label: 'CLICK_LON', keys: ['CLICK_LON'] }
    ];
}

function pickRoadPopupValue(props, keys) {
    if (!props || !Array.isArray(keys)) return undefined;
    for (let i = 0; i < keys.length; i += 1) {
        const value = findRoadPropValue(props, keys[i]);
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }
    return undefined;
}

function buildRoadSummaryRows(props, title) {
    const specs = getRoadPopupFieldSpecs(title);
    return specs
        .map((spec) => ({
            key: spec.label,
            value: pickRoadPopupValue(props, spec.keys)
        }))
        .filter((entry) => entry.value !== undefined && entry.value !== null && entry.value !== '')
        .map((entry) => `
            <div class="road-popup-summary-row">
                <span class="road-popup-summary-key">${escapeHtml(entry.key)}</span>
                <span class="road-popup-summary-value">${escapeHtml(entry.value)}</span>
            </div>
        `)
        .join('');
}

function makeRoadPopupContent(props, title) {
    const safeProps = props || {};
    const summaryRows = buildRoadSummaryRows(safeProps, title);

    return `
        <div class="road-popup">
            <div class="road-popup-title">${escapeHtml(title)}</div>
            <div class="road-popup-subtitle">선택 필드</div>
            <div class="road-popup-summary">
                ${summaryRows || '<div class="road-popup-summary-row"><span class="road-popup-summary-key">INFO</span><span class="road-popup-summary-value">표시 가능한 필드 없음</span></div>'}
            </div>
        </div>
    `;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function handleExportHtml(buttonId = 'exportHtmlMenuButton') {
    const exportBtn = document.getElementById(buttonId);
    const issueInput = document.getElementById('issueIdInput');
    const issueId = (issueInput?.value || '').trim();

    if (exportBtn) exportBtn.disabled = true;
    setUploadProgress(100, 'Export 중...', true);

    fetch('/api/export-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: issueId })
    })
        .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'Export 실패');
            }
            setUploadProgress(100, `Export 완료: ${data.file_name}`, false);
        })
        .catch((err) => {
            setUploadProgress(0, `실패: ${err.message}`, false);
        })
        .finally(() => {
            if (exportBtn) exportBtn.disabled = false;
        });
}

function handleExportHtmlFromMenu() {
    handleExportHtml('exportHtmlMenuButton');
}

function isInSelectedRange(timestampMs, minVal, maxVal) {
    if (!Number.isFinite(timestampMs)) return false;
    return timestampMs >= minVal && timestampMs <= maxVal;
}

function resetVisualization() {
    markers.forEach(marker => map.removeLayer(marker));
    polylines.forEach(polyline => map.removeLayer(polyline));
    highlightLayer.clearLayers();
    clearDistanceVisuals();
    pickedDistancePoints = [];
    resetRadiusSelection(false);

    Object.keys(featureGroups).forEach((key) => {
        if (key === ROAD_LINK_LAYER || key === ROAD_NODE_LAYER) return;
        map.removeLayer(featureGroups[key]);
        delete featureGroups[key];
    });
    Object.keys(overlays).forEach((key) => {
        if (key === ROAD_LINK_LAYER || key === ROAD_NODE_LAYER) return;
        delete overlays[key];
    });

    markers = [];
    polylines = [];
    requestGroups = {};
    activeGroups = new Set([...activeGroups].filter((name) => name === ROAD_LINK_LAYER || name === ROAD_NODE_LAYER));
    layerOrder = layerOrder.filter((name) => name === ROAD_LINK_LAYER || name === ROAD_NODE_LAYER);
    isLayerTreeExpanded = true;
    renderLayerControls();
    handleRoadZoomChanged();
}

function openSidebar(title) {
    const sidebar = document.getElementById('sidebar');
    const titleSpan = document.getElementById('sidebar-title');
    const btnClose = document.getElementById('btnCloseSidebar');

    if (sidebar) {
        sidebar.classList.remove('collapsed');
        if (titleSpan) {
            titleSpan.innerText = title;
        }
        if (btnClose) btnClose.textContent = '◀';
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => map.invalidateSize(), 220);
    }
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const btnClose = document.getElementById('btnCloseSidebar');
    if (sidebar) {
        sidebar.classList.add('collapsed');
    }
    if (btnClose) btnClose.textContent = '▶';
    highlightLayer.clearLayers();
    requestAnimationFrame(() => map.invalidateSize());
    setTimeout(() => map.invalidateSize(), 220);
}

function drawMarkers(coordinates) {
    markers = [];
    requestGroups = {};

    coordinates.forEach(coord => {
        const coordtype = coord.type;
        const latitude = coord.latitude;
        const longitude = coord.longitude;
        if (latitude === undefined || longitude === undefined) return;

        if (coordtype === 'Request') {
            const key = `${latitude},${longitude}`;
            if (!requestGroups[key]) {
                requestGroups[key] = {
                    currentIndex: 0,
                    latitude: latitude,
                    longitude: longitude,
                    members: [],
                    marker: [],
                    dlt_id_list: [],
                    timestamp_ms_list: []
                };
            }
            requestGroups[key].members.push(coord);
            requestGroups[key].dlt_id_list.push(coord.dlt_id);
            requestGroups[key].timestamp_ms_list.push(coord.timestamp_ms);
        } else {
            const popupText = makePopupText(coord, coordtype);
            const marker = L.circleMarker([latitude, longitude], {
                radius: 3,
                color: coord.color || 'black',
                fill: coord.fill,
                fillOpacity: 0.8
            }).bindPopup(popupText);

            marker.dlt_id = coord.dlt_id;
            marker.timestamp_ms = coord.timestamp_ms;
            marker.id = coord.id || 0;
            marker.data = coord;
            marker._baseStyle = {
                opacity: 1,
                fillOpacity: 0.8,
                weight: marker.options.weight ?? 1,
                radius: marker.options.radius ?? 3
            };
            attachMarkerDistancePick(marker);

            addLayerToGroup(coordtype, marker);
            markers.push(marker);
        }
    });

    drawRequestGroupMarkers(requestGroups, markers);
    addOverlayLayers(featureGroups);
}

function drawRequestGroupMarkers(requestGroups, markers) {
    Object.keys(requestGroups).forEach(key => {
        const request = requestGroups[key];
        const latitude = request.latitude;
        const longitude = request.longitude;
        const members = request.members;

        const hasDeviation = members.some(m => m.extra.group_2_text === "이탈");
        let marker = L.marker([latitude, longitude], {
            icon: L.AwesomeMarkers.icon({
                icon: hasDeviation ? 'exclamation' : 'info-circle',
                markerColor: 'gray',
                prefix: 'fa',
                size: 'small'
            })
        });

        if (members.length === 1) {
            const coord = members[0];
            marker.bindPopup(makePopupText(coord, 'Request'));
            marker.dlt_id = coord.dlt_id;
            marker.timestamp_ms = coord.timestamp_ms;
            marker.id = coord.id || 0;
            marker.data = coord;
        } else {
            marker.dlt_id = request.dlt_id_list[0];
            marker.timestamp_ms = request.timestamp_ms_list[0];
            marker.id = members[0].id || 0;
            marker.data = members[0];

            const initialContent = `<div style="min-width:100px;">Request (${1}/${members.length})</div>`;
            const popup = L.popup({ autoClose: false, closeOnClick: false }).setContent(initialContent);
            marker.bindPopup(popup);

            marker.on('click', () => {
                if (!request.currentIndex) request.currentIndex = 0;
                showRequestGroupPopup(request, marker);
            });
        }
        marker._isIconMarker = true;
        requestGroups[key].marker = marker;
        attachMarkerDistancePick(marker);
        addLayerToGroup('Request', marker);
        markers.push(marker);
    });
}

function showRequestGroupPopup(request, groupMarker) {
    const members = request.members;
    if (!members || members.length === 0) return;

    const index = request.currentIndex || 0;
    const coord = members[index];

    const popupText = makePopupText(coord, 'Request');
    const content = `
        <div style="min-width:100px;">
            <div style="font-weight:600;">Request (${index + 1}/${members.length})</div>
            ${popupText}
            <div style="margin-top:8px; display:flex; gap:6px; justify-content:flex-end;">
                <button id="req-prev">이전</button>
                <button id="req-next">다음</button>
            </div>
        </div>`;

    let popup = groupMarker.getPopup();
    if (popup) {
        popup.setContent(content);
    }

    groupMarker.openPopup();

    setTimeout(() => {
        const prevBtn = document.getElementById('req-prev');
        const nextBtn = document.getElementById('req-next');
        if (prevBtn) prevBtn.onclick = (e) => {
            e.stopPropagation();
            request.currentIndex = (request.currentIndex - 1 + members.length) % members.length;
            showRequestGroupPopup(request, groupMarker);
        };
        if (nextBtn) nextBtn.onclick = (e) => {
            e.stopPropagation();
            request.currentIndex = (request.currentIndex + 1) % members.length;
            showRequestGroupPopup(request, groupMarker);
        };
    }, 50);
}

function makePopupText(coordinate, coordtype) {
    const dltId = Number.isFinite(coordinate?.dlt_id) ? coordinate.dlt_id : 0;
    const formatted = dltId > 0 ? dltId.toLocaleString() : '-';
    const markerId = Number.isFinite(coordinate?.id) ? coordinate.id : '-';
    const lat = Number.isFinite(coordinate?.latitude) ? coordinate.latitude.toFixed(6) : '-';
    const lon = Number.isFinite(coordinate?.longitude) ? coordinate.longitude.toFixed(6) : '-';
    const ts = coordinate?.timestamp_str ? coordinate.timestamp_str : '-';

    let text = `DLT: ${formatted}<br>ID: ${markerId}<br>TS: ${ts}<br>${lat}, ${lon}`;

    if (coordinate.heading !== null && coordinate.heading !== undefined) {
        text += `<br>Heading: ${coordinate.heading.toFixed(2)}°`;
    }

    if (coordinate.extra && coordinate.extra.Speed !== undefined) {
        text += `<br>Speed: ${parseFloat(coordinate.extra.Speed).toFixed(2)}`;
    }

    if (coordtype === "DR-based") {
        text += `<br>isDRGps: ${coordinate.extra?.isDRGps ?? ""}`;
    }
    if (coordtype === "Request") {
        text += `<br>${coordinate.extra?.group_1 ?? ""} ${coordinate.extra?.group_2_text ?? ""}`;
    }
    if (coordtype === "Route Match" || coordtype === "Road Match") {
        const state = coordinate.extra?.match_state || "";
        if (!(state === "MATCH_OK_GOOD" || state === "MATCH_OK_TRANSIENT")) {
            text += `<br>${state}`;
        }
    }
    return text;
}

function drawPolylines(lines) {
    polylines = [];
    lines.forEach(line => {
        const { type, extra } = line;

        let color = "gray";
        if (type === "Deviation") color = "red";
        else if (type === "DR Correction") color = "orange";
        else if (type === "DR to VPM") color = "#9ca3af";

        const polyline = L.polyline([line.start, line.end], {
            color: color,
            weight: (type === "DR Correction") ? 3 : 1,
            dashArray: null,
            opacity: type === "DR to VPM" ? 0.7 : 0.8
        });

        polyline.id = line.id || 0;
        polyline.timestamp_ms = line.timestamp_ms;
        polyline.lineData = line;
        polyline._baseStyle = {
            opacity: polyline.options.opacity ?? 0.8,
            weight: polyline.options.weight ?? 1
        };

        polyline.on('click', (e) => {
            highlightEndpoints(line.start, line.end, color);

            if (type === "Deviation") {
                openDeviationPopup(polyline, line);
            }
            else if (type === "DR Correction" && extra) {
                let popupContent = `<strong>[DR Correction]</strong><br>`;
                if (extra.reason) popupContent += `reason: ${extra.reason}`;
                L.popup().setLatLng(e.latlng).setContent(popupContent).openOn(map);
            }
            L.DomEvent.stopPropagation(e);
        });

        addLayerToGroup(type, polyline);
        polylines.push(polyline);
    });
    addOverlayLayers(featureGroups);
}

function highlightEndpoints(start, end, color) {
    highlightLayer.clearLayers();

    const haloStyle = { radius: 8, color: color, weight: 2, fillColor: color, fillOpacity: 0.3, interactive: false };
    const coreStyle = { radius: 2, color: 'white', weight: 1, fillColor: 'white', fillOpacity: 1.0, interactive: false };

    L.circleMarker(start, haloStyle).addTo(highlightLayer);
    L.circleMarker(start, coreStyle).addTo(highlightLayer);
    L.circleMarker(end, haloStyle).addTo(highlightLayer);
    L.circleMarker(end, coreStyle).addTo(highlightLayer);
}

function openDeviationPopup(polyline, line) {
    L.popup()
        .setLatLng(polyline.getCenter())
        .setContent(makeDeviationPopup(line))
        .openOn(map);
}

function makeDeviationPopup(lineData) {
    const isDistanceRed = lineData.deviation_type === "distance" || lineData.deviation_type === "both";
    const isAngleRed = lineData.deviation_type === "angle" || lineData.deviation_type === "both";
    const isLocalVpm = lineData.local_distance < lineData.route_distance;

    return `
        <strong ${isDistanceRed ? 'style="color:red;"' : ''}>거리</strong><br>
        실제: ${lineData.actual_distance}m<br>
        임계값: ${lineData.distance_threshold}m<br><br>
        <strong ${isAngleRed ? 'style="color:red;"' : ''}>각도</strong><br>
        실제: ${lineData.actual_angle_diff}°<br>
        임계값: ${lineData.angle_threshold}°<br><br>
        Local: ${lineData.local_distance}m ${isLocalVpm ? '<strong style="color:blue;">←</strong>' : ''}<br>
        Route: ${lineData.route_distance}m ${!isLocalVpm ? '<strong style="color:blue;">←</strong>' : ''}
    `;
}

function drawPolygons() {
    const polygons = [
        [[37.553061, 126.969263], [37.553274, 126.971954], [37.556680, 126.971958], [37.556454, 126.969327]], // 서울역
        [[37.553613, 126.975417], [37.553487, 126.976356], [37.554158, 126.976373], [37.554185, 126.975434]], // T-tower
        [[37.554980, 126.973650], [37.556025, 126.973569], [37.556029, 126.974524], [37.555010, 126.974620]], // ssq big one
        [[35.224479, 128.681126], [35.223577, 128.682656], [35.224349, 128.683336], [35.225124, 128.681710]], // 창원 롯데
        [[37.543904, 127.225833], [37.545233, 127.220904], [37.547293, 127.221773], [37.545630, 127.226240]], // 스타필드 미사 빅
        [[37.408756, 127.261004], [37.408807, 127.261544], [37.410264, 127.261583], [37.410239, 127.260896]], // 유스퀘어 문화관
        [[37.533002, 126.957991], [37.533439, 126.957793], [37.533597, 126.958554], [37.533191, 126.958749]], // 전자랜드 주차장
        [[37.532979, 126.964169], [37.533295, 126.964084], [37.533410, 126.965000], [37.533076, 126.965068]], // YS-한로마트
        [[37.547344, 126.970063], [37.547321, 126.969670], [37.547598, 126.969664], [37.547650, 126.970018]]  // KCC 오토 청파
    ];

    polygons.forEach(coords => {
        L.polygon(coords, {
            color: 'blue',
            fillColor: 'blue',
            fillOpacity: 0.5
        }).addTo(map);
    });

    // 이 안에 들어오면 + 헤딩 15도 이내면 보정 후보 -> FindCorrectionPoint
    const ssqCorrectionPoints = [
        {
            name: "SSQ RampUp",
            lat: 37.555515,
            lon: 126.974200
        },
        {
            name: "SSQ RampDown",
            lat: 37.555230,
            lon: 126.974200
        }
    ];

    const ssq_rampup_correction = [
        [
            [37.555407, 126.974063],
            [37.555407, 126.974337],
            [37.555623, 126.974337],
            [37.555623, 126.974063]
        ]
    ];
    const ssq_rampdown_correction = [
        [
            [37.555122, 126.974063],
            [37.555122, 126.974337],
            [37.555338, 126.974337],
            [37.555338, 126.974063]
        ]
    ];

    ssq_rampup_correction.forEach(coords => {
        L.polygon(coords, {
            color: 'purple',
            fillColor: 'purple',
            fillOpacity: 0.5
        }).addTo(map);
    });

    ssq_rampdown_correction.forEach(coords => {
        L.polygon(coords, {
            color: 'purple',
            fillColor: 'purple',
            fillOpacity: 0.5
        }).addTo(map);
    });

    ssqCorrectionPoints.forEach(p => {
        const marker = L.circleMarker([p.lat, p.lon], {
            radius: 2,
            color: 'red',
            fillColor: 'red',
            fillOpacity: 0.5,
            weight: 1
        }).bindPopup(`
            <strong>${p.name}</strong><br>
            Lat: ${p.lat.toFixed(6)}<br>
            Lon: ${p.lon.toFixed(6)}<br>
            DR Heading Range: 345° ~ 15° (±15°)<br>
            DR Heading Forced: 0°
        `);

        marker.addTo(map);
    });
}

function addLayerToGroup(type, layer) {
    if (!featureGroups[type]) {
        featureGroups[type] = L.featureGroup();
        featureGroups[type].addTo(map);
        activeGroups.add(type);
        if (!layerOrder.includes(type)) layerOrder.push(type);
    }

    let typeLower = type.toLowerCase();
    if (typeLower.includes('to') || typeLower.includes('deviation') || typeLower.includes('correction')) {
        layer.options.pane = 'overlayPane';
    } else if (typeLower.includes('request')) {
        layer.options.pane = 'tooltipPane';
    } else {
        layer.options.pane = 'markerPane';
    }
    featureGroups[type].addLayer(layer);
}

function addOverlayLayers(featureGroups) {
    Object.keys(featureGroups).forEach(coord => {
        overlays[coord] = featureGroups[coord];
    });
}

function fitToBounds(featureGroups) {
    const groups = Object.values(featureGroups);
    if (groups.length === 0) return;
    const allBounds = L.featureGroup(groups).getBounds();
    if (allBounds.isValid && allBounds.isValid()) {
        map.fitBounds(allBounds);
    }
}

function addControlLayers() {
    if (!baseLayerInitialized) {
        baseLayers["Tmap"].addTo(map);
        baseLayerInitialized = true;
    }

    if (layerControl) {
        map.removeControl(layerControl);
    }
    layerControl = L.control.layers(baseLayers, null, { collapsed: true }).addTo(map);
}

function getLayerOrderKey(name) {
    const order = {
        'Raw GNSS': 1,
        'Filtered GNSS': 2,
        'DR-based': 3,
        'Road Match': 4,
        'Route Match': 5,
        'VPM': 6,
        'Request': 7,
        'GNSS to DR': 8,
        'DR Correction': 9,
        'DR to VPM': 10,
        'Deviation': 11,
        'Road Link': 12,
        'Road Node': 13
    };
    return order[name] ?? 999;
}

function openLayerContextMenu(layerName, anchorEl) {
    const menu = document.getElementById('layerContextMenu');
    if (!menu) return;

    const isLink = layerName === ROAD_LINK_LAYER;
    const isNode = layerName === ROAD_NODE_LAYER;

    const title = document.getElementById('layerCtxTitle');
    if (title) title.textContent = `${layerName} 스타일`;

    const linkSec = document.getElementById('layerCtxLinkSection');
    const nodeSec = document.getElementById('layerCtxNodeSection');
    if (linkSec) linkSec.style.display = isLink ? '' : 'none';
    if (nodeSec) nodeSec.style.display = isNode ? '' : 'none';

    if (isLink) {
        renderLinkStyleFieldOptions();
        renderLinkBaseRuleEditorForContextMenu();
    }
    renderCustomLinkRuleList();
    menu.classList.remove('hidden');

    // 위치: 앵커 기준으로 배치
    if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        menu.style.left = `${Math.min(rect.right + 8, window.innerWidth - 300)}px`;
        menu.style.top = `${Math.max(rect.top, 8)}px`;
    }
}

function createRoadLinkBaseStyleEditorElement(isContextMenu = false) {
    const baseStyleWrap = document.createElement('div');
    baseStyleWrap.className = 'layer-rule-base-style-wrap';
    if (isContextMenu) {
        baseStyleWrap.classList.add('layer-rule-base-style-wrap-panel');
    }

    const baseTitle = document.createElement('div');
    baseTitle.className = 'layer-rule-base-style-title';
    baseTitle.textContent = '기본 링크 스타일';
    baseStyleWrap.appendChild(baseTitle);

    ROAD_LINK_RULES.forEach((rule) => {
        const style = ensureRoadLinkBaseStyle(rule.key);
        const row = document.createElement('div');
        row.className = 'layer-rule-base-style-row';

        const name = document.createElement('span');
        name.className = 'layer-rule-base-style-name';
        name.textContent = rule.label;
        row.appendChild(name);

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'layer-ctx-color';
        colorInput.value = normalizeRoadColor(style.color, rule.color);
        colorInput.title = `${rule.label} 색상`;
        colorInput.addEventListener('change', () => {
            updateRoadLinkBaseStyle(rule.key, { color: colorInput.value });
        });
        row.appendChild(colorInput);

        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.min = '0.5';
        weightInput.max = '12';
        weightInput.step = '0.1';
        weightInput.className = 'layer-ctx-weight';
        weightInput.value = String(clampRoadLinkWeight(style.weight));
        weightInput.title = `${rule.label} 두께`;
        weightInput.addEventListener('change', () => {
            updateRoadLinkBaseStyle(rule.key, { weight: weightInput.value });
        });
        row.appendChild(weightInput);

        baseStyleWrap.appendChild(row);
    });

    return baseStyleWrap;
}

function renderLinkBaseRuleEditorForContextMenu() {
    const container = document.getElementById('linkBaseRuleEditor');
    if (!container) return;
    container.innerHTML = '';
    container.appendChild(createRoadLinkBaseStyleEditorElement(true));
}

function closeLayerContextMenu() {
    const menu = document.getElementById('layerContextMenu');
    if (menu) menu.classList.add('hidden');
}

function renderLayerControls() {
    const list = document.getElementById('layerControlList');
    if (!list) return;
    list.innerHTML = '';

    ensureFeatureGroupsFromCurrentLayers();

    const sortedGroups = Object.keys(featureGroups).sort((a, b) => {
        const keyDiff = getLayerOrderKey(a) - getLayerOrderKey(b);
        return keyDiff !== 0 ? keyDiff : a.localeCompare(b);
    });
    if (layerOrder.length === 0) {
        layerOrder = sortedGroups.slice();
    } else {
        const missing = sortedGroups.filter((name) => !layerOrder.includes(name));
        layerOrder = layerOrder.filter((name) => sortedGroups.includes(name)).concat(missing);
    }

    const groups = layerOrder.slice();
    const visibleCount = groups.filter((name) => activeGroups.has(name)).length;

    const tree = document.createElement('div');
    tree.className = 'layer-tree-card';

    const rootRow = document.createElement('div');
    rootRow.className = 'layer-root-row';

    const rootToggleBtn = document.createElement('button');
    rootToggleBtn.type = 'button';
    rootToggleBtn.className = 'layer-tree-toggle';
    rootToggleBtn.textContent = isLayerTreeExpanded ? '▾' : '▸';
    rootToggleBtn.onclick = () => {
        isLayerTreeExpanded = !isLayerTreeExpanded;
        renderLayerControls();
    };
    rootRow.appendChild(rootToggleBtn);

    const rootCheckbox = document.createElement('input');
    rootCheckbox.type = 'checkbox';
    rootCheckbox.className = 'layer-control-check';
    rootCheckbox.checked = groups.length > 0 && visibleCount === groups.length;
    rootCheckbox.indeterminate = visibleCount > 0 && visibleCount < groups.length;
    rootCheckbox.onchange = () => {
        const enable = rootCheckbox.checked;
        groups.forEach((layerName) => {
            const group = featureGroups[layerName];
            if (!group) return;
            if (enable) {
                if (!map.hasLayer(group)) map.addLayer(group);
                activeGroups.add(layerName);
            } else {
                if (map.hasLayer(group)) map.removeLayer(group);
                activeGroups.delete(layerName);
            }
        });
        updateMap();
        renderLayerControls();
    };
    rootRow.appendChild(rootCheckbox);

    const rootLabel = document.createElement('div');
    rootLabel.className = 'layer-root-label';
    rootLabel.textContent = `result_${currentResultName}`;
    rootRow.appendChild(rootLabel);
    tree.appendChild(rootRow);

    const childWrap = document.createElement('div');
    childWrap.className = 'layer-children';
    if (!isLayerTreeExpanded) childWrap.style.display = 'none';

    groups.forEach((name) => {
        const group = featureGroups[name];
        if (!group) return;

        const row = document.createElement('div');
        row.className = 'layer-control-item';
        row.draggable = true;
        row.dataset.layerName = name;

        row.addEventListener('dragstart', (e) => {
            draggedLayerName = name;
            row.classList.add('dragging');
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            draggedLayerName = null;
            document.querySelectorAll('.layer-control-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('drag-over');
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drag-over');
            if (!draggedLayerName || draggedLayerName === name) return;
            const from = layerOrder.indexOf(draggedLayerName);
            const to = layerOrder.indexOf(name);
            if (from < 0 || to < 0) return;
            const [moved] = layerOrder.splice(from, 1);
            layerOrder.splice(to, 0, moved);
            renderLayerControls();
            updateMap();
        });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'layer-control-check';
        checkbox.checked = activeGroups.has(name);
        checkbox.onchange = () => {
            if (checkbox.checked) {
                if (!map.hasLayer(group)) map.addLayer(group);
                activeGroups.add(name);
            } else {
                if (map.hasLayer(group)) map.removeLayer(group);
                activeGroups.delete(name);
            }
            updateMap();
            renderLayerControls();
        };
        row.appendChild(checkbox);

        const swatch = document.createElement('span');
        swatch.className = 'layer-color-swatch';
        swatch.style.background = getLayerSwatchColor(name);
        row.appendChild(swatch);

        const label = document.createElement('div');
        label.className = 'layer-control-label';
        label.textContent = name;
        row.appendChild(label);

        const count = document.createElement('div');
        count.className = 'layer-count';
        const displayCount = Number.isFinite(layerCountOverride[name]) ? layerCountOverride[name] : group.getLayers().length;
        count.textContent = `${displayCount}`;
        row.appendChild(count);

        // 우클릭 컨텍스트 메뉴 (Road Link / Road Node 전용)
        if (name === ROAD_LINK_LAYER || name === ROAD_NODE_LAYER) {
            const ctxBtn = document.createElement('button');
            ctxBtn.type = 'button';
            ctxBtn.className = 'layer-ctx-trigger';
            ctxBtn.title = '스타일 설정';
            ctxBtn.innerHTML = '<i class="fa fa-paint-brush"></i>';
            ctxBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openLayerContextMenu(name, ctxBtn);
            });
            row.appendChild(ctxBtn);

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                openLayerContextMenu(name, row);
            });
        }

        childWrap.appendChild(row);
        appendRoadRuleControls(childWrap, name);
    });

    tree.appendChild(childWrap);
    list.appendChild(tree);
    applyLayerOrderZIndex();
}

function appendRoadRuleControls(parent, layerName) {
    if (layerName !== ROAD_LINK_LAYER && layerName !== ROAD_NODE_LAYER) return;

    const enabledMap = layerName === ROAD_LINK_LAYER ? roadLinkRuleEnabled : roadNodeRuleEnabled;
    let rules = [];

    if (layerName === ROAD_LINK_LAYER) {
        syncRoadLinkRuleEnabledState();
        const baseRules = ROAD_LINK_RULES.map((rule) => ({
            key: rule.key,
            label: rule.label,
            color: normalizeRoadColor(
                roadLinkBaseStyles?.[rule.key]?.color,
                rule.color
            ),
            count: Number(roadLinkRenderedRuleCounts?.[rule.key] || 0)
        }));
        const customRules = roadCustomLinkRules.map((rule) => {
            const customKey = getCustomRoadLinkRuleKey(rule);
            return {
                key: customKey,
                label: `커스텀 ${rule.propKey}=${rule.rawValue}`,
                color: rule.color || '#8b5cf6',
                count: Number(roadLinkRenderedRuleCounts?.[customKey] || 0)
            };
        }).filter((rule) => !!rule.key);
        rules = baseRules.concat(customRules);
    } else {
        rules = ROAD_NODE_RULES.map((rule) => ({
            key: rule.key,
            label: rule.label,
            color: rule.color,
            count: Number(roadNodeRenderedRuleCounts?.[rule.key] || 0)
        }));
    }

    const ruleWrap = document.createElement('div');
    ruleWrap.className = 'layer-rule-list';

    rules.forEach((rule) => {
        const item = document.createElement('label');
        item.className = 'layer-rule-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'layer-control-check';
        checkbox.checked = enabledMap[rule.key] !== false;
        checkbox.onchange = () => {
            enabledMap[rule.key] = checkbox.checked;
            if (roadShapeLoaded) {
                scheduleRoadViewportQuery();
            }
            renderLayerControls();
        };
        item.appendChild(checkbox);

        const swatch = document.createElement('span');
        swatch.className = 'layer-rule-swatch';
        swatch.style.background = rule.color;
        item.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'layer-rule-label';
        const countSuffix = Number.isFinite(rule.count) ? ` (${rule.count})` : '';
        label.textContent = `${rule.label}${countSuffix}`;
        item.appendChild(label);

        ruleWrap.appendChild(item);
    });

    if (layerName === ROAD_LINK_LAYER) {
        const labelItem = document.createElement('label');
        labelItem.className = 'layer-rule-item';

        const labelCheckbox = document.createElement('input');
        labelCheckbox.type = 'checkbox';
        labelCheckbox.className = 'layer-control-check';
        labelCheckbox.checked = roadLinkIdLabelEnabled;
        labelCheckbox.onchange = () => {
            roadLinkIdLabelEnabled = labelCheckbox.checked;
            if (roadShapeLoaded) {
                scheduleRoadViewportQuery();
            }
            renderLayerControls();
        };
        labelItem.appendChild(labelCheckbox);

        const labelSwatch = document.createElement('span');
        labelSwatch.className = 'layer-rule-swatch';
        labelSwatch.style.background = '#64748b';
        labelItem.appendChild(labelSwatch);

        const labelText = document.createElement('span');
        labelText.className = 'layer-rule-label';
        labelText.textContent = '도로 ID 라벨 표시';
        labelItem.appendChild(labelText);

        ruleWrap.appendChild(labelItem);
    }

    parent.appendChild(ruleWrap);
}

function getLayerSwatchColor(name) {
    if (name === ROAD_LINK_LAYER) {
        const style = ensureRoadLinkBaseStyle('default');
        return normalizeRoadColor(style.color, '#45c976');
    }
    const swatches = {
        'Raw GNSS': '#a855f7',
        'Filtered GNSS': '#facc15',
        'DR-based': '#ef4444',
        'Road Match': '#22d3ee',
        'Route Match': '#84cc16',
        'VPM': '#2563eb',
        'Request': '#f97316',
        'GNSS to DR': '#eab308',
        'DR Correction': '#fb923c',
        'DR to VPM': '#2563eb',
        'Deviation': '#ef4444',
        'Road Node': '#22c3d6'
    };
    return swatches[name] || '#94a3b8';
}

function ensureFeatureGroupsFromCurrentLayers() {
    if (Object.keys(featureGroups).length > 0) return;
    if (markers.length === 0 && polylines.length === 0) return;

    markers.forEach((marker) => {
        const type = marker?.data?.type || 'Request';
        if (!featureGroups[type]) {
            featureGroups[type] = L.featureGroup().addTo(map);
            activeGroups.add(type);
            if (!layerOrder.includes(type)) layerOrder.push(type);
        }
        if (!featureGroups[type].hasLayer(marker)) {
            featureGroups[type].addLayer(marker);
        }
    });

    polylines.forEach((line) => {
        const type = line?.lineData?.type || 'Unknown';
        if (!featureGroups[type]) {
            featureGroups[type] = L.featureGroup().addTo(map);
            activeGroups.add(type);
            if (!layerOrder.includes(type)) layerOrder.push(type);
        }
        if (!featureGroups[type].hasLayer(line)) {
            featureGroups[type].addLayer(line);
        }
    });
}

function applyLayerOrderZIndex() {
    // Leaflet renders later layers on top. Apply order by z-index and bringToFront.
    layerOrder.forEach((name, idx) => {
        const group = featureGroups[name];
        if (!group) return;
        const zBase = 1000 + idx * 10;
        group.eachLayer((layer) => {
            if (typeof layer.setZIndexOffset === 'function') {
                layer.setZIndexOffset(zBase);
            }
            if (typeof layer.bringToFront === 'function') {
                layer.bringToFront();
            }
        });
    });
}

function updateMap() {
    if (!slider.noUiSlider) return;
    const [minVal, maxVal] = slider.noUiSlider.get().map(Number);

    markers.forEach(marker => {
        const groupActive = activeGroups.has(getLayerGroupName(marker));
        const visibleByTime = isInSelectedRange(marker.timestamp_ms, minVal, maxVal);
        applyTimeVisibility(marker, groupActive && visibleByTime);
    });

    polylines.forEach(layer => {
        const groupActive = activeGroups.has(getLayerGroupName(layer));
        const visibleByTime = isInSelectedRange(layer.timestamp_ms, minVal, maxVal);
        applyTimeVisibility(layer, groupActive && visibleByTime);
    });

    handleRoadZoomChanged();
    updateRangeLabel(minVal, maxVal);
}

function applyTimeVisibility(layer, visible) {
    if (!layer) return;

    if (layer._isIconMarker && typeof layer.setOpacity === 'function') {
        layer.setOpacity(visible ? 1 : 0);
        return;
    }

    if (layer._baseStyle && typeof layer.setStyle === 'function') {
        if (visible) {
            layer.setStyle({
                opacity: layer._baseStyle.opacity,
                fillOpacity: layer._baseStyle.fillOpacity ?? layer._baseStyle.opacity,
                weight: layer._baseStyle.weight
            });
            if (typeof layer.setRadius === 'function' && Number.isFinite(layer._baseStyle.radius)) {
                layer.setRadius(layer._baseStyle.radius);
            }
        } else {
            layer.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 });
            if (typeof layer.setRadius === 'function') {
                layer.setRadius(0);
            }
        }
        return;
    }

    if (typeof layer.setOpacity === 'function') {
        layer.setOpacity(visible ? 1 : 0);
    }
}

function getLayerGroupName(layer) {
    for (const name in featureGroups) {
        if (featureGroups[name].hasLayer(layer)) return name;
    }
    return null;
}

function updateRangeLabel(minVal, maxVal) {
    const label = document.getElementById('rangeLabel');
    if (!label) return;
    const d1 = new Date(minVal);
    const d2 = new Date(maxVal);
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        label.textContent = '- ~ -';
        return;
    }

    const formatTs = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}.${ms}`;
    };

    label.textContent = `${formatTs(d1)} ~ ${formatTs(d2)}`;
}

function handleOverlayAdd(e) {
    const layer = e.layer;
    for (const key in featureGroups) {
        if (featureGroups[key] === layer) {
            activeGroups.add(key);
            break;
        }
    }
    updateMap();
    renderLayerControls();
}

function handleOverlayRemove(e) {
    for (const key in featureGroups) {
        if (featureGroups[key] === e.layer) {
            activeGroups.delete(key);
            break;
        }
    }
    e.layer.eachLayer(l => map.removeLayer(l));
    renderLayerControls();
}

function handleDltSearch() {
    const value = parseInt(document.getElementById('searchBox').value);
    const infoPanel = document.getElementById('infoPanel');
    if (!infoPanel) return;

    if (isNaN(value)) {
        infoPanel.innerHTML = "<div style='padding:16px; color:#cbd5e1;'>DLT ID 숫자를 입력하세요.</div>";
        return;
    }
    const matchedMarkers = markers.filter(m => m.dlt_id === value);
    const matchedLines = polylines.filter(l => l.lineData?.dlt_id === value);
    const foundItems = [
        ...matchedMarkers.map(obj => ({ type: 'marker', obj })),
        ...matchedLines.map(obj => ({ type: 'line', obj }))
    ];

    highlightLayer.clearLayers();
    infoPanel.innerHTML = "";
    openSidebar(`DLT: ${value} 검색 결과`);

    if (foundItems.length === 0) {
        infoPanel.innerHTML = "<div style='padding:16px; color:#cbd5e1;'>해당 DLT ID를 찾지 못했습니다.</div>";
        return;
    }

    foundItems.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = `info-item ${item.type}`;
        if (item.type === 'marker') {
            const data = item.obj.data || {};
            highlightMarker(item.obj);
            div.innerHTML = `
                <div class="info-title">[MARKER] ${data.type || 'Unknown'} #${idx + 1}</div>
                <div class="info-detail">
                    <div class="info-row"><span class="info-key">ID</span><span>${data.id ?? '-'}</span></div>
                    <div class="info-row"><span class="info-key">TS</span><span>${data.timestamp_str ?? '-'}</span></div>
                    <div class="info-row"><span class="info-key">Lat</span><span>${(data.latitude ?? 0).toFixed(6)}</span></div>
                    <div class="info-row"><span class="info-key">Lon</span><span>${(data.longitude ?? 0).toFixed(6)}</span></div>
                </div>`;
            div.onclick = () => {
                map.setView(item.obj.getLatLng(), 18);
                item.obj.openPopup();
            };
        } else {
            const data = item.obj.lineData || {};
            highlightLine(item.obj);
            div.innerHTML = `
                <div class="info-title">[LINE] ${data.type || 'Unknown'} #${idx + 1}</div>
                <div class="info-detail">
                    <div class="info-row"><span class="info-key">ID</span><span>${data.id ?? '-'}</span></div>
                    <div class="info-row"><span class="info-key">TS</span><span>${data.timestamp_str ?? '-'}</span></div>
                    <div class="info-row"><span class="info-key">Start</span><span>${data.start}</span></div>
                    <div class="info-row"><span class="info-key">End</span><span>${data.end}</span></div>
                </div>`;
            div.onclick = () => {
                map.fitBounds(item.obj.getBounds());
                item.obj.openPopup();
            };
        }
        infoPanel.appendChild(div);
    });

    const first = foundItems[0];
    if (first.type === 'marker') {
        map.setView(first.obj.getLatLng(), 17);
    } else {
        map.fitBounds(first.obj.getBounds());
    }
}

function handleIdSearch() {
    const searchId = parseInt(document.getElementById('idSearchBox').value);
    if (isNaN(searchId)) {
        alert("유효한 ID(숫자)를 입력하세요.");
        return;
    }

    highlightLayer.clearLayers();
    const infoPanel = document.getElementById('infoPanel');
    if (!infoPanel) return;
    infoPanel.innerHTML = "";

    openSidebar(`ID: ${searchId} 검색 결과`);

    let foundCount = 0;
    const foundItems = [];

    markers.forEach(marker => {
        if (marker.id === searchId) {
            highlightMarker(marker);
            foundItems.push({ type: 'marker', obj: marker });
            foundCount++;
        }
    });

    polylines.forEach(line => {
        if (line.id === searchId) {
            highlightLine(line);
            foundItems.push({ type: 'line', obj: line });
            foundCount++;
        }
    });

    if (foundCount === 0) {
        infoPanel.innerHTML = "<div style='padding:20px; color:#cbd5e1; text-align:center;'>해당 ID를 가진 데이터가 없습니다.</div>";
        return;
    }

    foundItems.forEach(item => {
        const div = document.createElement('div');
        div.className = `info-item ${item.type}`;

        let title = "";
        let latLonHtml = "";
        let extra = null;

        if (item.type === 'marker') {
            const data = item.obj.data || {};
            title = `${data.type || 'Unknown'}`;
            latLonHtml = `
                <div class="info-row"><span class="info-key">Lat</span><span>${data.latitude.toFixed(6)}</span></div>
                <div class="info-row"><span class="info-key">Lon</span><span>${data.longitude.toFixed(6)}</span></div>
            `;
            extra = data.extra;
        } else {
            const data = item.obj.lineData || {};
            title = `${data.type}`;
            latLonHtml = `
                <div class="info-row"><span class="info-key">Start</span><span>${data.start}</span></div>
                <div class="info-row"><span class="info-key">End</span><span>${data.end}</span></div>
            `;
            extra = data.extra;
        }

        let extraHtml = "";
        if (extra) {
            for (const [key, value] of Object.entries(extra)) {
                let displayVal = value;
                if (typeof value === 'number') displayVal = parseFloat(value).toFixed(2);
                extraHtml += `<div class="info-row">
                    <span class="info-key">${key}</span>
                    <span>${displayVal}</span>
                </div>`;
            }
        }

        div.innerHTML = `
            <div class="info-title">
                <span>[${item.type.toUpperCase()}] ${title}</span>
            </div>
            <div class="info-detail">
                ${latLonHtml}
                ${extraHtml ? `<div class="info-extra">${extraHtml}</div>` : ''}
            </div>`;

        div.onclick = () => {
            if (item.type === 'marker') {
                map.setView(item.obj.getLatLng(), 18);
                item.obj.openPopup();
            } else {
                map.fitBounds(item.obj.getBounds());
                item.obj.openPopup();
            }
        };

        infoPanel.appendChild(div);
    });

    if (foundItems.length > 0) {
        const first = foundItems[0];
        if (first.type === 'marker') map.setView(first.obj.getLatLng(), 17);
        else map.fitBounds(first.obj.getBounds());
    }
}

function highlightMarker(marker) {
    L.circleMarker(marker.getLatLng(), {
        radius: 12,
        color: 'red',
        fillColor: 'yellow',
        fillOpacity: 0.5,
        weight: 3,
        interactive: false
    }).addTo(highlightLayer);
}

function highlightLine(lineLayer) {
    L.polyline(lineLayer.getLatLngs(), {
        color: 'red',
        weight: 6,
        opacity: 0.5,
        interactive: false
    }).addTo(highlightLayer);
}
