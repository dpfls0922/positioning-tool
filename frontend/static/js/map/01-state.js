// ===== 전역 상태 · 상수 · 설정 저장(localStorage) 헬퍼 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
const map = L.map('map', { preferCanvas: true }).setView([37.5665, 126.9780], 15);
const highlightLayer = L.layerGroup().addTo(map);
const roadCanvasRenderer = L.canvas({ padding: 0.25 });
const roadCanvasRendererNode = L.canvas({ padding: 0.25 });
// 차로폭 박스 전용 렌더러 — 링크 중심선보다 아래(낮은 z-index 팬)에 그리기 위해 별도 팬에 고정.
const roadCanvasRendererLane = L.canvas({ padding: 0.25, pane: 'roadLaneWidthPane' });
const roadCanvasRendererLane2 = L.canvas({ padding: 0.25, pane: 'roadLaneWidth2Pane' });
const roadCanvasRendererLaneExtCalc = L.canvas({ padding: 0.25, pane: 'roadLaneWidthExtCalcPane' });
const roadCanvasRendererSegMid = L.canvas({ padding: 0.25, pane: 'roadSegmentMidlinePane' });
const roadCanvasRendererSegFb  = L.canvas({ padding: 0.25, pane: 'roadSegmentFbPane' });


const baseLayers = {
    "Google Maps": L.tileLayer('http://mt0.google.com/vt/lyrs=m&hl=ko&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        attribution: 'Google Maps'
    }),
    "Google Satellite": L.tileLayer('http://mt0.google.com/vt/lyrs=s&hl=ko&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        attribution: 'Google Satellite'
    }),
    // 구글 어스처럼 위성사진 위에 도로·지명 라벨이 얹힌 하이브리드(lyrs=y).
    // 차로 형상을 위성으로 보면서 도로명을 같이 읽을 때 쓴다.
    "Google Earth (위성+라벨)": L.tileLayer('http://mt0.google.com/vt/lyrs=y&hl=ko&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        attribution: 'Google Hybrid'
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
let rollPitchResetMarkers = [];
let gnssOutlierMarkers = [];
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
// 로그 없이 shapefile 위상(ST_ND_ID/ED_ND_ID + LANE)만으로 확장 차선수를 직접 계산해 그리는 레이어.
const LANE_WIDTH_EXT_CALC_LAYER = 'Lane Width Ext Calc';
const SEGMENT_FB_LAYER = 'Segment FB (0.25-0.75)';
const ROUTE_INFO_MARKER_LAYER = 'Route Info Markers';
const TMAP_ROUTE_LAYER = 'Tmap Route';
const TMAP_WAYPOINT_LAYER = 'Tmap Waypoints';
const ROUTE_INFO_LAYER_PREFIX = 'Route Info ';
const ROUTE_INFO_MARKER_LAYER_PREFIX = 'Route Info Markers ';
let roadLinkGeoLayer = null;
let roadLinkMultiRuleGeoLayer = null;
let roadNodeGeoLayer = null;
let roadLinkVertexGeoLayer = null;
let roadLaneWidthGeoLayer = null;
let roadLaneWidth2GeoLayer = null;
let roadLaneWidthExtCalcGeoLayer = null;
let roadSegmentMidlineGeoLayer = null;
let roadSegmentFbGeoLayer = null;
const segmentFbConfig = { color: '#f97316', weight: 3, opacity: 0.45, pointRadius: 4 };
// 차로폭 박스는 이 줌 이상에서만 그린다.
const LANE_WIDTH_MIN_ZOOM = 17;
// 박스 폴리곤이 폭증하지 않도록 상한을 둔다(확장 적용된 링크를 우선 그림).
const LANE_EXT_CALC_MAX_FEATURES = 20000;
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
// 계산형 확장 차선수 레이어 — 확장이 실제로 적용된 링크(ext > LANE)는 extendedColor 로 구분한다.
const DEFAULT_LANE_WIDTH_CONFIG_EXT_CALC = {
    normal: 3.0,
    extended: 3.5,
    normalColor: '#94a3b8',
    extendedColor: '#f43f5e',
    fillOpacity: 0.22
};
let laneWidthConfigExtCalc = { ...DEFAULT_LANE_WIDTH_CONFIG_EXT_CALC };
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
const FRONTEND_BUILD = 'lane-ext-v1';

