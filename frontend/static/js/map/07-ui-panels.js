// ===== 사이드바 · 드래그앤드롭 · 업로드 패널 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const btnClose = document.getElementById('btnCloseSidebar');
    const refreshMapSize = () => {
        // Sidebar width transition finishes around 200ms.
        // Invalidate twice to avoid right-edge clipping.
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => map.invalidateSize(), 220);
    };

    const syncSidebarToggle = () => {
        if (!sidebar || !btnClose) return;
        btnClose.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
    };

    if (btnClose) {
        btnClose.onclick = function () {
            sidebar?.classList.toggle('collapsed');
            syncSidebarToggle();
            refreshMapSize();
        };
    }
    syncSidebarToggle();
}

function setupDragAndDrop(dropZoneId, inputId) {
    const dropZone = document.getElementById(dropZoneId);
    const fileInput = document.getElementById(inputId);

    if (!dropZone || !fileInput) return;

    // Skip if already setup to prevent duplicate event listeners
    if (dropZone._dragDropSetup) return;
    dropZone._dragDropSetup = true;

    // Prevent default drag behaviors
    const preventDefaults = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults);
    });

    // Highlight drop zone when dragging over
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.style.borderColor = '#3b82f6';
            dropZone.style.backgroundColor = '#eef2ff';
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.style.borderColor = '#cbd5e1';
            dropZone.style.backgroundColor = '#f8fafc';
        });
    });

    // Handle drop
    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            fileInput.files = files;
            // Trigger change event to update UI
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    // Make dropzone clickable (only once!)
    dropZone.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });
}

function initUploadPanel() {
    bind('parseUploadButton', 'click', handleUploadAndParse);
    bind('parseLinkShpButton', 'click', () => handleUploadRoadShape('link'));
    bind('parseNodeShpButton', 'click', () => handleUploadRoadShape('node'));
    bind('clearShpButton', 'click', handleClearRoadShape);
    bind('addLinkStyleRuleButton', 'click', handleAddLinkStyleRule);
    bind('applyNodeStyleButton', 'click', applyRoadNodeStyleConfig);
    bind('applyVertexStyleButton', 'click', applyVertexStyleConfig);
    bind('layerCtxClose', 'click', closeLayerContextMenu);
    initLayerContextMenuDrag();

    bindFileSelectionSummary('logFileInput', 'logFileNameText', false);
    bindFileSelectionSummary('linkShpFolderInput', 'linkShpFileText', true);
    bindFileSelectionSummary('nodeShpFolderInput', 'nodeShpFileText', true);

    // Setup drag and drop for DLT log files
    setupDragAndDrop('logDropZone', 'logFileInput');
    setupDragAndDrop('linkDropZone', 'linkShpFolderInput');
    setupDragAndDrop('nodeDropZone', 'nodeShpFolderInput');

    loadRoadLinkBaseStylesFromStorage();
    loadRoadCustomLinkRulesFromStorage();
    loadRoadPointStylesFromStorage();
    loadLaneWidthConfigsFromStorage();
    loadRoadLinkIdLabelFromStorage();

    const nodeColorInput = document.getElementById('nodeColorInput');
    const nodeStrokeInput = document.getElementById('nodeStrokeInput');
    const nodeRadiusInput = document.getElementById('nodeRadiusInput');
    const nodeWeightInput = document.getElementById('nodeWeightInput');
    if (nodeColorInput) nodeColorInput.value = roadNodeStyleConfig.color;
    if (nodeStrokeInput) nodeStrokeInput.value = roadNodeStyleConfig.stroke;
    if (nodeRadiusInput) nodeRadiusInput.value = String(roadNodeStyleConfig.radius);
    if (nodeWeightInput) nodeWeightInput.value = String(roadNodeStyleConfig.weight);

    const vertexColorInput = document.getElementById('vertexColorInput');
    const vertexStrokeInput = document.getElementById('vertexStrokeInput');
    const vertexRadiusInput = document.getElementById('vertexRadiusInput');
    const vertexWeightInput = document.getElementById('vertexWeightInput');
    if (vertexColorInput) vertexColorInput.value = roadVertexStyleConfig.color;
    if (vertexStrokeInput) vertexStrokeInput.value = roadVertexStyleConfig.stroke;
    if (vertexRadiusInput) vertexRadiusInput.value = String(roadVertexStyleConfig.radius);
    if (vertexWeightInput) vertexWeightInput.value = String(roadVertexStyleConfig.weight);

    const exportBtn = document.getElementById('exportHtmlMenuButton');
    if (exportBtn) exportBtn.disabled = !(Array.isArray(markersData) && markersData.length > 0);
    const exportCsvBtn = document.getElementById('exportCsvMenuButton');
    if (exportCsvBtn) exportCsvBtn.disabled = !(Array.isArray(markersData) && markersData.length > 0);

    syncRoadLinkRuleEnabledState();
    renderCustomLinkRuleList();
    renderLinkStyleFieldOptions();
    setUploadProgress(0, '대기 중', false);
    const persistenceState = isRoadShapeOpfsAvailable() ? '영구 캐시 ON' : '영구 캐시 OFF';
    updateRoadShapeStateText(roadShapeMetaByKind, `로컬 업로드 모드 (${persistenceState}) | zoom ${roadMinZoom}+에서 표시`);
    void restoreRoadShapeFromLocalDb();
}

