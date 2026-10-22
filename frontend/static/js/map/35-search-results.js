/* Leaflet 기본 팝업 최대 폭은 300px 이다. DR 후보 링크 표처럼 가로로 넓은
   내용이 잘리지 않게 넉넉히 올린다(세로는 CSS 에서 제한). */
L.Popup.mergeOptions({ maxWidth: 720 });

/* ===================== 사이드바 탭 (결과 / 레이어) ===================== */
/* 결과 패널과 레이어 관리가 세로로 나뉘어 둘 다 좁았다. 탭으로 묶어
   한 번에 하나만 전체 높이를 쓰게 하고, 새 검색 결과가 오면 결과 탭으로
   자동 전환한다. */

function setSidebarTab(name) {
    document.querySelectorAll('.sidebar-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.sidebarTab === name);
    });
    document.getElementById('sidebar-pane-results')?.classList.toggle('hidden', name !== 'results');
    document.getElementById('sidebar-pane-layers')?.classList.toggle('hidden', name !== 'layers');
    const clearBtn = document.getElementById('clearResultsButton');
    if (clearBtn) clearBtn.classList.toggle('hidden', name !== 'results');
    // 레이어 탭으로 넘어오면 접혀 있던 목록의 폭이 바뀌므로 지도 크기를 다시 계산한다.
    requestAnimationFrame(() => map.invalidateSize());
}

function activeSidebarTab() {
    return document.querySelector('.sidebar-tab.active')?.dataset.sidebarTab || 'results';
}

/** 탭 라벨의 개수 배지를 갱신한다. */
function updateSidebarTabCounts() {
    const infoPanel = document.getElementById('infoPanel');
    const resultCount = infoPanel ? infoPanel.querySelectorAll('.info-item, .place-card').length : 0;
    const resultsBadge = document.getElementById('resultsTabCount');
    if (resultsBadge) resultsBadge.textContent = resultCount > 0 ? String(resultCount) : '';

    const layersBadge = document.getElementById('layersTabCount');
    if (layersBadge) {
        const activeCount = typeof activeGroups !== 'undefined' ? activeGroups.size : 0;
        layersBadge.textContent = activeCount > 0 ? String(activeCount) : '';
    }
}

function bindSidebarTabs() {
    document.querySelectorAll('.sidebar-tab').forEach((tab) => {
        tab.addEventListener('click', () => setSidebarTab(tab.dataset.sidebarTab));
    });
    // 기본은 레이어 탭. 검색 결과가 생기면 자동으로 결과 탭으로 넘어간다.
    setSidebarTab('layers');
    updateSidebarTabCounts();
}

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
    updateSidebarTabCounts();
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
        new MutationObserver(() => {
            updateClearResultsButton();
            updateSidebarTabCounts();
            // 검색으로 결과가 새로 채워졌으면 결과 탭을 보여준다.
            if (infoPanel.children.length > 0 && activeSidebarTab() !== 'results') setSidebarTab('results');
        }).observe(infoPanel, { childList: true });
    }
}

bindSidebarTabs();
bindClearResultsButton();
map.on('overlayadd overlayremove', updateSidebarTabCounts);
