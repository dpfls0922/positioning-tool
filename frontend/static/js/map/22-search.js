// ===== 검색(DLT ID · ID · 좌표 · RID · 요청 ID) =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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
                <div class="info-title">${infoTitleHtml('MARKER', data.type || 'Unknown', idx + 1)}</div>
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
                <div class="info-title">${infoTitleHtml('LINE', data.type || 'Unknown', idx + 1)}</div>
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

// 입력한 자리수만큼만 비교한다 — '37.544057' 로 검색하면 6자리까지 같은 마커가 걸린다.
function latLonInputPrecision(text) {
    const decimals = String(text || '').match(/\.(\d+)/g) || [];
    const longest = decimals.reduce((max, part) => Math.max(max, part.length - 1), 0);
    return Math.min(Math.max(longest, 4), 7);
}

// 같은 좌표를 가진 마커 찾기. markersData 를 쓰는 이유: GP/차선 버블처럼 전용
// 레이어에서만 그려지는 마커는 markers 배열에 없다.
function findMarkersAtLatLon(lat, lon, precision) {
    const key = (value) => Number(value).toFixed(precision);
    const targetLat = key(lat);
    const targetLon = key(lon);
    const target = L.latLng(lat, lon);

    return (Array.isArray(markersData) ? markersData : []).filter((marker) => {
        const markerLat = Number(marker?.latitude);
        const markerLon = Number(marker?.longitude);
        if (!Number.isFinite(markerLat) || !Number.isFinite(markerLon)) return false;
        if (key(markerLat) === targetLat && key(markerLon) === targetLon) return true;
        // 자리수 반올림 경계에서 갈리는 부동소수 오차 보정
        return target.distanceTo(L.latLng(markerLat, markerLon)) <= 0.5;
    });
}

function buildLatLonResultItem(marker) {
    const div = document.createElement('div');
    div.className = 'info-item marker';

    const rows = [
        ['Type', escapeHtml(String(marker.type || 'Unknown'))],
        ['ID', marker.id ?? '-'],
        ['DLT', marker.dlt_id ?? '-'],
        ['Time', escapeHtml(marker.timestamp_str || '-')],
        ['Lat', Number(marker.latitude).toFixed(7)],
        ['Lon', Number(marker.longitude).toFixed(7)]
    ];
    if (Number.isFinite(marker.heading)) rows.push(['Heading', Number(marker.heading).toFixed(2)]);

    div.innerHTML = `
        <div class="info-title"><span>[MARKER] ${escapeHtml(String(marker.type || 'Unknown'))}</span></div>
        <div class="info-detail">
            ${rows.map(([k, v]) => `<div class="info-row"><span class="info-key">${k}</span><span>${v}</span></div>`).join('')}
        </div>`;
    div.onclick = () => focusMarkerFromTableRow(marker);
    return div;
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

    const precision = latLonInputPrecision(input?.value);
    const matched = findMarkersAtLatLon(parsed.lat, parsed.lon, precision);
    matched.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));

    openSidebar(`좌표 검색 결과 (마커 ${matched.length}개)`);
    infoPanel.innerHTML = `
        <div class="info-item marker">
            <div class="info-title">${infoTitleHtml('COORD', '지정 좌표')}</div>
            <div class="info-detail">
                <div class="info-row"><span class="info-key">Lat</span><span>${parsed.lat.toFixed(7)}</span></div>
                <div class="info-row"><span class="info-key">Lon</span><span>${parsed.lon.toFixed(7)}</span></div>
                <div class="info-row"><span class="info-key">일치 자리수</span><span>소수점 ${precision}자리</span></div>
                <div class="info-row"><span class="info-key">일치 마커</span><span>${matched.length}개</span></div>
            </div>
        </div>
    `;

    if (matched.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:16px; color:#cbd5e1;';
        empty.textContent = '이 좌표와 일치하는 마커가 없습니다.';
        infoPanel.appendChild(empty);
        return;
    }

    matched.forEach((marker) => infoPanel.appendChild(buildLatLonResultItem(marker)));
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
                <div class="info-title">${infoTitleHtml('ROAD', escapeHtml(linkId))}</div>
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
            radius: 6,
            color: '#3b82f6',
            fillColor: '#60a5fa',
            fillOpacity: 0.9,
            weight: 1.5,
            interactive: false
        }).addTo(highlightLayer);

        // Add label for initial location
        L.marker([requestLat, requestLon], {
            icon: L.divIcon({
                className: 'route-label',
                html: '<div style="background:#3b82f6;color:white;padding:1px 4px;border-radius:3px;font-size:9px;font-weight:bold;white-space:nowrap;">시작</div>',
                iconSize: [28, 15],
                iconAnchor: [14, 8]
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
                infoMsg += `${point.role}:${nameText} ${coordText}<br>`;
            });
        } else {
            infoMsg += `<br><b>목적지 위치 (경로 마지막 지점):</b><br>[${destination.lat}, ${destination.lon}]<br>`;
        }

        infoMsg += `<br><b>경로 세그먼트:</b> ${routeInfos.length}개<br>`;
        showInfoMessage(
            'Request 경로 검색 상세 정보',
            infoMsg
        );
    }
}

