// ===== HTML/CSV 내보내기 · 시각화 초기화 · 사이드바 토글 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function handleExportHtml(buttonId = 'exportHtmlMenuButton') {
    const exportBtn = document.getElementById(buttonId);
    const issueInput = document.getElementById('issueIdInput');
    const issueId = (issueInput?.value || '').trim();

    if (exportBtn) exportBtn.disabled = true;
    setUploadProgress(100, 'Export 중...', true);

    fetch('/api/export-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: issueId })
    })
        .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'Export 실패');
            }
            setUploadProgress(100, `Export 완료: ${data.file_name} (Finder 열림)`, false);
        })
        .catch((err) => {
            setUploadProgress(0, `실패: ${err.message}`, false);
        })
        .finally(() => {
            if (exportBtn) exportBtn.disabled = false;
        });
}

function handleExportHtmlFromMenu() {
    handleExportHtml('exportHtmlMenuButton');
}

function handleExportCsv(buttonId = 'exportCsvMenuButton') {
    const exportBtn = document.getElementById(buttonId);
    const issueInput = document.getElementById('issueIdInput');
    const issueId = (issueInput?.value || '').trim();

    if (exportBtn) exportBtn.disabled = true;
    setUploadProgress(100, 'CSV Export 중...', true);

    fetch('/api/export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: issueId })
    })
        .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'CSV Export 실패');
            }
            setUploadProgress(100, `CSV Export 완료: ${data.file_name} (Finder 열림)`, false);
        })
        .catch((err) => {
            setUploadProgress(0, `실패: ${err.message}`, false);
        })
        .finally(() => {
            if (exportBtn) exportBtn.disabled = false;
        });
}

function handleExportCsvFromMenu() {
    handleExportCsv('exportCsvMenuButton');
}

function isInSelectedRange(timestampMs, minVal, maxVal) {
    if (!Number.isFinite(timestampMs)) return false;
    return timestampMs >= minVal && timestampMs <= maxVal;
}

function resetVisualization() {
    markers.forEach(marker => map.removeLayer(marker));
    parkingLotStateBands.forEach(layer => map.removeLayer(layer));
    gnssModeBands.forEach(layer => map.removeLayer(layer));
    polylines.forEach(polyline => map.removeLayer(polyline));
    highlightLayer.clearLayers();
    clearDistanceVisuals();
    pickedDistancePoints = [];
    resetRadiusSelection(false);

    Object.keys(featureGroups).forEach((key) => {
        if (isRoadShapeLayerName(key)) return;
        map.removeLayer(featureGroups[key]);
        delete featureGroups[key];
    });
    Object.keys(overlays).forEach((key) => {
        if (isRoadShapeLayerName(key)) return;
        delete overlays[key];
    });

    markers = [];
    parkingLotStateBands = [];
    gnssModeBands = [];
    polylines = [];
    requestGroups = {};
    cullTotalCounts = {};
    lastCullState = null;
    Object.keys(layerCountOverride).forEach((key) => {
        if (isRoadShapeLayerName(key)) return;
        delete layerCountOverride[key];
    });
    selectedCandidateLinkIds = new Set();
    activeGroups = new Set([...activeGroups].filter((name) => isRoadShapeLayerName(name)));
    layerOrder = layerOrder.filter((name) => isRoadShapeLayerName(name));
    setLayerTreeExpanded('result', true);
    setLayerTreeExpanded('route', true);
    renderLayerControls();
    handleRoadZoomChanged();
}

function openSidebar(title) {
    const sidebar = document.getElementById('sidebar');
    const titleSpan = document.getElementById('sidebar-title');
    const btnClose = document.getElementById('btnCloseSidebar');

    if (sidebar) {
        sidebar.classList.remove('collapsed');
        if (titleSpan) {
            titleSpan.innerText = title;
        }
        if (btnClose) btnClose.textContent = '◀';
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => map.invalidateSize(), 220);
    }
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const btnClose = document.getElementById('btnCloseSidebar');
    if (sidebar) {
        sidebar.classList.add('collapsed');
    }
    if (btnClose) btnClose.textContent = '▶';
    highlightLayer.clearLayers();
    requestAnimationFrame(() => map.invalidateSize());
    setTimeout(() => map.invalidateSize(), 220);
}

