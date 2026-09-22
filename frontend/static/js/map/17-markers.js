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

// 상태 구간을 궤적 밑에 깔리는 반투명 띠(폴리라인)로 그리는 공통 렌더러.
// 띠 채움 위에 얇은 실선 테두리를 겹쳐 그려 구간 경계를 또렷하게 한다.
// Parking Lot State(주차장)와 GNSS Mode(Normal/BusSleep)가 사용한다.
const STATE_BAND_STYLE = { weight: 14, fillOpacity: 0.45, outlineWeight: 1.5 };

function drawStateBandLayer(bandsData, groupName, stateLabelFor, assign) {
    const collected = [];
    assign(collected);
    if (!bandsData || bandsData.length === 0) {
        layerCountOverride[groupName] = 0;
        return;
    }

    const group = ensureTmapFeatureGroup(groupName);
    group.clearLayers();
    let bandCount = 0;

    bandsData.forEach((band) => {
        const points = (band.points || []).filter((pt) =>
            Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
        if (points.length === 0) return;
        bandCount += 1;

        const outlineColor = band.outline_color || band.color;
        let fillLayer;
        let outlineLayer = null;

        if (points.length === 1) {
            // 점이 하나뿐인 구간은 짧은 띠 대신 같은 색 원판으로 그린다.
            fillLayer = L.circleMarker(points[0], {
                radius: 9,
                stroke: true,
                color: outlineColor,
                weight: STATE_BAND_STYLE.outlineWeight,
                opacity: 0.9,
                fill: true,
                fillColor: band.color,
                fillOpacity: STATE_BAND_STYLE.fillOpacity,
                bubblingMouseEvents: false
            });
        } else {
            // 테두리: 채움보다 살짝 넓은 진한 실선을 아래에 깔아 가장자리만 보이게 한다.
            outlineLayer = L.polyline(points, {
                color: outlineColor,
                weight: STATE_BAND_STYLE.weight + STATE_BAND_STYLE.outlineWeight * 2,
                opacity: 0.85,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false,
                bubblingMouseEvents: false
            });
            fillLayer = L.polyline(points, {
                color: band.color,
                weight: STATE_BAND_STYLE.weight,
                opacity: STATE_BAND_STYLE.fillOpacity,
                lineCap: 'round',
                lineJoin: 'round',
                bubblingMouseEvents: false
            });
        }

        fillLayer.dlt_id = band.start_dlt_id;
        fillLayer.timestamp_ms = band.start_timestamp_ms;
        fillLayer.id = band.id || 0;
        fillLayer.data = band;
        fillLayer._groupName = groupName;
        fillLayer._bandRole = 'fill';

        const rows = [
            popupRow('상태', escapeHtml(stateLabelFor(band))),
            popupRow('시작', escapeHtml(String(band.start_timestamp_str || '-'))),
            popupRow('끝', escapeHtml(String(band.end_timestamp_str || '-'))),
            popupRow('점 개수', points.length),
            popupRow('DLT', `${band.start_dlt_id ?? '-'} ~ ${band.end_dlt_id ?? '-'}`)
        ].join('');
        fillLayer._popupContent = `<div class="mk-popup"><div class="mk-head">`
            + `<span class="mk-head-type">${escapeHtml(groupName)}</span></div>`
            + `<div class="mk-rows">${rows}</div></div>`;

        fillLayer.on('click', (e) => {
            if (inspectMode !== 'marker') {
                if (inspectMode === 'road' && e?.latlng) {
                    openNearestRoadPopupAt(e.latlng, getPreferredRoadKinds());
                }
                if (e) L.DomEvent.stopPropagation(e);
                return;
            }
            const latlng = e?.latlng || L.latLng(points[0][0], points[0][1]);
            L.popup().setLatLng(latlng).setContent(fillLayer._popupContent).openOn(map);
            if (e) L.DomEvent.stopPropagation(e);
        });

        if (outlineLayer) {
            outlineLayer._groupName = groupName;
            outlineLayer._bandRole = 'outline';
            group.addLayer(outlineLayer);
            collected.push(outlineLayer);
        }
        group.addLayer(fillLayer);
        collected.push(fillLayer);
    });

    layerCountOverride[groupName] = bandCount;
    addOverlayLayers(featureGroups);
    lastCullState = null;
    scheduleVisibleMarkerRefresh();
}

function drawParkingLotStateBands(bandsData) {
    drawStateBandLayer(bandsData, 'Parking Lot State', (band) => (
        band.state_group === 'ParkingLot'
            ? '주차장 모드'
            : `진입 후보/준비 (${(band.states || []).join(', ')})`
    ), (arr) => { parkingLotStateBands = arr; });
}

function drawGnssModeBands(bandsData) {
    drawStateBandLayer(bandsData, 'GNSS Mode', (band) => (
        (band.states || []).join(', ') || band.state_group || '-'
    ), (arr) => { gnssModeBands = arr; });
}

// Re-order the shared canvas draw list after each batched render: state bands
// sink below the point markers so the 띠 never covers the trace. Fills go
// back first, then outlines, so each outline ends up under its fill.
// 이벤트 색 DR 점(_alwaysShow: 정차 초기화/MM feedback)은 맨 위로 올린다 —
// 정차 구간은 같은 좌표에 DR 점이 겹겹이 쌓여서, 이벤트 이후에 찍힌 빨간
// 점들이 나중에 그려지며 보라/검정 점을 덮는다 (줌아웃에선 솎아내기가 겹친
// 점을 지워 보였지만, 줌인하면 전부 그려져 이벤트 점이 밑에 깔렸다).
function bringParkingLotMarkersToFront() {
    [parkingLotStateBands, gnssModeBands].forEach((list) => {
        list.forEach((layer) => {
            if (layer._map && layer._bandRole === 'fill' && typeof layer.bringToBack === 'function') {
                layer.bringToBack();
            }
        });
        list.forEach((layer) => {
            if (layer._map && layer._bandRole === 'outline' && typeof layer.bringToBack === 'function') {
                layer.bringToBack();
            }
        });
    });
    markers.forEach((marker) => {
        if (marker._alwaysShow && marker._map && typeof marker.bringToFront === 'function') {
            marker.bringToFront();
        }
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

