/* ===================== 검색 결과 지우기 ===================== */
/* 사이드바 결과 패널과 지도에 남은 검색 흔적(하이라이트/장소 핀/선택 상태)을
   한 번에 정리한다. 레이어 표시 상태는 건드리지 않는다. */

/**
 * 검색 결과 항목 제목. 종류는 배지로, 이름과 번호는 따로 둬서
 * 어느 타입의 결과인지 한눈에 들어오게 한다.
 */
function infoTitleHtml(kind, name, index = null) {
    const badge = `<span class="info-badge info-badge-${String(kind).toLowerCase()}">${escapeHtml(kind)}</span>`;
    const label = `<span class="info-name">${name}</span>`;
    const idx = index !== null ? `<span class="info-idx">#${index}</span>` : '';
    return `${badge}${label}${idx}`;
}

function clearSearchResults() {
    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel) infoPanel.innerHTML = '';

    const title = document.getElementById('sidebar-title');
    if (title) title.innerText = '검색 결과';

    if (typeof highlightLayer !== 'undefined') highlightLayer.clearLayers();
    if (typeof placeSearchLayer !== 'undefined') placeSearchLayer.clearLayers();
    if (typeof placeSearchResults !== 'undefined') placeSearchResults = [];
    if (typeof roadviewTargetLayer !== 'undefined') roadviewTargetLayer.clearLayers();

    if (typeof clearRouteInfoSelection === 'function') clearRouteInfoSelection();
    map.closePopup();
    updateClearResultsButton();
}

/** 지울 것이 없으면 버튼을 흐리게 둔다. */
function updateClearResultsButton() {
    const btn = document.getElementById('clearResultsButton');
    if (!btn) return;
    const infoPanel = document.getElementById('infoPanel');
    const hasResults = !!(infoPanel && infoPanel.children.length > 0);
    btn.disabled = !hasResults;
}

function bindClearResultsButton() {
    const btn = document.getElementById('clearResultsButton');
    if (!btn) return;
    btn.addEventListener('click', clearSearchResults);
    updateClearResultsButton();

    // 검색 핸들러들이 infoPanel 을 직접 채우므로, 변화를 관찰해 버튼 상태를 맞춘다.
    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel && typeof MutationObserver !== 'undefined') {
        new MutationObserver(updateClearResultsButton).observe(infoPanel, { childList: true });
    }
}

bindClearResultsButton();
