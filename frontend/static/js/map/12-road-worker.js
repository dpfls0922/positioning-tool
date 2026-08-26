// ===== Road Shape 워커 통신 · 좌표/각도 계산 헬퍼 · 규칙 분류 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function handleRoadShapeWorkerMessage(event) {
    const data = event.data || {};

    if (data.type === 'progress') {
        const pct = Number.isFinite(data.pct) ? data.pct : 0;
        updateRoadShapeStateText(roadShapeMetaByKind, data.msg || 'Shape 처리 중...');
        setShapeLoadingProgress(data.msg || 'Shape 처리 중...');
        return;
    }

    if (data.type === 'ready') {
        roadShapeLoading = false;
        roadShapeLoaded = true;
        roadShapePendingLoad = false;
        roadLinkFeatureCount = Number(data.linkCount || 0);
        roadNodeFeatureCount = Number(data.nodeCount || 0);
        roadLinkFieldNames = normalizeUniqueRoadFieldNames([
            ...DEFAULT_ROAD_LINK_STYLE_FIELDS,
            ...(Array.isArray(data.linkFieldNames) ? data.linkFieldNames : [])
        ]);
        syncRoadLinkRuleEnabledState();
        renderLinkStyleFieldOptions();
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        roadLinkRenderedRuleCounts = {};
        roadNodeRenderedRuleCounts = {};
        layerCountOverride[ROAD_LINK_LAYER] = roadLinkFeatureCount;
        layerCountOverride[ROAD_NODE_LAYER] = roadNodeFeatureCount;
        ensureRoadShapeLayers();
        renderLayerControls();
        queryRoadViewport();
        setUploadProgress(100, 'Shape 로드 완료', false);
        if (roadLinkFeatureCount === 0) {
            updateRoadShapeStateText(roadShapeMetaByKind, '로드됨: 링크 0개 (SHP 타입/좌표계 확인 필요)');
            return;
        }
        const linkMode = data.linkCoordMode || 'none';
        const nodeMode = data.nodeCoordMode || 'none';
        const attrDesc = (data.linkAttrAvailable || data.nodeAttrAvailable)
            ? '속성팝업 사용 가능'
            : '속성팝업 제한(대용량 DBF 생략)';
        updateRoadShapeStateText(
            roadShapeMetaByKind,
            `로드 완료 (링크 ${roadLinkFeatureCount.toLocaleString()}, 노드 ${roadNodeFeatureCount.toLocaleString()}) | mode L:${linkMode} N:${nodeMode} | ${attrDesc}`
        );
        return;
    }

    if (data.type === 'queryResult') {
        const reqId = Number(data.requestId || 0);
        if (reqId < roadShapeLastRenderedRequestId) return;
        roadShapeLastRenderedRequestId = reqId;
        renderRoadViewportFeatures(data.links || [], data.nodes || []);
        const matchedLinks = Number.isFinite(data.linkMatched) ? data.linkMatched : roadLinkFeatureCount;
        const matchedNodes = Number.isFinite(data.nodeMatched) ? data.nodeMatched : roadNodeFeatureCount;
        const extra = (matchedLinks === 0 && matchedNodes === 0)
            ? '현재 화면에 데이터 없음 (지도 위치 확인)'
            : `표시 중 (링크 ${roadLinkRenderCount}/${matchedLinks}/${roadLinkFeatureCount}, 노드 ${roadNodeRenderCount}/${matchedNodes}/${roadNodeFeatureCount})`;
        updateRoadShapeStateText(roadShapeMetaByKind, extra);
        return;
    }

    if (data.type === 'error') {
        roadShapeLoading = false;
        roadShapePendingLoad = false;
        roadShapeLoaded = false;
        terminateRoadShapeWorker();
        setUploadProgress(0, `로드 실패: ${data.message || '알 수 없는 오류'}`, false);
        updateRoadShapeStateText(roadShapeMetaByKind, `로드 실패: ${data.message || '알 수 없는 오류'}`);
        return;
    }

    if (data.type === 'attrs') {
        const reqId = Number(data.requestId || 0);
        const resolver = roadShapeAttrRequests.get(reqId);
        if (resolver) {
            roadShapeAttrRequests.delete(reqId);
            resolver(data.props || {});
        }
        return;
    }

    if (data.type === 'findLinkByRidResult') {
        const reqId = Number(data.requestId || 0);
        const resolver = roadShapeFindRequests.get(reqId);
        if (resolver) {
            roadShapeFindRequests.delete(reqId);
            resolver(data.feature ? { feature: data.feature } : null);
        }
    }
}

function terminateRoadShapeWorker() {
    if (roadShapeWorker) {
        try { roadShapeWorker.terminate(); } catch (_) {}
        roadShapeWorker = null;
    }
    roadShapeAttrRequests.clear();
    roadShapeFindRequests.clear();
    roadShapeQueryRequestId = 0;
    roadShapeLastRenderedRequestId = 0;
    if (roadQueryDebounceTimer) {
        clearTimeout(roadQueryDebounceTimer);
        roadQueryDebounceTimer = null;
    }
}

function requestRoadShapeAttrs(kind, index) {
    return new Promise((resolve) => {
        if (!roadShapeWorker || !Number.isFinite(index) || index < 0) {
            resolve({});
            return;
        }

        const requestId = ++roadShapeAttrRequestSeq;
        roadShapeAttrRequests.set(requestId, resolve);
        roadShapeWorker.postMessage({ type: 'attrs', requestId, kind, index });

        setTimeout(() => {
            if (!roadShapeAttrRequests.has(requestId)) return;
            roadShapeAttrRequests.delete(requestId);
            resolve({});
        }, 2500);
    });
}

function getRoadFeatureIndex(feature) {
    const raw = feature?._shpIndex
        ?? feature?.properties?._shpIndex
        ?? feature?.properties?.__featureRef?.shpIndex;
    const index = Number(raw);
    return Number.isFinite(index) ? index : null;
}

function toRoadInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : null;
}

function normalizeHeadingDegrees(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const normalized = ((num % 360) + 360) % 360;
    return normalized;
}

function computeHeadingDeltaDegrees(a, b) {
    const h1 = normalizeHeadingDegrees(a);
    const h2 = normalizeHeadingDegrees(b);
    if (!Number.isFinite(h1) || !Number.isFinite(h2)) return null;
    let diff = Math.abs(h1 - h2);
    if (diff > 180) diff = 360 - diff;
    return diff;
}

function computeSegmentHeadingDegrees(start, end) {
    if (!Array.isArray(start) || !Array.isArray(end) || start.length < 2 || end.length < 2) {
        return null;
    }
    const lat1 = Number(start[0]);
    const lon1 = Number(start[1]);
    const lat2 = Number(end[0]);
    const lon2 = Number(end[1]);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
    const y = Math.sin((lon2 - lon1) * DEG2RAD) * Math.cos(lat2 * DEG2RAD);
    const x =
        Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
        Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos((lon2 - lon1) * DEG2RAD);
    const bearing = Math.atan2(y, x) * (180 / Math.PI);
    return normalizeHeadingDegrees(bearing);
}

function firstLastCoordsFromGeometry(geometry) {
    if (!geometry || !geometry.type) return null;
    const coords = geometry.coordinates;
    if (!Array.isArray(coords)) return null;

    if (geometry.type === 'LineString' && coords.length >= 2) {
        return { start: coords[0], end: coords[coords.length - 1] };
    }
    if (geometry.type === 'MultiLineString' && coords.length > 0) {
        const firstLine = coords.find((line) => Array.isArray(line) && line.length >= 2);
        const lastLine = [...coords].reverse().find((line) => Array.isArray(line) && line.length >= 2);
        if (firstLine && lastLine) {
            return { start: firstLine[0], end: lastLine[lastLine.length - 1] };
        }
    }
    return null;
}

function computeRoadFeatureAngle(feature) {
    const endpoints = firstLastCoordsFromGeometry(feature?.geometry);
    if (!endpoints) return null;
    const start = Array.isArray(endpoints.start) ? [endpoints.start[1], endpoints.start[0]] : null;
    const end = Array.isArray(endpoints.end) ? [endpoints.end[1], endpoints.end[0]] : null;
    return computeSegmentHeadingDegrees(start, end);
}

function classifyRoadLinkRule(props) {
    const roadCate = toRoadInt(findRoadPropValue(props, 'ROAD_CATE'));
    const linkFacil = toRoadInt(findRoadPropValue(props, 'LINK_FACIL'));
    if (roadCate === 11) return 'parkingRoad';
    if (linkFacil === 4) return 'underpass';
    if (linkFacil === 3) return 'overpass';
    if (linkFacil === 2) return 'tunnel';
    return 'default';
}

function classifyRoadNodeRule() {
    return 'default';
}

function getRoadLinkResolvedRule(props) {
    if (Array.isArray(roadCustomLinkRules) && roadCustomLinkRules.length > 0) {
        for (let i = 0; i < roadCustomLinkRules.length; i += 1) {
            const customRule = roadCustomLinkRules[i];
            if (!matchesCustomLinkRule(customRule, props)) continue;
            const customKey = getCustomRoadLinkRuleKey(customRule);
            return {
                key: customKey || 'default',
                label: customRule.customName || `${customRule.propKey}=${customRule.rawValue}`,
                color: customRule.color || '#8b5cf6',
                weight: Number(customRule.weight) || 2.1,
                isCustom: true
            };
        }
    }

    const builtInKey = classifyRoadLinkRule(props);
    const builtInRule = roadLinkRuleMap[builtInKey] || roadLinkRuleMap.default;
    const baseStyle = roadLinkBaseStyles?.[builtInRule?.key || 'default'] || {};
    return {
        key: builtInRule?.key || 'default',
        label: builtInRule?.label || '일반',
        color: normalizeRoadColor(baseStyle.color, builtInRule?.color || '#45c976'),
        weight: clampRoadLinkWeight(baseStyle.weight ?? builtInRule?.weight ?? 2.1),
        isCustom: false
    };
}

function isRoadLinkRuleEnabled(ruleKey) {
    return roadLinkRuleEnabled[ruleKey] !== false;
}

function isRoadNodeRuleEnabled(ruleKey) {
    return roadNodeRuleEnabled[ruleKey] !== false;
}

