// ===== 부트스트랩(init) · 타임 슬라이더 · 렌더 진입점 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function init() {
    console.log(`[positioning-tool] frontend build: ${FRONTEND_BUILD}`);
    // Initialize data variables
    if (typeof markersData === 'undefined') markersData = [];
    if (typeof parkingLotStateMarkersData === 'undefined') parkingLotStateMarkersData = [];
    if (typeof rollPitchResetMarkersData === 'undefined') rollPitchResetMarkersData = [];
    if (typeof mmFeedbackMarkersData === 'undefined') mmFeedbackMarkersData = [];
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
    initOmnibox();
    initSimulation();
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
    // 새 파싱 결과가 들어오면 모의주행 궤적도 버린다(이전 로그를 계속 주행하는 문제).
    resetSimulationForNewData();
    drawMarkers(markersData);
    drawParkingLotStateMarkers(parkingLotStateMarkersData);
    drawRollPitchResetMarkers(rollPitchResetMarkersData);
    drawMmFeedbackMarkers(mmFeedbackMarkersData);
    drawPolylines(linesData);
    addControlLayers();
    renderLayerControls();
    renderMarkerTable();
    focusOnInitialView();
    updateMap();

    // Visualize guide events from log (C2X, Accident) and route guide points (GP)
    setTimeout(() => {
        visualizeGuideEventsFromLog();
        visualizeGpGuideFromLog();
        visualizeLaneBubblesFromLog();
    }, 100);
}

