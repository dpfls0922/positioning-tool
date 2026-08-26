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

        const firstLine = sessionLines[0];
        const lastLine = sessionLines[sessionLines.length - 1];

        // Prefer the request's own [출발지, 경유지..., 목적지] set when available
        const request = findRequestForRouteSession(sessionLines[0]?.extra?.route_session_id);
        let routePointMarkers = buildRoutePointSetMarkers(request, routeLayerName);

        if (routePointMarkers.length === 0) {
            // Fallback: first/last parsed segment endpoints
            routePointMarkers = [
                L.marker(firstLine.start, { icon: buildRoutePointIcon('S', '#16a34a', '출발') })
                    .bindPopup(
                        `<b>${routeLayerName} Start</b><br>` +
                        `Lat: ${Number(firstLine.start[0]).toFixed(7)}<br>` +
                        `Lon: ${Number(firstLine.start[1]).toFixed(7)}`
                    ),
                L.marker(lastLine.end, { icon: buildRoutePointIcon('E', '#dc2626', '도착') })
                    .bindPopup(
                        `<b>${routeLayerName} End</b><br>` +
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
        iconSize: [16, 24],
        iconAnchor: [8, 8],
        html:
            `<div style="display:flex;flex-direction:column;align-items:center">` +
            `<div style="width:16px;height:16px;line-height:16px;text-align:center;background:${bgColor};color:#fff;border-radius:50%;font-size:9px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.25);border:1.5px solid #fff">${label}</div>` +
            `<div style="margin-top:1px;padding:0 3px;background:rgba(15,23,42,0.75);color:#fff;font-size:7px;font-weight:600;border-radius:5px;white-space:nowrap">${subLabel}</div>` +
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
// Points without coordinates are skipped, per-role styling:
//   출발지 S(green) / 경유지 1..N(orange) / 목적지 E(red)
function buildRoutePointSetMarkers(request, layerLabel) {
    const routePoints = request?.extra?.route_points;
    if (!Array.isArray(routePoints) || routePoints.length === 0) return [];

    const markers = [];
    let viaCounter = 0;

    routePoints.forEach((point) => {
        const latLng = routePointToLatLng(point);
        if (!latLng) return;

        let icon;
        if (point.role === '출발지') {
            icon = buildRoutePointIcon('S', '#16a34a', '출발');
        } else if (point.role === '목적지') {
            icon = buildRoutePointIcon('E', '#dc2626', '도착');
        } else {
            viaCounter += 1;
            icon = buildRoutePointIcon(String(viaCounter), '#f59e0b', `경유${viaCounter}`);
        }

        const nameRow = point.name ? `<br>이름: ${escapeHtml(point.name)}` : '';
        const marker = L.marker(latLng, { icon }).bindPopup(
            `<b>${escapeHtml(layerLabel || 'Route')} ${point.role}</b>` +
            `${nameRow}` +
            `<br>Content ID: ${escapeHtml(String(request?.extra?.group_1 ?? '-'))}` +
            `<br>Lat: ${latLng[0].toFixed(7)}<br>Lon: ${latLng[1].toFixed(7)}`
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
    return { color: '#f97316', weight: 4, dashArray: '8 5', opacity: 0.92 };
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

