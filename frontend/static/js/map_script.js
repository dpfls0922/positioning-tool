const map = L.map('map').setView([37.5665, 126.9780], 15);
const highlightLayer = L.layerGroup().addTo(map);

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
let roadMinZoom = 16;
let roadLabelZoom = 17;
let roadShapeMeta = null;
let roadShapePendingLoad = false;
let roadShapeLoading = false;
let roadShapeLoaded = false;
let roadNodeRenderCount = 0;
const ROAD_LABEL_BIND_LIMIT = 12000;
const ROAD_LINK_QUERY_LIMIT = 12000;
const ROAD_NODE_QUERY_LIMIT = 8000;

let roadShapeWorker = null;
let roadShapeQueryRequestId = 0;
let roadShapeLastRenderedRequestId = 0;
let roadQueryDebounceTimer = null;
let roadLabelEnabledForRender = false;

const EARTH_RADIUS = 6371000.0;
const DEG2RAD = Math.PI / 180.0;

let distancePickMode = false;
let distanceSelectionMode = 'map';
let pickedDistancePoints = [];
let distanceMarkers = [];
let distanceLine = null;
let radiusPickMode = false;
let radiusSelectionMode = 'map';
let radiusCenterPoint = null;
let radiusCenterMarker = null;
let radiusCircle = null;
let radiusGuideLine = null;
let radiusDrawState = 'idle';
let radiusDeleteMarker = null;

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
        if (radiusPickMode && radiusDrawState === 'drawing') {
            updateRadiusPreview(e.latlng, false);
        }
    });
    map.on('contextmenu', (e) => {
        if (!radiusPickMode) return;
        L.DomEvent.stop(e);

        if (radiusDrawState === 'drawing') {
            updateRadiusPreview(e.latlng, true);
            radiusDrawState = 'idle';
            radiusPickMode = false;
            setRadiusPickButtonState();
            return;
        }

        resetRadiusSelection(false);
        setRadiusResultText('반경 결과: 취소됨(우클릭).');
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

function clearDistanceVisuals() {
    distanceMarkers.forEach(marker => map.removeLayer(marker));
    distanceMarkers = [];

    if (distanceLine) {
        map.removeLayer(distanceLine);
        distanceLine = null;
    }
}

function drawDistanceVisuals() {
    clearDistanceVisuals();

    if (pickedDistancePoints.length === 0) return;

    const first = pickedDistancePoints[0];
    const markerA = L.circleMarker([first.lat, first.lon], {
        radius: 6,
        color: '#0056b3',
        fillColor: '#0056b3',
        fillOpacity: 0.9,
        weight: 2
    }).addTo(map).bindPopup('A');
    distanceMarkers.push(markerA);

    if (pickedDistancePoints.length < 2) return;

    const second = pickedDistancePoints[1];
    const markerB = L.circleMarker([second.lat, second.lon], {
        radius: 6,
        color: '#198754',
        fillColor: '#198754',
        fillOpacity: 0.9,
        weight: 2
    }).addTo(map).bindPopup('B');
    distanceMarkers.push(markerB);

    distanceLine = L.polyline([[first.lat, first.lon], [second.lat, second.lon]], {
        color: '#0d6efd',
        weight: 2,
        dashArray: '6, 6',
        opacity: 0.9
    }).addTo(map);
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

function handleMapDistancePick(latlng) {
    if (pickedDistancePoints.length >= 2) {
        pickedDistancePoints = [];
    }

    pickedDistancePoints.push(buildDistancePoint(latlng.lat, latlng.lng, 'map'));
    drawDistanceVisuals();

    if (pickedDistancePoints.length === 1) {
        setDistanceGuideMessage();
        return;
    }

    updateDistanceResult(pickedDistancePoints[0], pickedDistancePoints[1], '지도 점 선택');
    distancePickMode = false;
    setDistancePickButtonState();
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
        ? '거리 결과: 마커를 클릭해 두 번째 점(B)을 선택하세요.'
        : '거리 결과: 지도에서 두 번째 점(B)을 선택하세요.';
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
    const resultEl = document.getElementById('radiusResult');
    if (!resultEl) return;
    resultEl.innerHTML =
        `${prefix}: <strong>${radiusMeters.toFixed(1)} m</strong>`;
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
        radiusDrawState = 'idle';
        radiusPickMode = false;
        setRadiusPickButtonState();
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

    if (pickedDistancePoints.length >= 2) {
        pickedDistancePoints = [];
    }

    pickedDistancePoints.push(buildDistancePoint(latlng.lat, latlng.lng, 'marker', marker));
    drawDistanceVisuals();

    if (pickedDistancePoints.length < 2) {
        setDistanceGuideMessage();
        return;
    }

    updateDistanceResult(pickedDistancePoints[0], pickedDistancePoints[1], '마커 선택');
    distancePickMode = false;
    setDistancePickButtonState();
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
    bind('parseShpButton', 'click', handleUploadAndParseShapefile);
    bind('clearShpButton', 'click', handleClearRoadShape);
    bind('exportHtmlButton', 'click', handleExportHtml);
    const exportBtn = document.getElementById('exportHtmlButton');
    if (exportBtn) exportBtn.disabled = true;
    setUploadProgress(0, '대기 중', false);
    updateRoadShapeStateText(null, '업로드 후 zoom 조건 충족 시 로드');
}

function initToolPanels() {
    const panelMap = {
        toolUploadBtn: 'uploadPanel',
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
    ['uploadPanel', 'distancePanel', 'radiusPanel', 'playbackPanel', 'legendPanel']
        .forEach((panelId) => document.getElementById(panelId)?.classList.add('hidden'));
    syncToolButtonState();
}

function syncToolButtonState() {
    const mapping = {
        toolUploadBtn: 'uploadPanel',
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
    if (bar && !parsingMode) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (statusEl && status) statusEl.textContent = status;
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
        setUploadProgress(100, '파싱 중...', true);
    };

    xhr.onload = () => {
        if (parseButton) parseButton.disabled = false;

        let response = null;
        try {
            response = JSON.parse(xhr.responseText);
        } catch (e) {
            setUploadProgress(0, '실패: 응답 파싱 오류', false);
            return;
        }

        if (xhr.status < 200 || xhr.status >= 300 || !response?.ok) {
            setUploadProgress(0, `실패: ${response?.error || '업로드/파싱 오류'}`, false);
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
        setTimeout(() => renderLayerControls(), 0);
        const exportBtn = document.getElementById('exportHtmlButton');
        if (exportBtn) exportBtn.disabled = false;
        setUploadProgress(100, '완료', false);
    };

    xhr.onerror = () => {
        if (parseButton) parseButton.disabled = false;
        setUploadProgress(0, '실패: 네트워크 오류', false);
    };

    xhr.send(formData);
}

async function handleUploadAndParseShapefile() {
    const fileInput = document.getElementById('shpFolderInput');
    const parseButton = document.getElementById('parseShpButton');
    const zoomInput = document.getElementById('shpMinZoomInput');
    const files = Array.from(fileInput?.files || []);
    if (files.length === 0) {
        setUploadProgress(0, 'SHP 폴더를 선택하세요.', false);
        return;
    }

    const hasShp = files.some((f) => f.name.toLowerCase().endsWith('.shp'));
    const hasDbf = files.some((f) => f.name.toLowerCase().endsWith('.dbf'));
    const hasShx = files.some((f) => f.name.toLowerCase().endsWith('.shx'));
    if (!hasShp || !hasDbf || !hasShx) {
        setUploadProgress(0, '폴더에 .shp/.dbf/.shx 파일이 모두 있어야 합니다.', false);
        return;
    }

    const minZoomRaw = Number.parseInt(zoomInput?.value || '16', 10);
    roadMinZoom = Number.isFinite(minZoomRaw) ? Math.max(0, Math.min(22, minZoomRaw)) : 16;
    roadLabelZoom = Math.min(22, roadMinZoom + 1);
    if (zoomInput) zoomInput.value = String(roadMinZoom);

    if (parseButton) parseButton.disabled = true;
    setUploadProgress(10, 'SHP 폴더 업로드 중...', false);

    try {
        const folderName = deriveFolderName(files);
        const meta = await persistRoadShapeFolder(files, folderName, roadMinZoom);
        roadShapeMeta = meta || { folder_name: folderName, min_zoom: roadMinZoom };
        if (Number.isFinite(roadShapeMeta?.min_zoom)) {
            roadMinZoom = Math.max(0, Math.min(22, Number(roadShapeMeta.min_zoom)));
            roadLabelZoom = Math.min(22, roadMinZoom + 1);
            if (zoomInput) zoomInput.value = String(roadMinZoom);
        }

        removeRoadShapeLayers();
        roadShapePendingLoad = true;
        updateRoadShapeStateText(roadShapeMeta, `업로드 완료, zoom ${roadMinZoom}+에서 로드`);
        setUploadProgress(100, `Shape 업로드 완료 (지금은 저장만). zoom ${roadMinZoom}+에서 표시`, false);
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
        const res = await fetch('/api/road-shape', { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            throw new Error(data.error || '저장된 Shape 삭제 실패');
        }
        removeRoadShapeLayers();
        roadShapeMeta = null;
        roadShapePendingLoad = false;
        roadShapeLoading = false;
        renderLayerControls();
        updateRoadShapeStateText(null);
        setUploadProgress(100, '저장된 Shape 삭제 완료', false);
    } catch (err) {
        const message = err instanceof Error ? err.message : '저장된 Shape 삭제 실패';
        setUploadProgress(0, `실패: ${message}`, false);
    } finally {
        if (clearBtn) clearBtn.disabled = false;
    }
}

function deriveFolderName(files) {
    const firstPath = files[0]?.webkitRelativePath || '';
    if (firstPath.includes('/')) {
        return firstPath.split('/')[0] || 'road_shape';
    }
    return 'road_shape';
}

async function persistRoadShapeFolder(files, folderName, minZoom) {
    const formData = new FormData();
    formData.append('folder_name', folderName);
    formData.append('min_zoom', String(minZoom));
    files.forEach((file) => {
        formData.append('files', file, file.name);
        formData.append('paths', file.webkitRelativePath || file.name);
    });
    const response = await fetch('/api/road-shape/folder', {
        method: 'POST',
        body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Shape 폴더 저장 실패');
    }
    return data.meta || null;
}

async function fetchPersistedRoadShapeZip(timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const contentRes = await fetch('/api/road-shape/content', { signal: controller.signal });
    clearTimeout(timer);
    if (!contentRes.ok) {
        throw new Error('저장된 Shape를 읽지 못했습니다.');
    }
    return contentRes.arrayBuffer();
}

async function loadRoadShapeOnDemand() {
    if (roadShapeLoading || !roadShapePendingLoad) return;
    if (map.getZoom() < roadMinZoom) return;

    roadShapeLoading = true;
    updateRoadShapeStateText(roadShapeMeta, '줌 조건 충족, 레이어 로딩 중...');
    try {
        const buffer = await fetchPersistedRoadShapeZip(20000);
        terminateRoadShapeWorker();
        roadShapeWorker = new Worker('/static/js/road_shape_worker.js');
        roadShapeWorker.onmessage = handleRoadShapeWorkerMessage;
        roadShapeWorker.onerror = () => {
            roadShapeLoading = false;
            roadShapePendingLoad = false;
            roadShapeLoaded = false;
            updateRoadShapeStateText(roadShapeMeta, '로드 실패: Worker 오류');
        };
        roadShapeWorker.postMessage({ type: 'loadZip', buffer }, [buffer]);
    } catch (e) {
        roadShapePendingLoad = false;
        roadShapeLoaded = false;
        const message = e instanceof Error ? e.message : '레이어 로드 실패';
        updateRoadShapeStateText(roadShapeMeta, `로드 실패: ${message}`);
    } finally {
        // Worker 기반 로딩에서는 ready/error에서 상태를 정리합니다.
    }
}

function handleRoadShapeWorkerMessage(event) {
    const data = event.data || {};

    if (data.type === 'progress') {
        updateRoadShapeStateText(roadShapeMeta, data.msg || 'Shape 처리 중...');
        return;
    }

    if (data.type === 'ready') {
        roadShapeLoading = false;
        roadShapeLoaded = true;
        roadShapePendingLoad = false;
        roadLinkFeatureCount = Number(data.linkCount || 0);
        roadNodeFeatureCount = Number(data.nodeCount || 0);
        roadNodeRenderCount = 0;
        layerCountOverride[ROAD_LINK_LAYER] = roadLinkFeatureCount;
        layerCountOverride[ROAD_NODE_LAYER] = roadNodeFeatureCount;
        ensureRoadShapeLayers();
        renderLayerControls();
        queryRoadViewport();
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
            ? `현재 화면에 데이터 없음 (줌 ${roadMinZoom}+ / 지도 위치 확인)`
            : `표시 중 (링크 ${matchedLinks}/${roadLinkFeatureCount}, 노드 ${roadNodeRenderCount}/${matchedNodes})`;
        updateRoadShapeStateText(roadShapeMeta, extra);
        return;
    }

    if (data.type === 'error') {
        roadShapeLoading = false;
        roadShapePendingLoad = false;
        roadShapeLoaded = false;
        terminateRoadShapeWorker();
        updateRoadShapeStateText(roadShapeMeta, `로드 실패: ${data.message || '알 수 없는 오류'}`);
    }
}

function terminateRoadShapeWorker() {
    if (roadShapeWorker) {
        try { roadShapeWorker.terminate(); } catch (_) {}
        roadShapeWorker = null;
    }
    roadShapeQueryRequestId = 0;
    roadShapeLastRenderedRequestId = 0;
    if (roadQueryDebounceTimer) {
        clearTimeout(roadQueryDebounceTimer);
        roadQueryDebounceTimer = null;
    }
}

function ensureRoadShapeLayers() {
    if (!roadLinkGeoLayer) {
        roadLinkGeoLayer = L.geoJSON(null, {
            style: (feature) => getRoadLinkStyle(feature?.properties || {}),
            onEachFeature: (feature, layer) => {
                const props = feature?.properties || {};
                const labelText = pickRoadLabelText(props);
                if (roadLabelEnabledForRender && labelText) {
                    layer.bindTooltip(labelText, {
                        permanent: true,
                        direction: 'center',
                        className: 'road-link-label'
                    });
                }
                layer.bindPopup(makeRoadPopupContent(props, 'Road Link'));
            }
        });
        addLayerToGroup(ROAD_LINK_LAYER, roadLinkGeoLayer);
    }

    if (!roadNodeGeoLayer) {
        roadNodeGeoLayer = L.geoJSON(null, {
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                radius: 4,
                color: '#0ea5e9',
                fillColor: '#38bdf8',
                fillOpacity: 0.9,
                weight: 1
            }),
            onEachFeature: (feature, layer) => {
                const props = feature?.properties || {};
                layer.bindPopup(makeRoadPopupContent(props, 'Road Node'));
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
    if (map.getZoom() < roadMinZoom) return;

    const bounds = map.getBounds();
    roadShapeWorker.postMessage({
        type: 'query',
        requestId: ++roadShapeQueryRequestId,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        includeLinks: activeGroups.has(ROAD_LINK_LAYER),
        includeNodes: activeGroups.has(ROAD_NODE_LAYER),
        maxLinks: ROAD_LINK_QUERY_LIMIT,
        maxNodes: ROAD_NODE_QUERY_LIMIT
    });
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
    const showRoad = map.getZoom() >= roadMinZoom;
    roadLabelEnabledForRender = showRoad && map.getZoom() >= roadLabelZoom && roadLinkFeatureCount <= ROAD_LABEL_BIND_LIMIT;

    if (roadLinkGeoLayer) {
        roadLinkGeoLayer.clearLayers();
        if (showRoad && activeGroups.has(ROAD_LINK_LAYER) && Array.isArray(linkFeatures) && linkFeatures.length > 0) {
            roadLinkGeoLayer.addData({ type: 'FeatureCollection', features: linkFeatures });
        }
    }

    if (roadNodeGeoLayer) {
        roadNodeGeoLayer.clearLayers();
        if (showRoad && activeGroups.has(ROAD_NODE_LAYER) && Array.isArray(nodeFeatures) && nodeFeatures.length > 0) {
            roadNodeGeoLayer.addData({ type: 'FeatureCollection', features: nodeFeatures });
        }
    }

    roadNodeRenderCount = Array.isArray(nodeFeatures) ? nodeFeatures.length : 0;
}

function updateRoadShapeStateText(meta, extraMessage = '') {
    const el = document.getElementById('roadShapeStateText');
    if (!el) return;
    if (!meta) {
        el.textContent = extraMessage ? `저장된 파일 없음 | ${extraMessage}` : '저장된 파일 없음';
        return;
    }
    const name = meta.folder_name || meta.file_name || 'current_road_shape.zip';
    const zoom = Number.isFinite(meta.min_zoom) ? meta.min_zoom : roadMinZoom;
    const sizeBytes = Number(meta.size_bytes || 0);
    const sizeMb = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB` : '-';
    const updatedAt = meta.updated_at || '-';
    const suffix = extraMessage ? ` | ${extraMessage}` : '';
    el.textContent = `${name} | zoom ${zoom}+ | ${sizeMb} | ${updatedAt}${suffix}`;
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
    roadNodeRenderCount = 0;
    roadShapeLoaded = false;
    terminateRoadShapeWorker();
}

function handleRoadZoomChanged() {
    const zoom = map.getZoom();
    const showRoad = zoom >= roadMinZoom;

    if (roadShapePendingLoad && showRoad && !roadShapeLoaded) {
        void loadRoadShapeOnDemand();
        return;
    }

    if (!showRoad) {
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        return;
    }

    if (roadShapeLoaded) {
        scheduleRoadViewportQuery();
    }
}

function pickRoadLabelText(props) {
    return (
        props?.LINK_ID ??
        props?.IDXNAME ??
        props?.ID ??
        props?.LINK ??
        props?.KEY ??
        ''
    ).toString();
}

function getRoadLinkStyle(props) {
    const facil = Number.parseInt(props?.ROAD_FACIL, 10);
    if (facil === 1) return { color: '#f59e0b', weight: 3, opacity: 0.95 };
    if (facil === 2) return { color: '#a78bfa', weight: 3, opacity: 0.95 };
    if (facil === 4) return { color: '#93c5fd', weight: 3, opacity: 0.95 };
    return { color: '#67e8f9', weight: 3, opacity: 0.95 };
}

function makeRoadPopupContent(props, title) {
    const rows = Object.entries(props || {})
        .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
        .join('');
    return `
        <div class="road-popup">
            <div style="font-weight:700; margin-bottom:6px;">${escapeHtml(title)}</div>
            <table style="border-collapse:collapse; min-width:220px;">
                ${rows || '<tr><td>-</td></tr>'}
            </table>
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

function handleExportHtml() {
    const exportBtn = document.getElementById('exportHtmlButton');
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

        childWrap.appendChild(row);
    });

    tree.appendChild(childWrap);
    list.appendChild(tree);
    applyLayerOrderZIndex();
}

function getLayerSwatchColor(name) {
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
        'Road Link': '#67e8f9',
        'Road Node': '#38bdf8'
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
