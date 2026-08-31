/* ===================== 마커 팝업 주소 조회 ===================== */
/* 마커 팝업의 '주소' 버튼을 누르면 그 지점의 도로명/지번/행정동을 팝업 안에 보여준다.
   좌표는 서버(/api/kakao/reverse-geocode)가 카카오 로컬 API 로 변환한다. */

/** 팝업 안에 주소 결과를 그린다(줄 수를 최소로 유지한다). */
function renderPopupAddress(box, data) {
    const primary = data.road_address || data.address;
    if (!primary) {
        box.innerHTML = '<div class="popup-address-empty">매칭되는 주소가 없는 지점입니다.</div>';
        return;
    }
    const dong = data.region?.administrative?.name || '';
    box.innerHTML = `
        <div class="popup-address-main">${escapeHtml(primary)}</div>
        ${dong ? `<div class="popup-address-sub">${escapeHtml(dong)}</div>` : ''}
    `;
}

async function loadPopupAddress(box, lat, lon) {
    box.innerHTML = '<div class="popup-address-loading">조회 중...</div>';
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
    if (!content || content.querySelector('.popup-address-btn')) return;

    const latlng = source.getLatLng();
    const wrap = document.createElement('div');
    wrap.className = 'popup-address-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popup-address-btn';
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

// 마커 생성 코드를 건드리지 않고 팝업 DOM 에만 버튼을 추가한다.
map.on('popupopen', (event) => {
    const source = event?.popup?._source;
    if (!source || typeof source.getLatLng !== 'function') return;
    attachPopupAddressButton(event.popup, source);
});
