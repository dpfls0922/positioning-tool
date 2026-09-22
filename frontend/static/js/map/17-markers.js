// ===== 마커 렌더(DR/주차장/요청 그룹)와 팝업 텍스트 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function drawMarkers(coordinates) {
    markers = [];
    requestGroups = {};

    // Markers are created detached (viewport culling attaches them later),
    // so batches are pure JS work: large batches are safe. Hidden tabs have
    // no frame budget at all, so process even bigger chunks there.
    const BATCH_SIZE = (typeof document !== 'undefined' && document.hidden) ? 20000 : 2000;
    let processedCount = 0;
    const totalCount = coordinates.length;

    function processBatch(startIndex) {
        const endIndex = Math.min(startIndex + BATCH_SIZE, totalCount);

        for (let i = startIndex; i < endIndex; i++) {
            const coord = coordinates[i];
            const coordtype = coord.type;
            // 'Route Info' coords exist only for request-route search; the route
            // itself is drawn as polylines — never as circle markers.
            if (coordtype === 'Route Info') continue;
            // 아래 타입들은 전용 레이어에서만 그린다 (중복 레이어 방지)
            //   GP*        -> visualizeGpGuideFromLog / visualizeLaneBubblesFromLog
            //   Guide Event -> C2X Events / Tmap Incidents (MFS)
            if (coordtype === 'GP Guide' || coordtype === 'GP Lane Color') continue;
            if (coordtype === 'Guide Event') continue;
            if (coordtype === 'GP Lane Bubble') continue;
            //   SDI Event  -> 'SDI Events' (visualizeGuideEventsFromLog)
            if (coordtype === 'SDI Event') continue;
            const latitude = coord.latitude;
            const longitude = coord.longitude;
            if (latitude === undefined || longitude === undefined) continue;

            if (coordtype === 'Request') {
                const key = `${latitude},${longitude}`;
                if (!requestGroups[key]) {
                    requestGroups[key] = {
                        currentIndex: 0,
                        latitude: latitude,
                        longitude: longitude,
                        members: [],
                        marker: [],
                        dlt_id_list: [],
                        timestamp_ms_list: []
                    };
                }
                requestGroups[key].members.push(coord);
                requestGroups[key].dlt_id_list.push(coord.dlt_id);
                requestGroups[key].timestamp_ms_list.push(coord.timestamp_ms);
            } else {
                const popupText = makePopupText(coord, coordtype);
                const isGnssTransitionHighlight = coordtype === 'Filtered GNSS' && !!coord?.extra?.gnss_transition_highlight;
                const useDrHeadingArrow = coordtype === 'DR-based' && drHeadingArrowEnabled;

                // Use color set by backend. MM feedback no longer recolors the
                // DR dot — feedback points live on the 'MM Feedback' ring layer.
                let markerColor = coord.color || 'black';

                const marker = useDrHeadingArrow
                    ? L.marker([latitude, longitude], {
                        icon: buildDrHeadingIcon(coord.heading, markerColor)
                    })
                    : L.circleMarker([latitude, longitude], {
                        radius: isGnssTransitionHighlight ? 6 : 3,
                        color: markerColor,
                        weight: isGnssTransitionHighlight ? 3 : 1,
                        fill: coord.fill,
                        fillOpacity: 0.8
                    });

                marker.dlt_id = coord.dlt_id;
                marker.timestamp_ms = coord.timestamp_ms;
                marker.id = coord.id || 0;
                marker.data = coord;
                marker._isIconMarker = useDrHeadingArrow;
                // MM feedback-corrected / roll-pitch-reset(정차) DR points must
                // never be decimated away
                marker._alwaysShow = coordtype === 'DR-based' &&
                    (!!coord.extra?.mm_feedback || !!coord.extra?.roll_pitch_reset);
                marker._baseStyle = {
                    opacity: 1,
                    fillOpacity: useDrHeadingArrow ? 1 : 0.8,
                    weight: marker.options?.weight ?? 1,
                    radius: useDrHeadingArrow ? null : (marker.options.radius ?? 3)
                };
                attachMarkerDistancePick(marker);
                marker._popupContent = popupText;
                marker.on('click', (e) => {
                    if (inspectMode !== 'marker') {
                        if (inspectMode === 'road') {
                            const latlng = e?.latlng || L.latLng(latitude, longitude);
                            openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                        }
                        if (e) L.DomEvent.stopPropagation(e);
                        return;
                    }
                    if (coordtype === 'DR-based') {
                        selectedDrCoordinate = coord;
                        selectedCandidateLinkIds = extractCandidateLinkIdSet(coord?.extra);
                        refreshDrSelectionStyles(marker);
                        if (roadLinkGeoLayer) {
                            roadLinkGeoLayer.setStyle((feature) => getRoadLinkStyle({
                                ...(feature?.properties || {}),
                                __featureRef: feature
                            }));
                        }
                    }
                    L.popup({ maxWidth: 480 }).setLatLng([latitude, longitude]).setContent(marker._popupContent).openOn(map);
                    if (e) {
                        L.DomEvent.stopPropagation(e);
                    }
                });

                addLayerToGroup(coordtype, marker, { defer: true });
                markers.push(marker);
            }
        }

        processedCount = endIndex;
        if (endIndex < totalCount) {
            scheduleFrame(() => processBatch(endIndex));
        } else {
            drawRequestGroupMarkers(requestGroups, markers);
            refreshDrSelectionStyles();
            addOverlayLayers(featureGroups);
            lastCullState = null;
            scheduleVisibleMarkerRefresh();
            renderLayerControls();
        }
    }

    if (totalCount > 0) {
        processBatch(0);
    } else {
        drawRequestGroupMarkers(requestGroups, markers);
        refreshDrSelectionStyles();
        addOverlayLayers(featureGroups);
        lastCullState = null;
        scheduleVisibleMarkerRefresh();
    }
}

// DR 이벤트 링 레이어 공통 스타일: DR 점(반지름 3) 위에 두 배 크기 링으로
// 얹히는 상태/이벤트 마커. Parking Lot State / Roll/Pitch Reset / MM Feedback
// 세 레이어가 모두 이 팩토리를 사용해 스타일이 통일된다.
const RING_MARKER_STYLE = { radius: 6, weight: 2, fillOpacity: 0.6 };

function createRingMarker(coord, groupName, popupType, alwaysShow) {
    const latitude = coord.latitude;
    const longitude = coord.longitude;
    if (latitude === undefined || longitude === undefined) return null;

    const marker = L.circleMarker([latitude, longitude], {
        radius: RING_MARKER_STYLE.radius,
        color: coord.color || '#808080',
        weight: RING_MARKER_STYLE.weight,
        fill: true,
        fillOpacity: RING_MARKER_STYLE.fillOpacity,
        bubblingMouseEvents: false
    });

    marker.dlt_id = coord.dlt_id;
    marker.timestamp_ms = coord.timestamp_ms;
    marker.id = coord.id || 0;
    marker.data = coord;
    marker._alwaysShow = !!alwaysShow;
    marker._baseStyle = {
        opacity: 1,
        fillOpacity: RING_MARKER_STYLE.fillOpacity,
        weight: RING_MARKER_STYLE.weight,
        radius: RING_MARKER_STYLE.radius
    };
    marker._popupContent = makePopupText(coord, popupType);
    marker.on('click', (e) => {
        if (inspectMode !== 'marker') {
            if (inspectMode === 'road') {
                const latlng = e?.latlng || L.latLng(latitude, longitude);
                openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
            }
            if (e) L.DomEvent.stopPropagation(e);
            return;
        }
        L.popup().setLatLng([latitude, longitude]).setContent(marker._popupContent).openOn(map);
        if (e) L.DomEvent.stopPropagation(e);
    });

    marker._groupName = groupName;
    marker._culledOnMap = false;
    return marker;
}

// Shared batched renderer for ring-marker layers. `assign` receives the
// (initially empty) marker array so the caller's global always points at
// the array being filled.
function drawRingMarkerLayer(coordsData, groupName, popupType, alwaysShow, assign) {
    const collected = [];
    assign(collected);
    if (!coordsData || coordsData.length === 0) {
        return;
    }

    const layerGroup = ensureTmapFeatureGroup(groupName);
    layerGroup.clearLayers();

    // Markers are created detached (viewport culling attaches them later),
    // so batches are pure JS work: large batches are safe. Hidden tabs have
    // no frame budget at all, so process even bigger chunks there.
    const BATCH_SIZE = (typeof document !== 'undefined' && document.hidden) ? 20000 : 2000;
    const totalCount = coordsData.length;

    function processBatch(startIndex) {
        const endIndex = Math.min(startIndex + BATCH_SIZE, totalCount);

        for (let i = startIndex; i < endIndex; i++) {
            const marker = createRingMarker(coordsData[i], groupName, popupType, alwaysShow);
            if (marker) collected.push(marker);
        }

        if (endIndex < totalCount) {
            scheduleFrame(() => processBatch(endIndex));
        } else {
            layerCountOverride[groupName] = collected.length;
            addOverlayLayers(featureGroups);
            lastCullState = null;
            scheduleVisibleMarkerRefresh();
        }
    }

    processBatch(0);
}

function drawParkingLotStateMarkers(coordsData) {
    drawRingMarkerLayer(coordsData, 'Parking Lot State', 'Parking Lot State', false,
        (arr) => { parkingLotStateMarkers = arr; });
}

// Roll/pitch reset (정차) markers: a DR point where the DR estimator
// re-initialized roll/pitch — SetRollPitchFromAccelerometer fires while the
// vehicle is stationary, ResetRollPitch on an MM feedback orientation reset.
function drawRollPitchResetMarkers(coordsData) {
    drawRingMarkerLayer(coordsData, 'Roll/Pitch Reset (정차)', 'Roll/Pitch Reset', true,
        (arr) => { rollPitchResetMarkers = arr; });
}

// MM feedback correction markers: a DR point that was corrected by MM
// feedback (position clamp or heading-only). Replaces the old black/gray
// recoloring of the DR dot itself.
function drawMmFeedbackMarkers(coordsData) {
    drawRingMarkerLayer(coordsData, 'MM Feedback', 'MM Feedback', true,
        (arr) => { mmFeedbackMarkers = arr; });
}

// Re-order the shared canvas draw list so ring-marker layers paint last
// (= on top). Called after each batched render completes; whichever draw
// call finishes last wins, so ring markers always end up above DR-based /
// Road Match markers.
function bringParkingLotMarkersToFront() {
    [mmFeedbackMarkers, rollPitchResetMarkers, parkingLotStateMarkers].forEach((list) => {
        list.forEach((marker) => {
            if (marker._map && typeof marker.bringToFront === 'function') {
                marker.bringToFront();
            }
        });
    });
}

function buildRequestIcon(hasDeviation) {
    const size = 17;
    const glyph = hasDeviation ? '!' : 'i';
    return L.divIcon({
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2],
        html:
            `<div style="width:${size}px;height:${size}px;line-height:${size}px;text-align:center;` +
            `background:#6b7280;color:#fff;border-radius:50%;font-size:11px;font-weight:700;` +
            `font-style:normal;border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)">${glyph}</div>`
    });
}

function drawRequestGroupMarkers(requestGroups, markers) {
    Object.keys(requestGroups).forEach(key => {
        const request = requestGroups[key];
        const latitude = request.latitude;
        const longitude = request.longitude;
        const members = request.members;

        const hasDeviation = members.some(m => m.extra.group_2_text === "이탈");
        // A compact circle rather than an AwesomeMarkers pin: 'small' is that
        // library's smallest preset, and scaling it with a CSS transform would
        // override the transform Leaflet uses to position the marker. This also
        // matches the other route-card icons.
        let marker = L.marker([latitude, longitude], {
            icon: buildRequestIcon(hasDeviation)
        });

        // Same-position requests are merged into one marker; show how many
        // are stacked here so multiple requests from one spot stay visible.
        if (members.length > 1) {
            marker.bindTooltip(`×${members.length}`, {
                permanent: true,
                direction: 'right',
                offset: [9, 0],
                className: 'request-count-badge'
            });
        }

        if (members.length === 1) {
            const coord = members[0];
            marker.dlt_id = coord.dlt_id;
            marker.timestamp_ms = coord.timestamp_ms;
            marker.id = coord.id || 0;
            marker.data = coord;
            marker._popupContent = makePopupText(coord, 'Request');
            marker.on('click', (e) => {
                if (inspectMode !== 'marker') {
                    if (inspectMode === 'road') {
                        const latlng = e?.latlng || L.latLng(latitude, longitude);
                        openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                    }
                    if (e) L.DomEvent.stopPropagation(e);
                    return;
                }
                L.popup().setLatLng([latitude, longitude]).setContent(marker._popupContent).openOn(map);
                if (e) L.DomEvent.stopPropagation(e);
            });
        } else {
            marker.dlt_id = request.dlt_id_list[0];
            marker.timestamp_ms = request.timestamp_ms_list[0];
            marker.id = members[0].id || 0;
            marker.data = members[0];

            const initialContent = `<div style="min-width:100px;">Request (${1}/${members.length})</div>`;
            const popup = L.popup({ autoClose: false, closeOnClick: false }).setContent(initialContent);
            marker.bindPopup(popup);
            marker.on('click', (e) => {
                if (inspectMode !== 'marker') {
                    if (inspectMode === 'road') {
                        const latlng = e?.latlng || L.latLng(latitude, longitude);
                        openNearestRoadPopupAt(latlng, getPreferredRoadKinds());
                    }
                    if (e) L.DomEvent.stopPropagation(e);
                    return;
                }
                if (!request.currentIndex) request.currentIndex = 0;
                showRequestGroupPopup(request, marker);
                if (e) {
                    L.DomEvent.stopPropagation(e);
                }
            });
        }
        marker._isIconMarker = true;
        requestGroups[key].marker = marker;
        attachMarkerDistancePick(marker);
        addLayerToGroup('Request', marker, { defer: true });
        markers.push(marker);
    });
}

function showRequestGroupPopup(request, groupMarker) {
    const members = request.members;
    if (!members || members.length === 0) return;

    const index = request.currentIndex || 0;
    const coord = members[index];

    const popupText = makePopupText(coord, 'Request');
    const content = `
        <div style="min-width:100px;">
            <div style="font-weight:600;">Request (${index + 1}/${members.length})</div>
            ${popupText}
            <div style="margin-top:8px; display:flex; gap:6px; justify-content:flex-end;">
                <button id="req-prev">이전</button>
                <button id="req-next">다음</button>
            </div>
        </div>`;

    let popup = groupMarker.getPopup();
    if (popup) {
        popup.setContent(content);
    }

    groupMarker.openPopup();

    setTimeout(() => {
        const prevBtn = document.getElementById('req-prev');
        const nextBtn = document.getElementById('req-next');
        if (prevBtn) prevBtn.onclick = (e) => {
            e.stopPropagation();
            request.currentIndex = (request.currentIndex - 1 + members.length) % members.length;
            showRequestGroupPopup(request, groupMarker);
        };
        if (nextBtn) nextBtn.onclick = (e) => {
            e.stopPropagation();
            request.currentIndex = (request.currentIndex + 1) % members.length;
            showRequestGroupPopup(request, groupMarker);
        };
    }, 50);
}

function popupRow(key, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="mk-row"><span class="mk-key">${key}</span><span class="mk-val">${value}</span></div>`;
}

/** 팝업 본문. 자주 보는 값만 위에 두고, 나머지는 '상세' 안에 접어둔다. */
function makePopupText(coordinate, coordtype) {
    const dltId = Number.isFinite(coordinate?.dlt_id) ? coordinate.dlt_id : 0;
    const markerId = Number.isFinite(coordinate?.id) ? coordinate.id : '-';
    const lat = Number.isFinite(coordinate?.latitude) ? coordinate.latitude.toFixed(6) : '-';
    const lon = Number.isFinite(coordinate?.longitude) ? coordinate.longitude.toFixed(6) : '-';
    const ts = coordinate?.timestamp_str || '-';

    const head = `
        <div class="mk-head">
            <span class="mk-head-id">DLT ${dltId > 0 ? dltId.toLocaleString() : '-'}</span>
            <span class="mk-head-type">${escapeHtml(coordtype || '')}</span>
        </div>
    `;

    const primary = [
        popupRow('ID', markerId),
        popupRow('시간', escapeHtml(String(ts))),
        popupRow('좌표', `${lat}, ${lon}`),
        Number.isFinite(coordinate?.heading) ? popupRow('방위', `${coordinate.heading.toFixed(1)}°`) : '',
        // 로그 값에 단위가 없어 그대로와 ×3.6 을 같이 보여준다 (m/s ↔ km/h 혼동 방지)
        coordinate?.extra?.Speed !== undefined
            ? popupRow('속도', `${parseFloat(coordinate.extra.Speed).toFixed(1)} m/s · `
                + `${(parseFloat(coordinate.extra.Speed) * 3.6).toFixed(1)} km/h`)
            : ''
    ].join('');

    // 상세: 좌표 타입별 값들. 접혀 있으므로 팝업이 길어지지 않는다.
    const details = [];

    if (coordtype === 'Filtered GNSS') {
        details.push(popupRow('GNSS 모드', escapeHtml(String(coordinate.extra?.gnss_mode || ''))));
        const transition = coordinate.extra?.gnss_mode_transition;
        if (transition?.from && transition?.to) {
            details.push(popupRow('모드 전환', `${escapeHtml(transition.from)} → ${escapeHtml(transition.to)}`));
        }
    }

    if (coordtype === 'DR-based') {
        details.push(popupRow('isDRGps', escapeHtml(String(coordinate.extra?.isDRGps ?? ''))));
        details.push(popupRow('MM Feedback', escapeHtml(String(coordinate.extra?.mm_feedback_reason || ''))));
    }

    if (coordtype === 'MM Feedback') {
        details.push(popupRow('MM Feedback', escapeHtml(String(coordinate.extra?.mm_feedback_reason || ''))));
    }

    if (coordtype === 'DR-based' || coordtype === 'Roll/Pitch Reset') {
        const rollPitchEvents = coordinate.extra?.roll_pitch_reset_events;
        if (Array.isArray(rollPitchEvents)) {
            rollPitchEvents.forEach((event) => {
                const label = event?.event === 'SetRollPitchFromAccelerometer'
                    ? '정차 초기화 (가속도계)'
                    : '정차 초기화 (리셋)';
                details.push(popupRow(label, escapeHtml(String(event?.detail || ''))));
            });
        }
    }

    if (coordtype === 'DR-based' || coordtype === 'Parking Lot State') {
        if (coordinate.extra?.parking_state) {
            details.push(popupRow('주차장 상태', escapeHtml(String(coordinate.extra.parking_state))));
            if (coordtype === 'Parking Lot State' || coordinate.extra.parking_state !== 'ParkingLot') {
                details.push(popupRow('후보 링크', coordinate.extra.parking_candidate_count || 0));
                if (coordinate.extra.parking_best_link_id > 0) {
                    details.push(popupRow('최고 매칭', coordinate.extra.parking_best_link_id));
                }
            }
        }
    }

    if (coordtype === 'Request') {
        details.push(popupRow('Content ID', escapeHtml(String(coordinate.extra?.group_1 ?? '-'))));
        details.push(popupRow('요청 타입', escapeHtml(String(coordinate.extra?.group_2_text ?? ''))));
    }

    if (coordtype === 'Route Match' || coordtype === 'Road Match') {
        const state = coordinate.extra?.match_state || '';
        if (state && state !== 'MATCH_OK_GOOD' && state !== 'MATCH_OK_TRANSIENT') {
            details.push(popupRow('매칭 상태', escapeHtml(state)));
        }
    }

    const candidateHtml = (coordtype === 'DR-based' || coordtype === 'Parking Lot State')
        ? buildCandidateLinkPopupHtml(coordinate?.extra)
        : '';

    const extraRows = details.filter(Boolean).join('');
    const extraBlock = extraRows ? `<div class="mk-rows mk-rows-extra">${extraRows}</div>` : '';

    return `<div class="mk-popup">${head}<div class="mk-rows">${primary}</div>${extraBlock}${candidateHtml}</div>`;
}

