// ===== 도로 속성 조회 · 커스텀 링크 규칙 · 스타일 갱신 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function toUpperKey(value) {
    return String(value || '').trim().toUpperCase();
}

function findRoadPropValue(props, propKey) {
    if (!props || !propKey) return undefined;
    if (Object.prototype.hasOwnProperty.call(props, propKey)) return props[propKey];
    const upper = toUpperKey(propKey);
    if (Object.prototype.hasOwnProperty.call(props, upper)) return props[upper];

    const keys = Object.keys(props);
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (toUpperKey(key) === upper) return props[key];
    }
    return undefined;
}

function normalizeRuleMatchValue(value) {
    const str = String(value ?? '').trim();
    const num = Number(str);
    if (str !== '' && Number.isFinite(num)) return num;
    return str.toLowerCase();
}

function normalizeCustomLinkRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const propKey = String(raw.propKey || '').trim();
    const rawValue = String(raw.rawValue ?? '').trim();
    if (!propKey || rawValue === '') return null;
    const seqNum = Number(raw.seq);
    return {
        seq: Number.isFinite(seqNum) ? seqNum : 0,
        propKey,
        rawValue,
        normalizedValue: normalizeRuleMatchValue(rawValue),
        color: normalizeRoadColor(raw.color, '#8b5cf6'),
        weight: clampRoadLinkWeight(raw.weight ?? 2.1),
        customName: String(raw.customName || '').trim()
    };
}

function loadRoadCustomLinkRulesFromStorage() {
    const raw = readJsonSetting(ROAD_CUSTOM_LINK_RULES_STORAGE_KEY, []);
    const list = Array.isArray(raw) ? raw.map(normalizeCustomLinkRule).filter(Boolean) : [];
    roadCustomLinkRules = list;
    const maxSeq = list.reduce((max, rule) => Math.max(max, rule.seq || 0), 0);
    roadCustomLinkRuleSeq = maxSeq + 1;
}

function saveRoadCustomLinkRulesToStorage() {
    writeJsonSetting(ROAD_CUSTOM_LINK_RULES_STORAGE_KEY, roadCustomLinkRules);
}

function matchesCustomLinkRule(rule, props) {
    if (!rule || !props) return false;
    const propValue = findRoadPropValue(props, rule.propKey);
    if (propValue === undefined || propValue === null || propValue === '') return false;

    const propNum = Number(propValue);
    if (typeof rule.normalizedValue === 'number' && Number.isFinite(propNum)) {
        return propNum === rule.normalizedValue;
    }
    return String(propValue).trim().toLowerCase() === String(rule.normalizedValue);
}

function getCustomRoadLinkRuleKey(rule) {
    const seq = Number(rule?.seq);
    if (!Number.isFinite(seq)) return '';
    return `custom:${seq}`;
}

function normalizeUniqueRoadFieldNames(values) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(values)) return out;
    values.forEach((value) => {
        const name = String(value || '').trim();
        if (!name) return;
        const upper = toUpperKey(name);
        if (seen.has(upper)) return;
        seen.add(upper);
        out.push(name);
    });
    return out;
}

function getRoadLinkStyleFieldOptions() {
    const merged = normalizeUniqueRoadFieldNames([
        ...DEFAULT_ROAD_LINK_STYLE_FIELDS,
        ...roadLinkFieldNames,
        ...roadCustomLinkRules.map((rule) => rule?.propKey)
    ]);
    return merged.sort((a, b) => a.localeCompare(b));
}

function renderLinkStyleFieldOptions(selectedKey = '') {
    const select = document.getElementById('linkStylePropSelect');
    if (!select) return;

    const current = String(selectedKey || select.value || '').trim();
    const options = getRoadLinkStyleFieldOptions();

    select.innerHTML = '<option value="">필드 선택</option>';
    options.forEach((fieldName) => {
        const option = document.createElement('option');
        option.value = fieldName;
        option.textContent = fieldName;
        select.appendChild(option);
    });

    if (current && options.includes(current)) {
        select.value = current;
    }
}

function syncRoadLinkRuleEnabledState() {
    const valid = new Set(ROAD_LINK_RULES.map((rule) => rule.key));
    roadCustomLinkRules.forEach((rule) => {
        const customKey = getCustomRoadLinkRuleKey(rule);
        if (customKey) valid.add(customKey);
    });

    Object.keys(roadLinkRuleEnabled).forEach((key) => {
        if (!valid.has(key)) delete roadLinkRuleEnabled[key];
    });

    roadCustomLinkRules.forEach((rule) => {
        const customKey = getCustomRoadLinkRuleKey(rule);
        if (!customKey) return;
        if (typeof roadLinkRuleEnabled[customKey] !== 'boolean') {
            roadLinkRuleEnabled[customKey] = true;
        }
    });
}

function getRoadWorkerRequestedLinkProps() {
    const keys = new Set(DEFAULT_ROAD_LINK_STYLE_FIELDS);
    roadLinkFieldNames.forEach((fieldName) => {
        keys.add(fieldName);
        keys.add(toUpperKey(fieldName));
    });
    roadCustomLinkRules.forEach((rule) => {
        if (rule?.propKey) {
            keys.add(toUpperKey(rule.propKey));
            keys.add(rule.propKey);
        }
    });
    return Array.from(keys);
}

function syncRoadShapeWorkerQueryKeys() {
    if (!roadShapeWorker) return;
    roadShapeWorker.postMessage({
        type: 'setQueryKeys',
        linkPropKeys: getRoadWorkerRequestedLinkProps()
    });
}

function refreshRoadLayerStyles() {
    if (roadLinkGeoLayer) {
        roadLinkGeoLayer.setStyle((feature) => getRoadLinkStyle({
            ...(feature?.properties || {}),
            __featureRef: feature
        }));
    }
    if (roadNodeGeoLayer) {
        roadNodeGeoLayer.eachLayer((layer) => {
            if (typeof layer.setStyle !== 'function') return;
            const style = getRoadNodeStyle({
                ...(layer?.feature?.properties || {}),
                __featureRef: layer?.feature || null
            });
            layer.setStyle(style);
            if (typeof layer.setRadius === 'function') layer.setRadius(style.radius);
        });
    }
    if (roadLinkVertexGeoLayer) {
        roadLinkVertexGeoLayer.eachLayer((layer) => {
            if (typeof layer.setStyle !== 'function') return;
            const style = getRoadLinkVertexStyle({
                ...(layer?.feature?.properties || {}),
                __featureRef: layer?.feature || null
            });
            layer.setStyle(style);
            if (typeof layer.setRadius === 'function') layer.setRadius(style.radius);
        });
    }
}

function setSelectedRoadFeature(kind, feature) {
    const shpIndex = getRoadFeatureIndex(feature);
    const vertexIndex = Number(feature?.properties?.LINK_VERTEX_INDEX);
    const partIndex = Number(feature?.properties?.LINK_VERTEX_PART);
    if (kind === 'vertex' && Number.isFinite(shpIndex) && Number.isFinite(vertexIndex)) {
        selectedRoadFeatureRef = {
            kind,
            shpIndex,
            vertexIndex,
            partIndex: Number.isFinite(partIndex) ? partIndex : 0
        };
    } else if (Number.isFinite(shpIndex)) {
        selectedRoadFeatureRef = { kind, shpIndex };
    } else {
        selectedRoadFeatureRef = { kind: null, shpIndex: null };
    }
    refreshRoadLayerStyles();
}

function isSelectedRoadFeature(kind, feature) {
    if (!feature || selectedRoadFeatureRef.kind !== kind) return false;
    const shpIndex = getRoadFeatureIndex(feature);
    if (!Number.isFinite(shpIndex) || shpIndex !== selectedRoadFeatureRef.shpIndex) return false;
    if (kind !== 'vertex') return true;
    const vertexIndex = Number(feature?.properties?.LINK_VERTEX_INDEX);
    const partIndex = Number(feature?.properties?.LINK_VERTEX_PART);
    return Number.isFinite(vertexIndex)
        && vertexIndex === selectedRoadFeatureRef.vertexIndex
        && (Number.isFinite(partIndex) ? partIndex : 0) === (selectedRoadFeatureRef.partIndex ?? 0);
}

function renderCustomLinkRuleList() {
    const list = document.getElementById('linkStyleRuleList');
    if (!list) return;

    if (!Array.isArray(roadCustomLinkRules) || roadCustomLinkRules.length === 0) {
        list.innerHTML = '<div class="style-rule-empty">규칙 없음 (기본 색상 규칙 사용 중)</div>';
        return;
    }

    list.innerHTML = '';
    roadCustomLinkRules.forEach((rule, index) => {
        const row = document.createElement('div');
        row.className = 'style-rule-item';
        const nameLabel = rule.customName ? `${rule.customName} (${rule.propKey} = ${rule.rawValue})` : `${rule.propKey} = ${rule.rawValue}`;
        row.innerHTML = `
            <span class="style-rule-chip" style="background:${escapeHtml(rule.color)};"></span>
            <span class="style-rule-text">${escapeHtml(`${index + 1}. ${nameLabel} / ${rule.weight}px`)}</span>
            <button type="button" class="style-rule-remove">삭제</button>
        `;

        const removeBtn = row.querySelector('.style-rule-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                roadCustomLinkRules = roadCustomLinkRules.filter((item) => item.seq !== rule.seq);
                saveRoadCustomLinkRulesToStorage();
                syncRoadLinkRuleEnabledState();
                renderCustomLinkRuleList();
                renderLinkStyleFieldOptions();
                syncRoadShapeWorkerQueryKeys();
                refreshRoadLayerStyles();
                renderLayerControls();
                if (roadShapeLoaded) scheduleRoadViewportQuery();
            });
        }
        list.appendChild(row);
    });
}

function handleAddLinkStyleRule() {
    const nameInput = document.getElementById('linkStyleNameInput');
    const propInput = document.getElementById('linkStylePropSelect');
    const valueInput = document.getElementById('linkStyleValueInput');
    const colorInput = document.getElementById('linkStyleColorInput');
    const weightInput = document.getElementById('linkStyleWeightInput');

    const customName = String(nameInput?.value || '').trim();
    const propKey = String(propInput?.value || '').trim();
    const rawValue = String(valueInput?.value || '').trim();
    const color = String(colorInput?.value || '#8b5cf6').trim() || '#8b5cf6';
    const weightRaw = Number(weightInput?.value);
    const weight = Number.isFinite(weightRaw) ? Math.max(0.5, Math.min(12, weightRaw)) : 2.1;

    if (!propKey || rawValue === '') {
        setUploadProgress(0, '스타일 규칙은 속성명/값을 모두 입력해야 합니다.', false);
        return;
    }

    const normalizedValue = normalizeRuleMatchValue(rawValue);
    roadCustomLinkRules.push({
        seq: roadCustomLinkRuleSeq++,
        propKey,
        rawValue,
        normalizedValue,
        color,
        weight,
        customName
    });
    saveRoadCustomLinkRulesToStorage();
    syncRoadLinkRuleEnabledState();
    renderCustomLinkRuleList();
    renderLinkStyleFieldOptions(propKey);
    syncRoadShapeWorkerQueryKeys();
    refreshRoadLayerStyles();
    renderLayerControls();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    if (nameInput) nameInput.value = '';
    setUploadProgress(100, `링크 스타일 규칙 추가: ${customName || `${propKey}=${rawValue}`}`, false);
}

function applyRoadNodeStyleConfig() {
    const colorInput = document.getElementById('nodeColorInput');
    const strokeInput = document.getElementById('nodeStrokeInput');
    const radiusInput = document.getElementById('nodeRadiusInput');
    const weightInput = document.getElementById('nodeWeightInput');

    const color = String(colorInput?.value || DEFAULT_ROAD_NODE_STYLE.color).trim() || DEFAULT_ROAD_NODE_STYLE.color;
    const stroke = String(strokeInput?.value || DEFAULT_ROAD_NODE_STYLE.stroke).trim() || DEFAULT_ROAD_NODE_STYLE.stroke;
    const radiusRaw = Number(radiusInput?.value);
    const weightRaw = Number(weightInput?.value);

    Object.assign(roadNodeStyleConfig, {
        color,
        stroke,
        radius: Number.isFinite(radiusRaw) ? Math.max(1, Math.min(12, radiusRaw)) : DEFAULT_ROAD_NODE_STYLE.radius,
        weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(5, weightRaw)) : DEFAULT_ROAD_NODE_STYLE.weight
    });
    saveRoadPointStylesToStorage();
    refreshRoadLayerStyles();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    setUploadProgress(100, '노드 스타일 적용 완료', false);
}

function applyVertexStyleConfig() {
    const colorInput = document.getElementById('vertexColorInput');
    const strokeInput = document.getElementById('vertexStrokeInput');
    const radiusInput = document.getElementById('vertexRadiusInput');
    const weightInput = document.getElementById('vertexWeightInput');

    const color = String(colorInput?.value || DEFAULT_ROAD_VERTEX_STYLE.color).trim() || DEFAULT_ROAD_VERTEX_STYLE.color;
    const stroke = String(strokeInput?.value || DEFAULT_ROAD_VERTEX_STYLE.stroke).trim() || DEFAULT_ROAD_VERTEX_STYLE.stroke;
    const radiusRaw = Number(radiusInput?.value);
    const weightRaw = Number(weightInput?.value);

    Object.assign(roadVertexStyleConfig, {
        color,
        stroke,
        radius: Number.isFinite(radiusRaw) ? Math.max(1, Math.min(12, radiusRaw)) : DEFAULT_ROAD_VERTEX_STYLE.radius,
        weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(5, weightRaw)) : DEFAULT_ROAD_VERTEX_STYLE.weight
    });
    saveRoadPointStylesToStorage();
    refreshRoadLayerStyles();
    if (roadShapeLoaded) scheduleRoadViewportQuery();
    setUploadProgress(100, 'Vertex 스타일 적용 완료', false);
}

