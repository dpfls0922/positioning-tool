// ===== 뷰포트 조회/렌더 · 줌 처리 · 도로 팝업 내용 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function queryRoadViewport() {
    if (!roadShapeWorker || !roadShapeLoaded) return;

    const zoom = map.getZoom();
    if (zoom < roadMinZoom) {
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadLinkMultiRuleGeoLayer) roadLinkMultiRuleGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        if (roadLinkVertexGeoLayer) roadLinkVertexGeoLayer.clearLayers();
        if (roadLaneWidthGeoLayer) roadLaneWidthGeoLayer.clearLayers();
        if (roadLaneWidth2GeoLayer) roadLaneWidth2GeoLayer.clearLayers();
        if (roadLaneWidthExtCalcGeoLayer) roadLaneWidthExtCalcGeoLayer.clearLayers();
        lastRenderedRoadLinks = [];
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        return;
    }

    const limits = getRoadQueryLimits(zoom);

    const bounds = map.getBounds();
    roadShapeWorker.postMessage({
        type: 'query',
        requestId: ++roadShapeQueryRequestId,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        includeLinks: activeGroups.has(ROAD_LINK_LAYER) || activeGroups.has(ROAD_LINK_VERTEX_LAYER) || activeGroups.has(SEGMENT_FB_LAYER) || activeGroups.has(LANE_WIDTH_LAYER) || activeGroups.has(LANE_WIDTH_LAYER_2) || activeGroups.has(LANE_WIDTH_EXT_CALC_LAYER),
        includeNodes: activeGroups.has(ROAD_NODE_LAYER),
        linkPropKeys: getRoadWorkerRequestedLinkProps(),
        maxLinks: limits.maxLinks,
        maxNodes: limits.maxNodes
    });
}

function getRoadQueryLimits(zoom) {
    if (zoom <= 11) {
        return { maxLinks: 1800, maxNodes: 900 };
    }
    if (zoom <= 13) {
        return { maxLinks: 4500, maxNodes: 1800 };
    }
    if (zoom <= 15) {
        return { maxLinks: 9000, maxNodes: 3000 };
    }
    if (zoom <= 16) {
        return { maxLinks: 4500, maxNodes: 1800 };
    }
    if (zoom <= 17) {
        return { maxLinks: 8000, maxNodes: 3200 };
    }
    return { maxLinks: ROAD_LINK_QUERY_LIMIT, maxNodes: ROAD_NODE_QUERY_LIMIT };
}

function scheduleRoadViewportQuery() {
    if (roadQueryDebounceTimer) clearTimeout(roadQueryDebounceTimer);
    roadQueryDebounceTimer = setTimeout(() => {
        roadQueryDebounceTimer = null;
        queryRoadViewport();
    }, 80);
}

function renderRoadViewportFeatures(linkFeatures, nodeFeatures) {
    ensureRoadShapeLayers();
    if (map.getZoom() < roadMinZoom) {
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadLinkMultiRuleGeoLayer) roadLinkMultiRuleGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        if (roadLinkVertexGeoLayer) roadLinkVertexGeoLayer.clearLayers();
        if (roadLaneWidthGeoLayer) roadLaneWidthGeoLayer.clearLayers();
        if (roadLaneWidth2GeoLayer) roadLaneWidth2GeoLayer.clearLayers();
        if (roadLaneWidthExtCalcGeoLayer) roadLaneWidthExtCalcGeoLayer.clearLayers();
        lastRenderedRoadLinks = [];
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        return;
    }

    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];
    const sourceNodes = Array.isArray(nodeFeatures) ? nodeFeatures : [];

    const resolvedLinkEntries = sourceLinks.map((feature) => {
        const props = feature?.properties || {};
        return {
            feature,
            rules: getRoadLinkMatchedRules(props)
        };
    });

    // 한 링크가 여러 분류에 해당하면 각 분류의 카운트에 모두 포함시킨다
    const linkRuleCounts = {};
    resolvedLinkEntries.forEach((entry) => {
        (entry.rules || []).forEach((rule) => {
            const ruleKey = rule?.key || 'default';
            linkRuleCounts[ruleKey] = (linkRuleCounts[ruleKey] || 0) + 1;
        });
    });
    roadLinkRenderedRuleCounts = linkRuleCounts;

    // 매칭된 분류 중 하나라도 켜져 있으면 표시한다
    const visibleLinks = resolvedLinkEntries
        .filter((entry) => (entry.rules || []).some((rule) => isRoadLinkRuleEnabled(rule.key)))
        .map((entry) => entry.feature);
    const visibleNodes = sourceNodes.filter((feature) => {
        const props = feature?.properties || {};
        return isRoadNodeRuleEnabled(classifyRoadNodeRule(props));
    });

    roadNodeRenderedRuleCounts = { default: visibleNodes.length };

    roadLabelEnabledForRender =
        roadLinkIdLabelEnabled &&
        map.getZoom() >= roadLabelZoom &&
        visibleLinks.length > 0 &&
        visibleLinks.length <= ROAD_LABEL_BIND_LIMIT;

    if (roadLinkGeoLayer) {
        roadLinkGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_LINK_LAYER) && visibleLinks.length > 0) {
            roadLinkGeoLayer.addData({ type: 'FeatureCollection', features: visibleLinks });
        }
    }

    if (roadLinkMultiRuleGeoLayer) {
        roadLinkMultiRuleGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_LINK_LAYER)) {
            const overlayFeatures = [];
            resolvedLinkEntries.forEach((entry) => {
                const enabledRules = (entry.rules || []).filter((rule) => isRoadLinkRuleEnabled(rule.key));
                if (enabledRules.length < 2 || !entry.feature?.geometry) return;
                // 대표(첫) 규칙 색은 기본 선으로 이미 그려졌으므로 나머지를 점선으로 겹친다
                enabledRules.slice(1).forEach((rule, overlayIdx) => {
                    overlayFeatures.push({
                        type: 'Feature',
                        geometry: entry.feature.geometry,
                        properties: {
                            __overlayColor: rule.color,
                            __overlayWeight: Math.max(Number(rule.weight) || 2.1, 2.1),
                            __overlayIdx: overlayIdx
                        }
                    });
                });
            });
            if (overlayFeatures.length > 0) {
                roadLinkMultiRuleGeoLayer.addData({ type: 'FeatureCollection', features: overlayFeatures });
            }
        }
    }

    if (roadNodeGeoLayer) {
        roadNodeGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_NODE_LAYER) && visibleNodes.length > 0) {
            roadNodeGeoLayer.addData({ type: 'FeatureCollection', features: visibleNodes });
        }
    }

    if (roadLinkVertexGeoLayer) {
        roadLinkVertexGeoLayer.clearLayers();
        if (activeGroups.has(ROAD_LINK_VERTEX_LAYER) && visibleLinks.length > 0) {
            roadLinkVertexGeoLayer.addData({
                type: 'FeatureCollection',
                features: makeRoadLinkVertexFeatures(visibleLinks)
            });
        }
    }

    // 차로폭 박스는 링크 규칙 필터와 무관하게 뷰포트 내 모든 링크 기준으로 그린다.
    lastRenderedRoadLinks = sourceLinks;
    refreshLaneWidthLayer();

    roadLinkRenderCount = visibleLinks.length;
    roadNodeRenderCount = visibleNodes.length;
}

function formatRoadShapeMetaForState(kindLabel, meta) {
    if (!meta || typeof meta !== 'object') return `${kindLabel}: 없음`;
    const name = meta.folder_name || meta.file_name || '-';
    const sizeBytes = Number(meta.size_bytes || 0);
    const sizeMb = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB` : '-';
    const updatedAt = meta.updated_at || '-';
    return `${kindLabel}: ${name} (${sizeMb}, ${updatedAt})`;
}

function updateRoadShapeStateText(metaByKind, extraMessage = '') {
    const el = document.getElementById('roadShapeStateText');
    if (!el) return;
    const linkMeta = metaByKind?.link || null;
    const nodeMeta = metaByKind?.node || null;
    if (!linkMeta && !nodeMeta) {
        el.textContent = extraMessage ? `저장된 파일 없음 | ${extraMessage}` : '저장된 파일 없음';
        return;
    }
    const parts = [
        formatRoadShapeMetaForState('Link', linkMeta),
        formatRoadShapeMetaForState('Node', nodeMeta)
    ];
    const suffix = extraMessage ? ` | ${extraMessage}` : '';
    el.textContent = `${parts.join(' | ')}${suffix}`;
}

function removeRoadShapeLayers() {
    if (featureGroups[ROAD_LINK_LAYER]) {
        map.removeLayer(featureGroups[ROAD_LINK_LAYER]);
        delete featureGroups[ROAD_LINK_LAYER];
    }
    if (featureGroups[ROAD_NODE_LAYER]) {
        map.removeLayer(featureGroups[ROAD_NODE_LAYER]);
        delete featureGroups[ROAD_NODE_LAYER];
    }
    if (featureGroups[ROAD_LINK_VERTEX_LAYER]) {
        map.removeLayer(featureGroups[ROAD_LINK_VERTEX_LAYER]);
        delete featureGroups[ROAD_LINK_VERTEX_LAYER];
    }
    if (featureGroups[LANE_WIDTH_LAYER]) {
        map.removeLayer(featureGroups[LANE_WIDTH_LAYER]);
        delete featureGroups[LANE_WIDTH_LAYER];
    }
    if (featureGroups[LANE_WIDTH_LAYER_2]) {
        map.removeLayer(featureGroups[LANE_WIDTH_LAYER_2]);
        delete featureGroups[LANE_WIDTH_LAYER_2];
    }
    if (featureGroups[LANE_WIDTH_EXT_CALC_LAYER]) {
        map.removeLayer(featureGroups[LANE_WIDTH_EXT_CALC_LAYER]);
        delete featureGroups[LANE_WIDTH_EXT_CALC_LAYER];
    }
    delete overlays[ROAD_LINK_LAYER];
    delete overlays[ROAD_NODE_LAYER];
    delete overlays[ROAD_LINK_VERTEX_LAYER];
    delete overlays[LANE_WIDTH_LAYER];
    delete overlays[LANE_WIDTH_LAYER_2];
    delete overlays[LANE_WIDTH_EXT_CALC_LAYER];
    delete layerCountOverride[ROAD_LINK_LAYER];
    delete layerCountOverride[ROAD_NODE_LAYER];
    delete layerCountOverride[ROAD_LINK_VERTEX_LAYER];
    delete layerCountOverride[LANE_WIDTH_LAYER];
    delete layerCountOverride[LANE_WIDTH_LAYER_2];
    delete layerCountOverride[LANE_WIDTH_EXT_CALC_LAYER];
    activeGroups.delete(ROAD_LINK_LAYER);
    activeGroups.delete(ROAD_NODE_LAYER);
    activeGroups.delete(ROAD_LINK_VERTEX_LAYER);
    activeGroups.delete(LANE_WIDTH_LAYER);
    activeGroups.delete(LANE_WIDTH_LAYER_2);
    activeGroups.delete(LANE_WIDTH_EXT_CALC_LAYER);
    layerOrder = layerOrder.filter((name) => name !== ROAD_LINK_LAYER && name !== ROAD_NODE_LAYER && name !== ROAD_LINK_VERTEX_LAYER && name !== LANE_WIDTH_LAYER && name !== LANE_WIDTH_LAYER_2 && name !== LANE_WIDTH_EXT_CALC_LAYER);

    roadLinkGeoLayer = null;
    roadLinkMultiRuleGeoLayer = null;
    roadNodeGeoLayer = null;
    roadLinkVertexGeoLayer = null;
    roadLaneWidthGeoLayer = null;
    roadLaneWidth2GeoLayer = null;
    roadLaneWidthExtCalcGeoLayer = null;
    laneExtCalcCache = { source: null, byLinkKey: null };
    lastRenderedRoadLinks = [];
    roadLinkFeatureCount = 0;
    roadNodeFeatureCount = 0;
    roadLinkRenderCount = 0;
    roadNodeRenderCount = 0;
    roadLinkRenderedRuleCounts = {};
    roadNodeRenderedRuleCounts = {};
    selectedRoadFeatureRef = { kind: null, shpIndex: null };
    roadShapeLoaded = false;
    terminateRoadShapeWorker();
}

function handleRoadZoomChanged() {
    const zoom = map.getZoom();
    const showRoad = zoom >= roadMinZoom;

    if (roadShapePendingLoad && !roadShapeLoaded && !roadShapeLoading) {
        if (showRoad) {
            void loadRoadShapeOnDemand();
        }
        return;
    }

    if (roadShapeLoaded) {
        if (showRoad) {
            scheduleRoadViewportQuery();
            return;
        }
        if (roadLinkGeoLayer) roadLinkGeoLayer.clearLayers();
        if (roadLinkMultiRuleGeoLayer) roadLinkMultiRuleGeoLayer.clearLayers();
        if (roadNodeGeoLayer) roadNodeGeoLayer.clearLayers();
        if (roadLinkVertexGeoLayer) roadLinkVertexGeoLayer.clearLayers();
        if (roadLaneWidthGeoLayer) roadLaneWidthGeoLayer.clearLayers();
        if (roadLaneWidth2GeoLayer) roadLaneWidth2GeoLayer.clearLayers();
        if (roadLaneWidthExtCalcGeoLayer) roadLaneWidthExtCalcGeoLayer.clearLayers();
        if (roadSegmentFbGeoLayer) roadSegmentFbGeoLayer.clearLayers();
        if (roadSegmentMidlineGeoLayer) roadSegmentMidlineGeoLayer.clearLayers();
        lastRenderedRoadLinks = [];
        roadLinkRenderCount = 0;
        roadNodeRenderCount = 0;
        updateRoadShapeStateText(roadShapeMetaByKind, `zoom ${roadMinZoom}+에서만 표시`);
    }
}

function pickRoadLabelText(feature, props) {
    const shpIndex = getRoadFeatureIndex(feature);
    return (
        findRoadPropValue(props, 'LINK_ID') ??
        findRoadPropValue(props, 'IDXNAME') ??
        findRoadPropValue(props, 'ID') ??
        findRoadPropValue(props, 'LINK') ??
        (Number.isFinite(shpIndex) ? `#${shpIndex + 1}` : '') ??
        ''
    ).toString();
}

function getRoadLinkStyle(props) {
    const matchedRules = getRoadLinkMatchedRules(props);
    // 대표 규칙이 꺼져 있으면 켜져 있는 다음 매칭 규칙의 색으로 그린다
    const resolvedRule = matchedRules.find((rule) => isRoadLinkRuleEnabled(rule.key)) || matchedRules[0];
    const linkIdCandidate = Number(
        findRoadPropValue(props, 'LINK_ID') ??
        findRoadPropValue(props, 'LINBK_ID') ??
        findRoadPropValue(props, 'LINBKID')
    );
    if (isSelectedRoadFeature('link', props?.__featureRef)) {
        return {
            color: '#ef4444',
            weight: Math.max((Number(resolvedRule.weight) || 2.1) + 2, 4),
            opacity: 1
        };
    }
    if (Number.isFinite(linkIdCandidate) && routeInfoLinkIds.has(linkIdCandidate)) {
        return {
            color: '#f97316',
            weight: Math.max((Number(resolvedRule.weight) || 2.1) + 1.6, 3.6),
            opacity: 0.98
        };
    }
    if (Number.isFinite(linkIdCandidate) && selectedCandidateLinkIds.has(linkIdCandidate)) {
        return {
            color: '#a855f7',
            weight: Math.max((Number(resolvedRule.weight) || 2.1) + 1.8, 3.8),
            opacity: 1
        };
    }
    return {
        color: resolvedRule.color || '#45c976',
        weight: Number(resolvedRule.weight) || 2.1,
        opacity: resolvedRule.isCustom ? 0.96 : 0.92
    };
}

function getRoadNodeStyle(props) {
    if (isSelectedRoadFeature('node', props?.__featureRef)) {
        return {
            radius: Math.max(roadNodeStyleConfig.radius + 2, 5),
            color: '#b91c1c',
            fillColor: '#ef4444',
            fillOpacity: 0.95,
            weight: Math.max(roadNodeStyleConfig.weight + 1.5, 2)
        };
    }
    return {
        radius: roadNodeStyleConfig.radius,
        color: roadNodeStyleConfig.stroke,
        fillColor: roadNodeStyleConfig.color,
        fillOpacity: 0.88,
        weight: roadNodeStyleConfig.weight
    };
}

function getRoadPopupFieldSpecs(title) {
    if (title === 'Road Link') {
        return [
            { label: 'LINK_ID', keys: ['LINK_ID', 'LINBK_ID', 'LINBKID'] },
            { label: 'IDXNAME', keys: ['IDXNAME', 'LIDXNAME'] },
            { label: 'LINK_ANGLE', keys: ['LINK_ANGLE'] },
            { label: 'DR_HEADING', keys: ['DR_HEADING'] },
            { label: 'DR_LINK_DIFF', keys: ['DR_LINK_DIFF'] },
            { label: 'LANE', keys: ['LANE'] },
            { label: 'LENGTH', keys: ['LENGTH'] },
            { label: 'ONEWAY', keys: ['ONEWAY'] },
            { label: 'ROAD_CATE', keys: ['ROAD_CATE', 'ROADCATE'] },
            { label: 'LINK_CATE', keys: ['LINK_CATE', 'LINCATE'] },
            { label: 'LINK_FACIL', keys: ['LINK_FACIL', 'LINKFACIL'] },
            { label: 'ST_ND_ID', keys: ['ST_ND_ID', 'ST_NODE_ID'] },
            { label: 'ED_ND_ID', keys: ['ED_ND_ID', 'ED_NODE_ID'] },
            { label: 'CLICK_LAT', keys: ['CLICK_LAT'] },
            { label: 'CLICK_LON', keys: ['CLICK_LON'] }
        ];
    }

    if (title === 'Road Link Vertex') {
        return [
            { label: 'LINK_ID', keys: ['LINK_ID', 'LINBK_ID', 'LINBKID'] },
            { label: 'VERTEX_INDEX', keys: ['LINK_VERTEX_INDEX'] },
            { label: 'PART_INDEX', keys: ['LINK_VERTEX_PART'] },
            { label: 'CLICK_LAT', keys: ['CLICK_LAT'] },
            { label: 'CLICK_LON', keys: ['CLICK_LON'] }
        ];
    }

    return [
        { label: 'NODE_ID', keys: ['NODE_ID', 'ND_ID', 'ID'] },
        { label: 'ST_ND_ID', keys: ['ST_ND_ID', 'ST_NODE_ID', 'ST_ND_IDM'] },
        { label: 'ED_ND_ID', keys: ['ED_ND_ID', 'ED_NODE_ID'] },
        { label: 'LINK_ID', keys: ['LINK_ID', 'LINBK_ID', 'LINBKID'] },
        { label: 'IDXNAME', keys: ['IDXNAME', 'LIDXNAME'] },
        { label: 'CLICK_LAT', keys: ['CLICK_LAT'] },
        { label: 'CLICK_LON', keys: ['CLICK_LON'] }
    ];
}

function pickRoadPopupValue(props, keys) {
    if (!props || !Array.isArray(keys)) return undefined;
    for (let i = 0; i < keys.length; i += 1) {
        const value = findRoadPropValue(props, keys[i]);
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }
    return undefined;
}

function buildRoadSummaryRows(props, title) {
    const specs = getRoadPopupFieldSpecs(title);
    // 링크가 속한 모든 분류(터널·국도처럼 중복 포함)를 맨 위에 보여준다
    const ruleRow = title === 'Road Link'
        ? [{ key: '분류', value: getRoadLinkMatchedRules(props).map((rule) => rule.label).join(', ') }]
        : [];
    // 확장 차선수(계산)를 팝업 맨 위에 표시한다.
    const extCalcEntry = (title === 'Road Link' || title === 'Road Link Vertex')
        ? laneExtCalcEntryForProps(props)
        : null;
    const extCalcRow = extCalcEntry
        ? [{
            key: 'LANE_EXT(계산)',
            value: `${extCalcEntry.lane} → ${extCalcEntry.ext}`
                + (extCalcEntry.ext > extCalcEntry.lane ? ' (확장 적용)' : ' (변화 없음)')
        }]
        : [];
    return ruleRow
        .concat(extCalcRow)
        .concat(specs.map((spec) => ({
            key: spec.label,
            value: pickRoadPopupValue(props, spec.keys)
        })))
        .filter((entry) => entry.value !== undefined && entry.value !== null && entry.value !== '')
        .map((entry) => `
            <div class="road-popup-summary-row">
                <span class="road-popup-summary-key">${escapeHtml(entry.key)}</span>
                <span class="road-popup-summary-value">${escapeHtml(entry.value)}</span>
            </div>
        `)
        .join('');
}

function makeRoadPopupContent(props, title) {
    const safeProps = props || {};
    const summaryRows = buildRoadSummaryRows(safeProps, title);

    return `
        <div class="road-popup">
            <div class="road-popup-title">${escapeHtml(title)}</div>
            <div class="road-popup-subtitle">선택 필드</div>
            <div class="road-popup-summary">
                ${summaryRows || '<div class="road-popup-summary-row"><span class="road-popup-summary-key">INFO</span><span class="road-popup-summary-value">표시 가능한 필드 없음</span></div>'}
            </div>
        </div>
    `;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

