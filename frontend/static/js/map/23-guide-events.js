// ===== 하이라이트 · 안내 이벤트(C2X/MFS/SDI) 시각화 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function highlightMarker(marker) {
    L.circleMarker(marker.getLatLng(), {
        radius: 12,
        color: 'red',
        fillColor: 'yellow',
        fillOpacity: 0.5,
        weight: 3,
        interactive: false
    }).addTo(highlightLayer);
}

function highlightLine(lineLayer) {
    L.polyline(lineLayer.getLatLngs(), {
        color: 'red',
        weight: 6,
        opacity: 0.5,
        interactive: false
    }).addTo(highlightLayer);
}

// ============================================================================
// C2X Events & Traffic Incident Visualization
// ============================================================================

const EVENT_ICON_MAP = {
    'A': { name: '사고', color: '#ef4444', icon: '🚨' },
    'B': { name: '공사', color: '#f59e0b', icon: '🚧' },
    'C': { name: '행사', color: '#8b5cf6', icon: '🎉' },
    'D': { name: '재해', color: '#dc2626', icon: '⚠️' },
    'E': { name: '통제', color: '#059669', icon: '🛑' },
};

const SDI_TYPE_MAP = {
    0: { name: '신호과속', color: '#ef4444', text: '🚨', desc: '신호 과속 단속카메라' },
    1: { name: '과속 고정식', color: '#f59e0b', text: '📷', desc: '과속 단속카메라(고정식)' },
    2: { name: '구간단속 시작', color: '#ea580c', text: '시', desc: '구간속도 단속 시작' },
    3: { name: '구간단속 끝', color: '#f97316', text: '끝', desc: '구간속도 단속 종료' },
    4: { name: '구간단속중', color: '#fb923c', text: '중', desc: '구간속도 단속 중' },
    5: { name: '꼬리물기단속', color: '#fbbf24', text: '꼬', desc: '꼬리물기 단속카메라' },
    6: { name: '신호단속', color: '#dc2626', text: '🚥', desc: '신호 단속카메라' },
    7: { name: '과속 이동식', color: '#f59e0b', text: '이', desc: '과속 단속카메라(이동식)' },
    8: { name: '박스형 과속', color: '#d946ef', text: '📦', desc: '박스형 과속위험 구간' },
    9: { name: '후면 사고', color: '#be123c', text: '←', desc: '속도 사고 후면' },
    10: { name: '후면 제한', color: '#f43f5e', text: '←', desc: '속도 제한 후면' },
    11: { name: '버스전용차로', color: '#a855f7', text: '🚌', desc: '버스 전용 차로 구간' },
    12: { name: '가변차로', color: '#9333ea', text: '🔄', desc: '가변 차로 단속' },
    13: { name: '갓길감시', color: '#7c3aed', text: '📸', desc: '갓길 감시 지점' },
    14: { name: '끼어들기금지', color: '#6366f1', text: '⛔', desc: '끼어들기 금지 구간' },
    15: { name: '교통정보수집', color: '#06b6d4', text: '📊', desc: '교통정보 수집지점' },
    16: { name: '방범CCTV', color: '#0891b2', text: '🎥', desc: '방범용 CCTV' },
    17: { name: '과적차량', color: '#f59e0b', text: '⚖️', desc: '과적차량 위험구간' },
    18: { name: '적재불량', color: '#ea580c', text: '📦', desc: '적재 불량 단속' },
    19: { name: '주차단속', color: '#8b5cf6', text: '🚗', desc: '주차 단속 지점' },
    20: { name: '일방통행', color: '#7c3aed', text: '→', desc: '일방통행 도로' },
    21: { name: '철도건널목', color: '#dc2626', text: '🚂', desc: '철도 건널목' },
    22: { name: '스쿨존 시작', color: '#ec4899', text: '🏫', desc: '어린이보호구역 시작' },
    23: { name: '스쿨존 끝', color: '#f43f5e', text: '🏫', desc: '어린이보호구역 종료' },
    24: { name: '과속방지턱', color: '#06b6d4', text: '⌣', desc: '과속방지턱' },
    25: { name: 'LPG충전소', color: '#14b8a6', text: '⛽', desc: 'LPG 충전소' },
    26: { name: '터널구간', color: '#0f766e', text: '🚇', desc: '터널 구간' },
    27: { name: '휴게소', color: '#22c55e', text: '🛑', desc: '휴게소' },
    28: { name: '톨게이트', color: '#16a34a', text: '💳', desc: '톨게이트' },
    29: { name: '안개주의', color: '#9ca3af', text: '☁️', desc: '안개주의 지역' },
    30: { name: '유해물질', color: '#6b7280', text: '☣️', desc: '유해물질 지역' },
    31: { name: '사고다발', color: '#ef4444', text: '⚠️', desc: '사고다발 지역' },
    32: { name: '급경사구간', color: '#f59e0b', text: '⬇️', desc: '급경사 구간' },
    33: { name: '급커브지역', color: '#d97706', text: '↪', desc: '급한 커브 지역' },
    34: { name: '신규급커브', color: '#ea580c', text: '↪', desc: '신규 급커브 구간' },
    35: { name: '야생동물', color: '#7c3aed', text: '🦌', desc: '야생동물 교통사고 잦은 구간' },
    36: { name: '우측시야불량', color: '#8b5cf6', text: '👁️', desc: '우측 시야 불량 지점' },
    37: { name: '시야불량', color: '#9333ea', text: '👁️', desc: '시야 불량 지점' },
    38: { name: '좌측시야불량', color: '#a855f7', text: '👁️', desc: '좌측 시야 불량 지점' },
    39: { name: '신호위반다발', color: '#dc2626', text: '🚥', desc: '신호위반 다발 구간' },
    40: { name: '과속운행다발', color: '#ef4444', text: '🏃', desc: '과속운행 다발 구간' },
    41: { name: '교통혼잡지역', color: '#f59e0b', text: '🚗', desc: '교통혼잡 지역' },
    42: { name: '방향별차로', color: '#3b82f6', text: '🔀', desc: '방향별 차로 선택 지점' },
    43: { name: '무단횡단', color: '#dc2626', text: '🚶', desc: '무단횡단 사고 다발 지점' },
    44: { name: '갓길사고다발', color: '#be123c', text: '📍', desc: '갓길 사고 다발 지점' },
    45: { name: '과속사고다발', color: '#ef4444', text: '⚡', desc: '과속 사고 다발 지점' },
    46: { name: '졸음사고다발', color: '#b91c1c', text: '😴', desc: '졸음 사고 다발 지점' },
    47: { name: '사고다발지점', color: '#dc2626', text: '📍', desc: '사고 다발 지점' },
    48: { name: '보행자사고다발', color: '#ef4444', text: '🚶', desc: '보행자 사고 다발 지점' },
    49: { name: '실버존', color: '#a855f7', text: '👴', desc: '노인보호 구역' },
    50: { name: '차량도난', color: '#8b5cf6', text: '🚗', desc: '차량도난 사고 다발 지점' },
    51: { name: '낙석주의', color: '#78350f', text: '🪨', desc: '낙석 주의 지역' },
    52: { name: '결빙주의', color: '#0ea5e9', text: '❄️', desc: '결빙 주의 지역' },
    53: { name: '병목지점', color: '#f59e0b', text: '⚠️', desc: '병목 지점' },
    54: { name: '합류도로', color: '#3b82f6', text: '➕', desc: '합류 도로' },
    55: { name: '추락주의', color: '#dc2626', text: '⬇️', desc: '추락 주의 지역' },
    56: { name: '지하차도', color: '#1f2937', text: '🚇', desc: '지하차도 구간' },
    57: { name: '주택밀집', color: '#6366f1', text: '🏘️', desc: '주택밀집 교통진정지역' },
    58: { name: '인터체인지', color: '#3b82f6', text: '🔀', desc: '인터체인지' },
    59: { name: '분기점', color: '#0ea5e9', text: '⛔', desc: '분기점' },
    60: { name: '휴게소LPG', color: '#10b981', text: '⛽', desc: '휴게소(LPG충전가능)' },
    61: { name: '교량', color: '#06b6d4', text: '🌉', desc: '교량' },
    62: { name: '제동장치사고', color: '#dc2626', text: '🛑', desc: '제동장치 사고 다발 지점' },
    63: { name: '중앙선침범', color: '#ef4444', text: '↔️', desc: '중앙선 침범 사고 다발 지점' },
    64: { name: '통행위반', color: '#be123c', text: '🚫', desc: '통행위반 사고 다발 지점' },
    65: { name: '목적지건너편', color: '#8b5cf6', text: '🔄', desc: '목적지 건너편 안내' },
    66: { name: '졸음쉼터', color: '#10b981', text: '😴', desc: '졸음 쉼터 안내' },
    67: { name: '노후경유차', color: '#059669', text: '💨', desc: '노후경유차 단속' },
    68: { name: '터널차로변경', color: '#0f766e', text: '🔄', desc: '터널내 차로변경 단속' },
};

function getEventIconConfig(typeCode) {
    return EVENT_ICON_MAP[typeCode] || { name: '기타', color: '#6b7280', icon: '📍' };
}

function getSdiIconConfig(sdiType) {
    return SDI_TYPE_MAP[sdiType] || { name: `기타 안내`, color: '#64748b', text: '⚙️', desc: `SDI Type ${sdiType}` };
}

function createEventMarkerIcon(typeCode, iconText = null) {
    const config = getEventIconConfig(typeCode);
    const iconHtml = `
        <div style="
            background-color: ${config.color};
            color: white;
            border-radius: 50%;
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            border: 1.5px solid white;
            box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        ">
            ${iconText || config.icon}
        </div>
    `;
    return L.divIcon({
        html: iconHtml,
        className: 'event-marker',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -11]
    });
}

function createSdiMarkerIcon(sdiType) {
    const config = getSdiIconConfig(sdiType);
    const iconHtml = `
        <div style="
            background: linear-gradient(135deg, ${config.color} 0%, ${config.color}dd 100%);
            color: white;
            border-radius: 50%;
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: bold;
            border: 1.5px solid white;
            box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        ">
            ${config.text}
        </div>
    `;
    return L.divIcon({
        html: iconHtml,
        className: 'sdi-marker',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -11]
    });
}

function renderTrafficIncidents(tvasResult) {
    if (!tvasResult || !tvasResult.incidents || tvasResult.incidents.length === 0) {
        return;
    }

    const eventGroup = ensureTmapFeatureGroup('Traffic Events');
    const coords = resolveVertexCoordinates(tvasResult);
    const coordMap = new Map();
    coords.forEach((coord, idx) => {
        coordMap.set(idx, { lat: coord.lat, lon: coord.lon });
    });

    tvasResult.incidents.forEach((incident) => {
        const vxCoord = coordMap.get(incident.startVxIdx);
        if (!vxCoord) return;

        const eventIcon = createEventMarkerIcon(incident.typeCode);
        const typeConfig = getEventIconConfig(incident.typeCode);
        const marker = L.marker([vxCoord.lat, vxCoord.lon], { icon: eventIcon });

        marker.bindPopup(`
            <div style="min-width: 200px;">
                <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                    ${typeConfig.icon} ${typeConfig.name}
                </div>
                <div style="font-size: 12px;">
                    <div><strong>종류:</strong> ${typeConfig.name}</div>
                    <div><strong>위치 Index:</strong> ${incident.startVxIdx}</div>
                    ${incident.content ? `<div><strong>내용:</strong> ${escapeHtml(incident.content)}</div>` : ''}
                </div>
            </div>
        `);

        eventGroup.addLayer(marker);
    });

    renderLayerControls();
}

function renderDangerAreas(tvasResult) {
    if (!tvasResult || !tvasResult.dangerAreas || tvasResult.dangerAreas.length === 0) {
        return;
    }

    const dangerGroup = ensureTmapFeatureGroup('Danger Areas');
    const coords = resolveVertexCoordinates(tvasResult);
    const coordMap = new Map();
    coords.forEach((coord, idx) => {
        coordMap.set(idx, { lat: coord.lat, lon: coord.lon });
    });

    const DANGER_TYPE_MAP = {
        1: { name: '급커브', color: '#f97316', icon: '🔄' },
        2: { name: '스쿨존', color: '#0ea5e9', icon: '🏫' },
        3: { name: '철도건널목', color: '#8b5cf6', icon: '🚂' },
        4: { name: '속도범프', color: '#ec4899', icon: '⬆️' },
        5: { name: '사고다발지', color: '#dc2626', icon: '⚠️' },
    };

    tvasResult.dangerAreas.forEach((area) => {
        const startCoord = coordMap.get(area.startVxIdx);
        const endCoord = coordMap.get(area.endVxIdx);

        if (!startCoord || !endCoord) return;

        const typeConfig = DANGER_TYPE_MAP[area.type] || { name: '위험구간', color: '#6b7280', icon: '📍' };
        const latlngs = [
            [startCoord.lat, startCoord.lon],
            [endCoord.lat, endCoord.lon]
        ];

        const polyline = L.polyline(latlngs, {
            color: typeConfig.color,
            weight: 3,
            opacity: 0.6,
            dashArray: '5, 5'
        });

        polyline.bindPopup(`
            <div style="min-width: 150px;">
                <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                    ${typeConfig.icon} ${typeConfig.name}
                </div>
                <div style="font-size: 12px;">
                    <div><strong>구간:</strong> ${area.startVxIdx} ~ ${area.endVxIdx}</div>
                    <div><strong>거리:</strong> ${area.sectionLength}m</div>
                    ${area.speedLimit > 0 ? `<div><strong>제한속도:</strong> ${area.speedLimit}km/h</div>` : ''}
                </div>
            </div>
        `);

        dangerGroup.addLayer(polyline);

        const midCoord = {
            lat: (startCoord.lat + endCoord.lat) / 2,
            lon: (startCoord.lon + endCoord.lon) / 2
        };
        const marker = L.marker([midCoord.lat, midCoord.lon], {
            icon: createEventMarkerIcon(null, typeConfig.icon)
        });
        dangerGroup.addLayer(marker);
    });

    renderLayerControls();
}

function renderTmapRouteResultWithEvents(routeResponse) {
    renderTmapRouteResult(routeResponse);

    if (!tmapRouteResult || !tmapRouteResult.tvasResult) {
        return;
    }

    setTimeout(() => {
        renderTrafficIncidents(tmapRouteResult.tvasResult);
        renderDangerAreas(tmapRouteResult.tvasResult);
    }, 100);
}

// MFS 유고정보 name → 이벤트 타입 코드 (사고/공사/행사/재해/통제)
function mfsNameToEventCode(name) {
    const s = String(name || '');
    if (s.includes('사고')) return 'A';
    if (s.includes('공사')) return 'B';
    if (s.includes('행사')) return 'C';
    if (s.includes('재해')) return 'D';
    if (s.includes('통제')) return 'E';
    return null;
}

function visualizeGuideEventsFromLog() {
    if (!Array.isArray(markersData) || markersData.length === 0) {
        console.log('❌ visualizeGuideEventsFromLog: No markers data');
        return;
    }

    const guideMarkers = markersData.filter((m) => m.extra?.guide_event);
    const sdiMarkers = markersData.filter((m) => m.extra?.sdi_event);
    const c2xEvents = guideMarkers.filter((m) => m.extra.event_type === 'C2X');
    const mfsEvents = guideMarkers.filter((m) => m.extra.event_type === 'MFS');
    console.log(`📊 Guide Events: ${c2xEvents.length} C2X, ${mfsEvents.length} MFS(유고정보), SDI: ${sdiMarkers.length}`);

    if (guideMarkers.length === 0) {
        return;
    }

    // C2X 이벤트 (V2X 통신 수신 — EventPos 좌표)
    if (c2xEvents.length > 0) {
        const c2xGroup = ensureTmapFeatureGroup('C2X Events');
        c2xGroup.clearLayers();

        c2xEvents.forEach((marker) => {
            const icon = createEventMarkerIcon(null, '📡');
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 200px;">
                    <div style="font-weight: bold; color: #3b82f6; margin-bottom: 8px;">
                        📡 가이드 이벤트 (Guide Event) - C2X
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
                        V2X 통신으로 수신한 위험정보
                    </div>
                    <div style="font-size: 12px;">
                        <div><strong>Event ID:</strong> ${escapeHtml(String(marker.extra.event_id))}</div>
                        <div><strong>Event Type(CC):</strong> ${marker.extra.event_type_code ?? '-'}</div>
                        ${marker.extra.event_time ? `<div><strong>Event Time:</strong> ${escapeHtml(marker.extra.event_time)}</div>` : ''}
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>Log Time:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            c2xGroup.addLayer(markerObj);
        });
    }

    // TMAP 유고정보 (MFS — 서버 Point.location 좌표)
    if (mfsEvents.length > 0) {
        const mfsGroup = ensureTmapFeatureGroup('Tmap Incidents (MFS)');
        mfsGroup.clearLayers();

        mfsEvents.forEach((marker) => {
            const code = mfsNameToEventCode(marker.extra.name);
            const typeConfig = getEventIconConfig(code);
            const icon = createEventMarkerIcon(code);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 220px;">
                    <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                        ${typeConfig.icon} 가이드 이벤트 (Guide Event) - MFS
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
                        TMAP 유고정보 (Map Feature Service)
                    </div>
                    <div style="font-size: 12px;">
                        <div><strong>이벤트명:</strong> ${escapeHtml(marker.extra.name || typeConfig.name)}</div>
                        <div><strong>Key:</strong> ${escapeHtml(String(marker.extra.event_id))}</div>
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>Log Time:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            mfsGroup.addLayer(markerObj);
        });
    }

    // SDI Events (Safety Drive Information — 카메라, 과속방지턱 등)
    if (sdiMarkers.length > 0) {
        const sdiGroup = ensureTmapFeatureGroup('SDI Events');
        sdiGroup.clearLayers();

        sdiMarkers.forEach((marker) => {
            const icon = createSdiMarkerIcon(marker.extra.sdi_type);
            const config = getSdiIconConfig(marker.extra.sdi_type);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 240px;">
                    <div style="font-weight: bold; color: ${config.color}; margin-bottom: 8px; font-size: 14px;">
                        🛣️ ${config.name}
                    </div>
                    <div style="font-size: 12px; line-height: 1.6;">
                        <div style="background-color: ${config.color}20; padding: 6px; border-radius: 4px; margin-bottom: 8px; color: ${config.color}; font-weight: bold;">
                            ${config.desc}
                        </div>
                        <div><strong>타입 코드:</strong> ${marker.extra.sdi_type}</div>
                        ${marker.extra.speed ? `<div><strong>제한속도:</strong> ${marker.extra.speed} km/h</div>` : ''}
                        <div><strong>정보원:</strong> ${marker.extra.source}</div>
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>기록시간:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            sdiGroup.addLayer(markerObj);
        });
    }

    // Parking Lot State Transitions
    const parkingLotMarkers = markersData.filter((m) => m.extra?.event_type === 'ParkingLot');
    if (parkingLotMarkers.length > 0) {
        const parkingGroup = ensureTmapFeatureGroup('Parking Lot State');
        parkingGroup.clearLayers();

        parkingLotMarkers.forEach((markerData) => {
            const icon = markerData.extra?.icon || '🅿️';
            const color = markerData.color || '#6b7280';
            const isDashed = markerData.extra?.dashed || false;

            const markerObj = L.circleMarker([markerData.latitude, markerData.longitude], {
                radius: 7,
                color: color,
                weight: isDashed ? 1 : 2.5,
                dashArray: isDashed ? '5, 3' : null,
                fill: !isDashed,
                fillColor: color,
                fillOpacity: isDashed ? 0.3 : 0.8,
                pane: 'markerPane'
            });

            let popupContent = `
                <div class="popup-content" style="min-width: 240px;">
                    <div style="font-weight: bold; color: ${color}; margin-bottom: 8px;">
                        ${icon} ${markerData.extra?.state_label || '주차장 상태'}
                    </div>
                    <table style="font-size: 12px;">
            `;

            // Show state transition or apply info
            if (markerData.extra?.prev_state) {
                popupContent += `
                        <tr><td><strong>상태:</strong></td><td>${markerData.extra.prev_state} → ${markerData.extra.next_state}</td></tr>
                        <tr><td><strong>이유:</strong></td><td>${markerData.extra.reason || 'N/A'}</td></tr>
                `;
            } else if (markerData.extra?.state) {
                popupContent += `
                        <tr><td><strong>상태:</strong></td><td>${markerData.extra.state}</td></tr>
                        <tr><td><strong>후보 개수:</strong></td><td>${markerData.extra.candidate_count || 0}</td></tr>
                        <tr><td><strong>최고 매칭 Link:</strong></td><td>${markerData.extra.best_link_id || 'N/A'}</td></tr>
                `;
            }

            popupContent += `
                        <tr><td><strong>좌표:</strong></td><td>${markerData.latitude.toFixed(6)}, ${markerData.longitude.toFixed(6)}</td></tr>
                        <tr><td><strong>시간:</strong></td><td>${markerData.timestamp_str || 'N/A'}</td></tr>
                    </table>
                </div>
            `;

            markerObj.bindPopup(popupContent);
            parkingGroup.addLayer(markerObj);
        });
    }

    renderLayerControls();
}

