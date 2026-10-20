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

                // Use color set by backend: DR 점 자체에 이벤트 색이 입혀진다
                // (보라=정차 초기화, 검정/회색=MM 보정, 주황=isDRGps 0).
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

// DR 좌표에서 파생된 상태/이벤트 점 마커 레이어 공통 렌더러.
// Parking Lot State(주차장)와 Roll/Pitch Reset(정차)이 사용하며,
// 각 레이어는 독립적으로 켜고 끌 수 있다.
function drawDerivedPointLayer(coordsData, groupName, popupType, styleFor, alwaysShow, assign) {
    const collected = [];
    assign(collected);
    if (!coordsData || coordsData.length === 0) {
        layerCountOverride[groupName] = 0;
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
            const coord = coordsData[i];
            const latitude = coord.latitude;
            const longitude = coord.longitude;
            if (latitude === undefined || longitude === undefined) continue;

            const marker = L.circleMarker([latitude, longitude], {
                ...styleFor(coord),
                // DR 마커와 같은 markerPane 캔버스에 그려야 bringToFront로
                // DR 점 위에 올릴 수 있다 (pane이 다르면 캔버스가 분리되어
                // 기본 캔버스(z=400)가 markerPane(z=600) 아래에 깔린다).
                pane: 'markerPane',
                bubblingMouseEvents: false
            });

            marker.dlt_id = coord.dlt_id;
            marker.timestamp_ms = coord.timestamp_ms;
            marker.id = coord.id || 0;
            marker.data = coord;
            marker._alwaysShow = !!alwaysShow;
            marker._baseStyle = {
                opacity: marker.options.opacity ?? 1,
                fillOpacity: marker.options.fillOpacity ?? 0.8,
                weight: marker.options.weight ?? 1,
                radius: marker.options.radius ?? 3
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
            collected.push(marker);
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
    drawDerivedPointLayer(coordsData, 'Parking Lot State', 'Parking Lot State',
        (coord) => ({
            radius: 3,
            color: coord.color || '#808080',
            weight: 1,
            fill: true,
            fillOpacity: 0.8
        }), false, (arr) => { parkingLotStateMarkers = arr; });
}

// 정차(roll/pitch 초기화) 지점: 다른 점 마커와 같은 크기/스타일의 보라 마커.
// 항상 DR 점 위에 그려지므로 크기를 키우지 않아도 식별된다.
function drawRollPitchResetMarkers(coordsData) {
    drawDerivedPointLayer(coordsData, 'Roll/Pitch Reset (정차)', 'Roll/Pitch Reset',
        (coord) => ({
            radius: 3,
            color: coord.color || '#7c3aed',
            weight: 1,
            fill: true,
            fillOpacity: 0.8
        }), true, (arr) => { rollPitchResetMarkers = arr; });
}

// Outlier 팝업의 링크 ID: 누르면 그 링크만 하이라이트
function outlierLinkButton(linkId) {
    if (linkId === undefined || linkId === null || linkId === '') return '-';
    const id = escapeHtml(String(linkId));
    return `<a href="#" style="color:#6d28d9;font-weight:600" onclick="event.preventDefault(); highlightOutlierLinks('${id}', '${id}')">${id}</a>`;
}

// Outlier 판정에 쓰인 링크들을 지도에 강조한다. 최근접 링크는 진하게,
// 나머지 후보는 연하게. Road Shape(Link)가 로드되어 있어야 찾을 수 있다.
async function highlightOutlierLinks(idsCsv, nearestId) {
    const ids = String(idsCsv || '').split(',').map((v) => v.trim()).filter(Boolean);
    if (ids.length === 0) return;

    if (!roadLinkGeoLayer && !roadShapeWorker) {
        showInfoMessage('Outlier 후보 링크', 'Road Shape(Link)를 먼저 업로드하면 링크를 하이라이트할 수 있습니다.');
        return;
    }

    highlightLayer.clearLayers();
    const found = [];
    const missing = [];
    for (const id of ids) {
        const match = findRenderedRoadLinkByRid(id) || await requestRoadLinkByRid(id);
        if (!match?.feature) {
            missing.push(id);
            continue;
        }
        const isNearest = String(id) === String(nearestId);
        L.geoJSON(match.feature, {
            style: {
                color: '#4c1d95',
                weight: isNearest ? 8 : 5,
                opacity: isNearest ? 0.75 : 0.4,
                dashArray: isNearest ? null : '6 4'
            },
            interactive: false
        }).addTo(highlightLayer);
        found.push(id);
    }

    if (missing.length > 0) {
        showInfoMessage('Outlier 후보 링크',
            `하이라이트 ${found.length}개 · 찾지 못한 링크: ${missing.map(escapeHtml).join(', ')}`
            + (found.length === 0 ? '<br>Road Shape에 해당 링크가 없거나 아직 로드되지 않았습니다.' : ''));
    }
}

// GnssFilter가 outlier로 버린 Raw GNSS 지점: 진한 보라 링을 Raw GNSS 점 위에
// 겹쳐 그린다 (Raw GNSS 행의 하위 레이어). DR 계열(빨강/주황/검정)과 구분되는
// 색. 솎아내기 없이 항상 표시.
const GNSS_OUTLIER_COLOR = '#4c1d95';
const GNSS_OUTLIER_LAYER = 'GNSS Outlier (제거)';
function drawGnssOutlierMarkers(coordsData) {
    drawDerivedPointLayer(coordsData, GNSS_OUTLIER_LAYER, 'GNSS Outlier',
        (coord) => ({
            radius: 5,
            color: GNSS_OUTLIER_COLOR,
            weight: 2,
            // 반투명: 아래 Raw GNSS 점과 주변 궤적이 비쳐 보이게
            opacity: 0.6,
            fill: false
        }), true, (arr) => { gnssOutlierMarkers = arr; });
}

// Re-order the shared canvas draw list after each batched render: derived
// point layers paint above DR-based / Road Match markers, and _alwaysShow
// DR dots (MM feedback) stay on top of stacked stationary points.
// Roll/Pitch Reset(정차) 마커는 마지막에 올려 DR 점보다 항상 위에 보인다.
function bringParkingLotMarkersToFront() {
    markers.forEach((marker) => {
        if (marker._alwaysShow && marker._map && typeof marker.bringToFront === 'function') {
            marker.bringToFront();
        }
    });
    [parkingLotStateMarkers, rollPitchResetMarkers, gnssOutlierMarkers].forEach((list) => {
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

    // GnssFilter outlier 판정 (benz-ivi3 GnssFilter::classifyGnssOutlier)
    //   width = max(1, round(extLane / 2)) × 5m, 후보셋 center 60m 이내에서만 판정
    if (coordtype === 'Raw GNSS' || coordtype === 'GNSS Outlier') {
        const outlier = coordinate.extra?.gnss_outlier;
        if (outlier) {
            const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '-');
            details.push(popupRow('Outlier', '<b style="color:#6d28d9">rejected (GNSS 미사용)</b>'));
            const nearestId = outlier.nearest_link_id;
            const candidateIds = Array.isArray(outlier.candidate_link_ids) ? outlier.candidate_link_ids : [];
            details.push(popupRow('최근접 링크', `${outlierLinkButton(nearestId)} · extLane ${escapeHtml(String(outlier.ext_lane ?? '-'))}`));
            details.push(popupRow('후보 링크',
                candidateIds.length > 0
                    ? candidateIds.map(outlierLinkButton).join(' ')
                    : '<span style="opacity:.7">로그에 목록 없음 (최근접만)</span>'));
            const allIds = [...new Set([nearestId, ...candidateIds].filter((v) => v !== undefined && v !== null))];
            details.push(popupRow('하이라이트',
                `<button type="button" class="gp-guidance-open" onclick="highlightOutlierLinks('${allIds.join(',')}', '${escapeHtml(String(nearestId ?? ''))}')">후보 링크 전체 보기</button>`));
            details.push(popupRow('링크 거리 / 허용폭', `${fmt(outlier.dist_m)} m > ${fmt(outlier.width_m)} m`));
            details.push(popupRow('후보 center 거리', `${fmt(outlier.center_dist_m)} m (≤ 60 m)`));
            details.push(popupRow('후보 링크 수', escapeHtml(String(outlier.link_count ?? '-'))));
        }
        const outlierTransition = coordinate.extra?.gnss_outlier_transition;
        if (outlierTransition?.from && outlierTransition?.to) {
            details.push(popupRow('Outlier 상태', `${escapeHtml(outlierTransition.from)} → ${escapeHtml(outlierTransition.to)}`));
        }
    }

    if (coordtype === 'DR-based') {
        details.push(popupRow('isDRGps', escapeHtml(String(coordinate.extra?.isDRGps ?? ''))));
        details.push(popupRow('MM Feedback', escapeHtml(String(coordinate.extra?.mm_feedback_reason || ''))));
    }

    // DR 점과 정차(Roll/Pitch Reset) 마커 공통: 초기화/보정 변화량 상세
    if (coordtype === 'DR-based' || coordtype === 'Roll/Pitch Reset') {
        // 보정/초기화 직후 궤적이 얼마나 움직였는지 (직전 DR 좌표 대비)
        const extra = coordinate.extra || {};
        if (Number.isFinite(extra.delta_dist_m)) {
            details.push(popupRow('이동 (직전 DR 대비)', `${extra.delta_dist_m.toFixed(2)} m`));
        }
        if (Number.isFinite(extra.delta_heading_deg)) {
            details.push(popupRow('헤딩 변화 (직전 DR)', `${extra.delta_heading_deg.toFixed(1)}°`));
        }
        if (Number.isFinite(extra.feedback_heading_delta)) {
            details.push(popupRow('피드백 헤딩 보정량', `${extra.feedback_heading_delta.toFixed(1)}°`));
        }

        const rollPitchEvents = extra.roll_pitch_reset_events;
        if (Array.isArray(rollPitchEvents)) {
            rollPitchEvents.forEach((event) => {
                const isAccel = event?.event === 'SetRollPitchFromAccelerometer';
                const label = isAccel ? '정차 초기화 (가속도계)' : '정차 초기화 (리셋)';
                const v = event?.values || {};
                let desc;
                if (Number.isFinite(v.before_roll) && Number.isFinite(v.after_roll)) {
                    const dRoll = Number.isFinite(event.delta_roll) ? event.delta_roll : (v.after_roll - v.before_roll);
                    const dPitch = Number.isFinite(event.delta_pitch) ? event.delta_pitch : ((v.after_pitch ?? 0) - (v.before_pitch ?? 0));
                    desc = `roll ${v.before_roll.toFixed(2)}→${v.after_roll.toFixed(2)} (Δ${dRoll >= 0 ? '+' : ''}${dRoll.toFixed(2)}°)`
                        + `, pitch ${Number.isFinite(v.before_pitch) ? v.before_pitch.toFixed(2) : '-'}→${Number.isFinite(v.after_pitch) ? v.after_pitch.toFixed(2) : '-'}`
                        + ` (Δ${dPitch >= 0 ? '+' : ''}${dPitch.toFixed(2)}°)`;
                } else if (Number.isFinite(v.roll)) {
                    desc = `roll→${v.roll.toFixed(1)}°, pitch→${Number.isFinite(v.pitch) ? v.pitch.toFixed(1) : '-'}° 리셋`
                        + `${Number.isFinite(v.heading) ? `, heading ${v.heading.toFixed(1)}°` : ''}`;
                } else {
                    desc = String(event?.detail || '');
                }
                details.push(popupRow(label, escapeHtml(desc)));
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

