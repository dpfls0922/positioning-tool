/* ===================== 카카오 로컬 (주소 · 좌표계) ===================== */
/* - 마커 팝업의 '주소' 버튼: 그 지점의 도로명/지번/행정동을 팝업 안에 바로 표시
   - 주소 검색: 주소 문자열 → 좌표 이동
   - 좌표 검증: 자체 변환(tmap_coord.js)과 카카오 변환을 비교
   인증은 서버가 KAKAO_REST_API_KEY 로 처리한다(프론트에 키를 노출하지 않는다). */

const KAKAO_LOCAL_PANEL_ID = 'kakaoLocalPanel';
const KAKAO_COORD_SYSTEMS = ['BESSEL', 'TM', 'KTM', 'WCONGNAMUL'];

let kakaoLocalApi = null;
let kakaoCoordPickMode = false;
const kakaoPointLayer = L.layerGroup().addTo(map);

function ensureKakaoLocalPanel() {
    if (kakaoLocalApi) return kakaoLocalApi;

    kakaoLocalApi = createFloatingPanel({
        id: KAKAO_LOCAL_PANEL_ID,
        title: '카카오 로컬',
        defaultSize: { width: 420, height: 340 },
        storageKey: 'positioningTool.kakaoLocalSize',
        bodyHtml: `
            <div class="kakao-tabs">
                <button type="button" class="kakao-tab active" data-tab="search">주소 검색</button>
                <button type="button" class="kakao-tab" data-tab="coord">좌표 검증</button>
            </div>
            <div class="kakao-tab-body" data-tab-body="search">
                <div class="kakao-controls">
                    <div class="kakao-search-row">
                        <input type="text" data-address-input placeholder="예: 서울 강남구 강남대로 390">
                        <button type="button" class="kakao-btn" data-action="address-search">검색</button>
                    </div>
                </div>
                <div class="kakao-result" data-result="search"></div>
            </div>
            <div class="kakao-tab-body hidden" data-tab-body="coord">
                <div class="kakao-controls">
                    <div class="kakao-search-row">
                        <input type="text" data-coord-input placeholder="예: 37.4979, 127.0276">
                        <button type="button" class="kakao-btn" data-action="coord-check">검증</button>
                    </div>
                    <div class="kakao-hint">우측 툴바의 <b>좌표 검증</b>을 켜고 지도를 클릭해도 됩니다.</div>
                </div>
                <div class="kakao-result" data-result="coord"></div>
            </div>
        `,
        onClose: () => kakaoPointLayer.clearLayers()
    });

    bindKakaoLocalPanelEvents(kakaoLocalApi.panel);
    return kakaoLocalApi;
}

function bindKakaoLocalPanelEvents(panel) {
    panel.querySelectorAll('.kakao-tab').forEach((tab) => {
        tab.addEventListener('click', () => setKakaoLocalTab(tab.dataset.tab));
    });

    const addressInput = panel.querySelector('[data-address-input]');
    panel.querySelector('[data-action="address-search"]')?.addEventListener('click', () => {
        runKakaoAddressSearch(addressInput?.value);
    });
    addressInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runKakaoAddressSearch(addressInput.value);
    });

    const coordInput = panel.querySelector('[data-coord-input]');
    const runFromInput = () => {
        const matches = String(coordInput?.value || '').match(/-?\d+(?:\.\d+)?/g);
        if (!matches || matches.length < 2) {
            kakaoResultSlot('coord').innerHTML = '<div class="kakao-hint">예: 37.4979, 127.0276 형식으로 입력하세요.</div>';
            return;
        }
        runKakaoCoordCheck(Number(matches[0]), Number(matches[1]));
    };
    panel.querySelector('[data-action="coord-check"]')?.addEventListener('click', runFromInput);
    coordInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runFromInput();
    });
}

function setKakaoLocalTab(name) {
    const api = ensureKakaoLocalPanel();
    api.panel.querySelectorAll('.kakao-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.tab === name);
    });
    api.panel.querySelectorAll('.kakao-tab-body').forEach((body) => {
        body.classList.toggle('hidden', body.dataset.tabBody !== name);
    });
}

function kakaoResultSlot(name) {
    return ensureKakaoLocalPanel().panel.querySelector(`[data-result="${name}"]`);
}

/** 카카오 API 호출 공통 처리. 실패하면 안내 HTML 을 슬롯에 그린다. */
async function fetchKakaoApi(path, params, slotName) {
    const slot = kakaoResultSlot(slotName);
    slot.innerHTML = '<div class="kakao-loading">조회 중...</div>';
    try {
        const res = await fetch(`${path}?${new URLSearchParams(params)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            const guide = data.reason === 'no_api_key'
                ? '<code class="panel-message-code">KAKAO_REST_API_KEY=발급받은_REST_API_키   (프로젝트 루트 .env)</code>'
                : '';
            slot.innerHTML = `<div class="kakao-error">${escapeHtml(data.error || `요청 실패 (HTTP ${res.status})`)}</div>${guide}`;
            return null;
        }
        return data;
    } catch (err) {
        slot.innerHTML = `<div class="kakao-error">${escapeHtml(err.message || '요청 중 오류가 발생했습니다.')}</div>`;
        return null;
    }
}

function kakaoRow(key, value) {
    if (!value) return '';
    return `<div class="kakao-row"><span class="kakao-key">${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`;
}

/* ---------- 주소 → 좌표 ---------- */

async function runKakaoAddressSearch(query) {
    const keyword = (query || '').trim();
    const api = ensureKakaoLocalPanel();
    api.open();
    setKakaoLocalTab('search');
    if (!keyword) {
        kakaoResultSlot('search').innerHTML = '<div class="kakao-hint">검색할 주소를 입력하세요.</div>';
        return;
    }

    const data = await fetchKakaoApi('/api/kakao/address', { query: keyword, size: 10 }, 'search');
    if (!data) return;

    api.setSubtitle(`"${keyword}" · ${data.results.length}건`);
    if (!data.results.length) {
        kakaoResultSlot('search').innerHTML = `<div class="kakao-hint">'${escapeHtml(keyword)}' 검색 결과가 없습니다.</div>`;
        return;
    }

    kakaoResultSlot('search').innerHTML = data.results.map((item, index) => `
        <div class="kakao-item" data-address-index="${index}">
            <div class="kakao-item-head">
                <span class="kakao-item-rank">${index + 1}</span>
                <span class="kakao-item-name">${escapeHtml(item.road_address || item.address_name)}</span>
            </div>
            <div class="kakao-item-sub">${escapeHtml(item.address || '')}${item.building_name ? ` · ${escapeHtml(item.building_name)}` : ''}</div>
        </div>
    `).join('');

    kakaoResultSlot('search').querySelectorAll('[data-address-index]').forEach((el) => {
        el.addEventListener('click', () => {
            const item = data.results[Number(el.dataset.addressIndex)];
            if (!item || !Number.isFinite(item.lat)) return;
            map.setView([item.lat, item.lon], Math.max(map.getZoom(), 17));
            markKakaoPoint(item.lat, item.lon);
        });
    });
}

/* ---------- 좌표계 교차검증 ---------- */

async function runKakaoCoordCheck(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const api = ensureKakaoLocalPanel();
    api.open();
    setKakaoLocalTab('coord');
    api.setSubtitle(`${lat.toFixed(7)}, ${lon.toFixed(7)}`);
    markKakaoPoint(lat, lon);

    const data = await fetchKakaoApi(
        '/api/kakao/transcoord',
        { lat, lon, systems: KAKAO_COORD_SYSTEMS.join(',') },
        'coord'
    );
    if (!data) return;

    // 자체 변환: WGS84 → SK(베셀 도 × 36000) → WGS84 왕복
    const [skX, skY] = wgs84ToSkCoord(lat, lon);
    const roundTrip = skCoordToWgs84(skX, skY);
    const ourBessel = { lon: skX / 36000, lat: skY / 36000 };

    const metersPerDegLat = 110540;
    const metersPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const roundTripError = roundTrip
        ? Math.hypot((roundTrip[0] - lat) * metersPerDegLat, (roundTrip[1] - lon) * metersPerDegLon)
        : null;

    const kakaoBessel = data.converted?.BESSEL;
    let besselHtml = '<div class="kakao-hint">카카오 BESSEL 변환값을 받지 못했습니다.</div>';
    if (kakaoBessel) {
        const dLon = ourBessel.lon - Number(kakaoBessel.x);
        const dLat = ourBessel.lat - Number(kakaoBessel.y);
        const diffM = Math.hypot(dLat * metersPerDegLat, dLon * metersPerDegLon);
        besselHtml = `
            ${kakaoRow('입력 (WGS84)', `${lat.toFixed(7)}, ${lon.toFixed(7)}`)}
            ${kakaoRow('우리 (베셀)', `${ourBessel.lat.toFixed(7)}, ${ourBessel.lon.toFixed(7)}  [SK ${skX}, ${skY}]`)}
            ${kakaoRow('카카오 (BESSEL)', `${Number(kakaoBessel.y).toFixed(7)}, ${Number(kakaoBessel.x).toFixed(7)}`)}
            <div class="kakao-row"><span class="kakao-key">차이</span><span class="${diffM > 5 ? 'kakao-bad' : 'kakao-good'}">${diffM.toFixed(2)} m</span></div>
        `;
    }

    const otherRows = ['TM', 'KTM', 'WCONGNAMUL']
        .filter((system) => data.converted?.[system])
        .map((system) => kakaoRow(`카카오 ${system}`, `${data.converted[system].x}, ${data.converted[system].y}`))
        .join('');

    kakaoResultSlot('coord').innerHTML = `
        <div class="kakao-card">
            <div class="kakao-card-title">좌표계 교차검증</div>
            ${besselHtml}
            ${roundTripError !== null ? `<div class="kakao-row"><span class="kakao-key">왕복 오차</span><span class="${roundTripError > 1 ? 'kakao-bad' : 'kakao-good'}">${roundTripError.toFixed(2)} m</span></div>` : ''}
        </div>
        <div class="kakao-card">
            <div class="kakao-card-title">참고 변환값</div>
            ${otherRows || '<div class="kakao-hint">변환값이 없습니다.</div>'}
        </div>
        <div class="kakao-hint">우리 변환은 tmap_coord.js 의 WGS84↔SK(베셀×36000) 이고, 같은 지점을 카카오 BESSEL 변환과 비교합니다. 차이가 크면 데이텀 상수를 점검하세요.</div>
    `;
}

function markKakaoPoint(lat, lon) {
    kakaoPointLayer.clearLayers();
    L.circleMarker([lat, lon], {
        radius: 9,
        color: '#0ea5e9',
        fillColor: '#bae6fd',
        fillOpacity: 0.9,
        weight: 3,
        interactive: false
    }).addTo(kakaoPointLayer);
}

/* ---------- 마커 팝업의 '주소' 버튼 ---------- */

/** 팝업 안에 주소 결과를 그린다(패널을 열지 않고 그 자리에서 보여준다). */
function renderPopupAddress(box, data) {
    const admin = data.region?.administrative?.name;
    const rows = [
        ['도로명', data.road_address],
        ['지번', data.address],
        ['건물', data.building_name],
        ['행정동', admin]
    ].filter(([, value]) => value);

    if (!rows.length) {
        box.innerHTML = '<div class="popup-address-empty">매칭되는 주소가 없는 지점입니다.</div>';
        return;
    }
    box.innerHTML = rows
        .map(([key, value]) => `<div class="popup-address-row"><span>${escapeHtml(key)}</span>${escapeHtml(value)}</div>`)
        .join('');
}

async function loadPopupAddress(box, lat, lon) {
    box.innerHTML = '<div class="popup-address-loading">주소 조회 중...</div>';
    try {
        const res = await fetch(`/api/kakao/reverse-geocode?${new URLSearchParams({ lat, lon })}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            box.innerHTML = `<div class="popup-address-error">${escapeHtml(data.error || `주소 조회 실패 (HTTP ${res.status})`)}</div>`;
            return;
        }
        renderPopupAddress(box, data);
    } catch (err) {
        box.innerHTML = `<div class="popup-address-error">${escapeHtml(err.message || '주소 조회 중 오류가 발생했습니다.')}</div>`;
    }
}

function attachPopupAddressButton(popup, source) {
    const content = popup.getElement()?.querySelector('.leaflet-popup-content');
    if (!content || content.querySelector('.kakao-address-popup-btn')) return;

    const latlng = source.getLatLng();
    const wrap = document.createElement('div');
    wrap.className = 'popup-address-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kakao-address-popup-btn';
    btn.textContent = '주소';

    const resultBox = document.createElement('div');
    resultBox.className = 'popup-address-result';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.disabled = true;
        loadPopupAddress(resultBox, latlng.lat, latlng.lng).finally(() => {
            btn.disabled = false;
        });
    });

    wrap.appendChild(btn);
    wrap.appendChild(resultBox);
    content.appendChild(wrap);
}

/* ---------- 툴바 / 지도 클릭 연결 ---------- */

function setKakaoCoordPickMode(enabled) {
    kakaoCoordPickMode = !!enabled;
    const btn = document.getElementById('toolKakaoCoordBtn');
    if (btn) {
        btn.classList.toggle('active', kakaoCoordPickMode);
        btn.title = kakaoCoordPickMode ? '좌표 검증: 지도에서 지점 클릭' : '좌표 검증 · 주소 검색';
    }
    if (kakaoCoordPickMode) setKakaoPickMode('kakaoCoord');
    const container = map.getContainer();
    if (container) container.style.cursor = kakaoCoordPickMode ? 'crosshair' : '';
}

function bindKakaoLocalEvents() {
    addKakaoToolbarButton({
        id: 'toolKakaoCoordBtn',
        icon: 'fa-crosshairs',
        title: '좌표 검증 · 주소 검색',
        onClick: () => setKakaoCoordPickMode(!kakaoCoordPickMode)
    });

    registerKakaoPickMode('kakaoCoord', () => {
        if (kakaoCoordPickMode) setKakaoCoordPickMode(false);
    });

    map.on('click', (e) => {
        if (!kakaoCoordPickMode || otherMapToolActive()) return;
        runKakaoCoordCheck(e.latlng.lat, e.latlng.lng);
    });

    // 마커 팝업에 '주소' 버튼을 끼워 넣는다(마커 생성 코드는 건드리지 않는다).
    map.on('popupopen', (event) => {
        const source = event?.popup?._source;
        if (!source || typeof source.getLatLng !== 'function') return;
        attachPopupAddressButton(event.popup, source);
    });
}

bindKakaoLocalEvents();
