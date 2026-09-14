// ===== 경로 정보(Route Info) 라인/마커와 선택 상태 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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

// Route point icons. 출발/도착 은 실제 내비 에셋(origin/destination.png — 핀 안에
// 출발/도착 글자가 들어있다)을 쓰고, 경유지는 같은 핀 모양에 번호만 넣어 직접 그린다.
// (경유지용 flag_waypoint_*.png 는 깃발 모양이라 핀 3개와 언어가 달라서 쓰지 않는다.)
// 모두 아래쪽 끝(핀 꼭지)이 실제 지점을 가리키도록 앵커를 바닥에 둔다.
const ROUTE_POINT_ICON_DIR = '/static/img/route/';
const ROUTE_POINT_ICON_HEIGHT = 30;
// origin.png / destination.png 에서 뽑은 핀 색 — 경유지 핀도 같은 채도로 맞춘다.
const ROUTE_VIA_PIN_COLOR = '#f59e0b';

// Role text comes from the request's route_points ('출발지' / '경유지' / '목적지').
function routePointRole(label, subLabel) {
    const text = `${label || ''} ${subLabel || ''}`;
    if (/출발|^S$/.test(text)) return { kind: 'origin', file: 'origin.png', w: 22 };
    if (/도착|목적|^E$/.test(text)) return { kind: 'destination', file: 'destination.png', w: 22 };
    const via = text.match(/(\d+)/);
    return { kind: 'via', index: via ? parseInt(via[1], 10) : 1 };
}

// 출발/도착 핀과 같은 물방울 모양 핀. 번호는 원 안에 흰 글자로.
function buildViaPinSvg(index, height) {
    const w = Math.round(height * 41 / 56);
    return `<svg width="${w}" height="${height}" viewBox="0 0 41 56" xmlns="http://www.w3.org/2000/svg"`
        + ` style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))">`
        + `<path d="M20.5 55C20.5 55 38 33.8 38 20.6 38 9.4 30.1 1.5 20.5 1.5S3 9.4 3 20.6C3 33.8 20.5 55 20.5 55Z"`
        + ` fill="${ROUTE_VIA_PIN_COLOR}" stroke="#ffffff" stroke-width="2.5"/>`
        + `<text x="20.5" y="27" text-anchor="middle" font-size="19" font-weight="700"`
        + ` font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fill="#ffffff">${index}</text>`
        + `</svg>`;
}

function buildRoutePointIcon(label, bgColor, subLabel) {
    const role = routePointRole(label, subLabel);
    const h = ROUTE_POINT_ICON_HEIGHT;

    if (role.kind === 'via') {
        const w = Math.round(h * 41 / 56);
        return L.divIcon({
            className: '',
            iconSize: [w, h],
            iconAnchor: [w / 2, h],
            popupAnchor: [0, -h],
            html: buildViaPinSvg(role.index, h)
        });
    }

    const w = Math.round(role.w * h / 30);
    return L.divIcon({
        className: '',
        iconSize: [w, h],
        iconAnchor: [w / 2, h],
        popupAnchor: [0, -h],
        html: `<img src="${ROUTE_POINT_ICON_DIR}${role.file}" width="${w}" height="${h}"`
            + ` style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))" alt="">`
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

// GP guide / lane bubble markers are produced while parsing one route, and
// carry that route's `route_session_id`. The sidebar names route layers by
// `route_session_name` instead, so this bridges the two.
function routeLayerNameBySessionId() {
    const map = new Map();
    (Array.isArray(linesData) ? linesData : []).forEach((line) => {
        if (line?.type !== 'Route Info') return;
        const sessionId = line?.extra?.route_session_id;
        if (sessionId === null || sessionId === undefined) return;
        if (!map.has(sessionId)) map.set(sessionId, getRouteInfoLayerName(line));
    });
    return map;
}

// Layers owned by one route session, e.g.
//   'GP Lane Bubble (차선 버블) · Route Info 10000013'
// Base name first so these never collide with the 'Route Info ' prefix logic.
const ROUTE_CHILD_SEPARATOR = ' · ';

function routeChildLayerName(baseName, routeLayerName) {
    return `${baseName}${ROUTE_CHILD_SEPARATOR}${routeLayerName}`;
}

// The route layer a child layer belongs to, or null when it is not a child.
function routeChildLayerOwner(name) {
    if (typeof name !== 'string') return null;
    const index = name.indexOf(ROUTE_CHILD_SEPARATOR);
    if (index < 0) return null;
    const owner = name.slice(index + ROUTE_CHILD_SEPARATOR.length);
    return owner.startsWith('Route Info') ? owner : null;
}

function routeChildLayerBase(name) {
    const index = String(name).indexOf(ROUTE_CHILD_SEPARATOR);
    return index < 0 ? name : String(name).slice(0, index);
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

// 탐색된 경로는 실제 내비의 경로선처럼 그린다: 굵은 파란 실선 + 둥근 끝/이음.
//
// 이 지도는 preferCanvas 라 벡터가 전부 하나의 <canvas> 에 그려진다. 그래서
// 선마다 CSS 를 걸 수 없고(테두리를 그림자로 흉내낼 수 없다), 실제 내비처럼
// casing(어두운 밑선)을 넣으려면 폴리라인을 한 벌 더 깔아야 한다. 링크마다
// 폴리라인이 하나씩이라 개수가 두 배가 되고 타임라인 필터와도 어긋나므로,
// 캔버스에서 실제로 먹는 속성(두께·둥근 끝·불투명 실선)으로만 대비를 올린다.
const ROUTE_LINE_NAV_COLOR = '#1a73e8';

function getRouteInfoLineStyle(line) {
    const isSelected = Number.isFinite(selectedRouteInfoLineId) && line?.id === selectedRouteInfoLineId;
    const isNext = Number.isFinite(selectedRouteInfoNextLineId) && line?.id === selectedRouteInfoNextLineId;
    // 링크를 클릭해 짚어보는 기존 디버깅 표시는 그대로 둔다.
    if (isSelected) {
        return { color: '#ef4444', weight: 8, dashArray: null, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    }
    if (isNext) {
        return { color: '#f59e0b', weight: 7, dashArray: null, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    }
    // 약간 반투명하게 그려서 경로가 겹치는 구간은 알파가 누적되어 저절로 더
    // 진하게 보인다 (1겹 0.6 → 2겹 0.84 → 3겹 0.94). 실선이라 점선 위상 문제
    // 없이 깔끔하게 포개진다.
    return {
        color: ROUTE_LINE_NAV_COLOR,
        weight: 7,
        dashArray: null,
        opacity: 0.6,
        lineCap: 'round',
        lineJoin: 'round'
    };
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

