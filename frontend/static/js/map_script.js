const map = L.map('map', { preferCanvas: true }).setView([37.5665, 126.9780], 15);
const highlightLayer = L.layerGroup().addTo(map);
const roadCanvasRenderer = L.canvas({ padding: 0.25 });
const roadCanvasRendererNode = L.canvas({ padding: 0.25 });
// 차로폭 박스 전용 렌더러 — 링크 중심선보다 아래(낮은 z-index 팬)에 그리기 위해 별도 팬에 고정.
const roadCanvasRendererLane = L.canvas({ padding: 0.25, pane: 'roadLaneWidthPane' });
const roadCanvasRendererLane2 = L.canvas({ padding: 0.25, pane: 'roadLaneWidth2Pane' });


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
let parkingLotStateMarkers = [];
let polylines = [];
let requestGroups = {};
let activeGroups = new Set();
let layerOrder = [];
// Viewport culling: total per-group element counts (attached subset varies)
let cullTotalCounts = {};
let visibleRefreshScheduled = false;
const VIEWPORT_CULL_PAD = 0.5;
// Below this zoom, thin out markers that overlap within the same pixel cell;
// at closer zooms every marker is shown for precise inspection.
const MARKER_DECIMATION_MAX_ZOOM = 18;
const MARKER_DECIMATION_CELL_PX = 6;
// Reference zoom for cached world-pixel projections used by decimation
const CULL_PROJ_ZOOM = 10;
// Last cull inputs; refresh is skipped while the view stays inside them
let lastCullState = null;

// rAF stalls entirely while the tab is hidden — fall back to setTimeout so
// batched rendering keeps progressing in background tabs.
function scheduleFrame(fn) {
    if (typeof document !== 'undefined' && document.hidden) {
        setTimeout(fn, 0);
    } else {
        requestAnimationFrame(fn);
    }
}
let draggedLayerName = null;
let currentResultName = 'result';
const layerCountOverride = {};

const ROAD_LINK_LAYER = 'Road Link';
const ROAD_NODE_LAYER = 'Road Node';
const ROAD_LINK_VERTEX_LAYER = 'Road Link Vertex';
const LANE_WIDTH_LAYER = 'Lane Width';
const LANE_WIDTH_LAYER_2 = 'Lane Width 2';
const ROUTE_INFO_MARKER_LAYER = 'Route Info Markers';
const TMAP_ROUTE_LAYER = 'Tmap Route';
const TMAP_WAYPOINT_LAYER = 'Tmap Waypoints';
const ROUTE_INFO_LAYER_PREFIX = 'Route Info ';
const ROUTE_INFO_MARKER_LAYER_PREFIX = 'Route Info Markers ';
let roadLinkGeoLayer = null;
let roadNodeGeoLayer = null;
let roadLinkVertexGeoLayer = null;
let roadLaneWidthGeoLayer = null;
let roadLaneWidth2GeoLayer = null;
// 차로폭 박스는 이 줌 이상에서만 그린다.
const LANE_WIDTH_MIN_ZOOM = 17;
// 링크에서 유도한 차로폭(한 차선 폭) 시각화 설정.
// C 상수: LANE_WIDTH 3.0 / EXTENDED_LANE_WIDTH 3.5 (roadCate <= 1 이면 확장폭).
// 실제 박스 반폭 = ceil(max(1, 차선수)/2) * (타입별 한 차선 폭).
const DEFAULT_LANE_WIDTH_CONFIG = {
    normal: 3.0,
    extended: 3.5,
    normalColor: '#38bdf8',
    extendedColor: '#f97316',
    fillOpacity: 0.28
};
// 차로폭2 — 주차장/피드백 등 다른 기준용 별도 레이어(기본 OFF, 색/폭 독립 튜닝).
const DEFAULT_LANE_WIDTH_CONFIG_2 = {
    normal: 2.75,
    extended: 3.25,
    normalColor: '#22c55e',
    extendedColor: '#a855f7',
    fillOpacity: 0.28
};
let laneWidthConfig = { ...DEFAULT_LANE_WIDTH_CONFIG };
let laneWidthConfig2 = { ...DEFAULT_LANE_WIDTH_CONFIG_2 };
// 마지막으로 렌더된(뷰포트 내) 링크 피처 캐시 — 차로폭 값 변경 시 워커 재조회 없이 즉시 다시 그림.
let lastRenderedRoadLinks = [];
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
let roadShapeFindRequestSeq = 0;
const roadShapeFindRequests = new Map();
let roadCustomLinkRuleSeq = 1;
let roadCustomLinkRules = [];
let roadLinkFieldNames = DEFAULT_ROAD_LINK_STYLE_FIELDS.slice();
let roadShapeLocalGroupsByKind = { link: [], node: [] };
let roadLinkBaseStyles = createDefaultRoadLinkBaseStyles();
const DEFAULT_ROAD_NODE_STYLE = {
    radius: 3.4,
    color: '#38bdf8',
    stroke: '#075985',
    weight: 1.1
};
const DEFAULT_ROAD_VERTEX_STYLE = {
    radius: 2.2,
    color: '#f8fafc',
    stroke: '#0f172a',
    weight: 1.0
};
let roadNodeStyleConfig = { ...DEFAULT_ROAD_NODE_STYLE };
let roadVertexStyleConfig = { ...DEFAULT_ROAD_VERTEX_STYLE };
let roadStyleContextLayerName = ROAD_NODE_LAYER;
let selectedRoadFeatureRef = { kind: null, shpIndex: null };
let routeInfoLinkIds = new Set();
let selectedRouteInfoLineId = null;
let selectedRouteInfoNextLineId = null;
let selectedDrCoordinate = null;
let selectedCandidateLinkIds = new Set();
// 클릭으로 선택된 DR 마커 — 다음 선택 시 이 마커만 원복하면 되므로 전체 마커 재도색을 피한다.
let lastSelectedDrMarker = null;
let vertexWasActiveBeforeNodeDisabled = false;  // Road Node 끄기 전 Vertex 상태 기억
let tmapRouteResult = null;
let tmapRouteRequesting = false;
let tmapRouteWaypoints = {
    origin: null,
    destination: null,
    vias: []
};
const TMAP_STG_ROUTE_ENDPOINT = 'https://ntmapstg.tmap.co.kr:9443/tmap-channel/rsd/ev/route';

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
let drHeadingArrowEnabled = false;
let markerTableSelectedType = 'all';
let inspectMode = 'marker';
let resultTreeExpanded = true;
let roadTreeExpanded = true;
let lastRoadLayerInteractionTs = 0;

const ROAD_SHAPE_CACHE_DIR = 'road_shape_cache_v1';
const ROAD_SHAPE_MANIFEST_SUFFIX = '.manifest.json';
const ROAD_LINK_BASE_STYLE_STORAGE_KEY = 'road_link_base_style_v1';
const ROAD_CUSTOM_LINK_RULES_STORAGE_KEY = 'road_custom_link_rules_v1';
const ROAD_POINT_STYLE_STORAGE_KEY = 'road_point_style_v1';
const LANE_WIDTH_CONFIG_STORAGE_KEY = 'lane_width_config_v1';
const ROAD_LINK_ID_LABEL_STORAGE_KEY = 'road_link_id_label_v1';
let roadShapeCacheDirHandlePromise = null;

// 브라우저 새로고침 후에도 유지되는 레이어 스타일 설정을 위한 공용 localStorage 헬퍼.
function readJsonSetting(key, fallback) {
    try {
        if (typeof localStorage === 'undefined') return fallback;
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function writeJsonSetting(key, value) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
        // Ignore quota/storage errors.
    }
}

// Bumped on perf-relevant frontend changes; logged at startup so a stale
// cached page is immediately identifiable from the console.
const FRONTEND_BUILD = 'perf-cull-v3';

function init() {
    console.log(`[positioning-tool] frontend build: ${FRONTEND_BUILD}`);
    // Initialize data variables
    if (typeof markersData === 'undefined') markersData = [];
    if (typeof parkingLotStateMarkersData === 'undefined') parkingLotStateMarkersData = [];
    if (typeof linesData === 'undefined') linesData = [];

    map.zoomControl.remove();
    initSlider(minTs, maxTs);
    drawPolygons();
    renderFromCurrentData();

    initSidebar();
    initUploadPanel();
    initToolPanels();
    initRoutePanel();
    initMarkerTablePanel();
    bindSearchControls();
    bind('markerInspectModeButton', 'click', () => setInspectMode('marker'));
    bind('roadInspectModeButton', 'click', () => setInspectMode('road'));
    bind('toolZoomInBtn', 'click', () => map.zoomIn());
    bind('toolZoomOutBtn', 'click', () => map.zoomOut());
    bind('distancePickToggle', 'click', toggleDistancePickMode);
    bind('distancePickReset', 'click', resetDistanceSelection);
    bind('distanceCalcInput', 'click', handleInputDistanceCalculation);
    bind('distanceMode', 'change', handleDistanceModeChange);
    bind('radiusMode', 'change', handleRadiusModeChange);
    bind('radiusPickToggle', 'click', toggleRadiusPickMode);
    bind('radiusApplyButton', 'click', handleRadiusApplyInput);
    bind('radiusResetButton', 'click', () => resetRadiusSelection(true));
    bind('drHeadingToggle', 'change', handleDrHeadingToggleChange);

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
    map.on('zoomend', scheduleVisibleMarkerRefresh);
    map.on('moveend', scheduleVisibleMarkerRefresh);
    map.on('popupopen', (event) => {
        makePopupDraggable(event?.popup);
    });

    map.on('click', (e) => {
        highlightLayer.clearLayers();
        clearRouteInfoSelection();
        selectedCandidateLinkIds = new Set();
        if (roadLinkGeoLayer) {
            roadLinkGeoLayer.setStyle((feature) => getRoadLinkStyle({
                ...(feature?.properties || {}),
                __featureRef: feature
            }));
        }
        if (distancePickMode && distanceSelectionMode === 'map') {
            handleMapDistancePick(e.latlng);
        }
        if (radiusPickMode && radiusSelectionMode === 'map') {
            handleMapRadiusPick(e.latlng);
        }
        const preferredKinds = isRoadLinkLabelTarget(e?.originalEvent?.target) ? ['link'] : getPreferredRoadKinds();
        if (canInspectRoadShapes() && (Date.now() - lastRoadLayerInteractionTs) > 160 && openNearestRoadPopupAt(e.latlng, preferredKinds)) {
            return;
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
            if (distancePreviewLine) {
                map.removeLayer(distancePreviewLine);
                distancePreviewLine = null;
            }
            // 우클릭하면 현재 거리재기 작업 완료 후 새 작업 준비
            if (pickedDistancePoints.length === 0) {
                // 작업 시작 전 우클릭
                const resultEl = document.getElementById('distanceResult');
                if (resultEl) resultEl.textContent = '거리 결과: 취소됨(우클릭).';
            } else if (pickedDistancePoints.length === 1) {
                // 점 1개만 선택했으면 취소
                clearDistanceVisuals();
                const resultEl = document.getElementById('distanceResult');
                if (resultEl) resultEl.textContent = '거리 결과: 취소됨(우클릭).';
            } else {
                // 점 2개 이상이면 현재까지의 거리 확정
                updateDistanceResultForPath('우클릭 완료');
                // 확정된 거리는 지도에 남기고, 다음 측정을 위해 현재 점들만 초기화
                pickedDistancePoints = [];
                // distancePickMode는 true 유지하여 계속 거리재기 가능
                // 결과값은 계속 표시 (새로운 점 선택하면 업데이트됨)
                return;
            }
            // 점 0개 또는 1개인 경우 전체 초기화
            pickedDistancePoints = [];
            if (distanceLine) {
                map.removeLayer(distanceLine);
                distanceLine = null;
            }
            distanceMarkers.forEach(m => {
                try { map.removeLayer(m); } catch (e) {}
            });
            distanceMarkers = [];
            distanceLabelMarkers.forEach(m => {
                try { map.removeLayer(m); } catch (e) {}
            });
            distanceLabelMarkers = [];
            setDistanceGuideMessage();
        }

        if (radiusPickMode) {
            handled = true;
            if (radiusDrawState === 'drawing') {
                // 반경 그리는 중이면 현재 반경 확정
                updateRadiusPreview(e.latlng, true);
            }
            // 우클릭 후 다음 반경재기를 위해 초기화 (radiusPickMode는 true 유지)
            radiusDrawState = 'await_center';
            radiusCenterPoint = null;
            if (radiusCenterMarker) {
                map.removeLayer(radiusCenterMarker);
                radiusCenterMarker = null;
            }
            if (radiusGuideLine) {
                map.removeLayer(radiusGuideLine);
                radiusGuideLine = null;
            }
            if (radiusDeleteMarker) {
                map.removeLayer(radiusDeleteMarker);
                radiusDeleteMarker = null;
            }
            // 반경 결과값은 계속 표시 (새로운 중심점 선택하면 초기화됨)
            // radiusPickMode는 true 유지하여 계속 반경재기 가능
        }

        if (handled) {
            L.DomEvent.stop(e);
            return;
        }

        const preferredKinds = isRoadLinkLabelTarget(e?.originalEvent?.target) ? ['link'] : getPreferredRoadKinds();
        if (canInspectRoadShapes() && (Date.now() - lastRoadLayerInteractionTs) > 160 && openNearestRoadPopupAt(e.latlng, preferredKinds)) {
            L.DomEvent.stop(e);
            return;
        }

        openTmapRouteContextMenu(e.latlng);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && radiusPickMode) {
            resetRadiusSelection(false);
            setRadiusResultText('반경 결과: 취소됨(ESC).');
        }
    });

    updateMap();
}

function initMarkerTablePanel() {
    bind('markerTableTypeSelect', 'change', (event) => {
        markerTableSelectedType = String(event?.target?.value || 'all');
        renderMarkerTable();
    });
    bind('markerTableSearchInput', 'input', renderMarkerTable);
}

function handleDrHeadingToggleChange(event) {
    drHeadingArrowEnabled = !!event?.target?.checked;
    renderFromCurrentData();
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
        step: 100,
        keyboardSupport: true,
        keyboardDefaultStep: 1  // arrow keys move by 1 step (100ms) per press
    });
    slider.noUiSlider.on('update', updateMap);
    updateRangeLabel(startMin, startMax);
    initTimeFineControls();
}

// Fine-grained timeline filtering: ±1s / ±0.1s nudge buttons per handle and
// direct time entry (HH:MM:SS.mmm or full YYYY/MM/DD HH:MM:SS.mmm).
let timeFineControlsBound = false;

function initTimeFineControls() {
    if (timeFineControlsBound) return;
    const container = document.querySelector('.time-fine-controls');
    if (!container) return;
    timeFineControlsBound = true;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.time-fine-btn');
        if (!btn || !slider.noUiSlider) return;
        nudgeTimeHandle(Number(btn.dataset.handle), Number(btn.dataset.delta));
    });

    [['timeStartInput', 0], ['timeEndInput', 1]].forEach(([id, handleIndex]) => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !slider.noUiSlider) return;
            const values = slider.noUiSlider.get().map(Number);
            const parsed = parseTimeInputToMs(e.target.value, values[handleIndex]);
            if (!Number.isFinite(parsed)) {
                e.target.classList.add('time-fine-input-error');
                setTimeout(() => e.target.classList.remove('time-fine-input-error'), 800);
                return;
            }
            setTimeHandle(handleIndex, parsed);
            e.target.blur();
        });
    });
}

function nudgeTimeHandle(handleIndex, deltaMs) {
    const values = slider.noUiSlider.get().map(Number);
    setTimeHandle(handleIndex, values[handleIndex] + deltaMs);
}

function setTimeHandle(handleIndex, valueMs) {
    // noUiSlider clamps to the range and keeps handle order automatically
    slider.noUiSlider.set(handleIndex === 0 ? [valueMs, null] : [null, valueMs]);
}

function parseTimeInputToMs(text, referenceMs) {
    const trimmed = String(text || '').trim();
    let m = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6],
            +String(m[7] || '0').padEnd(3, '0')).getTime();
    }
    // Time-only: reuse the date of the current handle value
    m = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (m && Number.isFinite(referenceMs)) {
        const d = new Date(referenceMs);
        d.setHours(+m[1], +m[2], +m[3], +String(m[4] || '0').padEnd(3, '0'));
        return d.getTime();
    }
    return NaN;
}

function renderFromCurrentData() {
    resetVisualization();
    drawMarkers(markersData);
    drawParkingLotStateMarkers(parkingLotStateMarkersData);
    drawPolylines(linesData);
    addControlLayers();
    renderLayerControls();
    renderMarkerTable();
    focusOnInitialView();
    updateMap();

    // Visualize guide events from log (C2X, Accident)
    setTimeout(() => {
        visualizeGuideEventsFromLog();
    }, 100);
}

function refreshRouteInfoLinkIds(lines) {
    routeInfoLinkIds = new Set(
        (Array.isArray(lines) ? lines : [])
            .filter((line) => line?.type === 'Route Info')
            .map((line) => Number(line?.extra?.link_id))
            .filter((value) => Number.isFinite(value))
    );
    refreshRoadLayerStyles();
}

function renderRouteInfoMarkers(lines) {
    const sourceLines = (Array.isArray(lines) ? lines : []).filter((line) => line?.type === 'Route Info');
    clearRouteInfoMarkerLayers();
    if (sourceLines.length === 0) {
        return;
    }

    const sessionMap = new Map();
    sourceLines.forEach((line) => {
        const layerName = getRouteInfoLayerName(line);
        if (!sessionMap.has(layerName)) {
            sessionMap.set(layerName, []);
        }
        sessionMap.get(layerName).push(line);
    });

    sessionMap.forEach((sessionLines, routeLayerName) => {
        // Route point markers live INSIDE the same "Route Info N" layer as the
        // route polylines — one layer per request, toggled together.
        const group = ensureTmapFeatureGroup(routeLayerName);
        removeRoutePointMarkersFromGroup(group);

        // Order by route_sequence so the fallback S/E markers really land on the
        // route's first/last segment, not just the first/last parsed log line.
        const orderedLines = sessionLines.slice().sort(
            (a, b) => (a.extra?.route_sequence ?? 0) - (b.extra?.route_sequence ?? 0)
        );
        const firstLine = orderedLines[0];
        const lastLine = orderedLines[orderedLines.length - 1];

        // Prefer the request's own [출발지, 경유지..., 목적지] set when available
        const request = findRequestForRouteSession(orderedLines[0]?.extra?.route_session_id);
        let routePointMarkers = buildRoutePointSetMarkers(request, routeLayerName);

        if (routePointMarkers.length === 0) {
            // Fallback: first/last segment endpoints (경로 파싱 지점 기준 — 요청
            // 로그의 출발/도착 지점이 없을 때의 근사값임을 팝업에 명시)
            routePointMarkers = [
                L.marker(firstLine.start, { icon: buildRoutePointIcon('S', '#16a34a', '출발') })
                    .bindPopup(
                        `<b>${routeLayerName} Start</b><br>` +
                        `(경로 첫 세그먼트 기준 근사값)<br>` +
                        `Lat: ${Number(firstLine.start[0]).toFixed(7)}<br>` +
                        `Lon: ${Number(firstLine.start[1]).toFixed(7)}`
                    ),
                L.marker(lastLine.end, { icon: buildRoutePointIcon('E', '#dc2626', '도착') })
                    .bindPopup(
                        `<b>${routeLayerName} End</b><br>` +
                        `(경로 마지막 세그먼트 기준 근사값)<br>` +
                        `Lat: ${Number(lastLine.end[0]).toFixed(7)}<br>` +
                        `Lon: ${Number(lastLine.end[1]).toFixed(7)}`
                    )
            ];
        }

        routePointMarkers.forEach((marker) => {
            marker._isRoutePointMarker = true;
            group.addLayer(marker);
        });
    });
}

function removeRoutePointMarkersFromGroup(group) {
    if (!group) return;
    const stale = [];
    group.eachLayer((layer) => {
        if (layer._isRoutePointMarker) stale.push(layer);
    });
    stale.forEach((layer) => group.removeLayer(layer));
}

// Compact circular waypoint icon for route point sets (smaller than the
// Tmap route planner icons so parsed routes stay readable at a glance)
function buildRoutePointIcon(label, bgColor, subLabel) {
    return L.divIcon({
        className: '',
        iconSize: [22, 32],
        iconAnchor: [11, 11],
        html:
            `<div style="display:flex;flex-direction:column;align-items:center">` +
            `<div style="width:22px;height:22px;line-height:22px;text-align:center;background:${bgColor};color:#fff;border-radius:50%;font-size:11px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.25);border:2px solid #fff">${label}</div>` +
            `<div style="margin-top:1px;padding:0 4px;background:rgba(15,23,42,0.75);color:#fff;font-size:8px;font-weight:600;border-radius:6px;white-space:nowrap">${subLabel}</div>` +
            `</div>`
    });
}

function findRequestForRouteSession(routeSessionId) {
    if (!routeSessionId || !Array.isArray(markersData)) return null;
    return markersData.find((m) =>
        m.type === 'Request' && m.extra?.route_session_id === routeSessionId
    ) || null;
}

// Convert one route point (SK coords from the request log) to [lat, lon]
function routePointToLatLng(point) {
    if (!point || typeof window.skCoordToWgs84 !== 'function') return null;
    const converted = window.skCoordToWgs84(point.sk_x, point.sk_y);
    if (!converted) return null;
    const [lat, lon] = converted;
    if (!(lat > 30 && lat < 45 && lon > 120 && lon < 135)) return null;
    return [lat, lon];
}

// Build the [출발지, 경유지..., 목적지] marker set for one route request.
// Points without coordinates are skipped (with a console warning), per-role
// styling: 출발지 S(green) / 경유지 1..N(orange) / 목적지 E(red).
// 경유지 numbering follows the log's own wayPoint index (0-based → 1-based),
// so a skipped/unconvertible point no longer shifts the visible numbers.
function buildRoutePointSetMarkers(request, layerLabel) {
    const routePoints = request?.extra?.route_points;
    if (!Array.isArray(routePoints) || routePoints.length === 0) return [];

    const markers = [];
    let viaCounter = 0;

    routePoints.forEach((point) => {
        const latLng = routePointToLatLng(point);
        if (!latLng) {
            console.warn(
                `[route_points] 좌표 변환 실패로 마커 생략: ${point.role}` +
                `${point.name ? ` (${point.name})` : ''} SK=(${point.sk_x}, ${point.sk_y})`
            );
            return;
        }

        let icon;
        let viaRow = '';
        if (point.role === '출발지') {
            icon = buildRoutePointIcon('S', '#16a34a', '출발');
        } else if (point.role === '목적지') {
            icon = buildRoutePointIcon('E', '#dc2626', '도착');
        } else {
            viaCounter += 1;
            const viaNo = Number.isFinite(point.waypoint_index) ? point.waypoint_index + 1 : viaCounter;
            icon = buildRoutePointIcon(String(viaNo), '#f59e0b', `경유${viaNo}`);
            viaRow = `<br>wayPoint index: ${Number.isFinite(point.waypoint_index) ? point.waypoint_index : '-'}`;
            if (point.fixed !== undefined) viaRow += `<br>fixed: ${escapeHtml(String(point.fixed))}`;
        }

        const nameRow = point.name ? `<br>이름: ${escapeHtml(point.name)}` : '';
        const marker = L.marker(latLng, { icon }).bindPopup(
            `<b>${escapeHtml(layerLabel || 'Route')} ${point.role}</b>` +
            `${nameRow}${viaRow}` +
            `<br>Content ID: ${escapeHtml(String(request?.extra?.group_1 ?? '-'))}` +
            `<br>Lat: ${latLng[0].toFixed(7)}<br>Lon: ${latLng[1].toFixed(7)}` +
            `<br>SK: (${escapeHtml(String(point.sk_x))}, ${escapeHtml(String(point.sk_y))})`
        );
        markers.push(marker);
    });

    return markers;
}

function clearRouteInfoMarkerLayers() {
    Object.keys(featureGroups).forEach((name) => {
        if (name === ROUTE_INFO_MARKER_LAYER || name.startsWith(ROUTE_INFO_MARKER_LAYER_PREFIX)) {
            const layer = featureGroups[name];
            layer.clearLayers();
            map.removeLayer(layer);
            delete featureGroups[name];
            delete overlays[name];
        }
    });
}

function getRouteInfoLayerName(line) {
    const sessionName = line?.extra?.route_session_name;
    if (typeof sessionName === 'string' && sessionName.trim()) {
        return sessionName.trim();
    }
    return 'Route Info';
}

function getRouteInfoMarkerLayerName(routeLayerName) {
    if (routeLayerName === 'Route Info') {
        return ROUTE_INFO_MARKER_LAYER;
    }
    const suffix = routeLayerName.startsWith(ROUTE_INFO_LAYER_PREFIX)
        ? routeLayerName.slice(ROUTE_INFO_LAYER_PREFIX.length)
        : routeLayerName;
    return `${ROUTE_INFO_MARKER_LAYER_PREFIX}${suffix}`.trim();
}

function getRouteInfoLineStyle(line) {
    const isSelected = Number.isFinite(selectedRouteInfoLineId) && line?.id === selectedRouteInfoLineId;
    const isNext = Number.isFinite(selectedRouteInfoNextLineId) && line?.id === selectedRouteInfoNextLineId;
    if (isSelected) {
        return { color: '#ef4444', weight: 6, dashArray: null, opacity: 1 };
    }
    if (isNext) {
        return { color: '#2563eb', weight: 5, dashArray: '10 4', opacity: 0.98 };
    }
    // Translucent on purpose: overlapping route lines composite their alpha,
    // so a road covered by 2-3 sessions renders visibly darker than a single
    // route (1겹 0.5 → 2겹 0.75 → 3겹 0.87). Segments share per-link geometry,
    // so identical dash phases stack cleanly instead of smearing.
    return { color: '#f97316', weight: 4, dashArray: '8 5', opacity: 0.5 };
}

function applyRouteInfoPolylineStyle(polyline) {
    const line = polyline?.lineData;
    if (!line || line.type !== 'Route Info') return;
    const style = getRouteInfoLineStyle(line);
    // Keep base style in sync so timeline unhide restores the correct look
    polyline._baseStyle = { opacity: style.opacity, weight: style.weight };
    if (polyline._isVisible === false) {
        // Respect timeline filtering: stay hidden, only remember the new base style
        polyline.setStyle({ ...style, opacity: 0, weight: 0 });
    } else {
        polyline.setStyle(style);
    }
}

function refreshRouteInfoPolylineStyles() {
    polylines.forEach((polyline) => {
        if (polyline?.lineData?.type === 'Route Info') {
            applyRouteInfoPolylineStyle(polyline);
        }
    });
}

function getNextRouteInfoLine(currentLine, lines) {
    const sessionIndex = currentLine?.extra?.route_session_index;
    const currentSequence = currentLine?.extra?.route_sequence;
    if (!Number.isFinite(sessionIndex) || !Number.isFinite(currentSequence)) {
        return null;
    }
    return (Array.isArray(lines) ? lines : []).find((line) =>
        line?.type === 'Route Info' &&
        line?.extra?.route_session_index === sessionIndex &&
        line?.extra?.route_sequence === currentSequence + 1
    ) || null;
}

function selectRouteInfoLine(line, lines) {
    selectedRouteInfoLineId = line?.id ?? null;
    const nextLine = getNextRouteInfoLine(line, lines);
    selectedRouteInfoNextLineId = nextLine?.id ?? null;
    refreshRouteInfoPolylineStyles();
}

function clearRouteInfoSelection() {
    selectedRouteInfoLineId = null;
    selectedRouteInfoNextLineId = null;
    refreshRouteInfoPolylineStyles();
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
    // 현재 측정 중인 마커와 라벨만 제거 (확정된 거리는 유지)
    distanceMarkers.forEach(marker => {
        try { map.removeLayer(marker); } catch (e) {}
    });
    distanceMarkers = [];
    distanceLabelMarkers.forEach(marker => {
        try { map.removeLayer(marker); } catch (e) {}
    });
    distanceLabelMarkers = [];

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

    // 거리선 끝점에 삭제 버튼 추가
    const lastPoint = pickedDistancePoints[pickedDistancePoints.length - 1];
    const deleteBtn = L.marker([lastPoint.lat, lastPoint.lon], {
        icon: L.divIcon({
            className: 'distance-delete-btn-wrapper',
            html: '<button class="distance-delete-btn" title="거리재기 삭제">✕</button>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        }),
        interactive: false
    }).addTo(map);

    // 버튼에 직접 클릭 이벤트 바인드
    setTimeout(() => {
        const btn = document.querySelector('.distance-delete-btn');
        if (btn) btn.onclick = () => deleteCurrentDistance();
    }, 0);

    distanceMarkers.push(deleteBtn);

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

function deleteCurrentDistance() {
    // X 버튼으로 현재 거리만 삭제 (모드는 유지)
    if (distanceLine) {
        map.removeLayer(distanceLine);
        distanceLine = null;
    }
    distanceMarkers.forEach(marker => {
        try { map.removeLayer(marker); } catch (e) {}
    });
    distanceMarkers = [];
    distanceLabelMarkers.forEach(marker => {
        try { map.removeLayer(marker); } catch (e) {}
    });
    distanceLabelMarkers = [];
    pickedDistancePoints = [];
    setDistanceGuideMessage();
}

function resetDistanceSelection() {
    // 거리재기 모드 완전히 종료
    pickedDistancePoints = [];
    distancePickMode = false;
    setDistancePickButtonState();
    if (distanceLine) {
        map.removeLayer(distanceLine);
        distanceLine = null;
    }
    distanceMarkers.forEach(marker => {
        try { map.removeLayer(marker); } catch (e) {}
    });
    distanceMarkers = [];
    distanceLabelMarkers.forEach(marker => {
        try { map.removeLayer(marker); } catch (e) {}
    });
    distanceLabelMarkers = [];

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

function deleteCurrentRadius() {
    // X 버튼으로 현재 반경만 삭제 (모드는 유지)
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
    radiusCenterPoint = null;
    radiusDrawState = 'await_center';
    setRadiusResultText('반경 결과: -');
}

function resetRadiusSelection(resetInputs = true) {
    // 반경재기 모드 완전히 종료
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
    // radiusCircle은 유지 (이전에 확정된 반경들을 지도에 남김)
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
        interactive: false,
        keyboard: false
    }).addTo(map);

    // 버튼에 직접 클릭 이벤트 바인드
    setTimeout(() => {
        const btn = document.querySelector('.radius-delete-icon');
        if (btn) btn.onclick = () => deleteCurrentRadius();
    }, 0);
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

function bindSearchControls() {
    bind('searchButton', 'click', handleDltSearch);
    bind('idSearchButton', 'click', handleIdSearch);
    bind('latLonSearchButton', 'click', handleLatLonSearch);
    bind('ridSearchButton', 'click', handleRidSearch);
    bind('requestIdSearchButton', 'click', handleRequestIdSearch);

    document.getElementById('searchBox')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleDltSearch();
    });
    document.getElementById('idSearchBox')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleIdSearch();
    });
    document.getElementById('latLonSearchBox')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLatLonSearch();
    });
    document.getElementById('ridSearchBox')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRidSearch();
    });
    document.getElementById('requestIdSearchBox')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRequestIdSearch();
    });
}

function setInspectMode(mode) {
    inspectMode = mode === 'road' ? 'road' : 'marker';
    document.getElementById('markerInspectModeButton')?.classList.toggle('active', inspectMode === 'marker');
    document.getElementById('roadInspectModeButton')?.classList.toggle('active', inspectMode === 'road');
}

function canInspectRoadShapes() {
    return inspectMode === 'road' || markers.length === 0;
}

function isRoadLinkLabelTarget(target) {
    return !!target?.closest?.('.road-link-label');
}

function makePopupDraggable(popup) {
    // 컨테이너(닫기 버튼·꼬리 포함 전체)를 이동시켜야 × 버튼이 분리되지 않는다.
    const container = popup?._container;
    const wrapper = popup?._wrapper;
    if (!container || !wrapper) return;

    // 본문은 텍스트 선택/복사가 가능해야 하므로 드래그는 상단 핸들로만 한다.
    if (wrapper.querySelector(':scope > .popup-drag-handle')) return;

    const handle = document.createElement('div');
    handle.className = 'popup-drag-handle';
    handle.title = '드래그하여 이동';
    handle.textContent = '⠿';
    wrapper.insertBefore(handle, wrapper.firstChild);

    const parseTranslate = (value) => {
        const match = String(value || '').match(/translate3d?\(\s*([-\d.]+)px,\s*([-\d.]+)px/i);
        if (!match) return { x: 0, y: 0 };
        return { x: Number(match[1]) || 0, y: Number(match[2]) || 0 };
    };

    handle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const startMouseX = event.clientX;
        const startMouseY = event.clientY;
        const startPos = parseTranslate(container.style.transform);
        if (map.dragging) map.dragging.disable();

        const handleMove = (moveEvent) => {
            const dx = moveEvent.clientX - startMouseX;
            const dy = moveEvent.clientY - startMouseY;
            container.style.transform = `translate3d(${startPos.x + dx}px, ${startPos.y + dy}px, 0px)`;
        };

        const handleUp = () => {
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('mouseup', handleUp);
            if (map.dragging) map.dragging.enable();
        };

        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
    });
}

function flattenLatLngs(latlngs, out = []) {
    if (!Array.isArray(latlngs)) return out;
    latlngs.forEach((item) => {
        if (Array.isArray(item)) {
            flattenLatLngs(item, out);
        } else if (item && Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
            out.push(item);
        }
    });
    return out;
}

function findNearestRoadLayerAt(kind, latlng) {
    const target = latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)
        ? latlng
        : null;
    if (!target) return null;

    const isNode = kind === 'node';
    const isVertex = kind === 'vertex';
    const layerGroup = isNode ? roadNodeGeoLayer : (isVertex ? roadLinkVertexGeoLayer : roadLinkGeoLayer);
    if (!layerGroup) return null;

    let best = null;
    let bestDistance = Infinity;
    layerGroup.eachLayer((layer) => {
        let distance = Infinity;
        if (typeof layer.getLatLng === 'function') {
            distance = target.distanceTo(layer.getLatLng());
        } else if (typeof layer.getLatLngs === 'function') {
            const points = flattenLatLngs(layer.getLatLngs());
            points.forEach((point) => {
                distance = Math.min(distance, target.distanceTo(point));
            });
        }
        if (!Number.isFinite(distance) || distance >= bestDistance) return;
        bestDistance = distance;
        best = layer;
    });

    const maxDistance = isNode ? 24 : (isVertex ? 14 : 44);
    if (!best || bestDistance > maxDistance) return null;
    return best;
}

function findNearestRoadCandidateAt(latlng, preferredKinds = ['node', 'link']) {
    const target = latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)
        ? latlng
        : null;
    if (!target) return null;

    let best = null;
    let bestDistance = Infinity;
    let bestZ = -Infinity;

    preferredKinds.forEach((kind) => {
        const layer = findNearestRoadLayerAt(kind, target);
        if (!layer) return;

        let distance = Infinity;
        if (typeof layer.getLatLng === 'function') {
            distance = target.distanceTo(layer.getLatLng());
        } else if (typeof layer.getLatLngs === 'function') {
            const points = flattenLatLngs(layer.getLatLngs());
            points.forEach((point) => {
                distance = Math.min(distance, target.distanceTo(point));
            });
        }
        if (!Number.isFinite(distance)) return;
        const paneName = getRoadPaneName(kind === 'vertex' ? ROAD_LINK_VERTEX_LAYER : (kind === 'node' ? ROAD_NODE_LAYER : ROAD_LINK_LAYER));
        const paneZ = Number(map.getPane(paneName)?.style?.zIndex || 0);
        const withinTieRange = Math.abs(distance - bestDistance) <= 6;
        if (distance > bestDistance && !withinTieRange) return;
        if (withinTieRange && paneZ < bestZ) return;
        bestDistance = distance;
        bestZ = paneZ;
        best = { kind, layer, feature: layer.feature, distance, paneZ };
    });

    return best;
}

function openNearestRoadPopupAt(latlng, preferredKinds = ['node', 'link']) {
    const match = findNearestRoadCandidateAt(latlng, preferredKinds);
    if (!match) return false;

    if (match.kind === 'link') {
        openRoadLayerPopup(match.layer, match.feature, 'link', 'Road Link', latlng);
        return true;
    }
    if (match.kind === 'node') {
        openRoadLayerPopup(match.layer, match.feature, 'node', 'Road Node', latlng);
        return true;
    }
    if (match.kind === 'vertex') {
        openRoadLayerPopup(match.layer, match.feature, 'vertex', 'Road Link Vertex', latlng);
        return true;
    }
    return false;
}

function initRoutePanel() {
    bind('tmapRouteRequestButton', 'click', handleTmapRouteRequest);
    bind('tmapRouteClearButton', 'click', () => clearTmapRoute(true));

    let storedKey = '';
    try {
        storedKey = localStorage.getItem('tmap_route_app_key') || '';
    } catch (_) {
        storedKey = '';
    }
    const appKeyInput = document.getElementById('tmapAppKeyInput');
    if (appKeyInput) {
        appKeyInput.value = storedKey;
        appKeyInput.addEventListener('change', () => {
            try {
                localStorage.setItem('tmap_route_app_key', appKeyInput.value.trim());
            } catch (_) {
                // Ignore storage errors.
            }
        });
    }

    updateTmapWaypointBar();
    setTmapRouteStatus('대기 중');
}

function setTmapRouteStatus(message, isError = false) {
    const el = document.getElementById('tmapRouteStatus');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? '#b91c1c' : '#475569';
}

function nowReqTime() {
    const d = new Date();
    return d.getFullYear().toString() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0');
}

function getTmapRoutePlanTypes(option) {
    const key = String(option || '0');
    if (key === '1') return ['Traffic_Free'];
    if (key === '2') return ['Traffic_Time'];
    if (key === '3') return ['Traffic_Beginner'];
    return ['Traffic_Recommend'];
}

function buildTmapRouteHeaders(accessKey) {
    const headers = {
        Accept: 'application/octet-stream',
        CIH: '582079726',
        Client_ReqTime: nowReqTime(),
        Connection: 'close',
        'Content-Type': 'application/json; charset=UTF-8',
        'Network-Type': 'WIFI',
        Nonce: '858416984',
        Requester: 'CLIENT_SSL'
    };
    if (accessKey) {
        headers.accessKey = accessKey;
        headers.appKey = accessKey;
    }
    return headers;
}

function buildTmapRouteBody(searchOption) {
    if (typeof wgs84ToSkCoord !== 'function') {
        throw new Error('좌표 변환 스크립트가 로드되지 않았습니다.');
    }
    const origin = tmapRouteWaypoints.origin;
    const destination = tmapRouteWaypoints.destination;
    if (!origin || !destination) {
        throw new Error('출발지와 목적지를 먼저 지정해주세요.');
    }

    const [departXPos, departYPos] = wgs84ToSkCoord(origin.lat, origin.lon);
    const [destXPos, destYPos] = wgs84ToSkCoord(destination.lat, destination.lon);
    const reqTime = nowReqTime();

    const body = {
        addCameraTypes: ['Bus', 'SignalSpeeding', 'Moving', 'ShoulderControl', 'Traffic'],
        angle: 130,
        applyEvChargingTimeOnETA: true,
        autoAddingYn: 'Y',
        auxiliaryPower: 1200,
        availableAutoAddingYn: false,
        chargedEnergy: 55816,
        chargedRange: 37600,
        consumptionParam: '{"aux":1200.0,"batteryCapacity":69770,"batteryTemperature":-30,"chargingModeGen6":"PERFORMANCE","csc":[40.32,25.5,20.84,17.37,14.41,17.03,17.26,20.71,24.17,28.7,32.22],"firstCharging":false,"kAcc":2412000,"kDec":3600000,"kDown":3384000,"kUp":3132000,"mass":2580,"vehicleId":"11CF","vendor":"BMW"}',
        controlRouteReqFlag: 0,
        currentEnergy: 6970,
        currentRange: 47000,
        dangerAreaOptions: ['OccurFrequently', 'SharpCurveSection', 'MistArea', 'SchoolZone', 'TrainCrossing'],
        departDirPriority: 1,
        departDirectionType: 0,
        departLinkId: 0,
        departMeshId: 0,
        departName: origin.name || '출발지',
        departRoadType: 'None',
        departSrchFlag: 0,
        departXPos,
        departYPos,
        destEVChargerFlag: false,
        destName: destination.name || '목적지',
        destPoiId: '0',
        destRpFlag: 16,
        destSearchDetailFlag: 'None',
        destSearchFlag: 'LeaveReSearch',
        destXPos,
        destYPos,
        ecoModeFlag: 0,
        efficientSpeed: 0,
        evMobilityProviders: [],
        evSocHistory: [],
        gpsTraceData: '',
        guideImgResolutionCode: 'R480x540',
        header: {
            appLaunchCount: 1,
            appVersion: '3.11.260',
            buildNo: '311260',
            carrier: '',
            deviceId: '2-1-64f62924-13d2-3391-ad91-e935f9043d2d',
            modelNo: 'BMW IDCEvo',
            osType: 'AND',
            osVersion: '14',
            pushDeviceKey: '',
            reqTime,
            resolution: 'QUAD_HD',
            screenHeight: 1218,
            screenWidth: 2560,
            svcType: 113,
            using: 'MAIN'
        },
        hipassFlag: 0,
        initSrchDepartXPos: 0,
        initSrchDepartYPos: 0,
        initSrchLength: 155226,
        initSrchSessionId: `TPtr${reqTime}AHT`,
        isRetry: false,
        lastRid: 5153744,
        lastTollgateId: 0,
        maxCharge: 69770,
        minEnergy: 6977,
        minSocAtAutoAdding: 20,
        minSocAtChargingStation: 20,
        minSocAtDestination: 10,
        myEvStations: [],
        pastArrivalTime: '',
        pastSessionId: `TPtr${reqTime}AHT`,
        pastXpos: 0,
        pastYpos: 0,
        patternDateTime: '',
        pickEvStations: [],
        preMapVersion: '20260407',
        preRids: [],
        preSecs: [],
        preTollgateIds: '129',
        radiusEntryTurnType: 117,
        radiusInfoType: 1,
        radiusLeaveTurnType: 0,
        radiusLinkDirection: 1,
        radiusLinkId: 5901,
        radiusMeshCode: 2293816,
        radiusXPos: 127,
        radiusYPos: 36,
        routePlanTypes: getTmapRoutePlanTypes(searchOption),
        searchCondData: '',
        serviceFlag: 'Realtime',
        slopeFlag: 0,
        socketType: ['DcCombo'],
        speed: 0,
        tcRid: 0,
        tollCarType: 'Car',
        tvas: '5.9',
        vehicleId: '11CF',
        vehicleMass: 2580,
        vendor: 'BMW',
        version: '1.1',
        wayPoints: []
    };

    if (tmapRouteWaypoints.vias.length > 0) {
        body.wayPoints = tmapRouteWaypoints.vias.map((via, index) => {
            const [x, y] = wgs84ToSkCoord(via.lat, via.lon);
            return {
                x,
                y,
                wayPointName: via.name || `경유지${index + 1}`,
                wayPointSearchFlag: 'WaypointSearch',
                rpFlag: 99
            };
        });
    }

    return body;
}

function decodeBase64ToUint8Array(base64Text) {
    const binary = atob(base64Text || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function ensureTmapFeatureGroup(name) {
    if (!featureGroups[name]) {
        featureGroups[name] = L.featureGroup();
        featureGroups[name].addTo(map);
        activeGroups.add(name);
        if (!layerOrder.includes(name)) layerOrder.push(name);
        overlays[name] = featureGroups[name];
    }
    return featureGroups[name];
}

function buildTmapWaypointIcon(label, bgColor, subLabel) {
    return L.divIcon({
        className: '',
        iconSize: [36, 52],
        iconAnchor: [18, 26],
        html:
            `<div style="display:flex;flex-direction:column;align-items:center">` +
            `<div style="width:36px;height:36px;line-height:36px;text-align:center;background:${bgColor};color:#fff;border-radius:50%;font-size:16px;font-weight:800;box-shadow:0 3px 10px rgba(0,0,0,.25);border:3px solid #fff">${label}</div>` +
            `<div style="margin-top:2px;padding:1px 6px;background:rgba(15,23,42,0.78);color:#fff;font-size:9px;font-weight:600;border-radius:8px;white-space:nowrap">${subLabel}</div>` +
            `</div>`
    });
}

function updateTmapWaypointBar() {
    const bar = document.getElementById('routeWaypointBar');
    if (!bar) return;

    const items = [];
    const origin = tmapRouteWaypoints.origin;
    const destination = tmapRouteWaypoints.destination;
    if (origin) {
        items.push({ type: 'origin', label: 'S', className: 'route-wp-chip-start', name: origin.name || '출발지', index: -1, point: origin });
    }
    tmapRouteWaypoints.vias.forEach((via, index) => {
        items.push({ type: 'via', label: `W${index + 1}`, className: 'route-wp-chip-via', name: via.name || `경유지${index + 1}`, index, point: via });
    });
    if (destination) {
        items.push({ type: 'destination', label: 'E', className: 'route-wp-chip-dest', name: destination.name || '목적지', index: -1, point: destination });
    }

    if (items.length === 0) {
        bar.innerHTML = '<span class="route-waypoint-empty">지도 우클릭으로 출발지, 경유지, 목적지를 지정하세요.</span>';
        return;
    }

    bar.innerHTML = '';
    items.forEach((item) => {
        const chip = document.createElement('span');
        chip.className = `route-wp-chip ${item.className}`;
        chip.innerHTML = `<span>${item.label} ${item.point.lat.toFixed(5)}, ${item.point.lon.toFixed(5)}</span>`;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        removeBtn.title = `${item.name} 제거`;
        removeBtn.addEventListener('click', () => removeTmapWaypoint(item.type, item.index));
        chip.appendChild(removeBtn);
        bar.appendChild(chip);
    });
}

function renderTmapWaypointMarkers() {
    const group = ensureTmapFeatureGroup(TMAP_WAYPOINT_LAYER);
    group.clearLayers();

    const origin = tmapRouteWaypoints.origin;
    const destination = tmapRouteWaypoints.destination;

    if (origin) {
        group.addLayer(L.marker([origin.lat, origin.lon], {
            icon: buildTmapWaypointIcon('S', '#16a34a', '출발')
        }).bindPopup(`<b>출발지</b><br>${origin.lat.toFixed(6)}, ${origin.lon.toFixed(6)}`));
    }

    tmapRouteWaypoints.vias.forEach((via, index) => {
        group.addLayer(L.marker([via.lat, via.lon], {
            icon: buildTmapWaypointIcon(`W${index + 1}`, '#d97706', `경유${index + 1}`)
        }).bindPopup(`<b>경유지 ${index + 1}</b><br>${via.lat.toFixed(6)}, ${via.lon.toFixed(6)}`));
    });

    if (destination) {
        group.addLayer(L.marker([destination.lat, destination.lon], {
            icon: buildTmapWaypointIcon('E', '#dc2626', '도착')
        }).bindPopup(`<b>목적지</b><br>${destination.lat.toFixed(6)}, ${destination.lon.toFixed(6)}`));
    }

    renderLayerControls();
}

function setTmapWaypoint(type, latlng) {
    if (!latlng) return;

    const point = {
        lat: Number(latlng.lat),
        lon: Number(latlng.lng)
    };

    if (type === 'origin') {
        tmapRouteWaypoints.origin = { ...point, name: '출발지' };
    } else if (type === 'destination') {
        tmapRouteWaypoints.destination = { ...point, name: '목적지' };
    } else {
        if (tmapRouteWaypoints.vias.length >= 30) {
            alert('경유지는 최대 30개까지 설정할 수 있습니다.');
            return;
        }
        tmapRouteWaypoints.vias.push({ ...point, name: `경유지${tmapRouteWaypoints.vias.length + 1}` });
    }

    updateTmapWaypointBar();
    renderTmapWaypointMarkers();
    setTmapRouteStatus('경로점이 설정되었습니다.');
}

function removeTmapWaypoint(type, index = -1) {
    if (type === 'origin') {
        tmapRouteWaypoints.origin = null;
    } else if (type === 'destination') {
        tmapRouteWaypoints.destination = null;
    } else if (index >= 0 && index < tmapRouteWaypoints.vias.length) {
        tmapRouteWaypoints.vias.splice(index, 1);
        tmapRouteWaypoints.vias = tmapRouteWaypoints.vias.map((via, idx) => ({
            ...via,
            name: `경유지${idx + 1}`
        }));
    }
    updateTmapWaypointBar();
    renderTmapWaypointMarkers();
}

function openTmapRouteContextMenu(latlng) {
    if (!latlng) return;

    const container = document.createElement('div');
    container.style.cssText = 'font-size:12px;line-height:1.6;min-width:210px';
    container.innerHTML =
        `<div style="font-weight:700;margin-bottom:6px;">경로점 지정</div>` +
        `<div style="color:#475569;margin-bottom:8px;">${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</div>` +
        `<div style="display:flex;gap:4px;flex-wrap:wrap">` +
        `<button data-type="origin" style="flex:1;padding:6px 8px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">출발지</button>` +
        `<button data-type="via" style="flex:1;padding:6px 8px;background:#d97706;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">경유지</button>` +
        `<button data-type="destination" style="flex:1;padding:6px 8px;background:#dc2626;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">목적지</button>` +
        `</div>`;

    const popup = L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(container).openOn(map);
    container.querySelectorAll('button[data-type]').forEach((button) => {
        button.addEventListener('click', () => {
            setTmapWaypoint(button.dataset.type, latlng);
            map.closePopup(popup);
            const routePanel = document.getElementById('routePanel');
            if (routePanel?.classList.contains('hidden')) {
                toggleToolPanel('routePanel', 'toolRouteBtn');
            }
        });
    });
}

function clearTmapRoute(clearWaypoints = false) {
    tmapRouteResult = null;
    const routeGroup = featureGroups[TMAP_ROUTE_LAYER];
    if (routeGroup) routeGroup.clearLayers();

    if (clearWaypoints) {
        tmapRouteWaypoints = { origin: null, destination: null, vias: [] };
        const waypointGroup = featureGroups[TMAP_WAYPOINT_LAYER];
        if (waypointGroup) waypointGroup.clearLayers();
        updateTmapWaypointBar();
    } else {
        renderTmapWaypointMarkers();
    }

    renderLayerControls();
    setTmapRouteStatus(clearWaypoints ? '경로와 선택 지점을 초기화했습니다.' : '경로를 지웠습니다.');
}

async function handleTmapRouteRequest() {
    if (tmapRouteRequesting) return;

    const accessKey = (document.getElementById('tmapAppKeyInput')?.value || '').trim();
    if (!accessKey) {
        setTmapRouteStatus('TMAP_ACCESS_KEY를 입력해주세요.', true);
        return;
    }
    if (!tmapRouteWaypoints.origin || !tmapRouteWaypoints.destination) {
        setTmapRouteStatus('출발지와 목적지를 먼저 지정해주세요.', true);
        return;
    }

    const requestButton = document.getElementById('tmapRouteRequestButton');
    const searchOption = (document.getElementById('tmapRouteOptionSelect')?.value || '0').trim();

    tmapRouteRequesting = true;
    if (requestButton) requestButton.disabled = true;
    setTmapRouteStatus('ntmapstg 경로 요청 중...');

    try {
        const headers = buildTmapRouteHeaders(accessKey);
        const body = buildTmapRouteBody(searchOption);
        const response = await fetch('/api/tmap-route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accessKey,
                endpoint: TMAP_STG_ROUTE_ENDPOINT,
                headers,
                body
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            const detailText = data?.detail && typeof data.detail === 'object'
                ? JSON.stringify(data.detail)
                : (data?.detail || '');
            throw new Error(data?.error ? `${data.error}${detailText ? `\n${detailText}` : ''}` : '경로 요청 실패');
        }

        renderTmapRouteResultWithEvents(data.response);
    } catch (error) {
        setTmapRouteStatus(error.message || '경로 요청 실패', true);
    } finally {
        tmapRouteRequesting = false;
        if (requestButton) requestButton.disabled = false;
    }
}

function renderTmapRouteResult(routeResponse) {
    if (typeof parseTvas !== 'function' || typeof resolveVertexCoordinates !== 'function') {
        throw new Error('TVAS 파서가 로드되지 않았습니다.');
    }

    const bodyBase64 = routeResponse?.body_base64;
    if (!bodyBase64) {
        throw new Error('응답 본문이 비어 있습니다.');
    }

    const rawBytes = decodeBase64ToUint8Array(bodyBase64);
    let tvasBuffer = rawBytes.buffer;
    let responseInfo = {};

    if (rawBytes.length > 0 && rawBytes[0] === 0x7B) {
        const text = new TextDecoder('utf-8').decode(rawBytes);
        const json = JSON.parse(text);
        responseInfo = {
            sessionId: json.header?.sessionId || '',
            errorCode: json.header?.errorCode || '',
            errorMessage: json.header?.errorMessage || ''
        };

        if (json.header?.errorCode && json.header.errorCode !== '000000') {
            throw new Error(`서버 오류 [${json.header.errorCode}] ${json.header.errorMessage || ''}`.trim());
        }
        if (!json.tvases) {
            throw new Error('응답에 tvases 데이터가 없습니다.');
        }

        const tvasBytes = decodeBase64ToUint8Array(json.tvases);
        tvasBuffer = tvasBytes.buffer;
    }

    const tvasResult = parseTvas(tvasBuffer);
    const coords = resolveVertexCoordinates(tvasResult);
    if (!Array.isArray(coords) || coords.length < 2) {
        throw new Error('TVAS에서 경로 좌표를 추출하지 못했습니다.');
    }

    const routeGroup = ensureTmapFeatureGroup(TMAP_ROUTE_LAYER);
    routeGroup.clearLayers();

    const latlngs = coords.map((coord) => [coord.lat, coord.lon]);
    const line = L.polyline(latlngs, {
        color: '#ef4444',
        weight: 5,
        opacity: 0.9
    });
    line.bindPopup(
        `<b>TVAS Route</b><br>` +
        `점 개수: ${coords.length}<br>` +
        `거리: ${Number.isFinite(tvasResult?.header?.routeSearch?.totalDistance) ? `${(tvasResult.header.routeSearch.totalDistance / 1000).toFixed(1)} km` : '-'}<br>` +
        `시간: ${Number.isFinite(tvasResult?.header?.routeSearch?.totalTime) ? `${Math.round(tvasResult.header.routeSearch.totalTime / 60)} 분` : '-'}`
    );
    routeGroup.addLayer(line);

    tmapRouteResult = {
        responseInfo,
        tvasResult,
        coords
    };
    renderLayerControls();
    map.fitBounds(latlngs, { padding: [24, 24] });

    const distanceText = Number.isFinite(tvasResult?.header?.routeSearch?.totalDistance)
        ? `${(tvasResult.header.routeSearch.totalDistance / 1000).toFixed(1)} km`
        : '-';
    const timeText = Number.isFinite(tvasResult?.header?.routeSearch?.totalTime)
        ? `${Math.round(tvasResult.header.routeSearch.totalTime / 60)} 분`
        : '-';
    const viaText = tmapRouteWaypoints.vias.length > 0 ? `, 경유지 ${tmapRouteWaypoints.vias.length}개` : '';
    const sessionText = responseInfo.sessionId ? `, session ${responseInfo.sessionId}` : '';
    setTmapRouteStatus(`경로 요청 완료: 점 ${coords.length}개, 거리 ${distanceText}, 시간 ${timeText}${viaText}${sessionText}`);
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

function setupDragAndDrop(dropZoneId, inputId) {
    const dropZone = document.getElementById(dropZoneId);
    const fileInput = document.getElementById(inputId);

    if (!dropZone || !fileInput) return;

    // Skip if already setup to prevent duplicate event listeners
    if (dropZone._dragDropSetup) return;
    dropZone._dragDropSetup = true;

    // Prevent default drag behaviors
    const preventDefaults = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults);
    });

    // Highlight drop zone when dragging over
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.style.borderColor = '#3b82f6';
            dropZone.style.backgroundColor = '#eef2ff';
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.style.borderColor = '#cbd5e1';
            dropZone.style.backgroundColor = '#f8fafc';
        });
    });

    // Handle drop
    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            fileInput.files = files;
            // Trigger change event to update UI
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    // Make dropzone clickable (only once!)
    dropZone.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });
}

function initUploadPanel() {
    bind('parseUploadButton', 'click', handleUploadAndParse);
    bind('parseLinkShpButton', 'click', () => handleUploadRoadShape('link'));
    bind('parseNodeShpButton', 'click', () => handleUploadRoadShape('node'));
    bind('clearShpButton', 'click', handleClearRoadShape);
    bind('addLinkStyleRuleButton', 'click', handleAddLinkStyleRule);
    bind('applyNodeStyleButton', 'click', applyRoadNodeStyleConfig);
    bind('layerCtxClose', 'click', closeLayerContextMenu);
    initLayerContextMenuDrag();

    bindFileSelectionSummary('logFileInput', 'logFileNameText', false);
    bindFileSelectionSummary('linkShpFolderInput', 'linkShpFileText', true);
    bindFileSelectionSummary('nodeShpFolderInput', 'nodeShpFileText', true);

    // Setup drag and drop for DLT log files
    setupDragAndDrop('logDropZone', 'logFileInput');
    setupDragAndDrop('linkDropZone', 'linkShpFolderInput');
    setupDragAndDrop('nodeDropZone', 'nodeShpFolderInput');

    loadRoadLinkBaseStylesFromStorage();
    loadRoadCustomLinkRulesFromStorage();
    loadRoadPointStylesFromStorage();
    loadLaneWidthConfigsFromStorage();
    loadRoadLinkIdLabelFromStorage();

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
    const exportCsvBtn = document.getElementById('exportCsvMenuButton');
    if (exportCsvBtn) exportCsvBtn.disabled = !(Array.isArray(markersData) && markersData.length > 0);

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

function normalizeRoadPointStyle(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { ...fallback };
    const radiusRaw = Number(raw.radius);
    const weightRaw = Number(raw.weight);
    return {
        color: normalizeRoadColor(raw.color, fallback.color),
        stroke: normalizeRoadColor(raw.stroke, fallback.stroke),
        radius: Number.isFinite(radiusRaw) ? Math.max(1, Math.min(12, radiusRaw)) : fallback.radius,
        weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(5, weightRaw)) : fallback.weight
    };
}

// roadNodeStyleConfig/roadVertexStyleConfig는 이미 렌더 함수들이 이 객체 참조를 직접 읽으므로,
// 재할당 대신 in-place로 값을 덮어써 참조가 어긋나는 일이 없게 한다.
function loadRoadPointStylesFromStorage() {
    const raw = readJsonSetting(ROAD_POINT_STYLE_STORAGE_KEY, null);
    Object.assign(roadNodeStyleConfig, normalizeRoadPointStyle(raw?.node, DEFAULT_ROAD_NODE_STYLE));
    Object.assign(roadVertexStyleConfig, normalizeRoadPointStyle(raw?.vertex, DEFAULT_ROAD_VERTEX_STYLE));
}

function saveRoadPointStylesToStorage() {
    writeJsonSetting(ROAD_POINT_STYLE_STORAGE_KEY, {
        node: { ...roadNodeStyleConfig },
        vertex: { ...roadVertexStyleConfig }
    });
}

function normalizeLaneWidthConfig(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { ...fallback };
    return {
        normal: clampLaneWidthValue(raw.normal, fallback.normal),
        extended: clampLaneWidthValue(raw.extended, fallback.extended),
        normalColor: normalizeRoadColor(raw.normalColor, fallback.normalColor),
        extendedColor: normalizeRoadColor(raw.extendedColor, fallback.extendedColor),
        fillOpacity: clampLaneOpacityValue(raw.fillOpacity, fallback.fillOpacity)
    };
}

function loadLaneWidthConfigsFromStorage() {
    const raw = readJsonSetting(LANE_WIDTH_CONFIG_STORAGE_KEY, null);
    Object.assign(laneWidthConfig, normalizeLaneWidthConfig(raw?.lane1, DEFAULT_LANE_WIDTH_CONFIG));
    Object.assign(laneWidthConfig2, normalizeLaneWidthConfig(raw?.lane2, DEFAULT_LANE_WIDTH_CONFIG_2));
}

function saveLaneWidthConfigsToStorage() {
    writeJsonSetting(LANE_WIDTH_CONFIG_STORAGE_KEY, {
        lane1: { ...laneWidthConfig },
        lane2: { ...laneWidthConfig2 }
    });
}

function loadRoadLinkIdLabelFromStorage() {
    const raw = readJsonSetting(ROAD_LINK_ID_LABEL_STORAGE_KEY, null);
    roadLinkIdLabelEnabled = raw === null ? true : !!raw;
}

function saveRoadLinkIdLabelToStorage() {
    writeJsonSetting(ROAD_LINK_ID_LABEL_STORAGE_KEY, roadLinkIdLabelEnabled);
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

function normalizeCustomLinkRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const propKey = String(raw.propKey || '').trim();
    const rawValue = String(raw.rawValue ?? '').trim();
    if (!propKey || rawValue === '') return null;
    const seqNum = Number(raw.seq);
    return {
        seq: Number.isFinite(seqNum) ? seqNum : 0,
        propKey,
        rawValue,
        normalizedValue: normalizeRuleMatchValue(rawValue),
        color: normalizeRoadColor(raw.color, '#8b5cf6'),
        weight: clampRoadLinkWeight(raw.weight ?? 2.1),
        customName: String(raw.customName || '').trim()
    };
}

function loadRoadCustomLinkRulesFromStorage() {
    const raw = readJsonSetting(ROAD_CUSTOM_LINK_RULES_STORAGE_KEY, []);
    const list = Array.isArray(raw) ? raw.map(normalizeCustomLinkRule).filter(Boolean) : [];
    roadCustomLinkRules = list;
    const maxSeq = list.reduce((max, rule) => Math.max(max, rule.seq || 0), 0);
    roadCustomLinkRuleSeq = maxSeq + 1;
}

function saveRoadCustomLinkRulesToStorage() {
    writeJsonSetting(ROAD_CUSTOM_LINK_RULES_STORAGE_KEY, roadCustomLinkRules);
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
        roadLinkGeoLayer.setStyle((feature) => getRoadLinkStyle({
            ...(feature?.properties || {}),
            __featureRef: feature
        }));
    }
    if (roadNodeGeoLayer) {
        roadNodeGeoLayer.eachLayer((layer) => {
            if (typeof layer.setStyle !== 'function') return;
            layer.setStyle(getRoadNodeStyle({
                ...(layer?.feature?.properties || {}),
                __featureRef: layer?.feature || null
            }));
        });
    }
    if (roadLinkVertexGeoLayer) {
        roadLinkVertexGeoLayer.eachLayer((layer) => {
            if (typeof layer.setStyle !== 'function') return;
            layer.setStyle(getRoadLinkVertexStyle({
                ...(layer?.feature?.properties || {}),
                __featureRef: layer?.feature || null
            }));
        });
    }
}

function setSelectedRoadFeature(kind, feature) {
    const shpIndex = getRoadFeatureIndex(feature);
    const vertexIndex = Number(feature?.properties?.LINK_VERTEX_INDEX);
    const partIndex = Number(feature?.properties?.LINK_VERTEX_PART);
    if (kind === 'vertex' && Number.isFinite(shpIndex) && Number.isFinite(vertexIndex)) {
        selectedRoadFeatureRef = {
            kind,
            shpIndex,
            vertexIndex,
            partIndex: Number.isFinite(partIndex) ? partIndex : 0
        };
    } else if (Number.isFinite(shpIndex)) {
        selectedRoadFeatureRef = { kind, shpIndex };
    } else {
        selectedRoadFeatureRef = { kind: null, shpIndex: null };
    }
    refreshRoadLayerStyles();
}

function isSelectedRoadFeature(kind, feature) {
    if (!feature || selectedRoadFeatureRef.kind !== kind) return false;
    const shpIndex = getRoadFeatureIndex(feature);
    if (!Number.isFinite(shpIndex) || shpIndex !== selectedRoadFeatureRef.shpIndex) return false;
    if (kind !== 'vertex') return true;
    const vertexIndex = Number(feature?.properties?.LINK_VERTEX_INDEX);
    const partIndex = Number(feature?.properties?.LINK_VERTEX_PART);
    return Number.isFinite(vertexIndex)
        && vertexIndex === selectedRoadFeatureRef.vertexIndex
        && (Number.isFinite(partIndex) ? partIndex : 0) === (selectedRoadFeatureRef.partIndex ?? 0);
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
        const nameLabel = rule.customName ? `${rule.customName} (${rule.propKey} = ${rule.rawValue})` : `${rule.propKey} = ${rule.rawValue}`;
        row.innerHTML = `
            <span class="style-rule-chip" style="background:${escapeHtml(rule.color)};"></span>
            <span class="style-rule-text">${escapeHtml(`${index + 1}. ${nameLabel} / ${rule.weight}px`)}</span>
            <button type="button" class="style-rule-remove">삭제</button>
        `;

        const removeBtn = row.querySelector('.style-rule-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                roadCustomLinkRules = roadCustomLinkRules.filter((item) => item.seq !== rule.seq);
                saveRoadCustomLinkRulesToStorage();
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
    const nameInput = document.getElementById('linkStyleNameInput');
    const propInput = document.getElementById('linkStylePropSelect');
    const valueInput = document.getElementById('linkStyleValueInput');
    const colorInput = document.getElementById('linkStyleColorInput');
    const weightInput = document.getElementById('linkStyleWeightInput');

    const customName = String(nameInput?.value || '').trim();
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
        weight,
        customName
    });
    saveRoadCustomLinkRulesToStorage();
    syncRoadLinkRuleEnabledState();
    renderCustomLinkRuleList();
    renderLinkStyleFieldOptions(propKey);
    syncRoadShapeWorkerQueryKeys();
    refreshRoadLayerStyles();
    renderLayerControls();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    if (nameInput) nameInput.value = '';
    setUploadProgress(100, `링크 스타일 규칙 추가: ${customName || `${propKey}=${rawValue}`}`, false);
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

    const nextStyle = {
        color,
        stroke,
        radius: Number.isFinite(radiusRaw) ? Math.max(1, Math.min(12, radiusRaw)) : 3.2,
        weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(5, weightRaw)) : 1
    };
    if (roadStyleContextLayerName === ROAD_LINK_VERTEX_LAYER) {
        Object.assign(roadVertexStyleConfig, nextStyle);
    } else {
        Object.assign(roadNodeStyleConfig, nextStyle);
    }
    saveRoadPointStylesToStorage();
    refreshRoadLayerStyles();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    setUploadProgress(100, `${roadStyleContextLayerName === ROAD_LINK_VERTEX_LAYER ? 'Vertex' : '노드'} 스타일 적용 완료`, false);
}

function initToolPanels() {
    const panelMap = {
        toolUploadBtn: 'uploadPanel',
        toolExportBtn: 'exportPanel',
        toolMarkerTableBtn: 'markerTablePanel',
        toolRouteBtn: 'routePanel',
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
    bind('exportCsvMenuButton', 'click', () => handleExportCsvFromMenu());
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
    ['uploadPanel', 'exportPanel', 'markerTablePanel', 'routePanel', 'distancePanel', 'radiusPanel', 'playbackPanel', 'legendPanel']
        .forEach((panelId) => document.getElementById(panelId)?.classList.add('hidden'));
    syncToolButtonState();
}

function syncToolButtonState() {
    const mapping = {
        toolUploadBtn: 'uploadPanel',
        toolExportBtn: 'exportPanel',
        toolMarkerTableBtn: 'markerTablePanel',
        toolRouteBtn: 'routePanel',
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
        parkingLotStateMarkersData = response.parking_lot_state_markers || [];
        linesData = response.lines || [];
        console.log('[DEBUG] Loaded data:', {
            markersCount: markersData.length,
            parkingLotStateMarkersCount: parkingLotStateMarkersData.length,
            linesCount: linesData.length
        });
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
        const exportCsvBtn = document.getElementById('exportCsvMenuButton');
        if (exportCsvBtn) exportCsvBtn.disabled = false;

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
            const shpBuf = group?.shpBuf instanceof ArrayBuffer && group.shpBuf.byteLength > 0 ? group.shpBuf : null;
            const dbfBuf = group?.dbfBuf instanceof ArrayBuffer && group.dbfBuf.byteLength > 0 ? group.dbfBuf : null;
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

async function getRoadShapeGroupsForWorker() {
    const inMemoryGroups = cloneRoadShapeGroupsForWorker();
    if (inMemoryGroups.length > 0) {
        return inMemoryGroups;
    }

    const restored = [];
    for (const kind of ['link', 'node']) {
        const record = await loadRoadShapeKindFromLocalDb(kind);
        const groups = Array.isArray(record?.groups) ? record.groups : [];
        if (groups.length > 0) {
            roadShapeLocalGroupsByKind[kind] = groups;
            restored.push(...groups.map((group) => ({
                kind,
                name: group?.name || `${kind}_shape`,
                shpBuf: group?.shpBuf,
                dbfBuf: group?.dbfBuf,
                prjText: typeof group?.prjText === 'string' ? group.prjText : '',
                cpgText: typeof group?.cpgText === 'string' ? group.cpgText : ''
            })));
        }
    }
    return restored;
}

function releaseTransferredRoadShapeBuffers(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return;
    const transferredKeys = new Set(
        groups.map((group) => `${group?.kind || ''}::${group?.name || ''}`)
    );
    ['link', 'node'].forEach((kind) => {
        const sourceGroups = Array.isArray(roadShapeLocalGroupsByKind?.[kind]) ? roadShapeLocalGroupsByKind[kind] : [];
        sourceGroups.forEach((group) => {
            const key = `${kind}::${group?.name || ''}`;
            if (!transferredKeys.has(key)) return;
            group.shpBuf = null;
            group.dbfBuf = null;
        });
    });
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

        const groups = await getRoadShapeGroupsForWorker();
        if (!Array.isArray(groups) || groups.length === 0) {
            throw new Error('로컬 Shape 데이터가 없습니다. Link/Node 폴더를 업로드하세요.');
        }
        const transferables = [];
        groups.forEach((group) => {
            if (group.shpBuf instanceof ArrayBuffer) transferables.push(group.shpBuf);
            if (group.dbfBuf instanceof ArrayBuffer) transferables.push(group.dbfBuf);
        });
        roadShapeWorker.postMessage({ type: 'loadGroups', groups }, transferables);
        releaseTransferredRoadShapeBuffers(groups);
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
        return;
    }

    if (data.type === 'findLinkByRidResult') {
        const reqId = Number(data.requestId || 0);
        const resolver = roadShapeFindRequests.get(reqId);
        if (resolver) {
            roadShapeFindRequests.delete(reqId);
            resolver(data.feature ? { feature: data.feature } : null);
        }
    }
}

function terminateRoadShapeWorker() {
    if (roadShapeWorker) {
        try { roadShapeWorker.terminate(); } catch (_) {}
        roadShapeWorker = null;
    }
    roadShapeAttrRequests.clear();
    roadShapeFindRequests.clear();
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
    const raw = feature?._shpIndex
        ?? feature?.properties?._shpIndex
        ?? feature?.properties?.__featureRef?.shpIndex;
    const index = Number(raw);
    return Number.isFinite(index) ? index : null;
}

function toRoadInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : null;
}

function normalizeHeadingDegrees(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const normalized = ((num % 360) + 360) % 360;
    return normalized;
}

function computeHeadingDeltaDegrees(a, b) {
    const h1 = normalizeHeadingDegrees(a);
    const h2 = normalizeHeadingDegrees(b);
    if (!Number.isFinite(h1) || !Number.isFinite(h2)) return null;
    let diff = Math.abs(h1 - h2);
    if (diff > 180) diff = 360 - diff;
    return diff;
}

function computeSegmentHeadingDegrees(start, end) {
    if (!Array.isArray(start) || !Array.isArray(end) || start.length < 2 || end.length < 2) {
        return null;
    }
    const lat1 = Number(start[0]);
    const lon1 = Number(start[1]);
    const lat2 = Number(end[0]);
    const lon2 = Number(end[1]);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
    const y = Math.sin((lon2 - lon1) * DEG2RAD) * Math.cos(lat2 * DEG2RAD);
    const x =
        Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
        Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos((lon2 - lon1) * DEG2RAD);
    const bearing = Math.atan2(y, x) * (180 / Math.PI);
    return normalizeHeadingDegrees(bearing);
}

function firstLastCoordsFromGeometry(geometry) {
    if (!geometry || !geometry.type) return null;
    const coords = geometry.coordinates;
    if (!Array.isArray(coords)) return null;

    if (geometry.type === 'LineString' && coords.length >= 2) {
        return { start: coords[0], end: coords[coords.length - 1] };
    }
    if (geometry.type === 'MultiLineString' && coords.length > 0) {
        const firstLine = coords.find((line) => Array.isArray(line) && line.length >= 2);
        const lastLine = [...coords].reverse().find((line) => Array.isArray(line) && line.length >= 2);
        if (firstLine && lastLine) {
            return { start: firstLine[0], end: lastLine[lastLine.length - 1] };
        }
    }
    return null;
}

function computeRoadFeatureAngle(feature) {
    const endpoints = firstLastCoordsFromGeometry(feature?.geometry);
    if (!endpoints) return null;
    const start = Array.isArray(endpoints.start) ? [endpoints.start[1], endpoints.start[0]] : null;
    const end = Array.isArray(endpoints.end) ? [endpoints.end[1], endpoints.end[0]] : null;
    return computeSegmentHeadingDegrees(start, end);
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
                label: customRule.customName || `${customRule.propKey}=${customRule.rawValue}`,
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
    const linkAngle = title === 'Road Link' ? computeRoadFeatureAngle(feature) : null;
    if (Number.isFinite(shpIndex)) {
        baseProps.SHP_INDEX = shpIndex + 1;
    }
    if (Number.isFinite(linkAngle)) {
        baseProps.LINK_ANGLE = `${linkAngle.toFixed(2)}°`;
    }

    layer.bindPopup(makeRoadPopupContent(baseProps, title), { maxWidth: 420, autoPan: false, keepInView: false });
    layer.on('click', (event) => {
        if (!canInspectRoadShapes()) {
            if (event?.originalEvent) L.DomEvent.stop(event.originalEvent);
            return;
        }
        openRoadLayerPopup(layer, feature, kind, title, event?.latlng, event?.originalEvent);
    });
}

function openRoadLayerPopup(layer, feature, kind, title, latlng, originalEvent = null) {
    const baseProps = { ...(feature?.properties || {}) };
    const shpIndex = getRoadFeatureIndex(feature);
    const linkAngle = title === 'Road Link' ? computeRoadFeatureAngle(feature) : null;
    if (Number.isFinite(shpIndex)) {
        baseProps.SHP_INDEX = shpIndex + 1;
    }
    if (Number.isFinite(linkAngle)) {
        baseProps.LINK_ANGLE = `${linkAngle.toFixed(2)}°`;
    }

    setSelectedRoadFeature(kind, feature);
    lastRoadLayerInteractionTs = Date.now();

    const clickLat = Number(latlng?.lat);
    const clickLon = Number(latlng?.lng);
    const popupBaseProps = { ...baseProps };
    if (Number.isFinite(clickLat) && Number.isFinite(clickLon)) {
        popupBaseProps.CLICK_LAT = clickLat.toFixed(6);
        popupBaseProps.CLICK_LON = clickLon.toFixed(6);
    }
    if (Number.isFinite(linkAngle) && Number.isFinite(selectedDrCoordinate?.heading)) {
        popupBaseProps.DR_HEADING = `${Number(selectedDrCoordinate.heading).toFixed(2)}°`;
        const diff = computeHeadingDeltaDegrees(selectedDrCoordinate.heading, linkAngle);
        if (Number.isFinite(diff)) {
            popupBaseProps.DR_LINK_DIFF = `${diff.toFixed(2)}°`;
        }
    }

    const loadingProps = { ...popupBaseProps, 상태: '속성 조회 중...' };
    layer.setPopupContent(makeRoadPopupContent(loadingProps, title));
    if (typeof layer.openPopup === 'function') {
        layer.openPopup(latlng);
    }
    if (originalEvent) {
        L.DomEvent.stop(originalEvent);
    }

    if (!Number.isFinite(shpIndex) || kind === 'vertex') return;

    requestRoadShapeAttrs(kind, shpIndex).then((attrs) => {
        const attrObj = (attrs && typeof attrs === 'object') ? attrs : {};
        const merged = Object.keys(attrObj).length > 0
            ? { ...popupBaseProps, ...attrObj }
            : popupBaseProps;
        layer.setPopupContent(makeRoadPopupContent(merged, title));
    });
}

function ensureRoadInteractionPanes() {
    const ensurePane = (name, zIndex) => {
        let pane = map.getPane(name);
        if (!pane) {
            pane = map.createPane(name);
        }
        pane.style.zIndex = String(zIndex);
        pane.style.pointerEvents = 'auto';
        return pane;
    };

    // Keep road-shape layers below markerPane so parsed marker popups remain clickable.
    // Lane-width boxes sit below the link canvas (overlayPane, z=400) so the centerline stays on top.
    ensurePane('roadLaneWidthPane', 350);
    ensurePane('roadLaneWidth2Pane', 351);
    ensurePane('roadLinkPane', 550);
    ensurePane('roadNodePane', 551);
    ensurePane('roadLinkVertexPane', 552);

}

function getRoadPaneName(layerName) {
    if (layerName === ROAD_LINK_LAYER) return 'roadLinkPane';
    if (layerName === ROAD_LINK_VERTEX_LAYER) return 'roadLinkVertexPane';
    if (layerName === ROAD_NODE_LAYER) return 'roadNodePane';
    if (layerName === LANE_WIDTH_LAYER) return 'roadLaneWidthPane';
    if (layerName === LANE_WIDTH_LAYER_2) return 'roadLaneWidth2Pane';
    return null;
}

function getPreferredRoadKinds() {
    const kindByLayerName = {
        [ROAD_LINK_LAYER]: 'link',
        [ROAD_NODE_LAYER]: 'node',
        [ROAD_LINK_VERTEX_LAYER]: 'vertex'
    };
    return layerOrder
        .filter((name) => isRoadShapeLayerName(name) && activeGroups.has(name))
        .map((name) => kindByLayerName[name])
        .filter(Boolean)
        .reverse();
}

function getRoadLinkVertexStyle(props = {}) {
    const radius = roadVertexStyleConfig.radius;
    if (isSelectedRoadFeature('vertex', props?.__featureRef)) {
        return {
            radius,
            color: '#b91c1c',
            fillColor: '#ef4444',
            fillOpacity: 0.98,
            weight: Math.max(roadVertexStyleConfig.weight, 1.8)
        };
    }
    return {
        radius,
        color: roadVertexStyleConfig.stroke,
        fillColor: roadVertexStyleConfig.color,
        fillOpacity: 0.95,
        weight: roadVertexStyleConfig.weight
    };
}

function makeRoadLinkVertexFeatures(linkFeatures) {
    const out = [];
    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];

    sourceLinks.forEach((feature) => {
        const geometry = feature?.geometry;
        const props = feature?.properties || {};
        const shpIndex = getRoadFeatureIndex(feature);
        const linkId = pickRoadLinkId(props);
        if (!geometry) return;

        const pushVertex = (coord, vertexIndex, partIndex = 0) => {
            const lon = Number(coord?.[0]);
            const lat = Number(coord?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            out.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lon, lat]
                },
                properties: {
                    LINK_ID: linkId,
                    LINK_VERTEX_INDEX: vertexIndex,
                    LINK_VERTEX_PART: partIndex,
                    CLICK_LAT: lat,
                    CLICK_LON: lon,
                    __parentFeatureRef: feature,
                    __featureRef: {
                        kind: 'link-vertex',
                        shpIndex,
                        vertexIndex,
                        partIndex
                    }
                }
            });
        };

        if (geometry.type === 'LineString') {
            (geometry.coordinates || []).forEach((coord, index) => pushVertex(coord, index, 0));
            return;
        }
        if (geometry.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach((lineCoords, partIndex) => {
                (lineCoords || []).forEach((coord, index) => pushVertex(coord, index, partIndex));
            });
        }
    });

    return out;
}

function ensureRoadShapeLayers() {
    ensureRoadInteractionPanes();
    if (!roadLinkGeoLayer) {
        roadLinkGeoLayer = L.geoJSON(null, {
            pane: 'roadLinkPane',
            renderer: roadCanvasRenderer,
            interactive: true,
            bubblingMouseEvents: false,
            style: (feature) => getRoadLinkStyle({
                ...(feature?.properties || {}),
                __featureRef: feature
            }),
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

    if (!roadLaneWidthGeoLayer) {
        roadLaneWidthGeoLayer = L.geoJSON(null, {
            pane: 'roadLaneWidthPane',
            renderer: roadCanvasRendererLane,
            interactive: false,
            style: (feature) => getLaneWidthStyle(feature?.properties || {}, laneWidthConfig)
        });
        addLayerToGroup(LANE_WIDTH_LAYER, roadLaneWidthGeoLayer);
    }

    if (!roadLaneWidth2GeoLayer) {
        roadLaneWidth2GeoLayer = L.geoJSON(null, {
            pane: 'roadLaneWidth2Pane',
            renderer: roadCanvasRendererLane2,
            interactive: false,
            style: (feature) => getLaneWidthStyle(feature?.properties || {}, laneWidthConfig2)
        });
        addLayerToGroup(LANE_WIDTH_LAYER_2, roadLaneWidth2GeoLayer);
        // 차로폭2는 기본 OFF (필요할 때만 선택적으로 켬)
        activeGroups.delete(LANE_WIDTH_LAYER_2);
        const g2 = featureGroups[LANE_WIDTH_LAYER_2];
        if (g2 && map.hasLayer(g2)) map.removeLayer(g2);
    }

    if (!roadNodeGeoLayer) {
        roadNodeGeoLayer = L.geoJSON(null, {
            pane: 'roadNodePane',
            interactive: true,
            bubblingMouseEvents: false,
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                pane: 'roadNodePane',
                renderer: roadCanvasRendererNode,
                interactive: true,
                bubblingMouseEvents: false,
                ...getRoadNodeStyle({
                    ...(feature?.properties || {}),
                    __featureRef: feature
                })
            }),
            onEachFeature: (feature, layer) => {
                attachRoadShapePopup(feature, layer, 'node', 'Road Node');
            }
        });
        addLayerToGroup(ROAD_NODE_LAYER, roadNodeGeoLayer);
    }

    if (!roadLinkVertexGeoLayer) {
        roadLinkVertexGeoLayer = L.geoJSON(null, {
            pane: 'roadLinkVertexPane',
            interactive: true,
            bubblingMouseEvents: false,
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                pane: 'roadLinkVertexPane',
                interactive: true,
                bubblingMouseEvents: false,
                ...getRoadLinkVertexStyle({
                    ...(feature?.properties || {}),
                    __featureRef: feature
                })
            }),
            onEachFeature: (feature, layer) => {
                attachRoadShapePopup(feature, layer, 'vertex', 'Road Link Vertex');
            }
        });
        addLayerToGroup(ROAD_LINK_VERTEX_LAYER, roadLinkVertexGeoLayer);
    }

    if (!layerOrder.includes(ROAD_LINK_LAYER)) layerOrder.push(ROAD_LINK_LAYER);
    if (!layerOrder.includes(ROAD_NODE_LAYER)) layerOrder.push(ROAD_NODE_LAYER);
    if (!layerOrder.includes(ROAD_LINK_VERTEX_LAYER)) layerOrder.push(ROAD_LINK_VERTEX_LAYER);
    if (!layerOrder.includes(LANE_WIDTH_LAYER)) layerOrder.push(LANE_WIDTH_LAYER);
    if (!layerOrder.includes(LANE_WIDTH_LAYER_2)) layerOrder.push(LANE_WIDTH_LAYER_2);
    activeGroups.add(ROAD_LINK_LAYER);
    activeGroups.add(ROAD_NODE_LAYER);
    activeGroups.add(ROAD_LINK_VERTEX_LAYER);
    activeGroups.add(LANE_WIDTH_LAYER);
    // LANE_WIDTH_LAYER_2 는 기본 OFF — activeGroups에 추가하지 않음
}

// 렌더 대상 차로폭 레이어 목록(각자 geoLayer/설정/활성상태 보유).
function laneLayerEntries() {
    return [
        { name: LANE_WIDTH_LAYER, layer: roadLaneWidthGeoLayer, config: laneWidthConfig },
        { name: LANE_WIDTH_LAYER_2, layer: roadLaneWidth2GeoLayer, config: laneWidthConfig2 }
    ];
}

// 링크의 차선수(LANE, 최소 1). 파싱 불가 시 1로 간주.
function laneCountForProps(props) {
    const raw = toRoadInt(findRoadPropValue(props, 'LANE'));
    return (raw !== null && raw >= 1) ? raw : 1;
}

// 박스 반폭(중심선→가장자리) = ceil(max(1, 차선수)/2) * (타입별 한 차선 폭).
// roadCate <= 1 이면 확장(EXTENDED_LANE_WIDTH), 그 외 기본(LANE_WIDTH). 차선수/2는 올림.
function laneWidthForProps(props, config) {
    const roadCate = toRoadInt(findRoadPropValue(props, 'ROAD_CATE'));
    const extended = roadCate !== null && roadCate <= 1;
    const oneLaneWidth = extended ? Number(config.extended) : Number(config.normal);
    const laneCount = laneCountForProps(props);
    const halfLaneCount = Math.ceil(laneCount / 2); // 소수점 올림
    const halfWidth = halfLaneCount * oneLaneWidth;  // 미터
    return { halfWidth, oneLaneWidth, laneCount, extended };
}

function getLaneWidthStyle(props = {}, config = laneWidthConfig) {
    const extended = props.__laneExtended === true;
    const color = extended ? config.extendedColor : config.normalColor;
    return {
        color,
        weight: 0.6,
        opacity: 0.7,
        fillColor: color,
        fillOpacity: Number(config.fillOpacity)
    };
}

// 하나의 폴리라인 세그먼트를 중심선 기준 ±half 만큼 수직으로 확장한 사각형(폴리곤) 코너를 만든다.
// 로컬 ENU(미터) 평면에서 계산 후 위경도로 되돌린다. 반환값은 GeoJSON [lon, lat] 배열.
function laneRectCornersForSegment(a, b, halfWidthMeters) {
    const lon1 = Number(a[0]);
    const lat1 = Number(a[1]);
    const lon2 = Number(b[0]);
    const lat2 = Number(b[1]);
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return null;

    const metersPerDegLat = 111320.0;
    const metersPerDegLon = 111320.0 * Math.cos(lat1 * DEG2RAD);
    if (!Number.isFinite(metersPerDegLon) || metersPerDegLon === 0) return null;

    // 세그먼트를 기준점(lat1,lon1) 로컬 평면 미터 좌표로 변환.
    const ax = 0;
    const ay = 0;
    const bx = (lon2 - lon1) * metersPerDegLon;
    const by = (lat2 - lat1) * metersPerDegLat;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) return null;

    // 진행 방향 단위벡터와 그에 수직인 법선벡터.
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    const nx = -dy;
    const ny = dx;
    const h = halfWidthMeters;

    const toLonLat = (x, y) => [lon1 + x / metersPerDegLon, lat1 + y / metersPerDegLat];

    return [
        toLonLat(ax + nx * h, ay + ny * h),
        toLonLat(bx + nx * h, by + ny * h),
        toLonLat(bx - nx * h, by - ny * h),
        toLonLat(ax - nx * h, ay - ny * h)
    ];
}

// 링크 폴리라인들을 세그먼트별 차로폭 사각형 폴리곤 피처로 변환(주어진 config 기준).
function buildLaneWidthFeatures(linkFeatures, config) {
    const out = [];
    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];

    sourceLinks.forEach((feature) => {
        const geometry = feature?.geometry;
        const props = feature?.properties || {};
        if (!geometry) return;
        const { halfWidth, oneLaneWidth, laneCount, extended } = laneWidthForProps(props, config);
        if (!Number.isFinite(halfWidth) || halfWidth <= 0) return;

        const linkId = pickRoadLinkId(props);

        const emitLine = (coords) => {
            if (!Array.isArray(coords)) return;
            for (let i = 0; i < coords.length - 1; i += 1) {
                const corners = laneRectCornersForSegment(coords[i], coords[i + 1], halfWidth);
                if (!corners) continue;
                out.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[...corners, corners[0]]]
                    },
                    properties: {
                        LINK_ID: linkId,
                        LANE: laneCount,
                        ONE_LANE_WIDTH_M: oneLaneWidth,
                        HALF_WIDTH_M: halfWidth,
                        __laneExtended: extended
                    }
                });
            }
        };

        if (geometry.type === 'LineString') {
            emitLine(geometry.coordinates);
        } else if (geometry.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach((line) => emitLine(line));
        }
    });

    return out;
}

// 캐시된 뷰포트 링크로부터 차로폭 레이어들(차로폭/차로폭2)을 다시 채운다(zoom 17+에서만).
function refreshLaneWidthLayer() {
    const belowZoom = map.getZoom() < LANE_WIDTH_MIN_ZOOM;
    const noLinks = !Array.isArray(lastRenderedRoadLinks) || lastRenderedRoadLinks.length === 0;
    laneLayerEntries().forEach(({ name, layer, config }) => {
        if (!layer) return;
        layer.clearLayers();
        if (!activeGroups.has(name) || belowZoom || noLinks) return;
        const features = buildLaneWidthFeatures(lastRenderedRoadLinks, config);
        if (features.length > 0) {
            layer.addData({ type: 'FeatureCollection', features });
        }
    });
}

function queryRoadViewport() {
    if (!roadShapeWorker || !roadShapeLoaded) return;

    const zoom = map.getZoom();
    if (zoom < roadMinZoom) {
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        if (roadLinkVertexGeoLayer) roadLinkVertexGeoLayer.clearLayers();
        if (roadLaneWidthGeoLayer) roadLaneWidthGeoLayer.clearLayers();
        if (roadLaneWidth2GeoLayer) roadLaneWidth2GeoLayer.clearLayers();
        lastRenderedRoadLinks = [];
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
        includeLinks: activeGroups.has(ROAD_LINK_LAYER) || activeGroups.has(ROAD_LINK_VERTEX_LAYER) || activeGroups.has(LANE_WIDTH_LAYER) || activeGroups.has(LANE_WIDTH_LAYER_2),
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
        if (roadLinkVertexGeoLayer) roadLinkVertexGeoLayer.clearLayers();
        if (roadLaneWidthGeoLayer) roadLaneWidthGeoLayer.clearLayers();
        if (roadLaneWidth2GeoLayer) roadLaneWidth2GeoLayer.clearLayers();
        lastRenderedRoadLinks = [];
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

    if (roadLinkVertexGeoLayer) {
        roadLinkVertexGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_LINK_VERTEX_LAYER) && visibleLinks.length > 0) {
            roadLinkVertexGeoLayer.addData({
                type: 'FeatureCollection',
                features: makeRoadLinkVertexFeatures(visibleLinks)
            });
        }
    }

    // 차로폭 박스는 링크 규칙 필터와 무관하게 뷰포트 내 모든 링크 기준으로 그린다.
    lastRenderedRoadLinks = sourceLinks;
    refreshLaneWidthLayer();

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
    if (featureGroups[ROAD_LINK_VERTEX_LAYER]) {
        map.removeLayer(featureGroups[ROAD_LINK_VERTEX_LAYER]);
        delete featureGroups[ROAD_LINK_VERTEX_LAYER];
    }
    if (featureGroups[LANE_WIDTH_LAYER]) {
        map.removeLayer(featureGroups[LANE_WIDTH_LAYER]);
        delete featureGroups[LANE_WIDTH_LAYER];
    }
    if (featureGroups[LANE_WIDTH_LAYER_2]) {
        map.removeLayer(featureGroups[LANE_WIDTH_LAYER_2]);
        delete featureGroups[LANE_WIDTH_LAYER_2];
    }
    delete overlays[ROAD_LINK_LAYER];
    delete overlays[ROAD_NODE_LAYER];
    delete overlays[ROAD_LINK_VERTEX_LAYER];
    delete overlays[LANE_WIDTH_LAYER];
    delete overlays[LANE_WIDTH_LAYER_2];
    delete layerCountOverride[ROAD_LINK_LAYER];
    delete layerCountOverride[ROAD_NODE_LAYER];
    delete layerCountOverride[ROAD_LINK_VERTEX_LAYER];
    delete layerCountOverride[LANE_WIDTH_LAYER];
    delete layerCountOverride[LANE_WIDTH_LAYER_2];
    activeGroups.delete(ROAD_LINK_LAYER);
    activeGroups.delete(ROAD_NODE_LAYER);
    activeGroups.delete(ROAD_LINK_VERTEX_LAYER);
    activeGroups.delete(LANE_WIDTH_LAYER);
    activeGroups.delete(LANE_WIDTH_LAYER_2);
    layerOrder = layerOrder.filter((name) => name !== ROAD_LINK_LAYER && name !== ROAD_NODE_LAYER && name !== ROAD_LINK_VERTEX_LAYER && name !== LANE_WIDTH_LAYER && name !== LANE_WIDTH_LAYER_2);

    roadLinkGeoLayer = null;
    roadNodeGeoLayer = null;
    roadLinkVertexGeoLayer = null;
    roadLaneWidthGeoLayer = null;
    roadLaneWidth2GeoLayer = null;
    lastRenderedRoadLinks = [];
    roadLinkFeatureCount = 0;
    roadNodeFeatureCount = 0;
    roadLinkRenderCount = 0;
    roadNodeRenderCount = 0;
    roadLinkRenderedRuleCounts = {};
    roadNodeRenderedRuleCounts = {};
    selectedRoadFeatureRef = { kind: null, shpIndex: null };
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
        if (roadLinkVertexGeoLayer) roadLinkVertexGeoLayer.clearLayers();
        if (roadLaneWidthGeoLayer) roadLaneWidthGeoLayer.clearLayers();
        if (roadLaneWidth2GeoLayer) roadLaneWidth2GeoLayer.clearLayers();
        lastRenderedRoadLinks = [];
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
    const linkIdCandidate = Number(
        findRoadPropValue(props, 'LINK_ID') ??
        findRoadPropValue(props, 'LINBK_ID') ??
        findRoadPropValue(props, 'LINBKID')
    );
    if (isSelectedRoadFeature('link', props?.__featureRef)) {
        return {
            color: '#ef4444',
            weight: Math.max((Number(resolvedRule.weight) || 2.1) + 2, 4),
            opacity: 1
        };
    }
    if (Number.isFinite(linkIdCandidate) && routeInfoLinkIds.has(linkIdCandidate)) {
        return {
            color: '#f97316',
            weight: Math.max((Number(resolvedRule.weight) || 2.1) + 1.6, 3.6),
            opacity: 0.98
        };
    }
    if (Number.isFinite(linkIdCandidate) && selectedCandidateLinkIds.has(linkIdCandidate)) {
        return {
            color: '#a855f7',
            weight: Math.max((Number(resolvedRule.weight) || 2.1) + 1.8, 3.8),
            opacity: 1
        };
    }
    return {
        color: resolvedRule.color || '#45c976',
        weight: Number(resolvedRule.weight) || 2.1,
        opacity: resolvedRule.isCustom ? 0.96 : 0.92
    };
}

function getRoadNodeStyle(props) {
    if (isSelectedRoadFeature('node', props?.__featureRef)) {
        return {
            radius: Math.max(roadNodeStyleConfig.radius + 2, 5),
            color: '#b91c1c',
            fillColor: '#ef4444',
            fillOpacity: 0.95,
            weight: Math.max(roadNodeStyleConfig.weight + 1.5, 2)
        };
    }
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
            { label: 'LINK_ANGLE', keys: ['LINK_ANGLE'] },
            { label: 'DR_HEADING', keys: ['DR_HEADING'] },
            { label: 'DR_LINK_DIFF', keys: ['DR_LINK_DIFF'] },
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

    if (title === 'Road Link Vertex') {
        return [
            { label: 'LINK_ID', keys: ['LINK_ID', 'LINBK_ID', 'LINBKID'] },
            { label: 'VERTEX_INDEX', keys: ['LINK_VERTEX_INDEX'] },
            { label: 'PART_INDEX', keys: ['LINK_VERTEX_PART'] },
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
            setUploadProgress(100, `Export 완료: ${data.file_name} (Finder 열림)`, false);
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

function handleExportCsv(buttonId = 'exportCsvMenuButton') {
    const exportBtn = document.getElementById(buttonId);
    const issueInput = document.getElementById('issueIdInput');
    const issueId = (issueInput?.value || '').trim();

    if (exportBtn) exportBtn.disabled = true;
    setUploadProgress(100, 'CSV Export 중...', true);

    fetch('/api/export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: issueId })
    })
        .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'CSV Export 실패');
            }
            setUploadProgress(100, `CSV Export 완료: ${data.file_name} (Finder 열림)`, false);
        })
        .catch((err) => {
            setUploadProgress(0, `실패: ${err.message}`, false);
        })
        .finally(() => {
            if (exportBtn) exportBtn.disabled = false;
        });
}

function handleExportCsvFromMenu() {
    handleExportCsv('exportCsvMenuButton');
}

function isInSelectedRange(timestampMs, minVal, maxVal) {
    if (!Number.isFinite(timestampMs)) return false;
    return timestampMs >= minVal && timestampMs <= maxVal;
}

function resetVisualization() {
    markers.forEach(marker => map.removeLayer(marker));
    parkingLotStateMarkers.forEach(marker => map.removeLayer(marker));
    polylines.forEach(polyline => map.removeLayer(polyline));
    highlightLayer.clearLayers();
    clearDistanceVisuals();
    pickedDistancePoints = [];
    resetRadiusSelection(false);

    Object.keys(featureGroups).forEach((key) => {
        if (isRoadShapeLayerName(key)) return;
        map.removeLayer(featureGroups[key]);
        delete featureGroups[key];
    });
    Object.keys(overlays).forEach((key) => {
        if (isRoadShapeLayerName(key)) return;
        delete overlays[key];
    });

    markers = [];
    parkingLotStateMarkers = [];
    polylines = [];
    requestGroups = {};
    cullTotalCounts = {};
    lastCullState = null;
    Object.keys(layerCountOverride).forEach((key) => {
        if (isRoadShapeLayerName(key)) return;
        delete layerCountOverride[key];
    });
    selectedCandidateLinkIds = new Set();
    activeGroups = new Set([...activeGroups].filter((name) => isRoadShapeLayerName(name)));
    layerOrder = layerOrder.filter((name) => isRoadShapeLayerName(name));
    resultTreeExpanded = true;
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

    // Markers are created detached (viewport culling attaches them later),
    // so batches are pure JS work: large batches are safe. Hidden tabs have
    // no frame budget at all, so process even bigger chunks there.
    const BATCH_SIZE = (typeof document !== 'undefined' && document.hidden) ? 20000 : 2000;
    let processedCount = 0;
    const totalCount = coordinates.length;

    function processBatch(startIndex) {
        const endIndex = Math.min(startIndex + BATCH_SIZE, totalCount);

        for (let i = startIndex; i < endIndex; i++) {
            const coord = coordinates[i];
            const coordtype = coord.type;
            // 'Route Info' coords exist only for request-route search; the route
            // itself is drawn as polylines — never as circle markers.
            if (coordtype === 'Route Info') continue;
            const latitude = coord.latitude;
            const longitude = coord.longitude;
            if (latitude === undefined || longitude === undefined) continue;

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
                const isGnssTransitionHighlight = coordtype === 'Filtered GNSS' && !!coord?.extra?.gnss_transition_highlight;
                const useDrHeadingArrow = coordtype === 'DR-based' && drHeadingArrowEnabled;

                // Use color set by backend based on parking state
                let markerColor = coord.color || 'black';

                const marker = useDrHeadingArrow
                    ? L.marker([latitude, longitude], {
                        icon: buildDrHeadingIcon(coord.heading, markerColor)
                    })
                    : L.circleMarker([latitude, longitude], {
                        radius: isGnssTransitionHighlight ? 6 : 3,
                        color: markerColor,
                        weight: isGnssTransitionHighlight ? 3 : 1,
                        fill: coord.fill,
                        fillOpacity: 0.8
                    });

                marker.dlt_id = coord.dlt_id;
                marker.timestamp_ms = coord.timestamp_ms;
                marker.id = coord.id || 0;
                marker.data = coord;
                marker._isIconMarker = useDrHeadingArrow;
                // MM feedback-corrected DR points must never be decimated away
                marker._alwaysShow = coordtype === 'DR-based' && !!coord.extra?.mm_feedback;
                marker._baseStyle = {
                    opacity: 1,
                    fillOpacity: useDrHeadingArrow ? 1 : 0.8,
                    weight: marker.options?.weight ?? 1,
                    radius: useDrHeadingArrow ? null : (marker.options.radius ?? 3)
                };
                attachMarkerDistancePick(marker);
                marker._popupContent = popupText;
                marker.on('click', (e) => {
                    if (inspectMode !== 'marker') {
                        if (inspectMode === 'road') {
                            const latlng = e?.latlng || L.latLng(latitude, longitude);
                            openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                        }
                        if (e) L.DomEvent.stopPropagation(e);
                        return;
                    }
                    if (coordtype === 'DR-based') {
                        selectedDrCoordinate = coord;
                        selectedCandidateLinkIds = extractCandidateLinkIdSet(coord?.extra);
                        refreshDrSelectionStyles(marker);
                        if (roadLinkGeoLayer) {
                            roadLinkGeoLayer.setStyle((feature) => getRoadLinkStyle({
                                ...(feature?.properties || {}),
                                __featureRef: feature
                            }));
                        }
                    }
                    L.popup({ maxWidth: 480 }).setLatLng([latitude, longitude]).setContent(marker._popupContent).openOn(map);
                    if (e) {
                        L.DomEvent.stopPropagation(e);
                    }
                });

                addLayerToGroup(coordtype, marker, { defer: true });
                markers.push(marker);
            }
        }

        processedCount = endIndex;
        if (endIndex < totalCount) {
            scheduleFrame(() => processBatch(endIndex));
        } else {
            drawRequestGroupMarkers(requestGroups, markers);
            refreshDrSelectionStyles();
            addOverlayLayers(featureGroups);
            lastCullState = null;
            scheduleVisibleMarkerRefresh();
            renderLayerControls();
        }
    }

    if (totalCount > 0) {
        processBatch(0);
    } else {
        drawRequestGroupMarkers(requestGroups, markers);
        refreshDrSelectionStyles();
        addOverlayLayers(featureGroups);
        lastCullState = null;
        scheduleVisibleMarkerRefresh();
    }
}

function drawParkingLotStateMarkers(coordsData) {
    console.log('[DEBUG] drawParkingLotStateMarkers called with:', coordsData?.length || 0, 'markers');
    if (!coordsData || coordsData.length === 0) {
        console.log('[DEBUG] No parking lot state markers to render');
        parkingLotStateMarkers = [];
        return;
    }

    const parkingLotLayer = ensureTmapFeatureGroup('Parking Lot State');
    parkingLotLayer.clearLayers();
    parkingLotStateMarkers = [];

    // Markers are created detached (viewport culling attaches them later),
    // so batches are pure JS work: large batches are safe. Hidden tabs have
    // no frame budget at all, so process even bigger chunks there.
    const BATCH_SIZE = (typeof document !== 'undefined' && document.hidden) ? 20000 : 2000;
    let processedCount = 0;
    const totalCount = coordsData.length;

    function processBatch(startIndex) {
        const endIndex = Math.min(startIndex + BATCH_SIZE, totalCount);

        for (let i = startIndex; i < endIndex; i++) {
            const coord = coordsData[i];
            const latitude = coord.latitude;
            const longitude = coord.longitude;
            if (latitude === undefined || longitude === undefined) continue;

            const markerColor = coord.color || '#808080';
            const popupText = makePopupText(coord, 'Parking Lot State');

            const marker = L.circleMarker([latitude, longitude], {
                radius: 3,
                color: markerColor,
                weight: 1,
                fill: true,
                fillOpacity: 0.8,
                bubblingMouseEvents: false
            });

            marker.dlt_id = coord.dlt_id;
            marker.timestamp_ms = coord.timestamp_ms;
            marker.id = coord.id || 0;
            marker.data = coord;
            marker._baseStyle = {
                opacity: 1,
                fillOpacity: 0.8,
                weight: 1,
                radius: 3
            };
            marker._popupContent = popupText;
            marker.on('click', (e) => {
                if (inspectMode !== 'marker') {
                    if (inspectMode === 'road') {
                        const latlng = e?.latlng || L.latLng(latitude, longitude);
                        openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                    }
                    if (e) L.DomEvent.stopPropagation(e);
                    return;
                }
                L.popup().setLatLng([latitude, longitude]).setContent(marker._popupContent).openOn(map);
                if (e) L.DomEvent.stopPropagation(e);
            });

            marker._groupName = 'Parking Lot State';
            marker._culledOnMap = false;
            parkingLotStateMarkers.push(marker);
        }

        processedCount = endIndex;
        if (endIndex < totalCount) {
            scheduleFrame(() => processBatch(endIndex));
        } else {
            layerCountOverride['Parking Lot State'] = parkingLotStateMarkers.length;
            addOverlayLayers(featureGroups);
            lastCullState = null;
            scheduleVisibleMarkerRefresh();
        }
    }

    if (totalCount > 0) {
        processBatch(0);
    } else {
        addOverlayLayers(featureGroups);
    }
}

// Re-order the shared canvas draw list so Parking Lot State markers paint last
// (= on top). Called after each batched render completes; whichever of
// drawMarkers / drawParkingLotStateMarkers finishes last wins, so parking
// markers always end up above DR-based / Road Match markers.
function bringParkingLotMarkersToFront() {
    parkingLotStateMarkers.forEach((marker) => {
        if (marker._map && typeof marker.bringToFront === 'function') {
            marker.bringToFront();
        }
    });
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

        // Same-position requests are merged into one marker; show how many
        // are stacked here so multiple requests from one spot stay visible.
        if (members.length > 1) {
            marker.bindTooltip(`×${members.length}`, {
                permanent: true,
                direction: 'right',
                offset: [10, -18],
                className: 'request-count-badge'
            });
        }

        if (members.length === 1) {
            const coord = members[0];
            marker.dlt_id = coord.dlt_id;
            marker.timestamp_ms = coord.timestamp_ms;
            marker.id = coord.id || 0;
            marker.data = coord;
            marker._popupContent = makePopupText(coord, 'Request');
            marker.on('click', (e) => {
                if (inspectMode !== 'marker') {
                    if (inspectMode === 'road') {
                        const latlng = e?.latlng || L.latLng(latitude, longitude);
                        openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                    }
                    if (e) L.DomEvent.stopPropagation(e);
                    return;
                }
                L.popup().setLatLng([latitude, longitude]).setContent(marker._popupContent).openOn(map);
                if (e) L.DomEvent.stopPropagation(e);
            });
        } else {
            marker.dlt_id = request.dlt_id_list[0];
            marker.timestamp_ms = request.timestamp_ms_list[0];
            marker.id = members[0].id || 0;
            marker.data = members[0];

            const initialContent = `<div style="min-width:100px;">Request (${1}/${members.length})</div>`;
            const popup = L.popup({ autoClose: false, closeOnClick: false }).setContent(initialContent);
            marker.bindPopup(popup);
            marker.on('click', (e) => {
                if (inspectMode !== 'marker') {
                    if (inspectMode === 'road') {
                        const latlng = e?.latlng || L.latLng(latitude, longitude);
                        openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                    }
                    if (e) L.DomEvent.stopPropagation(e);
                    return;
                }
                if (!request.currentIndex) request.currentIndex = 0;
                showRequestGroupPopup(request, marker);
                if (e) {
                    L.DomEvent.stopPropagation(e);
                }
            });
        }
        marker._isIconMarker = true;
        requestGroups[key].marker = marker;
        attachMarkerDistancePick(marker);
        addLayerToGroup('Request', marker, { defer: true });
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

    if (coordtype === "Filtered GNSS") {
        const gnssMode = coordinate.extra?.gnss_mode;
        if (gnssMode) {
            text += `<br>GNSS mode: ${gnssMode}`;
        }
        const transition = coordinate.extra?.gnss_mode_transition;
        if (transition?.from && transition?.to) {
            text += `<br>Mode transition: ${transition.from} -> ${transition.to}`;
        }
    }

    if (coordtype === "DR-based") {
        text += `<br>isDRGps: ${coordinate.extra?.isDRGps ?? ""}`;
        if (coordinate.extra?.mm_feedback_reason) {
            text += `<br><b>MM Feedback:</b> ${coordinate.extra.mm_feedback_reason}`;
        }

        // Add parking lot state information
        if (coordinate.extra?.parking_state) {
            text += `<br><b>주차장 상태:</b> ${coordinate.extra.parking_state}`;
            if (coordinate.extra.parking_state !== 'ParkingLot') {
                text += `<br>후보 링크 개수: ${coordinate.extra.parking_candidate_count || 0}`;
                if (coordinate.extra.parking_best_link_id && coordinate.extra.parking_best_link_id > 0) {
                    text += `<br>최고 매칭 Link ID: ${coordinate.extra.parking_best_link_id}`;
                }
            }
        }

        text += buildCandidateLinkPopupHtml(coordinate?.extra);
    }
    if (coordtype === "Parking Lot State") {
        if (coordinate.extra?.parking_state) {
            text += `<br><b>주차장 상태:</b> ${coordinate.extra.parking_state}`;
            text += `<br>후보 링크 개수: ${coordinate.extra.parking_candidate_count || 0}`;
            if (coordinate.extra.parking_best_link_id && coordinate.extra.parking_best_link_id > 0) {
                text += `<br>최고 매칭 Link ID: ${coordinate.extra.parking_best_link_id}`;
            }
        }

        text += buildCandidateLinkPopupHtml(coordinate?.extra);
    }

    if (coordtype === "Request") {
        text += `<br>Content ID: ${coordinate.extra?.group_1 ?? "-"}`;
        text += `<br>요청 타입: ${coordinate.extra?.group_2_text ?? ""}`;
    }
    if (coordtype === "Route Match" || coordtype === "Road Match") {
        const state = coordinate.extra?.match_state || "";
        if (!(state === "MATCH_OK_GOOD" || state === "MATCH_OK_TRANSIENT")) {
            text += `<br>${state}`;
        }
    }

    return text;
}

function normalizeCandidateLinkEntries(extra) {
    if (!extra || typeof extra !== 'object') return [];
    const direct = extra.candidate_link_scores ?? extra.candidate_links ?? extra.candidateLinkScores;
    if (Array.isArray(direct)) return direct;
    if (typeof direct === 'string') {
        try {
            const parsed = JSON.parse(direct);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function extractCandidateLinkIdSet(extra) {
    const entries = normalizeCandidateLinkEntries(extra);
    const nextIds = new Set();
    entries.forEach((entry) => {
        const raw = pickCandidateField(entry, ['link_id', 'linkId', 'rid', 'RID', 'candidate_link_id']);
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
            nextIds.add(parsed);
        }
    });
    return nextIds;
}


function pickCandidateField(entry, keys) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(keys)) return '';
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
            return entry[key];
        }
    }
    return '';
}

function formatCandidateCell(value) {
    if (value === undefined || value === null || value === '') return '-';
    const num = Number(value);
    if (Number.isFinite(num)) {
        return Math.abs(num) >= 1000 ? String(num) : num.toFixed(3).replace(/\.?0+$/, '');
    }
    return escapeHtml(value);
}

// anglePenalty처럼 기본점수에서 "빼지는" 항을 음수로 표시한다(Base = distancePenalty - anglePenalty + laneBonus).
function formatSubtractedCandidateCell(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return formatCandidateCell(value);
    return `-${formatCandidateCell(Math.abs(num))}`;
}

// 로그의 "Candidate Link[...] ... | Base: base = distancePenalty - anglePenalty + laneBonus | Adj: adjustment |
// Dist(... laneW: laneWeight fB: facilityBonus) | ..." 형식에서, 기본점수(base)에 곱해지는 항(laneWeight)과
// 더해지는 항(distancePenalty/laneBonus/facilityBonus/adjustment, anglePenalty는 빼지는 항)을 분리해서 보여준다.
function buildCandidateLinkPopupHtml(extra) {
    const entries = normalizeCandidateLinkEntries(extra).slice(0, 12);
    if (entries.length === 0) return '';

    const rows = entries.map((entry, index) => {
        const linkId = pickCandidateField(entry, ['link_id', 'linkId', 'rid', 'RID', 'candidate_link_id']);
        const base = pickCandidateField(entry, ['base', 'baseScore', 'base_score']);
        const total = pickCandidateField(entry, ['total', 'totalScore', 'score']);
        const laneWeight = pickCandidateField(entry, ['laneWeight', 'lane_weight']);
        const distancePenalty = pickCandidateField(entry, ['distancePenalty', 'distance_penalty']);
        const anglePenalty = pickCandidateField(entry, ['anglePenalty', 'angle_penalty']);
        const laneBonus = pickCandidateField(entry, ['laneBonus', 'lane_bonus']);
        const facilityBonus = pickCandidateField(entry, ['facilityBonus', 'facility_bonus']);
        const adjustment = pickCandidateField(entry, ['adjustment']);
        return `
            <tr>
                <td>${index + 1}</td>
                <td>${formatCandidateCell(linkId)}</td>
                <td>${formatCandidateCell(base)}</td>
                <td class="weight-cell-mul">${formatCandidateCell(laneWeight)}</td>
                <td class="weight-cell-add">${formatCandidateCell(distancePenalty)}</td>
                <td class="weight-cell-add">${formatSubtractedCandidateCell(anglePenalty)}</td>
                <td class="weight-cell-add">${formatCandidateCell(laneBonus)}</td>
                <td class="weight-cell-add">${formatCandidateCell(facilityBonus)}</td>
                <td class="weight-cell-add">${formatCandidateCell(adjustment)}</td>
                <td>${formatCandidateCell(total)}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="road-popup-subtitle" style="margin-top:8px;">후보 링크 정보</div>
        <div class="road-popup-summary">
            <div class="candidate-weight-table-scroll">
                <table class="road-popup-table candidate-weight-table">
                    <thead>
                        <tr>
                            <th rowspan="2">#</th>
                            <th rowspan="2">Link ID</th>
                            <th rowspan="2">기본점수</th>
                            <th class="weight-group-mul">곱해진 가중치</th>
                            <th colspan="5" class="weight-group-add">더해진 가중치</th>
                            <th rowspan="2">총점</th>
                        </tr>
                        <tr>
                            <th class="weight-group-mul">차선가중치</th>
                            <th class="weight-group-add">거리보정</th>
                            <th class="weight-group-add">각도페널티</th>
                            <th class="weight-group-add">차선보너스</th>
                            <th class="weight-group-add">시설보너스</th>
                            <th class="weight-group-add">조정값</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function getMarkerTableCoreColumns() {
    return [
        { key: 'type', label: '분류' },
        { key: 'id', label: 'ID' },
        { key: 'dlt_id', label: 'DLT ID' },
        { key: 'timestamp_str', label: '시간' },
        { key: 'latitude', label: 'Lat' },
        { key: 'longitude', label: 'Lon' },
        { key: 'heading', label: 'Heading' },
        { key: 'color', label: 'Color' }
    ];
}

function getMarkerTableRows() {
    const rows = Array.isArray(markersData) ? markersData.slice() : [];
    rows.sort((a, b) => {
        const idA = Number.isFinite(a?.id) ? a.id : Number.MAX_SAFE_INTEGER;
        const idB = Number.isFinite(b?.id) ? b.id : Number.MAX_SAFE_INTEGER;
        if (idA !== idB) return idA - idB;
        return String(a?.timestamp_str || '').localeCompare(String(b?.timestamp_str || ''));
    });
    return rows;
}

function getMarkerTableFilteredRows() {
    const searchText = String(document.getElementById('markerTableSearchInput')?.value || '').trim().toLowerCase();
    return getMarkerTableRows().filter((row) => {
        if (markerTableSelectedType !== 'all' && row?.type !== markerTableSelectedType) {
            return false;
        }
        if (!searchText) return true;
        const extraValues = Object.values(row?.extra || {}).map((value) => String(value ?? ''));
        const corpus = [
            row?.type, row?.id, row?.dlt_id, row?.timestamp_str, row?.latitude, row?.longitude, row?.heading,
            ...extraValues
        ].map((value) => String(value ?? '').toLowerCase()).join(' | ');
        return corpus.includes(searchText);
    });
}

function getMarkerTableColumns(rows) {
    const baseColumns = getMarkerTableCoreColumns();
    const extraKeys = [];
    const seen = new Set();
    rows.forEach((row) => {
        Object.keys(row?.extra || {}).forEach((key) => {
            if (seen.has(key)) return;
            seen.add(key);
            extraKeys.push(key);
        });
    });
    extraKeys.sort((a, b) => a.localeCompare(b));
    return baseColumns.concat(extraKeys.map((key) => ({ key: `extra.${key}`, label: key })));
}

function formatMarkerTableCellValue(row, columnKey) {
    let value;
    if (columnKey.startsWith('extra.')) {
        value = row?.extra?.[columnKey.slice(6)];
    } else {
        value = row?.[columnKey];
    }
    if (value === null || value === undefined || value === '') return '-';
    if (typeof value === 'number') {
        if (columnKey === 'latitude' || columnKey === 'longitude') return value.toFixed(6);
        if (columnKey === 'heading') return value.toFixed(2);
        return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function updateMarkerTableTypeOptions(rows) {
    const select = document.getElementById('markerTableTypeSelect');
    if (!select) return;
    const counts = new Map();
    rows.forEach((row) => {
        const type = String(row?.type || 'Unknown');
        counts.set(type, (counts.get(type) || 0) + 1);
    });
    const sortedTypes = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));
    const options = [{ value: 'all', label: `전체 (${rows.length})` }]
        .concat(sortedTypes.map((type) => ({ value: type, label: `${type} (${counts.get(type)})` })));

    const previous = markerTableSelectedType;
    select.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('');
    markerTableSelectedType = options.some((option) => option.value === previous) ? previous : 'all';
    select.value = markerTableSelectedType;
}

function focusMarkerFromTableRow(row) {
    if (!row) return;
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.setView([lat, lon], Math.max(map.getZoom(), 18), { animate: true });
    const marker = markers.find((candidate) => candidate?.data?.type === row.type && candidate?.data?.id === row.id);
    if (marker && typeof marker.openPopup === 'function') {
        marker.openPopup();
    }
    highlightLayer.clearLayers();
    L.circleMarker([lat, lon], {
        radius: 9,
        color: '#2563eb',
        weight: 2,
        fillColor: '#60a5fa',
        fillOpacity: 0.25,
        interactive: false
    }).addTo(highlightLayer);
}

// Rendering every row of a large log creates a huge DOM (tens of thousands
// of <tr>) that slows down ALL browser painting — including map zoom/pan.
// Cap the rendered rows; search/type filters narrow into the cap.
const MARKER_TABLE_MAX_RENDER_ROWS = 1000;
let markerTableRenderedRows = [];

function renderMarkerTable() {
    const summary = document.getElementById('markerTableSummary');
    const head = document.getElementById('markerTableHead');
    const body = document.getElementById('markerTableBody');
    if (!summary || !head || !body) return;

    const allRows = getMarkerTableRows();
    updateMarkerTableTypeOptions(allRows);
    const rows = getMarkerTableFilteredRows();
    const columns = getMarkerTableColumns(rows.length > 0 ? rows : allRows);

    const truncated = rows.length > MARKER_TABLE_MAX_RENDER_ROWS;
    const visibleRows = truncated ? rows.slice(0, MARKER_TABLE_MAX_RENDER_ROWS) : rows;
    markerTableRenderedRows = visibleRows;

    summary.textContent = rows.length > 0
        ? `${markerTableSelectedType === 'all' ? '전체' : markerTableSelectedType} ${rows.length.toLocaleString()}건` +
          (truncated ? ` (상위 ${MARKER_TABLE_MAX_RENDER_ROWS.toLocaleString()}건만 표시 — 검색/타입으로 좁혀보세요)` : '')
        : '표시할 데이터 없음';

    head.innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr>`;

    if (rows.length === 0) {
        body.innerHTML = `<tr class="marker-table-empty"><td colspan="${columns.length}">조건에 맞는 마커가 없습니다.</td></tr>`;
        return;
    }

    body.innerHTML = visibleRows.map((row, index) => `
        <tr data-row-index="${index}">
            ${columns.map((column) => `<td>${escapeHtml(formatMarkerTableCellValue(row, column.key))}</td>`).join('')}
        </tr>
    `).join('');

    // One delegated listener instead of a listener per row
    if (!body._delegatedClickBound) {
        body._delegatedClickBound = true;
        body.addEventListener('click', (e) => {
            const tr = e.target?.closest?.('tr[data-row-index]');
            if (!tr) return;
            const row = markerTableRenderedRows[Number(tr.dataset.rowIndex)];
            if (row) focusMarkerFromTableRow(row);
        });
    }
}

function buildDrHeadingIcon(heading, color = '#ef4444') {
    const degrees = Number.isFinite(Number(heading)) ? Number(heading) : 0;
    return L.divIcon({
        className: 'dr-heading-icon-wrapper',
        html:
            `<div class="dr-heading-icon" style="transform: rotate(${degrees}deg);">` +
            `<span class="dr-heading-arrow" style="border-bottom-color: ${color};"></span>` +
            `</div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
        popupAnchor: [0, -8]
    });
}

function isSelectedDrCoordinate(coord) {
    if (!coord || !selectedDrCoordinate) return false;
    const selectedId = Number(selectedDrCoordinate.id);
    const coordId = Number(coord.id);
    if (Number.isFinite(selectedId) && Number.isFinite(coordId)) {
        return selectedId === coordId;
    }
    return coord === selectedDrCoordinate;
}

// 마커 하나에만 선택/비선택 스타일을 적용한다(heading 아이콘 모드는 setIcon으로 DOM을 새로 만듦).
function applyDrMarkerSelectionStyle(marker, selected) {
    const coord = marker?.data;
    if (!coord) return;
    if (marker._isIconMarker) {
        marker.setIcon(buildDrHeadingIcon(
            coord.heading,
            selected ? '#2563eb' : (coord.color || '#ef4444')
        ));
        if (typeof marker.setZIndexOffset === 'function') {
            marker.setZIndexOffset(selected ? 1200 : 0);
        }
        return;
    }
    if (typeof marker.setStyle === 'function') {
        marker.setStyle({
            color: selected ? '#2563eb' : (coord.color || 'black'),
            fillColor: selected ? '#60a5fa' : (coord.color || 'black'),
            weight: selected ? 3 : 1
        });
        if (typeof marker.setRadius === 'function') {
            marker.setRadius(selected ? 6 : (marker._baseStyle?.radius ?? 3));
        }
    }
}

// clickedMarker를 넘기면 그 마커와 이전 선택 마커 딱 2개만 갱신한다(O(1)).
// 인자 없이 부르면(전체 다시 그린 직후) 현재 selectedDrCoordinate와 일치하는 마커 하나만 찾아 복원한다.
// heading 아이콘 모드에서 markers.forEach로 전체를 setIcon하면 DR 마커 수만큼 DOM을 통째로
// 새로 만들어 클릭 이벤트 처리 중에 클릭된 마커 자신의 DOM까지 교체되어 팝업이 열리지 않는 문제가 있었다.
function refreshDrSelectionStyles(clickedMarker) {
    if (clickedMarker) {
        if (lastSelectedDrMarker && lastSelectedDrMarker !== clickedMarker) {
            applyDrMarkerSelectionStyle(lastSelectedDrMarker, false);
        }
        applyDrMarkerSelectionStyle(clickedMarker, true);
        lastSelectedDrMarker = clickedMarker;
        return;
    }

    lastSelectedDrMarker = null;
    if (!selectedDrCoordinate) return;
    const match = markers.find((marker) => marker?.data?.type === 'DR-based' && isSelectedDrCoordinate(marker.data));
    if (match) {
        applyDrMarkerSelectionStyle(match, true);
        lastSelectedDrMarker = match;
    }
}

function drawPolylines(lines) {
    polylines = [];
    clearRouteInfoSelection();
    refreshRouteInfoLinkIds(lines);
    renderRouteInfoMarkers(lines);
    lines.forEach(line => {
        const { type, extra } = line;

        let color = "gray";
        if (type === "Deviation") color = "red";
        else if (type === "DR Correction") color = "orange";
        else if (type === "DR to VPM") color = "#9ca3af";
        else if (type === "Route Info") color = "#f97316";

        const baseStyle = type === "Route Info"
            ? getRouteInfoLineStyle(line)
            : {
                color: color,
                weight: (type === "DR Correction") ? 3 : 1,
                dashArray: null,
                opacity: type === "DR to VPM" ? 0.7 : 0.8
            };
        const polyline = L.polyline([line.start, line.end], baseStyle);

        polyline.id = line.id || 0;
        polyline.timestamp_ms = line.timestamp_ms;
        polyline.lineData = line;
        polyline._baseStyle = {
            opacity: polyline.options.opacity ?? 0.8,
            weight: polyline.options.weight ?? 1
        };

        polyline.on('click', (e) => {
            highlightEndpoints(line.start, line.end, color);
            if (type === "Route Info") {
                selectRouteInfoLine(line, lines);
            }

            if (type === "Deviation") {
                openDeviationPopup(polyline, line);
            }
            else if (type === "DR Correction" && extra) {
                let popupContent = `<strong>[DR Correction]</strong><br>`;
                if (extra.reason) popupContent += `reason: ${extra.reason}`;
                L.popup().setLatLng(e.latlng).setContent(popupContent).openOn(map);
            }
            else if (type === "Route Info" && extra) {
                const routeAngle = computeSegmentHeadingDegrees(line.start, line.end);
                const popupRows = [
                    `session: ${extra.route_session_name ?? 'Route Info'}`,
                    `order: ${extra.route_sequence ?? '-'}`,
                    `LINK_ID: ${extra.link_id ?? '-'}`,
                    `dir: ${extra.dir ?? '-'}`,
                    `linkType: ${extra.link_type ?? '-'}`,
                    `vertexSize: ${extra.vertex_size ?? '-'}`,
                    `linkAngle: ${Number.isFinite(routeAngle) ? `${routeAngle.toFixed(2)}°` : '-'}`,
                    `v[st]: ${Number(line.start[0]).toFixed(7)}, ${Number(line.start[1]).toFixed(7)}`,
                    `v[en]: ${Number(line.end[0]).toFixed(7)}, ${Number(line.end[1]).toFixed(7)}`,
                ];
                if (Number.isFinite(selectedDrCoordinate?.heading)) {
                    popupRows.push(`DR heading: ${Number(selectedDrCoordinate.heading).toFixed(2)}°`);
                    const diff = computeHeadingDeltaDegrees(selectedDrCoordinate.heading, routeAngle);
                    if (Number.isFinite(diff)) popupRows.push(`DR-link diff: ${diff.toFixed(2)}°`);
                }
                const nextLine = getNextRouteInfoLine(line, lines);
                if (nextLine?.extra?.link_id !== undefined) popupRows.push(`next LINK_ID: ${nextLine.extra.link_id}`);
                if (extra.link_str_code !== undefined) popupRows.push(`strCode: ${extra.link_str_code}`);
                if (extra.road_length !== undefined) popupRows.push(`roadLength: ${extra.road_length}`);

                const popupContent =
                    `<strong>[Route Info]</strong><br>` +
                    popupRows.join('<br>');
                L.popup().setLatLng(e.latlng).setContent(popupContent).openOn(map);
            }
            L.DomEvent.stopPropagation(e);
        });

        const layerName = type === 'Route Info' ? getRouteInfoLayerName(line) : type;
        addLayerToGroup(layerName, polyline, { defer: true });
        polylines.push(polyline);
    });
    addOverlayLayers(featureGroups);
    lastCullState = null;
    scheduleVisibleMarkerRefresh();
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

function addLayerToGroup(type, layer, options = {}) {
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
    layer._groupName = type;

    if (options.defer) {
        // Viewport culling manages the actual attach/detach; only register
        // the group membership metadata and the display count here.
        layer._culledOnMap = false;
        cullTotalCounts[type] = (cullTotalCounts[type] || 0) + 1;
        layerCountOverride[type] = cullTotalCounts[type];
        return;
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
    if (name.startsWith(ROUTE_INFO_MARKER_LAYER_PREFIX)) return 15;
    if (name.startsWith(ROUTE_INFO_LAYER_PREFIX)) return 14;
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
        'Lane Width': 11.5,
        'Road Link': 12,
        'Road Node': 13,
        'Route Info': 14,
        'Route Info Markers': 15,
        'Tmap Waypoints': 16,
        'Tmap Route': 17
    };
    return order[name] ?? 999;
}

function openLayerContextMenu(layerName, anchorEl) {
    const menu = document.getElementById('layerContextMenu');
    if (!menu) return;

    const isLink = layerName === ROAD_LINK_LAYER;
    const isPointLayer = layerName === ROAD_NODE_LAYER || layerName === ROAD_LINK_VERTEX_LAYER;
    roadStyleContextLayerName = isPointLayer ? layerName : ROAD_NODE_LAYER;

    const title = document.getElementById('layerCtxTitle');
    if (title) title.textContent = `${layerName} 스타일`;

    const linkSec = document.getElementById('layerCtxLinkSection');
    const nodeSec = document.getElementById('layerCtxNodeSection');
    if (linkSec) linkSec.style.display = isLink ? '' : 'none';
    if (nodeSec) nodeSec.style.display = isPointLayer ? '' : 'none';
    const nodeSubtitle = nodeSec?.querySelector('.layer-ctx-subtitle');
    if (nodeSubtitle) {
        nodeSubtitle.textContent = layerName === ROAD_LINK_VERTEX_LAYER ? 'Vertex 스타일' : '노드 스타일';
    }
    const applyBtn = document.getElementById('applyNodeStyleButton');
    if (applyBtn) {
        applyBtn.textContent = layerName === ROAD_LINK_VERTEX_LAYER ? 'Vertex 스타일 적용' : '노드 스타일 적용';
    }
    const styleSource = layerName === ROAD_LINK_VERTEX_LAYER ? roadVertexStyleConfig : roadNodeStyleConfig;
    const nodeColorInput = document.getElementById('nodeColorInput');
    const nodeStrokeInput = document.getElementById('nodeStrokeInput');
    const nodeRadiusInput = document.getElementById('nodeRadiusInput');
    const nodeWeightInput = document.getElementById('nodeWeightInput');
    if (nodeColorInput) nodeColorInput.value = styleSource.color;
    if (nodeStrokeInput) nodeStrokeInput.value = styleSource.stroke;
    if (nodeRadiusInput) nodeRadiusInput.value = String(styleSource.radius);
    if (nodeWeightInput) nodeWeightInput.value = String(styleSource.weight);

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

function clampLaneWidthValue(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.min(Math.max(num, 0.1), 50);
}

function clampLaneOpacityValue(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(Math.max(num, 0), 1);
}

function closeLayerContextMenu() {
    const menu = document.getElementById('layerContextMenu');
    if (menu) menu.classList.add('hidden');
}

// 레이어 스타일 팝업(#layerContextMenu)을 제목 표시줄(#layerCtxTitle)로 드래그해서 옮길 수 있게 한다.
// 패널은 position:fixed이므로 getBoundingClientRect()의 뷰포트 좌표가 곧 left/top 값과 같다.
function initLayerContextMenuDrag() {
    const menu = document.getElementById('layerContextMenu');
    const handle = document.getElementById('layerCtxTitle');
    if (!menu || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onMouseMove = (e) => {
        if (!dragging) return;
        const nextLeft = startLeft + (e.clientX - startX);
        const nextTop = startTop + (e.clientY - startY);
        const maxLeft = Math.max(4, window.innerWidth - menu.offsetWidth - 4);
        const maxTop = Math.max(4, window.innerHeight - menu.offsetHeight - 4);
        menu.style.left = `${Math.min(Math.max(nextLeft, 4), maxLeft)}px`;
        menu.style.top = `${Math.min(Math.max(nextTop, 4), maxTop)}px`;
    };

    const onMouseUp = () => {
        dragging = false;
    };

    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        const rect = menu.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function isRoadShapeLayerName(name) {
    return name === ROAD_LINK_LAYER || name === ROAD_NODE_LAYER || name === ROAD_LINK_VERTEX_LAYER || name === LANE_WIDTH_LAYER || name === LANE_WIDTH_LAYER_2;
}

function appendLayerRows(childWrap, groups) {
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

                // Road Node를 키면 Vertex 이전 상태 복원
                if (name === ROAD_NODE_LAYER && vertexWasActiveBeforeNodeDisabled) {
                    const vertexGroup = featureGroups[ROAD_LINK_VERTEX_LAYER];
                    if (vertexGroup && !map.hasLayer(vertexGroup)) {
                        map.addLayer(vertexGroup);
                        activeGroups.add(ROAD_LINK_VERTEX_LAYER);
                    }
                }
            } else {
                if (map.hasLayer(group)) map.removeLayer(group);
                activeGroups.delete(name);

                // Road Node를 끄면 Vertex 상태 기억 후 함께 끔 (UI 일관성)
                if (name === ROAD_NODE_LAYER) {
                    vertexWasActiveBeforeNodeDisabled = activeGroups.has(ROAD_LINK_VERTEX_LAYER);
                    const vertexGroup = featureGroups[ROAD_LINK_VERTEX_LAYER];
                    if (vertexGroup && map.hasLayer(vertexGroup)) {
                        map.removeLayer(vertexGroup);
                        activeGroups.delete(ROAD_LINK_VERTEX_LAYER);
                    }
                }
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

        if (isRoadShapeLayerName(name)) {
            // 차로폭 레이어는 링크 스타일 메뉴(차로폭 에디터 포함)를 연다.
            const menuTarget = name === LANE_WIDTH_LAYER ? ROAD_LINK_LAYER : name;
            const ctxBtn = document.createElement('button');
            ctxBtn.type = 'button';
            ctxBtn.className = 'layer-ctx-trigger';
            ctxBtn.title = '스타일 설정';
            ctxBtn.innerHTML = '<i class="fa fa-paint-brush"></i>';
            ctxBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openLayerContextMenu(menuTarget, ctxBtn);
            });
            row.appendChild(ctxBtn);

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                openLayerContextMenu(menuTarget, row);
            });
        }

        childWrap.appendChild(row);
        if (name !== ROAD_LINK_VERTEX_LAYER) {
            appendRoadRuleControls(childWrap, name);
        }
    });
}

function createLayerTreeCard(rootLabelText, groups, expanded = true, visibilityGroups = null) {
    const effectiveVisibilityGroups = Array.isArray(visibilityGroups) ? visibilityGroups : groups;
    const visibleCount = effectiveVisibilityGroups.filter((name) => activeGroups.has(name)).length;
    const tree = document.createElement('div');
    tree.className = 'layer-tree-card';

    const rootRow = document.createElement('div');
    rootRow.className = 'layer-root-row';

    const rootToggleBtn = document.createElement('button');
    rootToggleBtn.type = 'button';
    rootToggleBtn.className = 'layer-tree-toggle';
    rootToggleBtn.textContent = expanded ? '▾' : '▸';
    rootToggleBtn.onclick = () => {
        if (rootLabelText === 'Road Shape') {
            roadTreeExpanded = !roadTreeExpanded;
        } else {
            resultTreeExpanded = !resultTreeExpanded;
        }
        renderLayerControls();
    };
    rootRow.appendChild(rootToggleBtn);

    const rootCheckbox = document.createElement('input');
    rootCheckbox.type = 'checkbox';
    rootCheckbox.className = 'layer-control-check';
    rootCheckbox.checked = effectiveVisibilityGroups.length > 0 && visibleCount === effectiveVisibilityGroups.length;
    rootCheckbox.indeterminate = visibleCount > 0 && visibleCount < effectiveVisibilityGroups.length;
    rootCheckbox.onchange = () => {
        const enable = rootCheckbox.checked;
        effectiveVisibilityGroups.forEach((layerName) => {
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
    rootLabel.textContent = rootLabelText;
    rootRow.appendChild(rootLabel);
    tree.appendChild(rootRow);

    const childWrap = document.createElement('div');
    childWrap.className = 'layer-children';
    if (!expanded) childWrap.style.display = 'none';
    appendLayerRows(childWrap, groups);
    tree.appendChild(childWrap);
    return tree;
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

    const resultGroups = layerOrder.filter((name) => !isRoadShapeLayerName(name));
    // Lane Width는 최상위 행이 아니라 Road Link 하위 체크박스로 노출한다(Vertex와 동일한 패턴).
    const roadGroups = layerOrder.filter((name) => isRoadShapeLayerName(name) && name !== ROAD_LINK_VERTEX_LAYER && name !== LANE_WIDTH_LAYER && name !== LANE_WIDTH_LAYER_2);
    const roadShapeVisibilityGroups = layerOrder.filter((name) => isRoadShapeLayerName(name));

    if (resultGroups.length > 0) {
        list.appendChild(createLayerTreeCard(`result_${currentResultName}`, resultGroups, resultTreeExpanded));
    }
    if (roadGroups.length > 0) {
        const tree = createLayerTreeCard('Road Shape', roadGroups, roadTreeExpanded, roadShapeVisibilityGroups);
        list.appendChild(tree);
    }
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
                label: rule.customName || `커스텀 ${rule.propKey}=${rule.rawValue}`,
                color: rule.color || '#8b5cf6',
                count: Number(roadLinkRenderedRuleCounts?.[customKey] || 0)
            };
        }).filter((rule) => !!rule.key);
        rules = baseRules.concat(customRules);
    } else {
        const vertexCount = Number.isFinite(layerCountOverride[ROAD_LINK_VERTEX_LAYER])
            ? layerCountOverride[ROAD_LINK_VERTEX_LAYER]
            : (featureGroups[ROAD_LINK_VERTEX_LAYER]?.getLayers?.().length || 0);
        const roadNodeEnabled = activeGroups.has(ROAD_NODE_LAYER);
        rules = [
            {
                key: '__vertex_layer__',
                label: 'Vertex',
                color: getLayerSwatchColor(ROAD_LINK_VERTEX_LAYER),
                count: vertexCount,
                layerName: ROAD_LINK_VERTEX_LAYER,
                disabled: !roadNodeEnabled  // Road Node가 꺼져 있으면 Vertex도 비활성화
            },
            ...ROAD_NODE_RULES.map((rule) => ({
                key: rule.key,
                label: rule.label,
                color: rule.color,
                count: Number(roadNodeRenderedRuleCounts?.[rule.key] || 0),
                layerName: ROAD_NODE_LAYER
            }))
        ];
    }

    const ruleWrap = document.createElement('div');
    ruleWrap.className = 'layer-rule-list';

    rules.forEach((rule) => {
        const item = document.createElement('label');
        item.className = 'layer-rule-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'layer-control-check';
        checkbox.checked = rule.layerName === ROAD_LINK_VERTEX_LAYER
            ? activeGroups.has(ROAD_LINK_VERTEX_LAYER)
            : enabledMap[rule.key] !== false;
        checkbox.disabled = rule.disabled === true;
        checkbox.title = rule.disabled ? 'Road Node를 활성화하면 사용 가능' : '';
        checkbox.onchange = () => {
            if (rule.layerName === ROAD_LINK_VERTEX_LAYER) {
                const group = featureGroups[ROAD_LINK_VERTEX_LAYER];
                if (checkbox.checked) {
                    if (group && !map.hasLayer(group)) map.addLayer(group);
                    activeGroups.add(ROAD_LINK_VERTEX_LAYER);
                } else {
                    if (group && map.hasLayer(group)) map.removeLayer(group);
                    activeGroups.delete(ROAD_LINK_VERTEX_LAYER);
                }
            } else {
                enabledMap[rule.key] = checkbox.checked;
            }
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
            saveRoadLinkIdLabelToStorage();
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

        // 차로폭 / 차로폭2 토글 + 인라인 튜닝 — Road Link 하위에 노출
        [
            { layerKey: LANE_WIDTH_LAYER, config: laneWidthConfig, label: '차로폭 (zoom 17+)' },
            { layerKey: LANE_WIDTH_LAYER_2, config: laneWidthConfig2, label: '차로폭2 (zoom 17+)' }
        ].forEach((spec) => appendLaneWidthControl(ruleWrap, spec));
    }

    parent.appendChild(ruleWrap);
}

// Road Link 하위 차로폭 레이어 토글 + 인라인 튜닝(기본/확장 폭·색) 한 세트를 붙인다.
function appendLaneWidthControl(ruleWrap, spec) {
    const { layerKey, config, label } = spec;

    const laneItem = document.createElement('label');
    laneItem.className = 'layer-rule-item';

    const laneCheckbox = document.createElement('input');
    laneCheckbox.type = 'checkbox';
    laneCheckbox.className = 'layer-control-check';
    laneCheckbox.checked = activeGroups.has(layerKey);
    laneCheckbox.onchange = () => {
        const group = featureGroups[layerKey];
        if (laneCheckbox.checked) {
            if (group && !map.hasLayer(group)) map.addLayer(group);
            activeGroups.add(layerKey);
        } else {
            if (group && map.hasLayer(group)) map.removeLayer(group);
            activeGroups.delete(layerKey);
        }
        if (roadShapeLoaded) {
            scheduleRoadViewportQuery();
        }
        renderLayerControls();
    };
    laneItem.appendChild(laneCheckbox);

    const laneSwatch = document.createElement('span');
    laneSwatch.className = 'layer-rule-swatch';
    laneSwatch.style.background = config.normalColor;
    laneItem.appendChild(laneSwatch);

    const laneText = document.createElement('span');
    laneText.className = 'layer-rule-label';
    laneText.textContent = label;
    laneItem.appendChild(laneText);

    ruleWrap.appendChild(laneItem);
    ruleWrap.appendChild(buildLaneWidthInlineControls(config, laneSwatch));
}

// 차로폭 인라인 튜닝 컨트롤(기본/확장 한 차선 폭·색). laneSwatch는 기본색 반영용.
function buildLaneWidthInlineControls(config, laneSwatch) {
    const wrap = document.createElement('div');
    wrap.className = 'lane-width-inline';

    const makeRow = (labelText, widthKey, colorKey) => {
        const row = document.createElement('div');
        row.className = 'lane-width-inline-row';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'layer-ctx-color';
        colorInput.value = config[colorKey];
        colorInput.title = `${labelText} 색상`;
        colorInput.addEventListener('input', () => {
            config[colorKey] = colorInput.value;
            if (colorKey === 'normalColor' && laneSwatch) laneSwatch.style.background = colorInput.value;
            refreshLaneWidthLayer();
            saveLaneWidthConfigsToStorage();
        });
        row.appendChild(colorInput);

        const name = document.createElement('span');
        name.className = 'lane-width-inline-label';
        name.textContent = labelText;
        row.appendChild(name);

        const widthInput = document.createElement('input');
        widthInput.type = 'number';
        widthInput.min = '0.1';
        widthInput.max = '50';
        widthInput.step = '0.1';
        widthInput.className = 'layer-ctx-weight';
        widthInput.value = String(config[widthKey]);
        widthInput.title = `${labelText} 한 차선 폭 (m)`;
        widthInput.addEventListener('change', () => {
            const next = clampLaneWidthValue(widthInput.value, config[widthKey]);
            config[widthKey] = next;
            widthInput.value = String(next);
            refreshLaneWidthLayer();
            saveLaneWidthConfigsToStorage();
        });
        row.appendChild(widthInput);

        const unit = document.createElement('span');
        unit.className = 'lane-width-inline-unit';
        unit.textContent = 'm';
        row.appendChild(unit);

        return row;
    };

    wrap.appendChild(makeRow('기본', 'normal', 'normalColor'));
    wrap.appendChild(makeRow('확장(roadCate≤1)', 'extended', 'extendedColor'));

    const opacityRow = document.createElement('div');
    opacityRow.className = 'lane-width-inline-row';
    const opacitySpacer = document.createElement('span');
    opacitySpacer.className = 'layer-ctx-color';
    opacitySpacer.style.visibility = 'hidden';
    opacityRow.appendChild(opacitySpacer);
    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'lane-width-inline-label';
    opacityLabel.textContent = '투명도';
    opacityRow.appendChild(opacityLabel);
    const opacityInput = document.createElement('input');
    opacityInput.type = 'number';
    opacityInput.min = '0';
    opacityInput.max = '1';
    opacityInput.step = '0.05';
    opacityInput.className = 'layer-ctx-weight';
    opacityInput.value = String(config.fillOpacity);
    opacityInput.title = '채우기 투명도 (0~1)';
    opacityInput.addEventListener('change', () => {
        const next = clampLaneOpacityValue(opacityInput.value, config.fillOpacity);
        config.fillOpacity = next;
        opacityInput.value = String(next);
        refreshLaneWidthLayer();
        saveLaneWidthConfigsToStorage();
    });
    opacityRow.appendChild(opacityInput);
    wrap.appendChild(opacityRow);

    return wrap;
}

function getLayerSwatchColor(name) {
    if (name.startsWith(ROUTE_INFO_MARKER_LAYER_PREFIX)) {
        return '#16a34a';
    }
    if (name.startsWith(ROUTE_INFO_LAYER_PREFIX)) {
        return '#f97316';
    }
    if (name === ROAD_LINK_LAYER) {
        const style = ensureRoadLinkBaseStyle('default');
        return normalizeRoadColor(style.color, '#45c976');
    }
    if (name === LANE_WIDTH_LAYER) {
        return laneWidthConfig.normalColor;
    }
    if (name === LANE_WIDTH_LAYER_2) {
        return laneWidthConfig2.normalColor;
    }
    const swatches = {
        'Road Link Vertex': '#f8fafc',
        'Raw GNSS': '#a855f7',
        'Filtered GNSS': '#14b8a6',
        'DR-based': '#ef4444',
        'Road Match': '#22d3ee',
        'Route Match': '#84cc16',
        'VPM': '#2563eb',
        'Request': '#f97316',
        'GNSS to DR': '#eab308',
        'DR Correction': '#fb923c',
        'DR to VPM': '#2563eb',
        'Deviation': '#ef4444',
        'Road Node': '#22c3d6',
        'Route Info': '#f97316',
        'Route Info Markers': '#16a34a',
        'Tmap Waypoints': '#f59e0b',
        'Tmap Route': '#ef4444'
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
        const paneName = getRoadPaneName(name);
        if (paneName) {
            const pane = map.getPane(paneName);
            if (pane) {
                const extra =
                    name === ROAD_NODE_LAYER ? 2 :
                    (name === ROAD_LINK_VERTEX_LAYER ? 0 : 0);
                pane.style.zIndex = String(550 + idx + extra);
            }
        }
        const zBase = 1000 + idx * 10;
        group.eachLayer((layer) => {
            if (typeof layer.setZIndexOffset === 'function') {
                layer.setZIndexOffset(zBase);
            }
            if (typeof layer.bringToFront === 'function' && activeGroups.has(name)) {
                layer.bringToFront();
            }
        });
    });
}

// Viewport + time-range culling.
// Instead of hiding markers with opacity 0 (which keeps every layer attached
// to the canvas renderer — every zoom/pan re-projects and redraws all of
// them, and every mousemove hit-tests the full list), only the markers that
// are inside the padded viewport AND the selected time range are attached to
// the map. Everything else is detached entirely, so interaction cost scales
// with what is visible, not with the size of the log.
function scheduleVisibleMarkerRefresh() {
    if (visibleRefreshScheduled) return;
    visibleRefreshScheduled = true;
    scheduleFrame(() => {
        visibleRefreshScheduled = false;
        refreshVisibleMarkers();
    });
}

function refreshVisibleMarkers() {
    let minVal = -Infinity;
    let maxVal = Infinity;
    if (slider.noUiSlider) {
        [minVal, maxVal] = slider.noUiSlider.get().map(Number);
    }
    const view = map.getBounds();
    const zoom = map.getZoom();
    const activeKey = Array.from(activeGroups).sort().join('|');

    // Skip entirely when the last computed attach-set still covers this view:
    // small pans inside the padded viewport with unchanged zoom/time/layers
    // need no work at all.
    if (lastCullState &&
        lastCullState.zoom === zoom &&
        lastCullState.minVal === minVal && lastCullState.maxVal === maxVal &&
        lastCullState.activeKey === activeKey &&
        lastCullState.bounds.contains(view)) {
        return;
    }

    const bounds = view.pad(VIEWPORT_CULL_PAD);
    lastCullState = { zoom, minVal, maxVal, activeKey, bounds };
    const south = bounds.getSouth(), north = bounds.getNorth();
    const west = bounds.getWest(), east = bounds.getEast();

    // Screen-space decimation: below the cutoff zoom, markers that would land
    // in the same ~cellPx pixel cell are indistinguishable — draw only the
    // first one per cell (deterministic by array order, so stable across
    // refreshes). Grid is anchored to world pixels, so panning doesn't
    // reshuffle which markers are shown.
    const decimate = zoom <= MARKER_DECIMATION_MAX_ZOOM;
    const cellPx = MARKER_DECIMATION_CELL_PX;
    // Per-group Sets with packed numeric cell keys (much faster than string keys)
    const claimedByGroup = decimate ? Object.create(null) : null;
    const CELL_PACK = 1 << 26;
    // World-pixel positions are cached once at a reference zoom and rescaled
    // (2^dz) instead of re-projecting every element on every refresh.
    const projScale = Math.pow(2, zoom - CULL_PROJ_ZOOM) / cellPx;

    const setAttached = (layer, group, show) => {
        if (show && !layer._culledOnMap) {
            group.addLayer(layer);
            layer._culledOnMap = true;
        } else if (!show && layer._culledOnMap) {
            group.removeLayer(layer);
            layer._culledOnMap = false;
        }
    };

    const cullPoint = (layer) => {
        const group = featureGroups[layer._groupName];
        if (!group) return;
        let show = activeGroups.has(layer._groupName) &&
            isInSelectedRange(layer.timestamp_ms, minVal, maxVal);
        if (show) {
            if (!layer._cullLatLng && layer.getLatLng) layer._cullLatLng = layer.getLatLng();
            const ll = layer._cullLatLng;
            if (ll) {
                show = ll.lat >= south && ll.lat <= north && ll.lng >= west && ll.lng <= east;
                // MM feedback-corrected DR points are diagnostically important
                // (heading-only=gray / lane-width=black) — never decimate them,
                // otherwise a gray point sharing a pixel cell with a black one
                // gets culled and the feedback looks all-black.
                const skipDecimation = layer._alwaysShow;
                if (show && decimate && !skipDecimation) {
                    if (!layer._cullPx) layer._cullPx = map.project(ll, CULL_PROJ_ZOOM);
                    const key = ((layer._cullPx.x * projScale) | 0) * CELL_PACK + ((layer._cullPx.y * projScale) | 0);
                    let cells = claimedByGroup[layer._groupName];
                    if (!cells) cells = claimedByGroup[layer._groupName] = new Set();
                    if (cells.has(key)) {
                        show = false;
                    } else {
                        cells.add(key);
                    }
                }
            }
        }
        setAttached(layer, group, show);
    };

    const cullLine = (layer) => {
        const group = featureGroups[layer._groupName];
        if (!group) return;
        let show = activeGroups.has(layer._groupName) &&
            isInSelectedRange(layer.timestamp_ms, minVal, maxVal);
        if (show) {
            if (!layer._cullBounds && layer.getLatLngs) layer._cullBounds = L.latLngBounds(layer.getLatLngs());
            show = !layer._cullBounds || bounds.intersects(layer._cullBounds);
            if (show && decimate && layer._cullBounds) {
                // Sub-pixel lines: draw one representative per cell
                if (!layer._cullPx1) {
                    layer._cullPx1 = map.project(layer._cullBounds.getSouthWest(), CULL_PROJ_ZOOM);
                    layer._cullPx2 = map.project(layer._cullBounds.getNorthEast(), CULL_PROJ_ZOOM);
                }
                const x1 = layer._cullPx1.x * projScale, y1 = layer._cullPx1.y * projScale;
                const x2 = layer._cullPx2.x * projScale, y2 = layer._cullPx2.y * projScale;
                if (Math.abs(x1 - x2) < 1 && Math.abs(y1 - y2) < 1) {
                    const key = (((x1 + x2) / 2) | 0) * CELL_PACK + (((y1 + y2) / 2) | 0);
                    const cellGroup = layer._groupName + ':L';
                    let cells = claimedByGroup[cellGroup];
                    if (!cells) cells = claimedByGroup[cellGroup] = new Set();
                    if (cells.has(key)) {
                        show = false;
                    } else {
                        cells.add(key);
                    }
                }
            }
        }
        setAttached(layer, group, show);
    };

    markers.forEach(cullPoint);
    parkingLotStateMarkers.forEach(cullPoint);
    polylines.forEach(cullLine);

    // Keep parking-lot markers painted above other canvas markers
    bringParkingLotMarkersToFront();
}

function updateMap() {
    if (!slider.noUiSlider) return;
    const [minVal, maxVal] = slider.noUiSlider.get().map(Number);
    scheduleVisibleMarkerRefresh();
    handleRoadZoomChanged();
    updateRangeLabel(minVal, maxVal);
}

function applyTimeVisibility(layer, visible) {
    if (!layer) return;

    if (layer._isIconMarker && typeof layer.setOpacity === 'function') {
        if (layer._isVisible !== visible) {
            layer._isVisible = visible;
            layer.setOpacity(visible ? 1 : 0);
        }
        return;
    }

    if (layer._baseStyle && typeof layer.setStyle === 'function') {
        if (layer._isVisible !== visible) {
            layer._isVisible = visible;
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
        }
        return;
    }

    if (typeof layer.setOpacity === 'function') {
        if (layer._isVisible !== visible) {
            layer._isVisible = visible;
            layer.setOpacity(visible ? 1 : 0);
        }
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

    // Keep fine-control inputs in sync (unless the user is typing in them)
    const timeOnly = (d) =>
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
        `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const startInput = document.getElementById('timeStartInput');
    const endInput = document.getElementById('timeEndInput');
    if (startInput && document.activeElement !== startInput) startInput.value = timeOnly(d1);
    if (endInput && document.activeElement !== endInput) endInput.value = timeOnly(d2);
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
                // Do not change zoom/view on result click — just open the popup
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
                // Do not change zoom/view on result click — just open the popup
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

function showInfoMessage(title, message) {
    const infoPanel = document.getElementById('infoPanel');
    if (!infoPanel) return;
    openSidebar(title);
    infoPanel.innerHTML = `<div style="padding:16px; color:#cbd5e1;">${message}</div>`;
}

function highlightLatLon(lat, lon) {
    highlightLayer.clearLayers();
    const latlng = L.latLng(lat, lon);
    L.circleMarker(latlng, {
        radius: 12,
        color: '#ef4444',
        fillColor: '#fde68a',
        fillOpacity: 0.95,
        weight: 3,
        interactive: false
    }).addTo(highlightLayer);
    L.circle(latlng, {
        radius: 8,
        color: '#ef4444',
        opacity: 0.85,
        weight: 2,
        fillOpacity: 0,
        interactive: false
    }).addTo(highlightLayer);
}

function parseLatLonSearchInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const matches = raw.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || matches.length < 2) return null;
    const lat = Number(matches[0]);
    const lon = Number(matches[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
}

function handleLatLonSearch() {
    const input = document.getElementById('latLonSearchBox');
    const parsed = parseLatLonSearchInput(input?.value);
    if (!parsed) {
        showInfoMessage('좌표 검색', '예: 37.5440568, 126.9516774 형식으로 입력하세요.');
        return;
    }

    highlightLatLon(parsed.lat, parsed.lon);
    map.setView([parsed.lat, parsed.lon], Math.max(map.getZoom(), 18));

    const infoPanel = document.getElementById('infoPanel');
    if (!infoPanel) return;
    openSidebar('좌표 검색 결과');
    infoPanel.innerHTML = `
        <div class="info-item marker">
            <div class="info-title">[COORD] 지정 좌표</div>
            <div class="info-detail">
                <div class="info-row"><span class="info-key">Lat</span><span>${parsed.lat.toFixed(7)}</span></div>
                <div class="info-row"><span class="info-key">Lon</span><span>${parsed.lon.toFixed(7)}</span></div>
            </div>
        </div>
    `;
}

function pickRoadLinkId(props) {
    const candidate = findRoadPropValue(props, 'LINK_ID')
        ?? findRoadPropValue(props, 'LINBK_ID')
        ?? findRoadPropValue(props, 'LINBKID')
        ?? findRoadPropValue(props, 'RID')
        ?? findRoadPropValue(props, 'R_ID');
    if (candidate === undefined || candidate === null || candidate === '') return null;
    return String(candidate).trim();
}

function findRenderedRoadLinkByRid(searchValue) {
    if (!roadLinkGeoLayer) return null;
    const normalized = String(searchValue || '').trim().toLowerCase();
    if (!normalized) return null;

    let matched = null;
    roadLinkGeoLayer.eachLayer((layer) => {
        if (matched) return;
        const feature = layer.feature;
        const props = feature?.properties || {};
        const linkId = pickRoadLinkId(props);
        if (!linkId || linkId.toLowerCase() !== normalized) return;
        matched = { layer, feature };
    });
    return matched;
}

function getFeatureBounds(feature) {
    if (!feature?.geometry) return null;
    try {
        return L.geoJSON(feature).getBounds();
    } catch (_) {
        return null;
    }
}

function focusRoadLinkFeature(feature, titlePrefix = 'RID 검색 결과') {
    if (!feature?.geometry) return false;

    const props = feature.properties || {};
    const linkId = pickRoadLinkId(props) || '-';
    const bounds = getFeatureBounds(feature);

    highlightLayer.clearLayers();
    const previewLayer = L.geoJSON(feature);
    previewLayer.eachLayer((layer) => {
        if (typeof layer.getLatLngs === 'function') {
            highlightLine(layer);
        }
    });

    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds.pad(0.35));
    }

    setSelectedRoadFeature('link', feature);
    if (roadLinkGeoLayer) {
        roadLinkGeoLayer.eachLayer((layer) => {
            if (getRoadFeatureIndex(layer.feature) === getRoadFeatureIndex(feature)) {
                layer.openPopup();
            }
        });
    }

    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel) {
        openSidebar(`${titlePrefix}: ${linkId}`);
        infoPanel.innerHTML = `
            <div class="info-item line">
                <div class="info-title">[ROAD LINK] ${escapeHtml(linkId)}</div>
                <div class="info-detail">${makeRoadPopupContent(props, 'Road Link')}</div>
            </div>
        `;
    }
    return true;
}

function requestRoadLinkByRid(searchValue) {
    return new Promise((resolve) => {
        if (!roadShapeWorker) {
            resolve(null);
            return;
        }

        const requestId = ++roadShapeFindRequestSeq;
        roadShapeFindRequests.set(requestId, resolve);
        roadShapeWorker.postMessage({
            type: 'findLinkByRid',
            requestId,
            value: String(searchValue || '').trim(),
            keys: ['RID', 'R_ID', 'LINK_ID', 'LINBK_ID', 'LINBKID']
        });

        setTimeout(() => {
            if (!roadShapeFindRequests.has(requestId)) return;
            roadShapeFindRequests.delete(requestId);
            resolve(null);
        }, 3000);
    });
}

async function handleRidSearch() {
    const input = document.getElementById('ridSearchBox');
    const searchValue = String(input?.value || '').trim();
    if (!searchValue) {
        showInfoMessage('RID 검색', 'RID 또는 LINK_ID 값을 입력하세요.');
        return;
    }

    const visibleMatch = findRenderedRoadLinkByRid(searchValue);
    if (visibleMatch?.feature) {
        focusRoadLinkFeature(visibleMatch.feature, 'RID 검색 결과');
        return;
    }

    const workerMatch = await requestRoadLinkByRid(searchValue);
    if (workerMatch?.feature) {
        focusRoadLinkFeature(workerMatch.feature, 'RID 검색 결과');
        return;
    }

    showInfoMessage('RID 검색 결과', `RID/LINK_ID ${escapeHtml(searchValue)} 에 해당하는 Road Link를 찾지 못했습니다.`);
}

function handleRequestIdSearch() {
    const input = document.getElementById('requestIdSearchBox');
    const searchValue = String(input?.value || '').trim();

    if (!searchValue) {
        showInfoMessage('Request 경로 검색', 'Request ID 또는 Content ID를 입력하세요.');
        return;
    }

    // Find request: Content ID (group_1) match first, then marker ID / DLT ID
    const searchNum = Number(searchValue);
    const requestMarkers = markersData.filter(m => m.type === 'Request');
    const request =
        requestMarkers.find(m => String(m.extra?.group_1 ?? '').trim() === searchValue) ||
        requestMarkers.find(m => m.id === searchNum || m.dlt_id === searchNum);

    if (!request) {
        showInfoMessage('Request 경로 검색', `Content ID/Request ID ${escapeHtml(searchValue)} 에 해당하는 Request를 찾지 못했습니다.`);
        return;
    }

    const allRouteInfos = markersData.filter(m => m.type === 'Route Info');

    // Primary: match by the route session linked to this request during parsing
    const routeSessionId = request.extra?.route_session_id;
    let routeInfos = routeSessionId
        ? allRouteInfos.filter(m => m.extra?.route_session_id === routeSessionId)
        : [];

    // Fallback: if no session was linked (e.g. session-id log line missing),
    // use the first route session parsed AFTER this request's timestamp
    if (routeInfos.length === 0 && Number.isFinite(request.timestamp_ms)) {
        const nextRoute = allRouteInfos
            .filter(m => Number.isFinite(m.timestamp_ms) && m.timestamp_ms >= request.timestamp_ms)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0];
        if (nextRoute) {
            const sessionIndex = nextRoute.extra?.route_session_index;
            routeInfos = allRouteInfos.filter(m => m.extra?.route_session_index === sessionIndex);
        }
    }

    if (routeInfos.length === 0) {
        showInfoMessage(
            'Request 경로 검색',
            `Request는 찾았지만 (Content ID: ${escapeHtml(String(request.extra?.group_1 ?? '-'))}, ` +
            `타입: ${escapeHtml(String(request.extra?.group_2_text ?? '-'))}) ` +
            `연결된 경로(setRouteInformation) 파싱 결과가 없습니다.`
        );
        return;
    }

    // Keep segments in route order
    routeInfos.sort((a, b) => (a.extra?.route_sequence ?? 0) - (b.extra?.route_sequence ?? 0));

    // Clear previous highlights
    highlightLayer.clearLayers();

    // Draw route as polyline
    const routePoints = [];
    for (const route of routeInfos) {
        const startLat = route.extra?.route_start_lat;
        const startLon = route.extra?.route_start_lon;
        const endLat = route.extra?.route_end_lat;
        const endLon = route.extra?.route_end_lon;

        if (startLat !== undefined && startLon !== undefined) {
            routePoints.push([startLat, startLon]);
        }
        if (endLat !== undefined && endLon !== undefined) {
            routePoints.push([endLat, endLon]);
        }
    }

    if (routePoints.length > 0) {
        // Draw route polyline
        L.polyline(routePoints, {
            color: '#10b981',
            weight: 4,
            opacity: 0.8,
            dashArray: '5, 5',
            interactive: false
        }).addTo(highlightLayer);

        // Mark initial location (Request point)
        const requestLat = request.latitude;
        const requestLon = request.longitude;
        L.circleMarker([requestLat, requestLon], {
            radius: 10,
            color: '#3b82f6',
            fillColor: '#60a5fa',
            fillOpacity: 0.9,
            weight: 3,
            interactive: false
        }).addTo(highlightLayer);

        // Add label for initial location
        L.marker([requestLat, requestLon], {
            icon: L.divIcon({
                className: 'route-label',
                html: '<div style="background:#3b82f6;color:white;padding:2px 6px;border-radius:3px;font-size:11px;font-weight:bold;white-space:nowrap;">시작</div>',
                iconSize: [40, 20],
                iconAnchor: [20, 10]
            }),
            interactive: false
        }).addTo(highlightLayer);

        // Mark [출발지, 경유지..., 목적지] from the request's own point set
        const routePointSet = Array.isArray(request.extra?.route_points) ? request.extra.route_points : [];
        const pointSetMarkers = buildRoutePointSetMarkers(request, `Request ${request.extra?.group_1 ?? ''}`);
        pointSetMarkers.forEach((marker) => highlightLayer.addLayer(marker));

        // Fallback destination marker when the request point set is unavailable
        const lastRoute = routeInfos[routeInfos.length - 1];
        if (pointSetMarkers.length === 0) {
            const destLat = lastRoute.extra?.route_end_lat;
            const destLon = lastRoute.extra?.route_end_lon;
            if (destLat !== undefined && destLon !== undefined) {
                L.marker([destLat, destLon], {
                    icon: buildRoutePointIcon('E', '#dc2626', '도착'),
                    interactive: false
                }).addTo(highlightLayer);
            }
        }

        // Fit map bounds to route
        const bounds = L.latLngBounds(routePoints);
        map.fitBounds(bounds, { padding: [50, 50] });

        // Build detailed info message
        const origin = {
            lat: request.latitude.toFixed(6),
            lon: request.longitude.toFixed(6)
        };

        const destination = {
            lat: lastRoute.extra?.route_end_lat?.toFixed(6) || '-',
            lon: lastRoute.extra?.route_end_lon?.toFixed(6) || '-'
        };

        let infoMsg = `<b>Content ID:</b> ${escapeHtml(String(request.extra?.group_1 ?? '-'))}<br>`;
        infoMsg += `<b>요청 타입:</b> ${request.extra?.group_2_text}<br>`;
        infoMsg += `<br><b>초기 위치 (Request Point):</b><br>[${origin.lat}, ${origin.lon}]<br>`;

        if (routePointSet.length > 0) {
            infoMsg += `<br><b>요청 지점 (${routePointSet.length}개):</b><br>`;
            routePointSet.forEach((point) => {
                const latLng = routePointToLatLng(point);
                const coordText = latLng ? `[${latLng[0].toFixed(6)}, ${latLng[1].toFixed(6)}]` : '(좌표 변환 실패)';
                const nameText = point.name ? ` ${escapeHtml(point.name)}` : '';
                const roleText = point.role === '경유지' && Number.isFinite(point.waypoint_index)
                    ? `경유지 ${point.waypoint_index + 1}`
                    : point.role;
                infoMsg += `${roleText}:${nameText} ${coordText}<br>`;
            });
        } else {
            infoMsg += `<br><b>목적지 위치 (경로 마지막 지점):</b><br>[${destination.lat}, ${destination.lon}]<br>`;
        }

        infoMsg += `<br><b>경로 세그먼트:</b> ${routeInfos.length}개<br>`;
        infoMsg += `<br><b>경로 상세:</b><br>`;
        for (let i = 0; i < routeInfos.length; i++) {
            const route = routeInfos[i];
            const startLat = route.extra?.route_start_lat?.toFixed(6) || '-';
            const startLon = route.extra?.route_start_lon?.toFixed(6) || '-';
            const endLat = route.extra?.route_end_lat?.toFixed(6) || '-';
            const endLon = route.extra?.route_end_lon?.toFixed(6) || '-';
            const linkId = route.extra?.link_id || '-';
            infoMsg += `Link ${i + 1}: [${startLat}, ${startLon}] → [${endLat}, ${endLon}] (ID: ${linkId})<br>`;
        }

        showInfoMessage(
            'Request 경로 검색 상세 정보',
            infoMsg
        );
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

// ============================================================================
// C2X Events & Traffic Incident Visualization
// ============================================================================

const EVENT_ICON_MAP = {
    'A': { name: '사고', color: '#ef4444', icon: '🚨' },
    'B': { name: '공사', color: '#f59e0b', icon: '🚧' },
    'C': { name: '행사', color: '#8b5cf6', icon: '🎉' },
    'D': { name: '재해', color: '#dc2626', icon: '⚠️' },
    'E': { name: '통제', color: '#059669', icon: '🛑' },
};

const SDI_TYPE_MAP = {
    0: { name: '신호과속', color: '#ef4444', text: '🚨', desc: '신호 과속 단속카메라' },
    1: { name: '과속 고정식', color: '#f59e0b', text: '📷', desc: '과속 단속카메라(고정식)' },
    2: { name: '구간단속 시작', color: '#ea580c', text: '시', desc: '구간속도 단속 시작' },
    3: { name: '구간단속 끝', color: '#f97316', text: '끝', desc: '구간속도 단속 종료' },
    4: { name: '구간단속중', color: '#fb923c', text: '중', desc: '구간속도 단속 중' },
    5: { name: '꼬리물기단속', color: '#fbbf24', text: '꼬', desc: '꼬리물기 단속카메라' },
    6: { name: '신호단속', color: '#dc2626', text: '🚥', desc: '신호 단속카메라' },
    7: { name: '과속 이동식', color: '#f59e0b', text: '이', desc: '과속 단속카메라(이동식)' },
    8: { name: '박스형 과속', color: '#d946ef', text: '📦', desc: '박스형 과속위험 구간' },
    9: { name: '후면 사고', color: '#be123c', text: '←', desc: '속도 사고 후면' },
    10: { name: '후면 제한', color: '#f43f5e', text: '←', desc: '속도 제한 후면' },
    11: { name: '버스전용차로', color: '#a855f7', text: '🚌', desc: '버스 전용 차로 구간' },
    12: { name: '가변차로', color: '#9333ea', text: '🔄', desc: '가변 차로 단속' },
    13: { name: '갓길감시', color: '#7c3aed', text: '📸', desc: '갓길 감시 지점' },
    14: { name: '끼어들기금지', color: '#6366f1', text: '⛔', desc: '끼어들기 금지 구간' },
    15: { name: '교통정보수집', color: '#06b6d4', text: '📊', desc: '교통정보 수집지점' },
    16: { name: '방범CCTV', color: '#0891b2', text: '🎥', desc: '방범용 CCTV' },
    17: { name: '과적차량', color: '#f59e0b', text: '⚖️', desc: '과적차량 위험구간' },
    18: { name: '적재불량', color: '#ea580c', text: '📦', desc: '적재 불량 단속' },
    19: { name: '주차단속', color: '#8b5cf6', text: '🚗', desc: '주차 단속 지점' },
    20: { name: '일방통행', color: '#7c3aed', text: '→', desc: '일방통행 도로' },
    21: { name: '철도건널목', color: '#dc2626', text: '🚂', desc: '철도 건널목' },
    22: { name: '스쿨존 시작', color: '#ec4899', text: '🏫', desc: '어린이보호구역 시작' },
    23: { name: '스쿨존 끝', color: '#f43f5e', text: '🏫', desc: '어린이보호구역 종료' },
    24: { name: '과속방지턱', color: '#06b6d4', text: '⌣', desc: '과속방지턱' },
    25: { name: 'LPG충전소', color: '#14b8a6', text: '⛽', desc: 'LPG 충전소' },
    26: { name: '터널구간', color: '#0f766e', text: '🚇', desc: '터널 구간' },
    27: { name: '휴게소', color: '#22c55e', text: '🛑', desc: '휴게소' },
    28: { name: '톨게이트', color: '#16a34a', text: '💳', desc: '톨게이트' },
    29: { name: '안개주의', color: '#9ca3af', text: '☁️', desc: '안개주의 지역' },
    30: { name: '유해물질', color: '#6b7280', text: '☣️', desc: '유해물질 지역' },
    31: { name: '사고다발', color: '#ef4444', text: '⚠️', desc: '사고다발 지역' },
    32: { name: '급경사구간', color: '#f59e0b', text: '⬇️', desc: '급경사 구간' },
    33: { name: '급커브지역', color: '#d97706', text: '↪', desc: '급한 커브 지역' },
    34: { name: '신규급커브', color: '#ea580c', text: '↪', desc: '신규 급커브 구간' },
    35: { name: '야생동물', color: '#7c3aed', text: '🦌', desc: '야생동물 교통사고 잦은 구간' },
    36: { name: '우측시야불량', color: '#8b5cf6', text: '👁️', desc: '우측 시야 불량 지점' },
    37: { name: '시야불량', color: '#9333ea', text: '👁️', desc: '시야 불량 지점' },
    38: { name: '좌측시야불량', color: '#a855f7', text: '👁️', desc: '좌측 시야 불량 지점' },
    39: { name: '신호위반다발', color: '#dc2626', text: '🚥', desc: '신호위반 다발 구간' },
    40: { name: '과속운행다발', color: '#ef4444', text: '🏃', desc: '과속운행 다발 구간' },
    41: { name: '교통혼잡지역', color: '#f59e0b', text: '🚗', desc: '교통혼잡 지역' },
    42: { name: '방향별차로', color: '#3b82f6', text: '🔀', desc: '방향별 차로 선택 지점' },
    43: { name: '무단횡단', color: '#dc2626', text: '🚶', desc: '무단횡단 사고 다발 지점' },
    44: { name: '갓길사고다발', color: '#be123c', text: '📍', desc: '갓길 사고 다발 지점' },
    45: { name: '과속사고다발', color: '#ef4444', text: '⚡', desc: '과속 사고 다발 지점' },
    46: { name: '졸음사고다발', color: '#b91c1c', text: '😴', desc: '졸음 사고 다발 지점' },
    47: { name: '사고다발지점', color: '#dc2626', text: '📍', desc: '사고 다발 지점' },
    48: { name: '보행자사고다발', color: '#ef4444', text: '🚶', desc: '보행자 사고 다발 지점' },
    49: { name: '실버존', color: '#a855f7', text: '👴', desc: '노인보호 구역' },
    50: { name: '차량도난', color: '#8b5cf6', text: '🚗', desc: '차량도난 사고 다발 지점' },
    51: { name: '낙석주의', color: '#78350f', text: '🪨', desc: '낙석 주의 지역' },
    52: { name: '결빙주의', color: '#0ea5e9', text: '❄️', desc: '결빙 주의 지역' },
    53: { name: '병목지점', color: '#f59e0b', text: '⚠️', desc: '병목 지점' },
    54: { name: '합류도로', color: '#3b82f6', text: '➕', desc: '합류 도로' },
    55: { name: '추락주의', color: '#dc2626', text: '⬇️', desc: '추락 주의 지역' },
    56: { name: '지하차도', color: '#1f2937', text: '🚇', desc: '지하차도 구간' },
    57: { name: '주택밀집', color: '#6366f1', text: '🏘️', desc: '주택밀집 교통진정지역' },
    58: { name: '인터체인지', color: '#3b82f6', text: '🔀', desc: '인터체인지' },
    59: { name: '분기점', color: '#0ea5e9', text: '⛔', desc: '분기점' },
    60: { name: '휴게소LPG', color: '#10b981', text: '⛽', desc: '휴게소(LPG충전가능)' },
    61: { name: '교량', color: '#06b6d4', text: '🌉', desc: '교량' },
    62: { name: '제동장치사고', color: '#dc2626', text: '🛑', desc: '제동장치 사고 다발 지점' },
    63: { name: '중앙선침범', color: '#ef4444', text: '↔️', desc: '중앙선 침범 사고 다발 지점' },
    64: { name: '통행위반', color: '#be123c', text: '🚫', desc: '통행위반 사고 다발 지점' },
    65: { name: '목적지건너편', color: '#8b5cf6', text: '🔄', desc: '목적지 건너편 안내' },
    66: { name: '졸음쉼터', color: '#10b981', text: '😴', desc: '졸음 쉼터 안내' },
    67: { name: '노후경유차', color: '#059669', text: '💨', desc: '노후경유차 단속' },
    68: { name: '터널차로변경', color: '#0f766e', text: '🔄', desc: '터널내 차로변경 단속' },
};

function getEventIconConfig(typeCode) {
    return EVENT_ICON_MAP[typeCode] || { name: '기타', color: '#6b7280', icon: '📍' };
}

function getSdiIconConfig(sdiType) {
    return SDI_TYPE_MAP[sdiType] || { name: `기타 안내`, color: '#64748b', text: '⚙️', desc: `SDI Type ${sdiType}` };
}

function createEventMarkerIcon(typeCode, iconText = null) {
    const config = getEventIconConfig(typeCode);
    const iconHtml = `
        <div style="
            background-color: ${config.color};
            color: white;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            border: 2px solid white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">
            ${iconText || config.icon}
        </div>
    `;
    return L.divIcon({
        html: iconHtml,
        className: 'event-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16]
    });
}

function createSdiMarkerIcon(sdiType) {
    const config = getSdiIconConfig(sdiType);
    const iconHtml = `
        <div style="
            background: linear-gradient(135deg, ${config.color} 0%, ${config.color}dd 100%);
            color: white;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            font-weight: bold;
            border: 2px solid white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">
            ${config.text}
        </div>
    `;
    return L.divIcon({
        html: iconHtml,
        className: 'sdi-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16]
    });
}

function renderTrafficIncidents(tvasResult) {
    if (!tvasResult || !tvasResult.incidents || tvasResult.incidents.length === 0) {
        return;
    }

    const eventGroup = ensureTmapFeatureGroup('Traffic Events');
    const coords = resolveVertexCoordinates(tvasResult);
    const coordMap = new Map();
    coords.forEach((coord, idx) => {
        coordMap.set(idx, { lat: coord.lat, lon: coord.lon });
    });

    tvasResult.incidents.forEach((incident) => {
        const vxCoord = coordMap.get(incident.startVxIdx);
        if (!vxCoord) return;

        const eventIcon = createEventMarkerIcon(incident.typeCode);
        const typeConfig = getEventIconConfig(incident.typeCode);
        const marker = L.marker([vxCoord.lat, vxCoord.lon], { icon: eventIcon });

        marker.bindPopup(`
            <div style="min-width: 200px;">
                <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                    ${typeConfig.icon} ${typeConfig.name}
                </div>
                <div style="font-size: 12px;">
                    <div><strong>종류:</strong> ${typeConfig.name}</div>
                    <div><strong>위치 Index:</strong> ${incident.startVxIdx}</div>
                    ${incident.content ? `<div><strong>내용:</strong> ${escapeHtml(incident.content)}</div>` : ''}
                </div>
            </div>
        `);

        eventGroup.addLayer(marker);
    });

    renderLayerControls();
}

function renderDangerAreas(tvasResult) {
    if (!tvasResult || !tvasResult.dangerAreas || tvasResult.dangerAreas.length === 0) {
        return;
    }

    const dangerGroup = ensureTmapFeatureGroup('Danger Areas');
    const coords = resolveVertexCoordinates(tvasResult);
    const coordMap = new Map();
    coords.forEach((coord, idx) => {
        coordMap.set(idx, { lat: coord.lat, lon: coord.lon });
    });

    const DANGER_TYPE_MAP = {
        1: { name: '급커브', color: '#f97316', icon: '🔄' },
        2: { name: '스쿨존', color: '#0ea5e9', icon: '🏫' },
        3: { name: '철도건널목', color: '#8b5cf6', icon: '🚂' },
        4: { name: '속도범프', color: '#ec4899', icon: '⬆️' },
        5: { name: '사고다발지', color: '#dc2626', icon: '⚠️' },
    };

    tvasResult.dangerAreas.forEach((area) => {
        const startCoord = coordMap.get(area.startVxIdx);
        const endCoord = coordMap.get(area.endVxIdx);

        if (!startCoord || !endCoord) return;

        const typeConfig = DANGER_TYPE_MAP[area.type] || { name: '위험구간', color: '#6b7280', icon: '📍' };
        const latlngs = [
            [startCoord.lat, startCoord.lon],
            [endCoord.lat, endCoord.lon]
        ];

        const polyline = L.polyline(latlngs, {
            color: typeConfig.color,
            weight: 3,
            opacity: 0.6,
            dashArray: '5, 5'
        });

        polyline.bindPopup(`
            <div style="min-width: 150px;">
                <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                    ${typeConfig.icon} ${typeConfig.name}
                </div>
                <div style="font-size: 12px;">
                    <div><strong>구간:</strong> ${area.startVxIdx} ~ ${area.endVxIdx}</div>
                    <div><strong>거리:</strong> ${area.sectionLength}m</div>
                    ${area.speedLimit > 0 ? `<div><strong>제한속도:</strong> ${area.speedLimit}km/h</div>` : ''}
                </div>
            </div>
        `);

        dangerGroup.addLayer(polyline);

        const midCoord = {
            lat: (startCoord.lat + endCoord.lat) / 2,
            lon: (startCoord.lon + endCoord.lon) / 2
        };
        const marker = L.marker([midCoord.lat, midCoord.lon], {
            icon: createEventMarkerIcon(null, typeConfig.icon)
        });
        dangerGroup.addLayer(marker);
    });

    renderLayerControls();
}

function renderTmapRouteResultWithEvents(routeResponse) {
    renderTmapRouteResult(routeResponse);

    if (!tmapRouteResult || !tmapRouteResult.tvasResult) {
        return;
    }

    setTimeout(() => {
        renderTrafficIncidents(tmapRouteResult.tvasResult);
        renderDangerAreas(tmapRouteResult.tvasResult);
    }, 100);
}

// MFS 유고정보 name → 이벤트 타입 코드 (사고/공사/행사/재해/통제)
function mfsNameToEventCode(name) {
    const s = String(name || '');
    if (s.includes('사고')) return 'A';
    if (s.includes('공사')) return 'B';
    if (s.includes('행사')) return 'C';
    if (s.includes('재해')) return 'D';
    if (s.includes('통제')) return 'E';
    return null;
}

function visualizeGuideEventsFromLog() {
    if (!Array.isArray(markersData) || markersData.length === 0) {
        console.log('❌ visualizeGuideEventsFromLog: No markers data');
        return;
    }

    const guideMarkers = markersData.filter((m) => m.extra?.guide_event);
    const sdiMarkers = markersData.filter((m) => m.extra?.sdi_event);
    const c2xEvents = guideMarkers.filter((m) => m.extra.event_type === 'C2X');
    const mfsEvents = guideMarkers.filter((m) => m.extra.event_type === 'MFS');
    console.log(`📊 Guide Events: ${c2xEvents.length} C2X, ${mfsEvents.length} MFS(유고정보), SDI: ${sdiMarkers.length}`);

    if (guideMarkers.length === 0) {
        return;
    }

    // C2X 이벤트 (V2X 통신 수신 — EventPos 좌표)
    if (c2xEvents.length > 0) {
        const c2xGroup = ensureTmapFeatureGroup('C2X Events');
        c2xGroup.clearLayers();

        c2xEvents.forEach((marker) => {
            const icon = createEventMarkerIcon(null, '📡');
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 200px;">
                    <div style="font-weight: bold; color: #3b82f6; margin-bottom: 8px;">
                        📡 가이드 이벤트 (Guide Event) - C2X
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
                        V2X 통신으로 수신한 위험정보
                    </div>
                    <div style="font-size: 12px;">
                        <div><strong>Event ID:</strong> ${escapeHtml(String(marker.extra.event_id))}</div>
                        <div><strong>Event Type(CC):</strong> ${marker.extra.event_type_code ?? '-'}</div>
                        ${marker.extra.event_time ? `<div><strong>Event Time:</strong> ${escapeHtml(marker.extra.event_time)}</div>` : ''}
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>Log Time:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            c2xGroup.addLayer(markerObj);
        });
    }

    // TMAP 유고정보 (MFS — 서버 Point.location 좌표)
    if (mfsEvents.length > 0) {
        const mfsGroup = ensureTmapFeatureGroup('Tmap Incidents (MFS)');
        mfsGroup.clearLayers();

        mfsEvents.forEach((marker) => {
            const code = mfsNameToEventCode(marker.extra.name);
            const typeConfig = getEventIconConfig(code);
            const icon = createEventMarkerIcon(code);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 220px;">
                    <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                        ${typeConfig.icon} 가이드 이벤트 (Guide Event) - MFS
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
                        TMAP 유고정보 (Map Feature Service)
                    </div>
                    <div style="font-size: 12px;">
                        <div><strong>이벤트명:</strong> ${escapeHtml(marker.extra.name || typeConfig.name)}</div>
                        <div><strong>Key:</strong> ${escapeHtml(String(marker.extra.event_id))}</div>
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>Log Time:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            mfsGroup.addLayer(markerObj);
        });
    }

    // SDI Events (Safety Drive Information — 카메라, 과속방지턱 등)
    if (sdiMarkers.length > 0) {
        const sdiGroup = ensureTmapFeatureGroup('SDI Events');
        sdiGroup.clearLayers();

        sdiMarkers.forEach((marker) => {
            const icon = createSdiMarkerIcon(marker.extra.sdi_type);
            const config = getSdiIconConfig(marker.extra.sdi_type);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 240px;">
                    <div style="font-weight: bold; color: ${config.color}; margin-bottom: 8px; font-size: 14px;">
                        🛣️ ${config.name}
                    </div>
                    <div style="font-size: 12px; line-height: 1.6;">
                        <div style="background-color: ${config.color}20; padding: 6px; border-radius: 4px; margin-bottom: 8px; color: ${config.color}; font-weight: bold;">
                            ${config.desc}
                        </div>
                        <div><strong>타입 코드:</strong> ${marker.extra.sdi_type}</div>
                        ${marker.extra.speed ? `<div><strong>제한속도:</strong> ${marker.extra.speed} km/h</div>` : ''}
                        <div><strong>정보원:</strong> ${marker.extra.source}</div>
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>기록시간:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            sdiGroup.addLayer(markerObj);
        });
    }

    // Parking Lot State Transitions
    const parkingLotMarkers = markersData.filter((m) => m.extra?.event_type === 'ParkingLot');
    if (parkingLotMarkers.length > 0) {
        const parkingGroup = ensureTmapFeatureGroup('Parking Lot State');
        parkingGroup.clearLayers();

        parkingLotMarkers.forEach((markerData) => {
            const icon = markerData.extra?.icon || '🅿️';
            const color = markerData.color || '#6b7280';
            const isDashed = markerData.extra?.dashed || false;

            const markerObj = L.circleMarker([markerData.latitude, markerData.longitude], {
                radius: 7,
                color: color,
                weight: isDashed ? 1 : 2.5,
                dashArray: isDashed ? '5, 3' : null,
                fill: !isDashed,
                fillColor: color,
                fillOpacity: isDashed ? 0.3 : 0.8,
                pane: 'markerPane'
            });

            let popupContent = `
                <div class="popup-content" style="min-width: 240px;">
                    <div style="font-weight: bold; color: ${color}; margin-bottom: 8px;">
                        ${icon} ${markerData.extra?.state_label || '주차장 상태'}
                    </div>
                    <table style="font-size: 12px;">
            `;

            // Show state transition or apply info
            if (markerData.extra?.prev_state) {
                popupContent += `
                        <tr><td><strong>상태:</strong></td><td>${markerData.extra.prev_state} → ${markerData.extra.next_state}</td></tr>
                        <tr><td><strong>이유:</strong></td><td>${markerData.extra.reason || 'N/A'}</td></tr>
                `;
            } else if (markerData.extra?.state) {
                popupContent += `
                        <tr><td><strong>상태:</strong></td><td>${markerData.extra.state}</td></tr>
                        <tr><td><strong>후보 개수:</strong></td><td>${markerData.extra.candidate_count || 0}</td></tr>
                        <tr><td><strong>최고 매칭 Link:</strong></td><td>${markerData.extra.best_link_id || 'N/A'}</td></tr>
                `;
            }

            popupContent += `
                        <tr><td><strong>좌표:</strong></td><td>${markerData.latitude.toFixed(6)}, ${markerData.longitude.toFixed(6)}</td></tr>
                        <tr><td><strong>시간:</strong></td><td>${markerData.timestamp_str || 'N/A'}</td></tr>
                    </table>
                </div>
            `;

            markerObj.bindPopup(popupContent);
            parkingGroup.addLayer(markerObj);
        });
    }

    renderLayerControls();
}
