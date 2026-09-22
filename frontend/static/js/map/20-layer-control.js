// ===== 레이어 그룹 · 컨텍스트 메뉴 · 레이어 트리 컨트롤 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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
    } else if (isRouteLineLayerName(type)) {
        // 탐색된 경로선은 전용 pane 에 둔다. 이름이 line 판정 문자열에 걸리지 않아
        // 그동안 마커와 같은 markerPane 에 들어갔고, 레이어 순서상 나중에
        // bringToFront 되어 VPM 같은 측위 결과를 덮었다. 실제 내비처럼
        // 도로형상 위 · 마커 아래에 깔린다.
        layer.options.pane = ensureRouteLinePane();
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

// 카카오맵을 배경지도 목록과 같은 자리에서 켜고 끌 수 있게 한다.
//
// 카카오 타일은 Leaflet 배경지도가 될 수 없다. 자체 SDK 렌더러만 제공하고 타일이
// EPSG:5181 자체 스킴인데 Leaflet 지도는 CRS 가 하나뿐이라, Web Mercator 인
// Google/Tmap 과 한 지도에 섞으면 중심에서 멀어질수록 도로와 마커가 어긋난다.
// 위치 분석 도구에서 그 어긋남은 그대로 오독으로 이어지므로 배경으로 깔지 않는다.
//
// 대신 지도와 중심·줌이 동기화되는 카카오 창을 이 항목으로 여닫는다. 배경지도
// 라디오와 섞이지 않게 오버레이(체크박스)로 넣어 '배경을 바꾸는 것'이 아니라는
// 점이 UI 에서 드러나게 했다.
const kakaoMapToggleLayer = L.Layer.extend({
    onAdd() {
        if (typeof openSkyview === 'function') openSkyview();
        return this;
    },
    onRemove() {
        if (typeof skyviewApi !== 'undefined' && skyviewApi && skyviewApi.isOpen()) {
            skyviewApi.close();
        }
        return this;
    }
});

let kakaoMapOverlay = null;

// 패널을 X 로 닫거나 툴바 버튼으로 열면 레이어 목록의 체크 상태도 따라가야 한다.
// 이미 같은 상태면 아무것도 하지 않아 onAdd/onRemove ↔ onClose 가 서로를 다시
// 부르는 일이 없다.
function syncKakaoOverlayCheckbox(on) {
    if (!kakaoMapOverlay) return;
    const has = map.hasLayer(kakaoMapOverlay);
    if (on && !has) map.addLayer(kakaoMapOverlay);
    if (!on && has) map.removeLayer(kakaoMapOverlay);
}

function buildControlOverlays() {
    if (typeof kakaoJsKeySet !== 'undefined' && !kakaoJsKeySet) return null;
    if (!kakaoMapOverlay) kakaoMapOverlay = new kakaoMapToggleLayer();
    return { '카카오맵 (별도 창)': kakaoMapOverlay };
}

function addControlLayers() {
    if (!baseLayerInitialized) {
        baseLayers["Tmap"].addTo(map);
        baseLayerInitialized = true;
    }

    if (layerControl) {
        map.removeControl(layerControl);
    }
    layerControl = L.control.layers(baseLayers, buildControlOverlays(), { collapsed: true }).addTo(map);
}

// 경로선 전용 pane. z-index 는 도로형상 pane(550~) 위, markerPane(600) 아래.
const ROUTE_LINE_PANE = 'routeLinePane';

function ensureRouteLinePane() {
    if (!map.getPane(ROUTE_LINE_PANE)) {
        map.createPane(ROUTE_LINE_PANE).style.zIndex = '580';
    }
    return ROUTE_LINE_PANE;
}

// 'Route Info' / 'Route Info <id>' 는 경로 폴리라인 레이어다.
// 'Route Info Markers …' 와 'GP … · Route Info N' 같은 하위 마커 레이어는 제외한다.
function isRouteLineLayerName(name) {
    if (typeof name !== 'string') return false;
    if (routeChildLayerOwner(name)) return false;
    if (name.startsWith(ROUTE_INFO_MARKER_LAYER_PREFIX) || name === ROUTE_INFO_MARKER_LAYER) return false;
    return name === 'Route Info' || name.startsWith(ROUTE_INFO_LAYER_PREFIX);
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
    const isNode = layerName === ROAD_NODE_LAYER;
    const isVertex = layerName === ROAD_LINK_VERTEX_LAYER;
    const isPointLayer = isNode || isVertex;

    const title = document.getElementById('layerCtxTitle');
    if (title) title.textContent = `${layerName} 스타일`;

    const linkSec = document.getElementById('layerCtxLinkSection');
    const nodeSec = document.getElementById('layerCtxNodeSection');
    const vertexSec = document.getElementById('layerCtxVertexSection');
    if (linkSec) linkSec.style.display = isLink ? '' : 'none';
    // Road Node opens both sections; Road Link Vertex opens only vertex section
    if (nodeSec) nodeSec.style.display = isNode ? '' : 'none';
    if (vertexSec) vertexSec.style.display = isPointLayer ? '' : 'none';

    // Pre-fill node inputs
    if (isNode) {
        const nodeColorInput = document.getElementById('nodeColorInput');
        const nodeStrokeInput = document.getElementById('nodeStrokeInput');
        const nodeRadiusInput = document.getElementById('nodeRadiusInput');
        const nodeWeightInput = document.getElementById('nodeWeightInput');
        if (nodeColorInput) nodeColorInput.value = roadNodeStyleConfig.color;
        if (nodeStrokeInput) nodeStrokeInput.value = roadNodeStyleConfig.stroke;
        if (nodeRadiusInput) nodeRadiusInput.value = String(roadNodeStyleConfig.radius);
        if (nodeWeightInput) nodeWeightInput.value = String(roadNodeStyleConfig.weight);
    }

    // Pre-fill vertex inputs
    if (isPointLayer) {
        const vertexColorInput = document.getElementById('vertexColorInput');
        const vertexStrokeInput = document.getElementById('vertexStrokeInput');
        const vertexRadiusInput = document.getElementById('vertexRadiusInput');
        const vertexWeightInput = document.getElementById('vertexWeightInput');
        if (vertexColorInput) vertexColorInput.value = roadVertexStyleConfig.color;
        if (vertexStrokeInput) vertexStrokeInput.value = roadVertexStyleConfig.stroke;
        if (vertexRadiusInput) vertexRadiusInput.value = String(roadVertexStyleConfig.radius);
        if (vertexWeightInput) vertexWeightInput.value = String(roadVertexStyleConfig.weight);
    }

    const fbSec = document.getElementById('layerCtxSegmentFbSection');
    if (fbSec) {
        fbSec.style.display = isLink ? '' : 'none';
        if (isLink) {
            const fbColor = document.getElementById('fbColorInput');
            const fbWeight = document.getElementById('fbWeightInput');
            const fbOpacity = document.getElementById('fbOpacityInput');
            if (fbColor) fbColor.value = segmentFbConfig.color;
            if (fbWeight) fbWeight.value = String(segmentFbConfig.weight);
            if (fbOpacity) fbOpacity.value = String(segmentFbConfig.opacity);
            if (fbColor) fbColor.oninput = () => { segmentFbConfig.color = fbColor.value; refreshLaneWidthLayer(); };
            if (fbWeight) fbWeight.onchange = () => { segmentFbConfig.weight = Math.max(1, Math.min(10, Number(fbWeight.value))); refreshLaneWidthLayer(); };
            if (fbOpacity) fbOpacity.onchange = () => { segmentFbConfig.opacity = Math.max(0.05, Math.min(1, Number(fbOpacity.value))); refreshLaneWidthLayer(); };
        }
    }

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

// Route-derived layers get their own sidebar card: they describe the guidance
// route rather than the positioning trace, so mixing them into the result card
// buried the GNSS/DR layers people actually scroll to.
//
// Route Info layers are per-session suffixed ('Route Info <session>'), so
// membership is prefix-based for those and exact for the rest.
function isRouteLayerName(name) {
    if (typeof name !== 'string') return false;
    if (name.startsWith(ROUTE_INFO_MARKER_LAYER_PREFIX)) return true;
    if (name.startsWith(ROUTE_INFO_LAYER_PREFIX)) return true;
    // 'GP Lane Bubble (차선 버블) · Route Info 10000013' and friends.
    if (routeChildLayerOwner(name)) return true;
    return [
        ROUTE_INFO_MARKER_LAYER,
        'Route Info',
        TMAP_ROUTE_LAYER,
        TMAP_WAYPOINT_LAYER,
        'Request',
        'C2X Events',
        'Tmap Incidents (MFS)',
        'SDI Events',
        GP_CROSS_IMAGE_LAYER,
        GP_TURN_ONLY_LAYER,
        GP_LANE_COLOR_LAYER,
        GP_LANE_BUBBLE_LAYER
    ].includes(name);
}

// 좌표 레이어에서 파생된 하위 레이어. 최상위 행이 아니라 부모 행 하위에
// 중첩해 관리하되, 부모가 꺼져 있어도 독립적으로 켜고 끌 수 있다.
const COORD_CHILD_LAYERS = {
    'DR-based': ['Parking Lot State'],
    'Filtered GNSS': ['GNSS Mode']
};

// 점/띠 색 의미 범례 (부모 행 아래 상시 표시).
const COORD_COLOR_LEGENDS = {
    'DR-based': [
        { color: '#7c3aed', label: '정차 Roll/Pitch 초기화' },
        { color: '#000000', label: 'MM Feedback 위치 보정' },
        { color: '#9e9e9e', label: 'MM Feedback 헤딩 보정' },
        { color: 'orange', label: 'isDRGps = 0' }
    ],
    'Filtered GNSS': [
        { color: '#22c55e', label: '모드 전환 지점' },
        { color: '#99f6e4', label: 'Normal 구간 띠' },
        { color: '#e879f9', label: 'BusSleep 구간 띠' }
    ]
};

function isDrChildLayerName(name) {
    return Object.values(COORD_CHILD_LAYERS).some((list) => list.includes(name));
}

// 하위 레이어 체크박스와 색 범례를 부모 좌표 행 아래에 붙인다.
function appendDrChildLayerControls(parent, layerName) {
    const childNames = COORD_CHILD_LAYERS[layerName];
    const legend = COORD_COLOR_LEGENDS[layerName];
    if (!childNames && !legend) return;

    const wrap = document.createElement('div');
    wrap.className = 'layer-rule-list';

    (legend || []).forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'layer-rule-item';

        const swatch = document.createElement('span');
        swatch.className = 'layer-rule-swatch';
        swatch.style.background = entry.color;
        item.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'layer-rule-label';
        label.textContent = entry.label;
        item.appendChild(label);

        wrap.appendChild(item);
    });

    const children = (childNames || []).filter((name) => !!featureGroups[name]);

    children.forEach((childName) => {
        const group = featureGroups[childName];

        const item = document.createElement('label');
        item.className = 'layer-rule-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'layer-control-check';
        checkbox.checked = activeGroups.has(childName);
        checkbox.onchange = () => {
            if (checkbox.checked) {
                if (!map.hasLayer(group)) map.addLayer(group);
                activeGroups.add(childName);
            } else {
                if (map.hasLayer(group)) map.removeLayer(group);
                activeGroups.delete(childName);
            }
            updateMap();
            renderLayerControls();
        };
        item.appendChild(checkbox);

        const swatch = document.createElement('span');
        swatch.className = 'layer-rule-swatch';
        swatch.style.background = getLayerSwatchColor(childName);
        item.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'layer-rule-label';
        const displayCount = Number.isFinite(layerCountOverride[childName])
            ? layerCountOverride[childName]
            : (group.getLayers?.().length || 0);
        label.textContent = `${childName} (${displayCount})`;
        item.appendChild(label);

        wrap.appendChild(item);
    });

    parent.appendChild(wrap);
}

function isRoadShapeLayerName(name) {
    return name === ROAD_LINK_LAYER || name === ROAD_NODE_LAYER || name === ROAD_LINK_VERTEX_LAYER || name === SEGMENT_FB_LAYER || name === LANE_WIDTH_LAYER || name === LANE_WIDTH_LAYER_2 || name === LANE_WIDTH_EXT_CALC_LAYER;
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

                // Route Info를 다시 키면 함께 껐던 하위 레이어를 복원
                restoreRouteChildLayers(name);


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

                // Route Info를 끄면 그 경로에서 파싱된 하위 레이어도 함께 끔
                hideRouteChildLayers(name);


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

            // Route Info 세션을 켜고 끄면 겹침 음영도 보이는 레이어 기준으로 재계산
            if (name === 'Route Info' || name.startsWith(ROUTE_INFO_LAYER_PREFIX)) {
                refreshRouteInfoOverlapShading();
            }

            if (name === SEGMENT_FB_LAYER) refreshLaneWidthLayer();
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
        appendRouteChildLayerControls(childWrap, name);
        appendDrChildLayerControls(childWrap, name);
    });
}

// Child layers follow their parent route: they describe that route, so leaving
// them on the map after its row is unchecked reads as a bug. The set that was
// on is remembered so re-checking the parent restores it, mirroring how
// Road Node remembers Road Link Vertex.
const routeChildActiveBeforeParentDisabled = new Map();

// ensureTmapFeatureGroup() shows every group it creates, so a child built while
// its route is hidden would appear orphaned. Call this right after creating one.
function syncRouteChildLayerToParent(childName) {
    const owner = routeChildLayerOwner(childName);
    if (!owner) return;
    // An owner with no layer yet has not been drawn; leave the child visible.
    if (!featureGroups[owner] || activeGroups.has(owner)) return;
    const group = featureGroups[childName];
    if (group && map.hasLayer(group)) map.removeLayer(group);
    activeGroups.delete(childName);
}

function routeChildLayerNames(routeLayerName) {
    return layerOrder.filter((name) => routeChildLayerOwner(name) === routeLayerName);
}

function hideRouteChildLayers(routeLayerName) {
    const children = routeChildLayerNames(routeLayerName);
    if (children.length === 0) return;
    routeChildActiveBeforeParentDisabled.set(
        routeLayerName,
        children.filter((child) => activeGroups.has(child))
    );
    children.forEach((child) => {
        const group = featureGroups[child];
        if (group && map.hasLayer(group)) map.removeLayer(group);
        activeGroups.delete(child);
    });
}

function restoreRouteChildLayers(routeLayerName) {
    const remembered = routeChildActiveBeforeParentDisabled.get(routeLayerName);
    if (!remembered) return;
    remembered.forEach((child) => {
        const group = featureGroups[child];
        if (!group) return;
        if (!map.hasLayer(group)) map.addLayer(group);
        activeGroups.add(child);
    });
    routeChildActiveBeforeParentDisabled.delete(routeLayerName);
}

// GP guide / lane bubble layers parsed from one route, shown under that route's
// row so they are managed with it rather than as unrelated top-level layers.
function appendRouteChildLayerControls(parent, routeLayerName) {
    if (typeof routeLayerName !== 'string' || !routeLayerName.startsWith('Route Info')) return;
    // Only the route polyline row owns the children, not its markers row.
    if (routeLayerName.startsWith(ROUTE_INFO_MARKER_LAYER_PREFIX) || routeLayerName === ROUTE_INFO_MARKER_LAYER) return;

    const children = routeChildLayerNames(routeLayerName);
    if (children.length === 0) return;
    const parentActive = activeGroups.has(routeLayerName);

    const wrap = document.createElement('div');
    wrap.className = 'layer-rule-list';

    children.forEach((childName) => {
        const group = featureGroups[childName];
        if (!group) return;

        const item = document.createElement('label');
        item.className = 'layer-rule-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'layer-control-check';
        checkbox.checked = activeGroups.has(childName);
        // Turning a child on while its route is hidden would contradict the
        // cascade, so the row is inert until the route is shown again.
        checkbox.disabled = !parentActive;
        checkbox.onchange = () => {
            if (checkbox.checked) {
                if (!map.hasLayer(group)) map.addLayer(group);
                activeGroups.add(childName);
            } else {
                if (map.hasLayer(group)) map.removeLayer(group);
                activeGroups.delete(childName);
            }
            renderLayerControls();
        };
        item.appendChild(checkbox);

        const swatch = document.createElement('span');
        swatch.className = 'layer-rule-swatch';
        // Resolve the colour from the kind: the session suffix matches none of
        // getLayerSwatchColor's names.
        swatch.style.background = getLayerSwatchColor(routeChildLayerBase(childName));
        item.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'layer-rule-label';
        // The owning route is already the parent row, so show only the kind.
        label.textContent = `${routeChildLayerBase(childName)} (${group.getLayers().length})`;
        label.title = childName;
        item.appendChild(label);

        wrap.appendChild(item);
    });

    parent.appendChild(wrap);
}

function createLayerTreeCard(rootLabelText, groups, expanded = true, visibilityGroups = null, cardKey = null) {
    const treeKey = cardKey || rootLabelText;
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
        // Keyed by card so a third card does not share the result card's state.
        setLayerTreeExpanded(treeKey, !expanded);
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

// Expanded state per sidebar card. 'result' and 'road' keep their original
// defaults; any new card defaults to expanded.
const layerTreeExpandedState = { result: true, road: true, route: true };

function isLayerTreeExpanded(key) {
    return layerTreeExpandedState[key] !== false;
}

function setLayerTreeExpanded(key, value) {
    layerTreeExpandedState[key] = !!value;
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

    // DR 하위 링 레이어(MM Feedback 등)는 DR-based 행 밑에 중첩되므로
    // 최상위 행에서는 제외하고, 카드 체크박스 집계에는 포함한다.
    const resultVisibilityGroups = layerOrder.filter((name) => !isRoadShapeLayerName(name) && !isRouteLayerName(name));
    const resultGroups = resultVisibilityGroups.filter((name) => !isDrChildLayerName(name));
    // Session-owned GP/lane layers are nested under their route's row, so they
    // are excluded from the top-level rows (still counted by the card checkbox).
    const routeGroups = layerOrder.filter((name) => isRouteLayerName(name) && !routeChildLayerOwner(name));
    const routeVisibilityGroups = layerOrder.filter((name) => isRouteLayerName(name));
    // Lane Width는 최상위 행이 아니라 Road Link 하위 체크박스로 노출한다(Vertex와 동일한 패턴).
    const roadGroups = layerOrder.filter((name) => isRoadShapeLayerName(name) && name !== ROAD_LINK_VERTEX_LAYER && name !== SEGMENT_FB_LAYER && name !== LANE_WIDTH_LAYER && name !== LANE_WIDTH_LAYER_2 && name !== LANE_WIDTH_EXT_CALC_LAYER);
    const roadShapeVisibilityGroups = layerOrder.filter((name) => isRoadShapeLayerName(name));

    if (resultGroups.length > 0) {
        list.appendChild(createLayerTreeCard(
            `result_${currentResultName}`, resultGroups, isLayerTreeExpanded('result'), resultVisibilityGroups, 'result'));
    }
    // Route data is derived from the result, so it sits between the two.
    if (routeGroups.length > 0) {
        list.appendChild(createLayerTreeCard(
            '경로', routeGroups, isLayerTreeExpanded('route'), routeVisibilityGroups, 'route'));
    }
    if (roadGroups.length > 0) {
        const tree = createLayerTreeCard(
            'Road Shape', roadGroups, isLayerTreeExpanded('road'), roadShapeVisibilityGroups, 'road');
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
            { layerKey: LANE_WIDTH_LAYER_2, config: laneWidthConfig2, label: '차로폭2 (zoom 17+)' },
            {
                layerKey: LANE_WIDTH_EXT_CALC_LAYER,
                config: laneWidthConfigExtCalc,
                label: `확장 차선수(계산) (zoom ${LANE_WIDTH_MIN_ZOOM}+)`
            }
        ].forEach((spec) => appendLaneWidthControl(ruleWrap, spec));

        // Segment FB 토글 — Road Link 하위 (스타일은 붓 아이콘 패널에서 수정)
        appendSimpleLayerToggle(ruleWrap, SEGMENT_FB_LAYER, 'Segment FB (zoom 16+)');
    }

    parent.appendChild(ruleWrap);
}

// Road Link 하위 차로폭 레이어 토글 + 인라인 튜닝(기본/확장 폭·색) 한 세트를 붙인다.
function appendSimpleLayerToggle(parent, layerKey, label) {
    const item = document.createElement('label');
    item.className = 'layer-rule-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'layer-control-check';
    checkbox.checked = activeGroups.has(layerKey);
    checkbox.onchange = () => {
        const group = featureGroups[layerKey];
        if (checkbox.checked) {
            if (group && !map.hasLayer(group)) map.addLayer(group);
            activeGroups.add(layerKey);
        } else {
            if (group && map.hasLayer(group)) map.removeLayer(group);
            activeGroups.delete(layerKey);
        }
        refreshLaneWidthLayer();
        renderLayerControls();
    };
    item.appendChild(checkbox);

    const text = document.createElement('span');
    text.className = 'layer-rule-label';
    text.textContent = label;
    item.appendChild(text);

    parent.appendChild(item);
}

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
    if (name === LANE_WIDTH_EXT_CALC_LAYER) {
        return laneWidthConfigExtCalc.extendedColor;
    }
    const swatches = {
        'Road Link Vertex': '#f8fafc',
        'Raw GNSS': '#a855f7',
        'Filtered GNSS': '#14b8a6',
        'DR-based': '#ef4444',
        'Parking Lot State': '#db2777',
        'GNSS Mode': '#e879f9',
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
        'Tmap Route': '#ef4444',
        [GP_CROSS_IMAGE_LAYER]: '#7c3aed',
        [GP_TURN_ONLY_LAYER]: '#0ea5e9',
        [GP_LANE_COLOR_LAYER]: '#22c55e',
        [GP_LANE_BUBBLE_LAYER]: '#f472b6'
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

