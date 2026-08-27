// ===== 옴니박스 — 단일 검색창 + 타입 추론 + 후보 목록 ======================== //
//
// Six stacked search boxes took ~200px of sidebar before the layer tree, and the
// user had to know which box a value belonged in. Five of the six query kinds are
// distinguishable from the input itself, so the type is inferred instead of
// chosen up front.
//
// Bare integers are genuinely ambiguous (DLT ID / Marker ID / RID / LINK_ID /
// Request ID all look alike), so rather than forcing a pre-selection the
// candidates are listed and picked with the arrow keys — the command-palette
// pattern. Prefix operators skip the guessing entirely.
//
// The original inputs and handlers are reused as-is: a candidate writes into its
// input and calls its handler, so search behaviour is unchanged.

const OMNIBOX_KINDS = {
    dlt:   { label: 'DLT ID',         input: 'searchBox',          run: () => handleDltSearch() },
    id:    { label: 'Marker/Line ID', input: 'idSearchBox',        run: () => handleIdSearch() },
    rid:   { label: 'RID / LINK_ID',  input: 'ridSearchBox',       run: () => handleRidSearch() },
    req:   { label: 'Request ID',     input: 'requestIdSearchBox', run: () => handleRequestIdSearch() },
    coord: { label: '좌표',            input: 'latLonSearchBox',    run: () => handleLatLonSearch() },
    place: { label: '장소',            input: 'placeSearchBox',     run: () => handlePlaceSearch() }
};

const OMNIBOX_PREFIXES = { 'dlt:': 'dlt', 'id:': 'id', 'rid:': 'rid', 'link:': 'rid', 'req:': 'req',
    'route:': 'req', 'q:': 'place', '@': 'coord' };

let omniboxCandidates = [];
let omniboxActiveIndex = 0;

// Two floats separated by a comma (or whitespace) — a coordinate.
function omniboxParseCoord(text) {
    const m = String(text).match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    return Number.isFinite(a) && Number.isFinite(b) ? `${a}, ${b}` : null;
}

function omniboxSplitPrefix(raw) {
    const text = String(raw || '').trim();
    for (const [prefix, kind] of Object.entries(OMNIBOX_PREFIXES)) {
        if (text.toLowerCase().startsWith(prefix)) {
            return { kind, value: text.slice(prefix.length).trim() };
        }
    }
    return { kind: null, value: text };
}

// Ordered best-guess-first. An explicit prefix collapses this to one entry.
function omniboxBuildCandidates(raw) {
    const { kind, value } = omniboxSplitPrefix(raw);
    if (!value) return [];

    if (kind) {
        const coord = kind === 'coord' ? omniboxParseCoord(value) : null;
        if (kind === 'coord' && !coord) return [];
        return [{ kind, value: coord || value }];
    }

    const coord = omniboxParseCoord(value);
    if (coord) return [{ kind: 'coord', value: coord }];

    if (!/^\d+$/.test(value)) return [{ kind: 'place', value }];

    // All-digits: rank by what the number looks like rather than guessing one.
    const n = Number(value);
    const order = [];
    // Request ids in these logs are 8-digit and start at 10000000 / 20000000 / …
    if (value.length === 8 && n >= 10000000) order.push('req');
    // Marker/line ids are sequential per parse, so a value inside that range is
    // more likely a marker than a raw DLT id.
    if (Number.isFinite(maxId) && n <= maxId) order.push('id');
    order.push('dlt', 'rid');
    if (!order.includes('id')) order.push('id');
    if (!order.includes('req')) order.push('req');
    return [...new Set(order)].map((k) => ({ kind: k, value }));
}

function omniboxRender() {
    const box = document.getElementById('omnibox-results');
    if (!box) return;
    if (omniboxCandidates.length === 0) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    box.classList.remove('hidden');
    box.innerHTML = omniboxCandidates.map((c, i) => {
        const spec = OMNIBOX_KINDS[c.kind];
        return `<div class="omnibox-item${i === omniboxActiveIndex ? ' active' : ''}" data-index="${i}">`
            + `<span class="omnibox-item-kind">${spec.label}</span>`
            + `<span class="omnibox-item-value">${escapeHtml(c.value)}</span></div>`;
    }).join('');
    box.querySelectorAll('.omnibox-item').forEach((el) => {
        el.onmouseenter = () => {
            omniboxActiveIndex = Number(el.dataset.index);
            omniboxRender();
        };
        el.onclick = () => omniboxRun(Number(el.dataset.index));
    });
}

function omniboxRun(index) {
    const candidate = omniboxCandidates[index];
    if (!candidate) return;
    const spec = OMNIBOX_KINDS[candidate.kind];
    const input = document.getElementById(spec.input);
    if (input) input.value = candidate.value;
    omniboxCandidates = [];
    omniboxRender();
    spec.run();
}

function omniboxUpdate() {
    const field = document.getElementById('omnibox');
    omniboxCandidates = omniboxBuildCandidates(field?.value);
    omniboxActiveIndex = 0;
    omniboxRender();
}

function initOmnibox() {
    const field = document.getElementById('omnibox');
    if (!field) return;

    field.addEventListener('input', omniboxUpdate);
    field.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (omniboxCandidates.length === 0) return;
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            omniboxActiveIndex = (omniboxActiveIndex + step + omniboxCandidates.length)
                % omniboxCandidates.length;
            omniboxRender();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (omniboxCandidates.length === 0) omniboxUpdate();
            omniboxRun(omniboxActiveIndex);
            return;
        }
        if (e.key === 'Escape') {
            omniboxCandidates = [];
            omniboxRender();
        }
    });

    document.getElementById('omniboxClear')?.addEventListener('click', () => {
        field.value = '';
        omniboxUpdate();
        field.focus();
    });

    // Clicking elsewhere dismisses the list, but not when the click is inside it.
    document.addEventListener('click', (e) => {
        if (!document.getElementById('omnibox-wrap')?.contains(e.target)) {
            omniboxCandidates = [];
            omniboxRender();
        }
    });
}
