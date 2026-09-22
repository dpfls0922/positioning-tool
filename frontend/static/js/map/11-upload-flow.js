// ===== 툴 패널 · 진행률 UI · 로그/Road Shape 업로드 흐름 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function initToolPanels() {
    const panelMap = {
        toolUploadBtn: 'uploadPanel',
        toolExportBtn: 'exportPanel',
        toolMarkerTableBtn: 'markerTablePanel',
        toolRouteBtn: 'routePanel',
        toolDistanceBtn: 'distancePanel',
        toolRadiusBtn: 'radiusPanel',
        toolSimulationBtn: 'simulationPanel',
        toolPlaybackBtn: 'playbackPanel',
        toolLegendBtn: 'legendPanel'
    };
    Object.entries(panelMap).forEach(([btnId, panelId]) => {
        bind(btnId, 'click', () => toggleToolPanel(panelId, btnId));
    });
    document.querySelectorAll('.panel-close-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const panelId = btn.getAttribute('data-close-panel');
            closeToolPanel(panelId);
        });
    });
    bind('exportHtmlMenuButton', 'click', () => handleExportHtmlFromMenu());
    bind('exportCsvMenuButton', 'click', () => handleExportCsvFromMenu());
    bind('toolBackdrop', 'click', closeAllToolPanels);
}

function toggleToolPanel(panelId, buttonId) {
    const panel = document.getElementById(panelId);
    const button = document.getElementById(buttonId);
    if (!panel || !button) return;

    const isHidden = panel.classList.contains('hidden');
    closeAllToolPanels();
    if (!isHidden) return;

    panel.classList.remove('hidden');
    button.classList.add('active');
    document.getElementById('toolBackdrop')?.classList.add('active');
}

function closeToolPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('hidden');
    syncToolButtonState();
}

function closeAllToolPanels() {
    ['uploadPanel', 'exportPanel', 'markerTablePanel', 'routePanel', 'distancePanel', 'radiusPanel', 'playbackPanel', 'simulationPanel', 'legendPanel']
        .forEach((panelId) => document.getElementById(panelId)?.classList.add('hidden'));
    syncToolButtonState();
}

function syncToolButtonState() {
    const mapping = {
        toolUploadBtn: 'uploadPanel',
        toolExportBtn: 'exportPanel',
        toolMarkerTableBtn: 'markerTablePanel',
        toolRouteBtn: 'routePanel',
        toolDistanceBtn: 'distancePanel',
        toolRadiusBtn: 'radiusPanel',
        toolSimulationBtn: 'simulationPanel',
        toolPlaybackBtn: 'playbackPanel',
        toolLegendBtn: 'legendPanel'
    };
    Object.entries(mapping).forEach(([btnId, panelId]) => {
        const panel = document.getElementById(panelId);
        document.getElementById(btnId)?.classList.toggle('active', !!panel && !panel.classList.contains('hidden'));
    });
    const hasOpenPanel = Object.values(mapping).some((panelId) => {
        const panel = document.getElementById(panelId);
        return panel && !panel.classList.contains('hidden');
    });
    document.getElementById('toolBackdrop')?.classList.toggle('active', hasOpenPanel);
}

function setUploadProgress(percent, status, parsingMode = false) {
    const bar = document.getElementById('uploadProgressBar');
    const statusEl = document.getElementById('uploadStatusText');
    const wrap = document.getElementById('uploadProgressWrap');

    if (wrap) wrap.classList.toggle('parsing', parsingMode);
    if (bar) {
        const pct = Math.max(0, Math.min(100, percent));
        bar.style.width = `${pct}%`;
        // indeterminate 모드: percent가 0이고 parsingMode이면 striped animation
        if (parsingMode && pct > 0 && pct < 100) {
            bar.classList.add('progress-active');
            bar.classList.remove('progress-indeterminate');
        } else if (parsingMode && pct === 0) {
            bar.classList.add('progress-indeterminate');
            bar.classList.remove('progress-active');
            bar.style.width = '100%';
        } else {
            bar.classList.remove('progress-active', 'progress-indeterminate');
        }
    }
    if (statusEl && status) statusEl.textContent = status;
}

function setShapeLoadingProgress(status) {
    // SHP 로딩 중: indeterminate bar + 상태 텍스트
    const bar = document.getElementById('uploadProgressBar');
    const statusEl = document.getElementById('uploadStatusText');
    const wrap = document.getElementById('uploadProgressWrap');
    if (wrap) wrap.classList.add('parsing');
    if (bar) {
        bar.classList.add('progress-indeterminate');
        bar.classList.remove('progress-active');
        bar.style.width = '100%';
    }
    if (statusEl && status) statusEl.textContent = status;
}

function clearParsingProgressTimer() {
    if (parsingProgressTimer) {
        clearInterval(parsingProgressTimer);
        parsingProgressTimer = null;
    }
}

function startParsingProgress() {
    clearParsingProgressTimer();
    parsingProgressValue = 0;
    setUploadProgress(parsingProgressValue, '파싱 중 0%', true);
    parsingProgressTimer = setInterval(() => {
        parsingProgressValue = Math.min(95, parsingProgressValue + (parsingProgressValue < 60 ? 6 : 2));
        setUploadProgress(parsingProgressValue, `파싱 중 ${parsingProgressValue}%`, true);
        if (parsingProgressValue >= 95) {
            clearParsingProgressTimer();
        }
    }, 180);
}

function finishParsingProgress(success = true, statusText = '완료') {
    clearParsingProgressTimer();
    if (success) {
        setUploadProgress(100, statusText, false);
        return;
    }
    setUploadProgress(0, statusText, false);
}

function handleUploadAndParse() {
    const fileInput = document.getElementById('logFileInput');
    const parseButton = document.getElementById('parseUploadButton');
    const file = fileInput?.files?.[0];

    if (!file) {
        setUploadProgress(0, '대기 중', false);
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    if (parseButton) parseButton.disabled = true;
    setUploadProgress(5, '업로드 준비 중', false);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/parse-log', true);

    xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const ratio = event.loaded / event.total;
        const progress = Math.round(ratio * 100);
        setUploadProgress(progress, `업로드 중 ${Math.round(ratio * 100)}%`, false);
    };
    xhr.upload.onload = () => {
        setUploadProgress(100, '업로드 완료', false);
        startParsingProgress();
    };

    xhr.onload = () => {
        if (parseButton) parseButton.disabled = false;

        let response = null;
        try {
            response = JSON.parse(xhr.responseText);
        } catch (e) {
            finishParsingProgress(false, '실패: 응답 파싱 오류');
            return;
        }

        if (xhr.status < 200 || xhr.status >= 300 || !response?.ok) {
            finishParsingProgress(false, `실패: ${response?.error || '업로드/파싱 오류'}`);
            return;
        }

        markersData = response.coords || [];
        parkingLotStateMarkersData = response.parking_lot_state_markers || [];
        rollPitchResetMarkersData = response.roll_pitch_reset_markers || [];
        linesData = response.lines || [];
        setSdiBlockTimeline(response.sdi_block_timeline || []);
        setSimShadeTimeline(response.shade_timeline || []);
        console.log('[DEBUG] Loaded data:', {
            markersCount: markersData.length,
            parkingLotStateMarkersCount: parkingLotStateMarkersData.length,
            rollPitchResetMarkersCount: rollPitchResetMarkersData.length,
            linesCount: linesData.length
        });
        currentResultName = response.result_name || 'result';
        minTs = Number.isFinite(response.min_timestamp_ms) ? response.min_timestamp_ms : 0;
        maxTs = Number.isFinite(response.max_timestamp_ms) ? response.max_timestamp_ms : 1;
        maxId = Number.isFinite(response.max_id) ? response.max_id : 1;

        initSlider(minTs, maxTs);
        renderFromCurrentData();
        if (roadShapeLoaded) {
            scheduleRoadViewportQuery();
        } else if (roadShapePendingLoad) {
            handleRoadZoomChanged();
        }
        setTimeout(() => renderLayerControls(), 0);
        const exportBtn = document.getElementById('exportHtmlMenuButton');
        if (exportBtn) exportBtn.disabled = false;
        const exportCsvBtn = document.getElementById('exportCsvMenuButton');
        if (exportCsvBtn) exportCsvBtn.disabled = false;

        finishParsingProgress(true, '완료');
    };

    xhr.onerror = () => {
        if (parseButton) parseButton.disabled = false;
        finishParsingProgress(false, '실패: 네트워크 오류');
    };

    xhr.send(formData);
}

async function handleUploadRoadShape(kind) {
    const config = (kind === 'node')
        ? {
            inputId: 'nodeShpFolderInput',
            buttonId: 'parseNodeShpButton',
            label: '노드'
        }
        : {
            inputId: 'linkShpFolderInput',
            buttonId: 'parseLinkShpButton',
            label: '링크'
        };

    const fileInput = document.getElementById(config.inputId);
    const parseButton = document.getElementById(config.buttonId);
    const files = Array.from(fileInput?.files || []);
    if (files.length === 0) {
        setUploadProgress(0, `${config.label} SHP 폴더를 선택하세요.`, false);
        return;
    }

    const validationError = validateRoadShapeFolderSelection(files, config.label);
    if (validationError) {
        setUploadProgress(0, validationError, false);
        return;
    }

    if (parseButton) parseButton.disabled = true;
    setUploadProgress(10, `${config.label} SHP 읽는 중...`, false);

    try {
        const folderName = deriveFolderName(files);
        roadMinZoom = ROAD_RENDER_MIN_ZOOM;
        setUploadProgress(35, `${config.label} Shape 로컬 준비 중...`, false);

        const groups = await buildRoadShapeGroupsFromFiles(kind, files);
        roadShapeLocalGroupsByKind = {
            ...roadShapeLocalGroupsByKind,
            [kind]: groups
        };
        roadShapeMetaByKind = {
            ...roadShapeMetaByKind,
            [kind]: makeLocalRoadShapeMeta(kind, folderName, files, roadMinZoom)
        };
        await saveRoadShapeKindToLocalDb(kind, roadShapeMetaByKind[kind], groups);
        roadShapePendingLoad = true;
        roadShapeLoading = false;
        const persistenceState = isRoadShapeOpfsAvailable() ? '영구 캐시 ON' : '영구 캐시 OFF';
        updateRoadShapeStateText(
            roadShapeMetaByKind,
            `${config.label} 로컬 업로드 완료 (${persistenceState}), zoom ${roadMinZoom}+에서 표시`
        );
        handleRoadZoomChanged();
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Shapefile 파싱 실패';
        setUploadProgress(0, `실패: ${message}`, false);
    } finally {
        if (parseButton) parseButton.disabled = false;
    }
}

async function handleClearRoadShape() {
    const clearBtn = document.getElementById('clearShpButton');
    if (clearBtn) clearBtn.disabled = true;
    try {
        removeRoadShapeLayers();
        roadShapeMetaByKind = { link: null, node: null };
        roadShapeLocalGroupsByKind = { link: [], node: [] };
        roadShapePendingLoad = false;
        roadShapeLoading = false;
        await clearRoadShapeLocalDb();
        renderLayerControls();
        updateRoadShapeStateText(roadShapeMetaByKind);
        setUploadProgress(100, '로컬 Shape 삭제 완료', false);
    } catch (err) {
        const message = err instanceof Error ? err.message : '로컬 Shape 삭제 실패';
        setUploadProgress(0, `실패: ${message}`, false);
    } finally {
        if (clearBtn) clearBtn.disabled = false;
    }
}

function makeLocalRoadShapeMeta(kind, folderName, files, minZoom) {
    const totalBytes = Array.isArray(files)
        ? files.reduce((acc, file) => acc + Number(file?.size || 0), 0)
        : 0;
    return {
        kind,
        source: 'local',
        folder_name: folderName || `${kind}_shape`,
        file_name: `${kind}_local_folder`,
        min_zoom: minZoom,
        updated_at: new Date().toISOString().slice(0, 19),
        size_bytes: totalBytes,
        entry_count: Array.isArray(files) ? files.length : 0
    };
}

function deriveFolderName(files) {
    const firstPath = files[0]?.webkitRelativePath || '';
    if (firstPath.includes('/')) {
        return firstPath.split('/')[0] || 'road_shape';
    }
    return 'road_shape';
}

function getRoadShapeFolderRoot(files) {
    const roots = new Set();
    files.forEach((file) => {
        const relPath = String(file?.webkitRelativePath || '').trim();
        if (!relPath || !relPath.includes('/')) return;
        roots.add(relPath.split('/')[0]);
    });
    if (roots.size !== 1) return '';
    return Array.from(roots)[0] || '';
}

function validateRoadShapeFolderSelection(files, label) {
    if (!Array.isArray(files) || files.length === 0) {
        return `${label} SHP 폴더를 선택하세요.`;
    }

    const folderRoot = getRoadShapeFolderRoot(files);
    if (!folderRoot) {
        return `${label}는 폴더 선택 업로드만 지원합니다. (.shp/.shx/.dbf 포함 폴더 선택)`;
    }

    const grouped = groupRoadShapeFiles(files);
    if (grouped.length === 0) {
        return `${label} 폴더에서 .shp 파일을 찾지 못했습니다.`;
    }

    for (let i = 0; i < grouped.length; i += 1) {
        const group = grouped[i];
        if (!group.shp) continue;
        if (!group.shx || !group.dbf) {
            const missing = [];
            if (!group.shx) missing.push('.shx');
            if (!group.dbf) missing.push('.dbf');
            return `${label} SHP 세트 불완전: ${group.name}에 ${missing.join(', ')}가 없습니다.`;
        }
    }

    return '';
}

function groupRoadShapeFiles(files) {
    const groups = new Map();
    files.forEach((file) => {
        const relPath = (file?.webkitRelativePath || file?.name || '').trim();
        if (!relPath) return;
        const normalizedPath = relPath.replace(/\\/g, '/');
        const lower = normalizedPath.toLowerCase();
        const dot = lower.lastIndexOf('.');
        if (dot <= 0) return;

        const ext = lower.slice(dot + 1);
        if (!['shp', 'dbf', 'prj', 'cpg', 'shx'].includes(ext)) return;

        const base = lower.slice(0, dot);
        if (!groups.has(base)) {
            groups.set(base, {
                name: normalizedPath.split('/').pop()?.replace(/\.[^.]+$/, '') || base,
                shp: null,
                shx: null,
                dbf: null,
                prj: null,
                cpg: null
            });
        }

        const g = groups.get(base);
        if (ext === 'shp') g.shp = file;
        if (ext === 'shx') g.shx = file;
        if (ext === 'dbf') g.dbf = file;
        if (ext === 'prj') g.prj = file;
        if (ext === 'cpg') g.cpg = file;
    });

    return Array.from(groups.values()).filter((g) => !!g.shp);
}

async function buildRoadShapeGroupsFromFiles(kind, files) {
    const grouped = groupRoadShapeFiles(files);
    if (grouped.length === 0) {
        throw new Error('유효한 SHP 그룹이 없습니다.');
    }

    const groups = [];
    const kindLabel = kind === 'node' ? '노드' : '링크';
    for (let i = 0; i < grouped.length; i += 1) {
        const group = grouped[i];
        updateRoadShapeStateText(
            roadShapeMetaByKind,
            `${kindLabel} 파일 읽는 중 ${i + 1}/${grouped.length}: ${group.name}`
        );

        const shpBuf = await group.shp.arrayBuffer();
        let dbfBuf = null;
        if (group.dbf) {
            dbfBuf = await group.dbf.arrayBuffer();
        }

        let prjText = '';
        let cpgText = '';
        try { prjText = group.prj ? await group.prj.text() : ''; } catch (_) {}
        try { cpgText = group.cpg ? await group.cpg.text() : ''; } catch (_) {}

        groups.push({
            kind,
            name: group.name,
            shpBuf,
            dbfBuf,
            prjText,
            cpgText
        });
    }

    return groups;
}

function cloneRoadShapeGroupsForWorker() {
    const groups = [];
    ['link', 'node'].forEach((kind) => {
        const sourceGroups = Array.isArray(roadShapeLocalGroupsByKind?.[kind]) ? roadShapeLocalGroupsByKind[kind] : [];
        sourceGroups.forEach((group) => {
            const shpBuf = group?.shpBuf instanceof ArrayBuffer && group.shpBuf.byteLength > 0 ? group.shpBuf : null;
            const dbfBuf = group?.dbfBuf instanceof ArrayBuffer && group.dbfBuf.byteLength > 0 ? group.dbfBuf : null;
            if (!(shpBuf instanceof ArrayBuffer)) return;
            groups.push({
                kind,
                name: group?.name || `${kind}_shape`,
                shpBuf,
                dbfBuf,
                prjText: typeof group?.prjText === 'string' ? group.prjText : '',
                cpgText: typeof group?.cpgText === 'string' ? group.cpgText : ''
            });
        });
    });
    return groups;
}

async function getRoadShapeGroupsForWorker() {
    const inMemoryGroups = cloneRoadShapeGroupsForWorker();
    if (inMemoryGroups.length > 0) {
        return inMemoryGroups;
    }

    const restored = [];
    for (const kind of ['link', 'node']) {
        const record = await loadRoadShapeKindFromLocalDb(kind);
        const groups = Array.isArray(record?.groups) ? record.groups : [];
        if (groups.length > 0) {
            roadShapeLocalGroupsByKind[kind] = groups;
            restored.push(...groups.map((group) => ({
                kind,
                name: group?.name || `${kind}_shape`,
                shpBuf: group?.shpBuf,
                dbfBuf: group?.dbfBuf,
                prjText: typeof group?.prjText === 'string' ? group.prjText : '',
                cpgText: typeof group?.cpgText === 'string' ? group.cpgText : ''
            })));
        }
    }
    return restored;
}

function releaseTransferredRoadShapeBuffers(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return;
    const transferredKeys = new Set(
        groups.map((group) => `${group?.kind || ''}::${group?.name || ''}`)
    );
    ['link', 'node'].forEach((kind) => {
        const sourceGroups = Array.isArray(roadShapeLocalGroupsByKind?.[kind]) ? roadShapeLocalGroupsByKind[kind] : [];
        sourceGroups.forEach((group) => {
            const key = `${kind}::${group?.name || ''}`;
            if (!transferredKeys.has(key)) return;
            group.shpBuf = null;
            group.dbfBuf = null;
        });
    });
}

async function loadRoadShapeOnDemand() {
    if (roadShapeLoading || !roadShapePendingLoad) return;
    if (map.getZoom() < roadMinZoom) return;
    await loadRoadShapeOnDemandForced();
}

async function loadRoadShapeOnDemandForced() {
    if (roadShapeLoading || !roadShapePendingLoad) return;
    roadShapeLoading = true;
    updateRoadShapeStateText(roadShapeMetaByKind, '레이어 로딩 중...');
    setShapeLoadingProgress('SHP 파일 읽는 중...');
    try {
        terminateRoadShapeWorker();
        roadShapeWorker = new Worker(`/static/js/road_shape_worker.js?v=${ROAD_WORKER_VERSION}`);
        roadShapeWorker.onmessage = handleRoadShapeWorkerMessage;
        roadShapeWorker.onerror = () => {
            roadShapeLoading = false;
            roadShapePendingLoad = false;
            roadShapeLoaded = false;
            updateRoadShapeStateText(roadShapeMetaByKind, '로드 실패: Worker 오류');
        };
        syncRoadShapeWorkerQueryKeys();

        const groups = await getRoadShapeGroupsForWorker();
        if (!Array.isArray(groups) || groups.length === 0) {
            throw new Error('로컬 Shape 데이터가 없습니다. Link/Node 폴더를 업로드하세요.');
        }
        const transferables = [];
        groups.forEach((group) => {
            if (group.shpBuf instanceof ArrayBuffer) transferables.push(group.shpBuf);
            if (group.dbfBuf instanceof ArrayBuffer) transferables.push(group.dbfBuf);
        });
        roadShapeWorker.postMessage({ type: 'loadGroups', groups }, transferables);
        releaseTransferredRoadShapeBuffers(groups);
    } catch (e) {
        roadShapeLoading = false;
        roadShapePendingLoad = false;
        roadShapeLoaded = false;
        terminateRoadShapeWorker();
        const message = e instanceof Error ? e.message : '레이어 로드 실패';
        if (message.includes('로컬 Shape 데이터가 없습니다')) {
            updateRoadShapeStateText(roadShapeMetaByKind, '업로드된 로컬 Shape가 없습니다');
        }
        updateRoadShapeStateText(roadShapeMetaByKind, `로드 실패: ${message}`);
    } finally {
        // Worker 기반 로딩에서는 ready/error에서 상태를 정리합니다.
    }
}

