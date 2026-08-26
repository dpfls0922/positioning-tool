// ===== Tmap 경로 요청 패널과 결과 렌더 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function initRoutePanel() {
    bind('tmapRouteRequestButton', 'click', handleTmapRouteRequest);
    bind('tmapRouteClearButton', 'click', () => clearTmapRoute(true));

    let storedKey = '';
    try {
        storedKey = localStorage.getItem('tmap_route_app_key') || '';
    } catch (_) {
        storedKey = '';
    }
    const appKeyInput = document.getElementById('tmapAppKeyInput');
    if (appKeyInput) {
        appKeyInput.value = storedKey;
        appKeyInput.addEventListener('change', () => {
            try {
                localStorage.setItem('tmap_route_app_key', appKeyInput.value.trim());
            } catch (_) {
                // Ignore storage errors.
            }
        });
    }

    updateTmapWaypointBar();
    setTmapRouteStatus('대기 중');
}

function setTmapRouteStatus(message, isError = false) {
    const el = document.getElementById('tmapRouteStatus');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? '#b91c1c' : '#475569';
}

function nowReqTime() {
    const d = new Date();
    return d.getFullYear().toString() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0');
}

function getTmapRoutePlanTypes(option) {
    const key = String(option || '0');
    if (key === '1') return ['Traffic_Free'];
    if (key === '2') return ['Traffic_Time'];
    if (key === '3') return ['Traffic_Beginner'];
    return ['Traffic_Recommend'];
}

function buildTmapRouteHeaders(accessKey) {
    const headers = {
        Accept: 'application/octet-stream',
        CIH: '582079726',
        Client_ReqTime: nowReqTime(),
        Connection: 'close',
        'Content-Type': 'application/json; charset=UTF-8',
        'Network-Type': 'WIFI',
        Nonce: '858416984',
        Requester: 'CLIENT_SSL'
    };
    if (accessKey) {
        headers.accessKey = accessKey;
        headers.appKey = accessKey;
    }
    return headers;
}

function buildTmapRouteBody(searchOption) {
    if (typeof wgs84ToSkCoord !== 'function') {
        throw new Error('좌표 변환 스크립트가 로드되지 않았습니다.');
    }
    const origin = tmapRouteWaypoints.origin;
    const destination = tmapRouteWaypoints.destination;
    if (!origin || !destination) {
        throw new Error('출발지와 목적지를 먼저 지정해주세요.');
    }

    const [departXPos, departYPos] = wgs84ToSkCoord(origin.lat, origin.lon);
    const [destXPos, destYPos] = wgs84ToSkCoord(destination.lat, destination.lon);
    const reqTime = nowReqTime();

    const body = {
        addCameraTypes: ['Bus', 'SignalSpeeding', 'Moving', 'ShoulderControl', 'Traffic'],
        angle: 130,
        applyEvChargingTimeOnETA: true,
        autoAddingYn: 'Y',
        auxiliaryPower: 1200,
        availableAutoAddingYn: false,
        chargedEnergy: 55816,
        chargedRange: 37600,
        consumptionParam: '{"aux":1200.0,"batteryCapacity":69770,"batteryTemperature":-30,"chargingModeGen6":"PERFORMANCE","csc":[40.32,25.5,20.84,17.37,14.41,17.03,17.26,20.71,24.17,28.7,32.22],"firstCharging":false,"kAcc":2412000,"kDec":3600000,"kDown":3384000,"kUp":3132000,"mass":2580,"vehicleId":"11CF","vendor":"BMW"}',
        controlRouteReqFlag: 0,
        currentEnergy: 6970,
        currentRange: 47000,
        dangerAreaOptions: ['OccurFrequently', 'SharpCurveSection', 'MistArea', 'SchoolZone', 'TrainCrossing'],
        departDirPriority: 1,
        departDirectionType: 0,
        departLinkId: 0,
        departMeshId: 0,
        departName: origin.name || '출발지',
        departRoadType: 'None',
        departSrchFlag: 0,
        departXPos,
        departYPos,
        destEVChargerFlag: false,
        destName: destination.name || '목적지',
        destPoiId: '0',
        destRpFlag: 16,
        destSearchDetailFlag: 'None',
        destSearchFlag: 'LeaveReSearch',
        destXPos,
        destYPos,
        ecoModeFlag: 0,
        efficientSpeed: 0,
        evMobilityProviders: [],
        evSocHistory: [],
        gpsTraceData: '',
        guideImgResolutionCode: 'R480x540',
        header: {
            appLaunchCount: 1,
            appVersion: '3.11.260',
            buildNo: '311260',
            carrier: '',
            deviceId: '2-1-64f62924-13d2-3391-ad91-e935f9043d2d',
            modelNo: 'BMW IDCEvo',
            osType: 'AND',
            osVersion: '14',
            pushDeviceKey: '',
            reqTime,
            resolution: 'QUAD_HD',
            screenHeight: 1218,
            screenWidth: 2560,
            svcType: 113,
            using: 'MAIN'
        },
        hipassFlag: 0,
        initSrchDepartXPos: 0,
        initSrchDepartYPos: 0,
        initSrchLength: 155226,
        initSrchSessionId: `TPtr${reqTime}AHT`,
        isRetry: false,
        lastRid: 5153744,
        lastTollgateId: 0,
        maxCharge: 69770,
        minEnergy: 6977,
        minSocAtAutoAdding: 20,
        minSocAtChargingStation: 20,
        minSocAtDestination: 10,
        myEvStations: [],
        pastArrivalTime: '',
        pastSessionId: `TPtr${reqTime}AHT`,
        pastXpos: 0,
        pastYpos: 0,
        patternDateTime: '',
        pickEvStations: [],
        preMapVersion: '20260407',
        preRids: [],
        preSecs: [],
        preTollgateIds: '129',
        radiusEntryTurnType: 117,
        radiusInfoType: 1,
        radiusLeaveTurnType: 0,
        radiusLinkDirection: 1,
        radiusLinkId: 5901,
        radiusMeshCode: 2293816,
        radiusXPos: 127,
        radiusYPos: 36,
        routePlanTypes: getTmapRoutePlanTypes(searchOption),
        searchCondData: '',
        serviceFlag: 'Realtime',
        slopeFlag: 0,
        socketType: ['DcCombo'],
        speed: 0,
        tcRid: 0,
        tollCarType: 'Car',
        tvas: '5.9',
        vehicleId: '11CF',
        vehicleMass: 2580,
        vendor: 'BMW',
        version: '1.1',
        wayPoints: []
    };

    if (tmapRouteWaypoints.vias.length > 0) {
        body.wayPoints = tmapRouteWaypoints.vias.map((via, index) => {
            const [x, y] = wgs84ToSkCoord(via.lat, via.lon);
            return {
                x,
                y,
                wayPointName: via.name || `경유지${index + 1}`,
                wayPointSearchFlag: 'WaypointSearch',
                rpFlag: 99
            };
        });
    }

    return body;
}

function decodeBase64ToUint8Array(base64Text) {
    const binary = atob(base64Text || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function ensureTmapFeatureGroup(name) {
    if (!featureGroups[name]) {
        featureGroups[name] = L.featureGroup();
        featureGroups[name].addTo(map);
        activeGroups.add(name);
        if (!layerOrder.includes(name)) layerOrder.push(name);
        overlays[name] = featureGroups[name];
    }
    return featureGroups[name];
}

function buildTmapWaypointIcon(label, bgColor, subLabel) {
    return L.divIcon({
        className: '',
        iconSize: [26, 38],
        iconAnchor: [13, 19],
        html:
            `<div style="display:flex;flex-direction:column;align-items:center">` +
            `<div style="width:26px;height:26px;line-height:26px;text-align:center;background:${bgColor};color:#fff;border-radius:50%;font-size:12px;font-weight:800;box-shadow:0 2px 7px rgba(0,0,0,.25);border:2px solid #fff">${label}</div>` +
            `<div style="margin-top:1px;padding:0 4px;background:rgba(15,23,42,0.78);color:#fff;font-size:8px;font-weight:600;border-radius:6px;white-space:nowrap">${subLabel}</div>` +
            `</div>`
    });
}

function updateTmapWaypointBar() {
    const bar = document.getElementById('routeWaypointBar');
    if (!bar) return;

    const items = [];
    const origin = tmapRouteWaypoints.origin;
    const destination = tmapRouteWaypoints.destination;
    if (origin) {
        items.push({ type: 'origin', label: 'S', className: 'route-wp-chip-start', name: origin.name || '출발지', index: -1, point: origin });
    }
    tmapRouteWaypoints.vias.forEach((via, index) => {
        items.push({ type: 'via', label: `W${index + 1}`, className: 'route-wp-chip-via', name: via.name || `경유지${index + 1}`, index, point: via });
    });
    if (destination) {
        items.push({ type: 'destination', label: 'E', className: 'route-wp-chip-dest', name: destination.name || '목적지', index: -1, point: destination });
    }

    if (items.length === 0) {
        bar.innerHTML = '<span class="route-waypoint-empty">지도 우클릭으로 출발지, 경유지, 목적지를 지정하세요.</span>';
        return;
    }

    bar.innerHTML = '';
    items.forEach((item) => {
        const chip = document.createElement('span');
        chip.className = `route-wp-chip ${item.className}`;
        chip.innerHTML = `<span>${item.label} ${item.point.lat.toFixed(5)}, ${item.point.lon.toFixed(5)}</span>`;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        removeBtn.title = `${item.name} 제거`;
        removeBtn.addEventListener('click', () => removeTmapWaypoint(item.type, item.index));
        chip.appendChild(removeBtn);
        bar.appendChild(chip);
    });
}

function renderTmapWaypointMarkers() {
    const group = ensureTmapFeatureGroup(TMAP_WAYPOINT_LAYER);
    group.clearLayers();

    const origin = tmapRouteWaypoints.origin;
    const destination = tmapRouteWaypoints.destination;

    if (origin) {
        group.addLayer(L.marker([origin.lat, origin.lon], {
            icon: buildTmapWaypointIcon('S', '#16a34a', '출발')
        }).bindPopup(`<b>출발지</b><br>${origin.lat.toFixed(6)}, ${origin.lon.toFixed(6)}`));
    }

    tmapRouteWaypoints.vias.forEach((via, index) => {
        group.addLayer(L.marker([via.lat, via.lon], {
            icon: buildTmapWaypointIcon(`W${index + 1}`, '#d97706', `경유${index + 1}`)
        }).bindPopup(`<b>경유지 ${index + 1}</b><br>${via.lat.toFixed(6)}, ${via.lon.toFixed(6)}`));
    });

    if (destination) {
        group.addLayer(L.marker([destination.lat, destination.lon], {
            icon: buildTmapWaypointIcon('E', '#dc2626', '도착')
        }).bindPopup(`<b>목적지</b><br>${destination.lat.toFixed(6)}, ${destination.lon.toFixed(6)}`));
    }

    renderLayerControls();
}

function setTmapWaypoint(type, latlng) {
    if (!latlng) return;

    const point = {
        lat: Number(latlng.lat),
        lon: Number(latlng.lng)
    };

    if (type === 'origin') {
        tmapRouteWaypoints.origin = { ...point, name: '출발지' };
    } else if (type === 'destination') {
        tmapRouteWaypoints.destination = { ...point, name: '목적지' };
    } else {
        if (tmapRouteWaypoints.vias.length >= 30) {
            alert('경유지는 최대 30개까지 설정할 수 있습니다.');
            return;
        }
        tmapRouteWaypoints.vias.push({ ...point, name: `경유지${tmapRouteWaypoints.vias.length + 1}` });
    }

    updateTmapWaypointBar();
    renderTmapWaypointMarkers();
    setTmapRouteStatus('경로점이 설정되었습니다.');
}

function removeTmapWaypoint(type, index = -1) {
    if (type === 'origin') {
        tmapRouteWaypoints.origin = null;
    } else if (type === 'destination') {
        tmapRouteWaypoints.destination = null;
    } else if (index >= 0 && index < tmapRouteWaypoints.vias.length) {
        tmapRouteWaypoints.vias.splice(index, 1);
        tmapRouteWaypoints.vias = tmapRouteWaypoints.vias.map((via, idx) => ({
            ...via,
            name: `경유지${idx + 1}`
        }));
    }
    updateTmapWaypointBar();
    renderTmapWaypointMarkers();
}

function openTmapRouteContextMenu(latlng) {
    if (!latlng) return;

    const container = document.createElement('div');
    container.style.cssText = 'font-size:12px;line-height:1.6;min-width:210px';
    container.innerHTML =
        `<div style="font-weight:700;margin-bottom:6px;">경로점 지정</div>` +
        `<div style="color:#475569;margin-bottom:8px;">${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</div>` +
        `<div style="display:flex;gap:4px;flex-wrap:wrap">` +
        `<button data-type="origin" style="flex:1;padding:6px 8px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">출발지</button>` +
        `<button data-type="via" style="flex:1;padding:6px 8px;background:#d97706;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">경유지</button>` +
        `<button data-type="destination" style="flex:1;padding:6px 8px;background:#dc2626;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">목적지</button>` +
        `</div>`;

    const popup = L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(container).openOn(map);
    container.querySelectorAll('button[data-type]').forEach((button) => {
        button.addEventListener('click', () => {
            setTmapWaypoint(button.dataset.type, latlng);
            map.closePopup(popup);
            const routePanel = document.getElementById('routePanel');
            if (routePanel?.classList.contains('hidden')) {
                toggleToolPanel('routePanel', 'toolRouteBtn');
            }
        });
    });
}

function clearTmapRoute(clearWaypoints = false) {
    tmapRouteResult = null;
    const routeGroup = featureGroups[TMAP_ROUTE_LAYER];
    if (routeGroup) routeGroup.clearLayers();

    if (clearWaypoints) {
        tmapRouteWaypoints = { origin: null, destination: null, vias: [] };
        const waypointGroup = featureGroups[TMAP_WAYPOINT_LAYER];
        if (waypointGroup) waypointGroup.clearLayers();
        updateTmapWaypointBar();
    } else {
        renderTmapWaypointMarkers();
    }

    renderLayerControls();
    setTmapRouteStatus(clearWaypoints ? '경로와 선택 지점을 초기화했습니다.' : '경로를 지웠습니다.');
}

async function handleTmapRouteRequest() {
    if (tmapRouteRequesting) return;

    const accessKey = (document.getElementById('tmapAppKeyInput')?.value || '').trim();
    if (!accessKey) {
        setTmapRouteStatus('TMAP_ACCESS_KEY를 입력해주세요.', true);
        return;
    }
    if (!tmapRouteWaypoints.origin || !tmapRouteWaypoints.destination) {
        setTmapRouteStatus('출발지와 목적지를 먼저 지정해주세요.', true);
        return;
    }

    const requestButton = document.getElementById('tmapRouteRequestButton');
    const searchOption = (document.getElementById('tmapRouteOptionSelect')?.value || '0').trim();

    tmapRouteRequesting = true;
    if (requestButton) requestButton.disabled = true;
    setTmapRouteStatus('ntmapstg 경로 요청 중...');

    try {
        const headers = buildTmapRouteHeaders(accessKey);
        const body = buildTmapRouteBody(searchOption);
        const response = await fetch('/api/tmap-route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accessKey,
                endpoint: TMAP_STG_ROUTE_ENDPOINT,
                headers,
                body
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            const detailText = data?.detail && typeof data.detail === 'object'
                ? JSON.stringify(data.detail)
                : (data?.detail || '');
            throw new Error(data?.error ? `${data.error}${detailText ? `\n${detailText}` : ''}` : '경로 요청 실패');
        }

        renderTmapRouteResultWithEvents(data.response);
    } catch (error) {
        setTmapRouteStatus(error.message || '경로 요청 실패', true);
    } finally {
        tmapRouteRequesting = false;
        if (requestButton) requestButton.disabled = false;
    }
}

function renderTmapRouteResult(routeResponse) {
    if (typeof parseTvas !== 'function' || typeof resolveVertexCoordinates !== 'function') {
        throw new Error('TVAS 파서가 로드되지 않았습니다.');
    }

    const bodyBase64 = routeResponse?.body_base64;
    if (!bodyBase64) {
        throw new Error('응답 본문이 비어 있습니다.');
    }

    const rawBytes = decodeBase64ToUint8Array(bodyBase64);
    let tvasBuffer = rawBytes.buffer;
    let responseInfo = {};

    if (rawBytes.length > 0 && rawBytes[0] === 0x7B) {
        const text = new TextDecoder('utf-8').decode(rawBytes);
        const json = JSON.parse(text);
        responseInfo = {
            sessionId: json.header?.sessionId || '',
            errorCode: json.header?.errorCode || '',
            errorMessage: json.header?.errorMessage || ''
        };

        if (json.header?.errorCode && json.header.errorCode !== '000000') {
            throw new Error(`서버 오류 [${json.header.errorCode}] ${json.header.errorMessage || ''}`.trim());
        }
        if (!json.tvases) {
            throw new Error('응답에 tvases 데이터가 없습니다.');
        }

        const tvasBytes = decodeBase64ToUint8Array(json.tvases);
        tvasBuffer = tvasBytes.buffer;
    }

    const tvasResult = parseTvas(tvasBuffer);
    const coords = resolveVertexCoordinates(tvasResult);
    if (!Array.isArray(coords) || coords.length < 2) {
        throw new Error('TVAS에서 경로 좌표를 추출하지 못했습니다.');
    }

    const routeGroup = ensureTmapFeatureGroup(TMAP_ROUTE_LAYER);
    routeGroup.clearLayers();

    const latlngs = coords.map((coord) => [coord.lat, coord.lon]);
    const line = L.polyline(latlngs, {
        color: '#ef4444',
        weight: 5,
        opacity: 0.9
    });
    line.bindPopup(
        `<b>TVAS Route</b><br>` +
        `점 개수: ${coords.length}<br>` +
        `거리: ${Number.isFinite(tvasResult?.header?.routeSearch?.totalDistance) ? `${(tvasResult.header.routeSearch.totalDistance / 1000).toFixed(1)} km` : '-'}<br>` +
        `시간: ${Number.isFinite(tvasResult?.header?.routeSearch?.totalTime) ? `${Math.round(tvasResult.header.routeSearch.totalTime / 60)} 분` : '-'}`
    );
    routeGroup.addLayer(line);

    tmapRouteResult = {
        responseInfo,
        tvasResult,
        coords
    };
    renderLayerControls();
    map.fitBounds(latlngs, { padding: [24, 24] });

    const distanceText = Number.isFinite(tvasResult?.header?.routeSearch?.totalDistance)
        ? `${(tvasResult.header.routeSearch.totalDistance / 1000).toFixed(1)} km`
        : '-';
    const timeText = Number.isFinite(tvasResult?.header?.routeSearch?.totalTime)
        ? `${Math.round(tvasResult.header.routeSearch.totalTime / 60)} 분`
        : '-';
    const viaText = tmapRouteWaypoints.vias.length > 0 ? `, 경유지 ${tmapRouteWaypoints.vias.length}개` : '';
    const sessionText = responseInfo.sessionId ? `, session ${responseInfo.sessionId}` : '';
    setTmapRouteStatus(`경로 요청 완료: 점 ${coords.length}개, 거리 ${distanceText}, 시간 ${timeText}${viaText}${sessionText}`);
}

