// ===== 후보 링크 팝업 · 마커 테이블 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function normalizeCandidateLinkEntries(extra) {
    if (!extra || typeof extra !== 'object') return [];
    const direct = extra.candidate_link_scores ?? extra.candidate_links ?? extra.candidateLinkScores;
    if (Array.isArray(direct)) return direct;
    if (typeof direct === 'string') {
        try {
            const parsed = JSON.parse(direct);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function extractCandidateLinkIdSet(extra) {
    const entries = normalizeCandidateLinkEntries(extra);
    const nextIds = new Set();
    entries.forEach((entry) => {
        const raw = pickCandidateField(entry, ['link_id', 'linkId', 'rid', 'RID', 'candidate_link_id']);
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
            nextIds.add(parsed);
        }
    });
    return nextIds;
}


function pickCandidateField(entry, keys) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(keys)) return '';
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
            return entry[key];
        }
    }
    return '';
}

function formatCandidateCell(value) {
    if (value === undefined || value === null || value === '') return '-';
    const num = Number(value);
    if (Number.isFinite(num)) {
        return Math.abs(num) >= 1000 ? String(num) : num.toFixed(3).replace(/\.?0+$/, '');
    }
    return escapeHtml(value);
}

// anglePenalty처럼 기본점수에서 "빼지는" 항을 음수로 표시한다(Base = distancePenalty - anglePenalty + laneBonus).
function formatSubtractedCandidateCell(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return formatCandidateCell(value);
    return `-${formatCandidateCell(Math.abs(num))}`;
}

// 로그의 "Candidate Link[...] ... | Base: base = distancePenalty - anglePenalty + laneBonus | Adj: adjustment |
// Dist(... laneW: laneWeight fB: facilityBonus) | ..." 형식에서, 기본점수(base)에 곱해지는 항(laneWeight)과
// 더해지는 항(distancePenalty/laneBonus/facilityBonus/adjustment, anglePenalty는 빼지는 항)을 분리해서 보여준다.
function buildCandidateLinkPopupHtml(extra) {
    const entries = normalizeCandidateLinkEntries(extra)
        .sort((a, b) => {
            const sa = Number(pickCandidateField(a, ['total', 'totalScore', 'score']));
            const sb = Number(pickCandidateField(b, ['total', 'totalScore', 'score']));
            return (Number.isFinite(sb) ? sb : -Infinity) - (Number.isFinite(sa) ? sa : -Infinity);
        })
        .slice(0, 12);
    if (entries.length === 0) return '';

    const rows = entries.map((entry, index) => {
        const linkId = pickCandidateField(entry, ['link_id', 'linkId', 'rid', 'RID', 'candidate_link_id']);
        const base = pickCandidateField(entry, ['base', 'baseScore', 'base_score']);
        const total = pickCandidateField(entry, ['total', 'totalScore', 'score']);
        const laneWeight = pickCandidateField(entry, ['laneWeight', 'lane_weight']);
        const distancePenalty = pickCandidateField(entry, ['distancePenalty', 'distance_penalty']);
        const anglePenalty = pickCandidateField(entry, ['anglePenalty', 'angle_penalty']);
        const laneBonus = pickCandidateField(entry, ['laneBonus', 'lane_bonus']);
        const distScore = pickCandidateField(entry, ['distanceProjection', 'distance_projection']); // p: = penalty
        const distProj = pickCandidateField(entry, ['distanceScore', 'distance_score']); // d: = 실제 투영거리
        const adjustment = pickCandidateField(entry, ['adjustment']);
        const extraMul = pickCandidateField(entry, ['mul', 'extrapoint', 'extrapointdr', 'extrapointgps']);
        const baseNum = Number(base);
        const adjNum = Number(adjustment);
        const subtotal = (Number.isFinite(baseNum) && Number.isFinite(adjNum))
            ? formatCandidateCell(baseNum + adjNum)
            : '-';
        const extraMulCell = (extraMul === '' || extraMul === null || extraMul === undefined)
            ? '<span style="opacity:0.45">1.00</span>'
            : formatCandidateCell(extraMul);
        return `
            <tr>
                <td>${index + 1}</td>
                <td>${formatCandidateCell(linkId)}</td>
                <td class="weight-cell-base">${formatCandidateCell(base)}</td>
                <td class="weight-cell-base-sub">${formatSubtractedCandidateCell(distScore)}</td>
                <td class="weight-cell-base-sub">${formatCandidateCell(distProj)}</td>
                <td class="weight-cell-base-sub">${formatSubtractedCandidateCell(anglePenalty)}</td>
                <td class="weight-cell-base-sub">${formatCandidateCell(laneBonus)}</td>
                <td class="weight-cell-add">${formatCandidateCell(adjustment)}</td>
                <td class="weight-cell-add weight-cell-subtotal">${subtotal}</td>
                <td class="weight-cell-mul">${extraMulCell}</td>
                <td>${formatCandidateCell(total)}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="road-popup-subtitle" style="margin-top:8px;">후보 링크 정보</div>
        <div class="road-popup-summary">
            <div class="candidate-weight-table-scroll">
                <table class="road-popup-table candidate-weight-table">
                    <thead>
                        <tr>
                            <th rowspan="2">#</th>
                            <th rowspan="2">Link ID</th>
                            <th colspan="7" class="weight-group-base">기본점수</th>
                            <th colspan="1" class="weight-group-weight">가중치</th>
                            <th rowspan="2">최종점수</th>
                        </tr>
                        <tr>
                            <th class="weight-group-base">Base Score</th>
                            <th class="weight-group-base">거리페널티</th>
                            <th class="weight-group-base">dist(m)</th>
                            <th class="weight-group-base">각도페널티</th>
                            <th class="weight-group-base">차선보너스</th>
                            <th class="weight-group-base">+조정값</th>
                            <th class="weight-group-base weight-cell-subtotal">합계</th>
                            <th class="weight-group-weight">×Extrapoint</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function getMarkerTableCoreColumns() {
    return [
        { key: 'type', label: '분류' },
        { key: 'id', label: 'ID' },
        { key: 'dlt_id', label: 'DLT ID' },
        { key: 'timestamp_str', label: '시간' },
        { key: 'latitude', label: 'Lat' },
        { key: 'longitude', label: 'Lon' },
        { key: 'heading', label: 'Heading' },
        { key: 'color', label: 'Color' }
    ];
}

function getMarkerTableRows() {
    const rows = Array.isArray(markersData) ? markersData.slice() : [];
    rows.sort((a, b) => {
        const idA = Number.isFinite(a?.id) ? a.id : Number.MAX_SAFE_INTEGER;
        const idB = Number.isFinite(b?.id) ? b.id : Number.MAX_SAFE_INTEGER;
        if (idA !== idB) return idA - idB;
        return String(a?.timestamp_str || '').localeCompare(String(b?.timestamp_str || ''));
    });
    return rows;
}

function getMarkerTableFilteredRows() {
    const searchText = String(document.getElementById('markerTableSearchInput')?.value || '').trim().toLowerCase();
    return getMarkerTableRows().filter((row) => {
        if (markerTableSelectedType !== 'all' && row?.type !== markerTableSelectedType) {
            return false;
        }
        if (!searchText) return true;
        const extraValues = Object.values(row?.extra || {}).map((value) => String(value ?? ''));
        const corpus = [
            row?.type, row?.id, row?.dlt_id, row?.timestamp_str, row?.latitude, row?.longitude, row?.heading,
            ...extraValues
        ].map((value) => String(value ?? '').toLowerCase()).join(' | ');
        return corpus.includes(searchText);
    });
}

function getMarkerTableColumns(rows) {
    const baseColumns = getMarkerTableCoreColumns();
    const extraKeys = [];
    const seen = new Set();
    rows.forEach((row) => {
        Object.keys(row?.extra || {}).forEach((key) => {
            if (seen.has(key)) return;
            seen.add(key);
            extraKeys.push(key);
        });
    });
    extraKeys.sort((a, b) => a.localeCompare(b));
    return baseColumns.concat(extraKeys.map((key) => ({ key: `extra.${key}`, label: key })));
}

function formatMarkerTableCellValue(row, columnKey) {
    let value;
    if (columnKey.startsWith('extra.')) {
        value = row?.extra?.[columnKey.slice(6)];
    } else {
        value = row?.[columnKey];
    }
    if (value === null || value === undefined || value === '') return '-';
    if (typeof value === 'number') {
        if (columnKey === 'latitude' || columnKey === 'longitude') return value.toFixed(6);
        if (columnKey === 'heading') return value.toFixed(2);
        return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function updateMarkerTableTypeOptions(rows) {
    const select = document.getElementById('markerTableTypeSelect');
    if (!select) return;
    const counts = new Map();
    rows.forEach((row) => {
        const type = String(row?.type || 'Unknown');
        counts.set(type, (counts.get(type) || 0) + 1);
    });
    const sortedTypes = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));
    const options = [{ value: 'all', label: `전체 (${rows.length})` }]
        .concat(sortedTypes.map((type) => ({ value: type, label: `${type} (${counts.get(type)})` })));

    const previous = markerTableSelectedType;
    select.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('');
    markerTableSelectedType = options.some((option) => option.value === previous) ? previous : 'all';
    select.value = markerTableSelectedType;
}

function focusMarkerFromTableRow(row) {
    if (!row) return;
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.setView([lat, lon], Math.max(map.getZoom(), 18), { animate: true });
    const marker = markers.find((candidate) => candidate?.data?.type === row.type && candidate?.data?.id === row.id);
    if (marker && typeof marker.openPopup === 'function') {
        marker.openPopup();
    }
    highlightLayer.clearLayers();
    L.circleMarker([lat, lon], {
        radius: 9,
        color: '#2563eb',
        weight: 2,
        fillColor: '#60a5fa',
        fillOpacity: 0.25,
        interactive: false
    }).addTo(highlightLayer);
}

// Rendering every row of a large log creates a huge DOM (tens of thousands
// of <tr>) that slows down ALL browser painting — including map zoom/pan.
// Cap the rendered rows; search/type filters narrow into the cap.
const MARKER_TABLE_MAX_RENDER_ROWS = 1000;
let markerTableRenderedRows = [];

function renderMarkerTable() {
    const summary = document.getElementById('markerTableSummary');
    const head = document.getElementById('markerTableHead');
    const body = document.getElementById('markerTableBody');
    if (!summary || !head || !body) return;

    const allRows = getMarkerTableRows();
    updateMarkerTableTypeOptions(allRows);
    const rows = getMarkerTableFilteredRows();
    const columns = getMarkerTableColumns(rows.length > 0 ? rows : allRows);

    const truncated = rows.length > MARKER_TABLE_MAX_RENDER_ROWS;
    const visibleRows = truncated ? rows.slice(0, MARKER_TABLE_MAX_RENDER_ROWS) : rows;
    markerTableRenderedRows = visibleRows;

    summary.textContent = rows.length > 0
        ? `${markerTableSelectedType === 'all' ? '전체' : markerTableSelectedType} ${rows.length.toLocaleString()}건` +
          (truncated ? ` (상위 ${MARKER_TABLE_MAX_RENDER_ROWS.toLocaleString()}건만 표시 — 검색/타입으로 좁혀보세요)` : '')
        : '표시할 데이터 없음';

    head.innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr>`;

    if (rows.length === 0) {
        body.innerHTML = `<tr class="marker-table-empty"><td colspan="${columns.length}">조건에 맞는 마커가 없습니다.</td></tr>`;
        return;
    }

    body.innerHTML = visibleRows.map((row, index) => `
        <tr data-row-index="${index}">
            ${columns.map((column) => `<td>${escapeHtml(formatMarkerTableCellValue(row, column.key))}</td>`).join('')}
        </tr>
    `).join('');

    // One delegated listener instead of a listener per row
    if (!body._delegatedClickBound) {
        body._delegatedClickBound = true;
        body.addEventListener('click', (e) => {
            const tr = e.target?.closest?.('tr[data-row-index]');
            if (!tr) return;
            const row = markerTableRenderedRows[Number(tr.dataset.rowIndex)];
            if (row) focusMarkerFromTableRow(row);
        });
    }
}

