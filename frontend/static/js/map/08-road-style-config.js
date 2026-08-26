// ===== 도로 링크/포인트/차로폭 스타일 설정과 영속화 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function createDefaultRoadLinkBaseStyles() {
    return ROAD_LINK_RULES.reduce((acc, rule) => {
        acc[rule.key] = {
            color: rule.color || '#45c976',
            weight: clampRoadLinkWeight(rule.weight)
        };
        return acc;
    }, {});
}

function clampRoadLinkWeight(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 2.1;
    return Math.max(0.5, Math.min(12, num));
}

function normalizeRoadColor(value, fallback = '#45c976') {
    const str = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(str) ? str : fallback;
}

function normalizeRoadLinkBaseStyles(raw) {
    const defaults = createDefaultRoadLinkBaseStyles();
    const normalized = { ...defaults };
    if (!raw || typeof raw !== 'object') return normalized;

    Object.keys(defaults).forEach((key) => {
        const source = raw[key];
        if (!source || typeof source !== 'object') return;
        const base = defaults[key];
        normalized[key] = {
            color: normalizeRoadColor(source.color, base.color),
            weight: clampRoadLinkWeight(source.weight)
        };
    });
    return normalized;
}

function loadRoadLinkBaseStylesFromStorage() {
    const defaults = createDefaultRoadLinkBaseStyles();
    roadLinkBaseStyles = { ...defaults };
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(ROAD_LINK_BASE_STYLE_STORAGE_KEY);
        if (!raw) return;
        roadLinkBaseStyles = normalizeRoadLinkBaseStyles(JSON.parse(raw));
    } catch (_) {
        roadLinkBaseStyles = { ...defaults };
    }
}

function saveRoadLinkBaseStylesToStorage() {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(
            ROAD_LINK_BASE_STYLE_STORAGE_KEY,
            JSON.stringify(normalizeRoadLinkBaseStyles(roadLinkBaseStyles))
        );
    } catch (_) {
        // Ignore quota/storage errors.
    }
}

function normalizeRoadPointStyle(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { ...fallback };
    const radiusRaw = Number(raw.radius);
    const weightRaw = Number(raw.weight);
    return {
        color: normalizeRoadColor(raw.color, fallback.color),
        stroke: normalizeRoadColor(raw.stroke, fallback.stroke),
        radius: Number.isFinite(radiusRaw) ? Math.max(1, Math.min(12, radiusRaw)) : fallback.radius,
        weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(5, weightRaw)) : fallback.weight
    };
}

// roadNodeStyleConfig/roadVertexStyleConfig는 이미 렌더 함수들이 이 객체 참조를 직접 읽으므로,
// 재할당 대신 in-place로 값을 덮어써 참조가 어긋나는 일이 없게 한다.
function loadRoadPointStylesFromStorage() {
    const raw = readJsonSetting(ROAD_POINT_STYLE_STORAGE_KEY, null);
    Object.assign(roadNodeStyleConfig, normalizeRoadPointStyle(raw?.node, DEFAULT_ROAD_NODE_STYLE));
    Object.assign(roadVertexStyleConfig, normalizeRoadPointStyle(raw?.vertex, DEFAULT_ROAD_VERTEX_STYLE));
}

function saveRoadPointStylesToStorage() {
    writeJsonSetting(ROAD_POINT_STYLE_STORAGE_KEY, {
        node: { ...roadNodeStyleConfig },
        vertex: { ...roadVertexStyleConfig }
    });
}

function normalizeLaneWidthConfig(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { ...fallback };
    return {
        normal: clampLaneWidthValue(raw.normal, fallback.normal),
        extended: clampLaneWidthValue(raw.extended, fallback.extended),
        normalColor: normalizeRoadColor(raw.normalColor, fallback.normalColor),
        extendedColor: normalizeRoadColor(raw.extendedColor, fallback.extendedColor),
        fillOpacity: clampLaneOpacityValue(raw.fillOpacity, fallback.fillOpacity)
    };
}

function loadLaneWidthConfigsFromStorage() {
    const raw = readJsonSetting(LANE_WIDTH_CONFIG_STORAGE_KEY, null);
    Object.assign(laneWidthConfig, normalizeLaneWidthConfig(raw?.lane1, DEFAULT_LANE_WIDTH_CONFIG));
    Object.assign(laneWidthConfig2, normalizeLaneWidthConfig(raw?.lane2, DEFAULT_LANE_WIDTH_CONFIG_2));
    Object.assign(laneWidthConfigExtCalc, normalizeLaneWidthConfig(raw?.laneExtCalc, DEFAULT_LANE_WIDTH_CONFIG_EXT_CALC));
}

function saveLaneWidthConfigsToStorage() {
    writeJsonSetting(LANE_WIDTH_CONFIG_STORAGE_KEY, {
        lane1: { ...laneWidthConfig },
        lane2: { ...laneWidthConfig2 },
        laneExtCalc: { ...laneWidthConfigExtCalc }
    });
}

function loadRoadLinkIdLabelFromStorage() {
    const raw = readJsonSetting(ROAD_LINK_ID_LABEL_STORAGE_KEY, null);
    roadLinkIdLabelEnabled = raw === null ? true : !!raw;
}

function saveRoadLinkIdLabelToStorage() {
    writeJsonSetting(ROAD_LINK_ID_LABEL_STORAGE_KEY, roadLinkIdLabelEnabled);
}

function ensureRoadLinkBaseStyle(ruleKey) {
    const defaults = createDefaultRoadLinkBaseStyles();
    const fallback = defaults[ruleKey] || defaults.default;
    if (!roadLinkBaseStyles || typeof roadLinkBaseStyles !== 'object') {
        roadLinkBaseStyles = { ...defaults };
    }
    if (!roadLinkBaseStyles[ruleKey] || typeof roadLinkBaseStyles[ruleKey] !== 'object') {
        roadLinkBaseStyles[ruleKey] = { ...fallback };
    }
    return roadLinkBaseStyles[ruleKey];
}

function updateRoadLinkBaseStyle(ruleKey, patch) {
    if (!ruleKey || !patch || typeof patch !== 'object') return;
    const defaults = createDefaultRoadLinkBaseStyles();
    const fallback = defaults[ruleKey] || defaults.default;
    const current = ensureRoadLinkBaseStyle(ruleKey);

    if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
        current.color = normalizeRoadColor(patch.color, fallback.color);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'weight')) {
        current.weight = clampRoadLinkWeight(patch.weight);
    }

    saveRoadLinkBaseStylesToStorage();
    refreshRoadLayerStyles();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    renderLayerControls();
}

