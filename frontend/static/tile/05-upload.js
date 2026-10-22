// DLT 로그 업로드 -> 그 안의 SDI 를 서버에 올려 두고, 지도에 전부 뿌린다.
async function uploadLog(file) {
    const body = new FormData();
    body.append('file', file);
    await loadSdiSource(body, `${file.name} 파싱 중...`);
}

// 수 GB 짜리 로그는 업로드 대신 경로만 넘긴다.
async function loadLogByPath() {
    const path = $('logPath').value.trim();
    if (!path) return;
    const body = new FormData();
    body.append('path', path);
    await loadSdiSource(body, `${path} 파싱 중...`);
}

async function loadSdiSource(body, pendingLabel) {
    const label = $('dropLabel');
    label.textContent = pendingLabel;

    try {
        const data = await getJson(API_BASE + '/api/sdi-source', { method: 'POST', body });
        sdiSummary = data.summary;
        label.textContent = `${sdiSummary.source_name} · 다른 로그를 올리면 교체됩니다`;
        $('clearLogBtn').hidden = false;
        $('logState').textContent = `${sdiSummary.total}건`;
        renderSdiSummary(sdiSummary);
        renderSdiTiles(sdiSummary);
        await loadAllSdi();
        if (currentTarget) await runSearch();
    } catch (ex) {
        label.textContent = `실패: ${ex.message}`;
    }
}

function renderSdiSummary(summary) {
    const box = $('sdiSummary');
    box.hidden = false;
    box.innerHTML = [
        [summary.total, 'SDI'],
        [summary.tile_count, '타일'],
        [summary.mesh_count, '메시'],
    ].map(([value, name]) => `<div class="stat"><b>${fmtNum(value)}</b><span>${name}</span></div>`).join('');
}

async function loadAllSdi() {
    const data = await getJson(API_BASE + '/api/sdi');
    allSdiPoints = data.sdi;
    renderSdiMarkers(allSdiPoints);
}

async function clearLogSdi() {
    await getJson(API_BASE + '/api/sdi-source', { method: 'DELETE' });
    sdiSummary = null;
    allSdiPoints = [];
    sdiMarkerLayer.clearLayers();
    sdiTileLayer.clearLayers();
    $('sdiSummary').hidden = true;
    $('clearLogBtn').hidden = true;
    $('logState').textContent = '';
    $('logPath').value = '';
    $('logInput').value = '';
    $('dropLabel').textContent = 'DLT 로그를 올리면 단말이 실제로 쓴 SDI 와 대조합니다';
    if (currentTarget) runSearch();
}

function bindUpload() {
    const zone = $('dropZone');
    const input = $('logInput');

    $('clearLogBtn').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearLogSdi();
    });

    input.addEventListener('change', () => {
        if (input.files.length) uploadLog(input.files[0]);
    });

    $('logPathBtn').addEventListener('click', loadLogByPath);
    $('logPath').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') loadLogByPath();
    });
    // 경로 입력칸을 누를 때 드롭존의 파일 선택창이 열리지 않게 한다.
    $('logPath').addEventListener('click', (event) => event.stopPropagation());

    ['dragenter', 'dragover'].forEach((name) => {
        zone.addEventListener(name, (event) => {
            event.preventDefault();
            zone.classList.add('over');
        });
    });
    ['dragleave', 'drop'].forEach((name) => {
        zone.addEventListener(name, (event) => {
            event.preventDefault();
            zone.classList.remove('over');
        });
    });
    zone.addEventListener('drop', (event) => {
        const file = event.dataTransfer.files[0];
        if (file) uploadLog(file);
    });
}

// --- 시작 ---
window.addEventListener('DOMContentLoaded', async () => {
    initMap();
    bindSearch();
    bindUpload();
    bindVsm();

    // SAFE_DRIVE_DB 는 서버가 뜰 때 이미 읽어 둔다.
    try {
        const vsm = await getJson(API_BASE + '/api/vsm/status');
        vsmStatus = vsm.status;
    } catch (ex) {
        vsmStatus = null;
    }
    renderVsmStatus();
    await refreshVsm();

    // 서버가 이미 로그를 들고 있으면(새로고침) 그대로 복원한다.
    try {
        const data = await getJson(API_BASE + '/api/sdi-source');
        if (data.summary.total) {
            sdiSummary = data.summary;
            $('dropLabel').textContent = `${sdiSummary.source_name} · 다른 로그를 올리면 교체됩니다`;
            $('clearLogBtn').hidden = false;
            $('logState').textContent = `${sdiSummary.total}건`;
            renderSdiSummary(sdiSummary);
            renderSdiTiles(sdiSummary);
            await loadAllSdi();
        }
    } catch (ex) {
        // 아직 올린 로그가 없다 - 정상 경로다.
    }
});
