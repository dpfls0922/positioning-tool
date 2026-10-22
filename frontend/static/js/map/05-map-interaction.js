// ===== 이벤트 바인딩 · 검사 모드 · 팝업 드래그 · 최근접 도로 탐색 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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
    bind('placeSearchButton', 'click', handlePlaceSearch);

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
    document.getElementById('placeSearchBox')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handlePlaceSearch();
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

