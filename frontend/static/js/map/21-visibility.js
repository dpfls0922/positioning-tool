// ===== 뷰포트/시간 범위 컬링 · 오버레이 표시 갱신 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
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
    rollPitchResetMarkers.forEach(cullPoint);
    mmFeedbackMarkers.forEach(cullPoint);
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
    // 구간단속 HUD 는 타임라인의 현재 끝 시점을 따라간다.
    refreshSdiBlockHud(maxVal);
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

