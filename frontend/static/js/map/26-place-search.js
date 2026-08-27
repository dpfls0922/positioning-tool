/* ===================== 상호명(장소) 검색 — 카카오 로컬 / 네이버 지역검색 ===================== */

const placeSearchLayer = L.layerGroup().addTo(map);
let placeSearchResults = [];
let placeSearchProviderLabel = '';
const placeReviewCache = new Map();

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
                <button type="button" class="place-btn" data-place-action="review">리뷰 보기</button>
                <a class="place-btn place-btn-link" href="${escapeHtml(place.place_url)}" target="_blank" rel="noopener noreferrer">${place.provider === 'kakao' ? '카카오맵' : '네이버 플레이스'}</a>
            </div>
            <div class="place-review-box" data-place-review="${index}"></div>
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
        card.querySelector('[data-place-action="review"]')?.addEventListener('click', (e) => {
            togglePlaceReviews(index, e.currentTarget);
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

async function togglePlaceReviews(index, button) {
    const place = placeSearchResults[index];
    const box = document.querySelector(`[data-place-review="${index}"]`);
    if (!place || !box) return;

    if (box.classList.contains('open')) {
        box.classList.remove('open');
        box.innerHTML = '';
        if (button) button.textContent = '리뷰 보기';
        return;
    }

    box.classList.add('open');
    if (button) button.textContent = '리뷰 접기';

    const cacheKey = `${place.name}|${place.address}`;
    if (placeReviewCache.has(cacheKey)) {
        box.innerHTML = placeReviewsHtml(placeReviewCache.get(cacheKey), place);
        return;
    }

    box.innerHTML = '<div class="place-review-loading">리뷰를 불러오는 중...</div>';
    try {
        const params = new URLSearchParams({ name: place.name, address: place.address || '', display: '10' });
        const res = await fetch(`/api/place/reviews?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            box.innerHTML = data.reason === 'no_review_source'
                ? placeReviewFallbackHtml(place, data.error)
                : `<div class="place-review-error">${escapeHtml(data.error || `리뷰 조회 실패 (HTTP ${res.status})`)}</div>`;
            return;
        }
        placeReviewCache.set(cacheKey, data);
        box.innerHTML = placeReviewsHtml(data, place);
    } catch (err) {
        box.innerHTML = `<div class="place-review-error">${escapeHtml(err.message || '리뷰 조회 중 오류가 발생했습니다.')}</div>`;
    }
}

function placeReviewFallbackHtml(place, message) {
    return `
        <div class="place-review-note">${escapeHtml(message || '리뷰 API 키가 없습니다.')}</div>
        <div class="place-review-links">
            ${place.place_url ? `<a class="place-btn place-btn-link" href="${escapeHtml(place.place_url)}" target="_blank" rel="noopener noreferrer">${place.provider === 'kakao' ? '카카오맵 후기 ↗' : '네이버 플레이스 ↗'}</a>` : ''}
            ${place.naver_place_url ? `<a class="place-btn place-btn-link" href="${escapeHtml(place.naver_place_url)}" target="_blank" rel="noopener noreferrer">네이버 플레이스 리뷰 ↗</a>` : ''}
        </div>
    `;
}

function placeReviewsHtml(data, place) {
    const reviews = data.reviews || [];
    const header = `
        <div class="place-review-head">
            <span>블로그 리뷰 ${reviews.length}건</span>
            <a href="${escapeHtml(place.naver_place_url || place.place_url)}" target="_blank" rel="noopener noreferrer">방문자 리뷰·별점은 네이버 플레이스에서 ↗</a>
        </div>
    `;
    if (!reviews.length) {
        return `${header}<div class="place-review-empty">'${escapeHtml(data.query || place.name)}' 검색 결과가 없습니다.</div>`;
    }
    const items = reviews.map((review) => `
        <a class="place-review-item" href="${escapeHtml(review.link)}" target="_blank" rel="noopener noreferrer">
            <div class="place-review-title">${escapeHtml(review.title)}</div>
            <div class="place-review-snippet">${escapeHtml(review.snippet)}</div>
            <div class="place-review-meta">${escapeHtml(review.author || '-')}${review.posted_at ? ` · ${escapeHtml(review.posted_at)}` : ''}</div>
        </a>
    `).join('');
    return `${header}<div class="place-review-list">${items}</div>`;
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
            showInfoMessage('장소 검색', `<div class="place-review-error">${escapeHtml(data.error || `검색 실패 (HTTP ${res.status})`)}</div>${guide}`);
            return;
        }
        placeSearchResults = data.places || [];
        placeSearchProviderLabel = PLACE_PROVIDER_LABELS[data.provider] || data.provider || '장소 검색';
        placeReviewCache.clear();
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
        showInfoMessage('장소 검색', `<div class="place-review-error">${escapeHtml(err.message || '검색 중 오류가 발생했습니다.')}</div>`);
    }
}
