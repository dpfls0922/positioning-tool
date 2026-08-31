/* ===================== 상호명(장소) 검색 — 카카오 로컬 / 네이버 지역검색 ===================== */

const placeSearchLayer = L.layerGroup().addTo(map);
let placeSearchResults = [];
let placeSearchProviderLabel = '';

const PLACE_PROVIDER_LABELS = {
    kakao: '카카오 로컬 검색',
    naver: '네이버 지역검색'
};

function clearPlaceSearchLayer() {
    placeSearchLayer.clearLayers();
}

function buildPlaceMarkerIcon(index) {
    return L.divIcon({
        className: 'place-search-pin-wrap',
        html: `<div class="place-search-pin"><span>${index + 1}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 26]
    });
}

function renderPlaceMarkers(places) {
    clearPlaceSearchLayer();
    places.forEach((place, index) => {
        if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
        const marker = L.marker([place.lat, place.lon], {
            icon: buildPlaceMarkerIcon(index),
            zIndexOffset: 900
        });
        marker.bindPopup(`
            <div class="place-popup">
                <div class="place-popup-name">${escapeHtml(place.name)}</div>
                <div class="place-popup-category">${escapeHtml(place.category || '-')}</div>
                <div class="place-popup-address">${escapeHtml(place.road_address || place.address || '')}</div>
                ${place.telephone ? `<div class="place-popup-tel">${escapeHtml(place.telephone)}</div>` : ''}
                <div class="place-popup-coord">${place.lat.toFixed(7)}, ${place.lon.toFixed(7)}</div>
            </div>
        `);
        marker.on('click', () => focusPlaceResult(index, { openPopup: false }));
        placeSearchLayer.addLayer(marker);
    });
}

function placeResultCardHtml(place, index) {
    const hasCoord = Number.isFinite(place.lat) && Number.isFinite(place.lon);
    return `
        <div class="place-card" data-place-index="${index}">
            <div class="place-card-head">
                <span class="place-card-rank">${index + 1}</span>
                <div class="place-card-title">
                    <div class="place-card-name">${escapeHtml(place.name)}</div>
                    <div class="place-card-category">${escapeHtml(place.category || '-')}</div>
                </div>
            </div>
            <div class="place-card-body">
                ${place.road_address ? `<div class="place-card-row"><span class="place-card-key">도로명</span><span>${escapeHtml(place.road_address)}</span></div>` : ''}
                ${place.address ? `<div class="place-card-row"><span class="place-card-key">지번</span><span>${escapeHtml(place.address)}</span></div>` : ''}
                ${place.telephone ? `<div class="place-card-row"><span class="place-card-key">전화</span><span>${escapeHtml(place.telephone)}</span></div>` : ''}
                ${hasCoord ? `<div class="place-card-row"><span class="place-card-key">좌표</span><span>${place.lat.toFixed(7)}, ${place.lon.toFixed(7)}</span></div>` : ''}
            </div>
            <div class="place-card-actions">
                <button type="button" class="place-btn" data-place-action="focus" ${hasCoord ? '' : 'disabled'}>지도에서 보기</button>
            </div>
        </div>
    `;
}

function renderPlaceResults(places, query) {
    const infoPanel = document.getElementById('infoPanel');
    if (!infoPanel) return;

    openSidebar(`장소 검색: ${query}`);
    if (!places.length) {
        infoPanel.innerHTML = `<div class="place-empty">'${escapeHtml(query)}' 에 대한 장소 검색 결과가 없습니다.</div>`;
        return;
    }

    infoPanel.innerHTML = `
        <div class="place-result-list">
            <div class="place-result-count">장소 ${places.length}건 (${escapeHtml(placeSearchProviderLabel)})</div>
            ${places.map(placeResultCardHtml).join('')}
        </div>
    `;
    bindPlaceCardEvents(infoPanel);
}

function bindPlaceCardEvents(container) {
    container.querySelectorAll('.place-card').forEach((card) => {
        const index = Number(card.dataset.placeIndex);
        card.querySelector('[data-place-action="focus"]')?.addEventListener('click', () => {
            focusPlaceResult(index, { openPopup: true });
        });
    });
}

function focusPlaceResult(index, { openPopup = true } = {}) {
    const place = placeSearchResults[index];
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;

    map.setView([place.lat, place.lon], Math.max(map.getZoom(), 17));
    document.querySelectorAll('.place-card').forEach((card) => {
        card.classList.toggle('active', Number(card.dataset.placeIndex) === index);
    });

    if (!openPopup) return;
    let cursor = 0;
    placeSearchLayer.eachLayer((layer) => {
        if (cursor === index && typeof layer.openPopup === 'function') layer.openPopup();
        cursor += 1;
    });
}

async function handlePlaceSearch() {
    const input = document.getElementById('placeSearchBox');
    const query = (input?.value || '').trim();
    if (!query) {
        showInfoMessage('장소 검색', '검색할 상호명을 입력하세요. (예: 스타벅스 강남역)');
        return;
    }

    showInfoMessage(`장소 검색: ${query}`, '장소 검색 API 호출 중...');
    try {
        const res = await fetch(`/api/place/search?${new URLSearchParams({ query, display: '5' })}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            const guide = data.reason === 'no_api_key'
                ? '<div class="place-key-guide">카카오 개발자센터(developers.kakao.com)에서 앱을 만들고 <b>REST API 키</b>를 발급받아, 서버 실행 전에 아래 환경변수를 설정하세요. 일 100,000건 무료이며 결제수단 등록이 필요 없습니다.<pre>export KAKAO_REST_API_KEY=발급받은_REST_API_키</pre></div>'
                : '';
            showInfoMessage('장소 검색', `<div class="place-error">${escapeHtml(data.error || `검색 실패 (HTTP ${res.status})`)}</div>${guide}`);
            return;
        }
        placeSearchResults = data.places || [];
        placeSearchProviderLabel = PLACE_PROVIDER_LABELS[data.provider] || data.provider || '장소 검색';
        renderPlaceMarkers(placeSearchResults);
        renderPlaceResults(placeSearchResults, query);
        const first = placeSearchResults.find((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
        if (first) {
            const bounds = L.latLngBounds(
                placeSearchResults
                    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
                    .map((p) => [p.lat, p.lon])
            );
            map.fitBounds(bounds.pad(0.4), { maxZoom: 17 });
        }
    } catch (err) {
        showInfoMessage('장소 검색', `<div class="place-error">${escapeHtml(err.message || '검색 중 오류가 발생했습니다.')}</div>`);
    }
}
