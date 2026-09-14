// ===== DR 선택 스타일 · 폴리라인/폴리곤 렌더 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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
    // 처음엔 모든 레이어가 켜져 있으므로 전체 기준으로 겹침을 센다;
    // 이후 레이어 토글 시 보이는 레이어 기준으로 재계산된다.
    rebuildRouteInfoOverlapCounts(lines);
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
                const overlapCount = getRouteInfoOverlapCount(line);
                const popupRows = [
                    `session: ${extra.route_session_name ?? 'Route Info'}`,
                    ...(overlapCount >= 2 ? [`겹침: ${overlapCount}개 경로선`] : []),
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
                    popupRows.join('<br>') +
                    buildRouteGuideSection(extra.guide);
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

