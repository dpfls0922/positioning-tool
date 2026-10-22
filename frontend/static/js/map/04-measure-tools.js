// ===== 거리 측정 · 반경 측정 도구 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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

