// ===== 도로 레이어 생성(pane/renderer) · 팝업 연결 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function attachRoadShapePopup(feature, layer, kind, title) {
    const baseProps = { ...(feature?.properties || {}) };
    const shpIndex = getRoadFeatureIndex(feature);
    const linkAngle = title === 'Road Link' ? computeRoadFeatureAngle(feature) : null;
    if (Number.isFinite(shpIndex)) {
        baseProps.SHP_INDEX = shpIndex + 1;
    }
    if (Number.isFinite(linkAngle)) {
        baseProps.LINK_ANGLE = `${linkAngle.toFixed(2)}°`;
    }

    layer.bindPopup(makeRoadPopupContent(baseProps, title), { maxWidth: 420, autoPan: false, keepInView: false });
    layer.on('click', (event) => {
        if (!canInspectRoadShapes()) {
            if (event?.originalEvent) L.DomEvent.stop(event.originalEvent);
            return;
        }
        openRoadLayerPopup(layer, feature, kind, title, event?.latlng, event?.originalEvent);
    });
}

function openRoadLayerPopup(layer, feature, kind, title, latlng, originalEvent = null) {
    const baseProps = { ...(feature?.properties || {}) };
    const shpIndex = getRoadFeatureIndex(feature);
    const linkAngle = title === 'Road Link' ? computeRoadFeatureAngle(feature) : null;
    if (Number.isFinite(shpIndex)) {
        baseProps.SHP_INDEX = shpIndex + 1;
    }
    if (Number.isFinite(linkAngle)) {
        baseProps.LINK_ANGLE = `${linkAngle.toFixed(2)}°`;
    }

    setSelectedRoadFeature(kind, feature);
    lastRoadLayerInteractionTs = Date.now();

    const clickLat = Number(latlng?.lat);
    const clickLon = Number(latlng?.lng);
    const popupBaseProps = { ...baseProps };
    if (Number.isFinite(clickLat) && Number.isFinite(clickLon)) {
        popupBaseProps.CLICK_LAT = clickLat.toFixed(6);
        popupBaseProps.CLICK_LON = clickLon.toFixed(6);
    }
    if (Number.isFinite(linkAngle) && Number.isFinite(selectedDrCoordinate?.heading)) {
        popupBaseProps.DR_HEADING = `${Number(selectedDrCoordinate.heading).toFixed(2)}°`;
        const diff = computeHeadingDeltaDegrees(selectedDrCoordinate.heading, linkAngle);
        if (Number.isFinite(diff)) {
            popupBaseProps.DR_LINK_DIFF = `${diff.toFixed(2)}°`;
        }
    }

    const loadingProps = { ...popupBaseProps, 상태: '속성 조회 중...' };
    layer.setPopupContent(makeRoadPopupContent(loadingProps, title));
    if (typeof layer.openPopup === 'function') {
        layer.openPopup(latlng);
    }
    if (originalEvent) {
        L.DomEvent.stop(originalEvent);
    }

    if (!Number.isFinite(shpIndex) || kind === 'vertex') return;

    requestRoadShapeAttrs(kind, shpIndex).then((attrs) => {
        const attrObj = (attrs && typeof attrs === 'object') ? attrs : {};
        const merged = Object.keys(attrObj).length > 0
            ? { ...popupBaseProps, ...attrObj }
            : popupBaseProps;
        layer.setPopupContent(makeRoadPopupContent(merged, title));
    });
}

function ensureRoadInteractionPanes() {
    const ensurePane = (name, zIndex) => {
        let pane = map.getPane(name);
        if (!pane) {
            pane = map.createPane(name);
        }
        pane.style.zIndex = String(zIndex);
        pane.style.pointerEvents = 'auto';
        return pane;
    };

    // Keep road-shape layers below markerPane so parsed marker popups remain clickable.
    // Lane-width boxes sit below the link canvas (overlayPane, z=400) so the centerline stays on top.
    ensurePane('roadLaneWidthPane', 350);
    ensurePane('roadLaneWidth2Pane', 351);
    ensurePane('roadLaneWidthExtCalcPane', 349);
    ensurePane('roadSegmentMidlinePane', 352);
    ensurePane('roadSegmentFbPane', 553);  // road link(550)보다 위
    ensurePane('roadLinkPane', 550);
    ensurePane('roadNodePane', 551);
    ensurePane('roadLinkVertexPane', 552);

}

function getRoadPaneName(layerName) {
    if (layerName === ROAD_LINK_LAYER) return 'roadLinkPane';
    if (layerName === ROAD_LINK_VERTEX_LAYER) return 'roadLinkVertexPane';
    if (layerName === ROAD_NODE_LAYER) return 'roadNodePane';
    if (layerName === LANE_WIDTH_LAYER) return 'roadLaneWidthPane';
    if (layerName === LANE_WIDTH_LAYER_2) return 'roadLaneWidth2Pane';
    if (layerName === LANE_WIDTH_EXT_CALC_LAYER) return 'roadLaneWidthExtCalcPane';
    return null;
}

function getPreferredRoadKinds() {
    const kindByLayerName = {
        [ROAD_LINK_LAYER]: 'link',
        [ROAD_NODE_LAYER]: 'node',
        [ROAD_LINK_VERTEX_LAYER]: 'vertex'
    };
    return layerOrder
        .filter((name) => isRoadShapeLayerName(name) && activeGroups.has(name))
        .map((name) => kindByLayerName[name])
        .filter(Boolean)
        .reverse();
}

function getRoadLinkVertexStyle(props = {}) {
    const radius = roadVertexStyleConfig.radius;
    if (isSelectedRoadFeature('vertex', props?.__featureRef)) {
        return {
            radius,
            color: '#b91c1c',
            fillColor: '#ef4444',
            fillOpacity: 0.98,
            weight: Math.max(roadVertexStyleConfig.weight, 1.8)
        };
    }
    return {
        radius,
        color: roadVertexStyleConfig.stroke,
        fillColor: roadVertexStyleConfig.color,
        fillOpacity: 0.95,
        weight: roadVertexStyleConfig.weight
    };
}

function makeRoadLinkVertexFeatures(linkFeatures) {
    const out = [];
    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];

    sourceLinks.forEach((feature) => {
        const geometry = feature?.geometry;
        const props = feature?.properties || {};
        const shpIndex = getRoadFeatureIndex(feature);
        const linkId = pickRoadLinkId(props);
        if (!geometry) return;

        const pushVertex = (coord, vertexIndex, partIndex = 0) => {
            const lon = Number(coord?.[0]);
            const lat = Number(coord?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            out.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lon, lat]
                },
                properties: {
                    LINK_ID: linkId,
                    LINK_VERTEX_INDEX: vertexIndex,
                    LINK_VERTEX_PART: partIndex,
                    CLICK_LAT: lat,
                    CLICK_LON: lon,
                    __parentFeatureRef: feature,
                    __featureRef: {
                        kind: 'link-vertex',
                        shpIndex,
                        vertexIndex,
                        partIndex
                    }
                }
            });
        };

        if (geometry.type === 'LineString') {
            (geometry.coordinates || []).forEach((coord, index) => pushVertex(coord, index, 0));
            return;
        }
        if (geometry.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach((lineCoords, partIndex) => {
                (lineCoords || []).forEach((coord, index) => pushVertex(coord, index, partIndex));
            });
        }
    });

    return out;
}

// road shape 레이어들의 표시 순서와 기본 ON 목록.
// (addLayerToGroup 이 생성 순서대로 layerOrder 에 넣으므로 여기서는 누락 보정용)
const ROAD_SHAPE_LAYER_ORDER = [
    ROAD_LINK_LAYER,
    ROAD_NODE_LAYER,
    ROAD_LINK_VERTEX_LAYER,
    SEGMENT_FB_LAYER,
    LANE_WIDTH_LAYER,
    LANE_WIDTH_LAYER_2,
    LANE_WIDTH_EXT_CALC_LAYER
];
const ROAD_SHAPE_DEFAULT_ON_LAYERS = [
    ROAD_LINK_LAYER,
    ROAD_NODE_LAYER,
    ROAD_LINK_VERTEX_LAYER,
    LANE_WIDTH_LAYER
];

// 레이어를 기본 OFF 상태로 되돌린다(생성 직후 필요할 때만 켜는 레이어들).
function setRoadLayerDefaultOff(layerName) {
    activeGroups.delete(layerName);
    const group = featureGroups[layerName];
    if (group && map.hasLayer(group)) map.removeLayer(group);
}

// 차로폭 계열(차로폭/차로폭2/확장 계산) 레이어는 pane·renderer·설정만 다르고 구조가 같다.
function createLaneWidthGeoLayer(paneName, renderer, config) {
    return L.geoJSON(null, {
        pane: paneName,
        renderer,
        interactive: false,
        style: (feature) => getLaneWidthStyle(feature?.properties || {}, config)
    });
}

// 노드/버텍스처럼 원형 마커 + 팝업으로 그리는 포인트 레이어.
function createRoadPointGeoLayer({ paneName, renderer, styleFor, popupKind, popupTitle }) {
    return L.geoJSON(null, {
        pane: paneName,
        interactive: true,
        bubblingMouseEvents: false,
        pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
            pane: paneName,
            ...(renderer ? { renderer } : {}),
            interactive: true,
            bubblingMouseEvents: false,
            ...styleFor({
                ...(feature?.properties || {}),
                __featureRef: feature
            })
        }),
        onEachFeature: (feature, layer) => {
            attachRoadShapePopup(feature, layer, popupKind, popupTitle);
        }
    });
}

function ensureRoadShapeLayers() {
    ensureRoadInteractionPanes();

    if (!roadLinkGeoLayer) {
        roadLinkGeoLayer = L.geoJSON(null, {
            pane: 'roadLinkPane',
            renderer: roadCanvasRenderer,
            interactive: true,
            bubblingMouseEvents: false,
            style: (feature) => getRoadLinkStyle({
                ...(feature?.properties || {}),
                __featureRef: feature
            }),
            onEachFeature: (feature, layer) => {
                const props = feature?.properties || {};
                const labelText = pickRoadLabelText(feature, props);
                if (roadLabelEnabledForRender && labelText) {
                    layer.bindTooltip(labelText, {
                        permanent: true,
                        direction: 'center',
                        className: 'road-link-label'
                    });
                }
                attachRoadShapePopup(feature, layer, 'link', 'Road Link');
            }
        });
        addLayerToGroup(ROAD_LINK_LAYER, roadLinkGeoLayer);
    }

    if (!roadLinkMultiRuleGeoLayer) {
        // 여러 분류에 동시에 해당하는 링크의 2번째 이후 규칙 색을 점선으로 겹쳐
        // 그린다(기본 선 색은 대표 규칙). Road Link 레이어와 함께 켜지고 꺼진다.
        roadLinkMultiRuleGeoLayer = L.geoJSON(null, {
            pane: 'roadLinkPane',
            renderer: roadCanvasRenderer,
            interactive: false,
            style: (feature) => ({
                color: feature?.properties?.__overlayColor || '#8b5cf6',
                weight: Number(feature?.properties?.__overlayWeight) || 2.1,
                opacity: 0.95,
                dashArray: (Number(feature?.properties?.__overlayIdx) || 0) % 2 === 0 ? '5 7' : '2 12'
            })
        });
        addLayerToGroup(ROAD_LINK_LAYER, roadLinkMultiRuleGeoLayer);
        // addLayerToGroup이 options.pane을 덮어쓰므로 복원
        roadLinkMultiRuleGeoLayer.options.pane = 'roadLinkPane';
    }

    if (!roadLaneWidthGeoLayer) {
        roadLaneWidthGeoLayer = createLaneWidthGeoLayer('roadLaneWidthPane', roadCanvasRendererLane, laneWidthConfig);
        addLayerToGroup(LANE_WIDTH_LAYER, roadLaneWidthGeoLayer);
    }

    if (!roadLaneWidth2GeoLayer) {
        roadLaneWidth2GeoLayer = createLaneWidthGeoLayer('roadLaneWidth2Pane', roadCanvasRendererLane2, laneWidthConfig2);
        addLayerToGroup(LANE_WIDTH_LAYER_2, roadLaneWidth2GeoLayer);
        // 차로폭2는 기본 OFF (필요할 때만 선택적으로 켬)
        setRoadLayerDefaultOff(LANE_WIDTH_LAYER_2);
    }

    if (!roadSegmentMidlineGeoLayer) {
        roadSegmentMidlineGeoLayer = L.geoJSON(null, {
            pane: 'roadSegmentMidlinePane',
            renderer: roadCanvasRendererSegMid,
            interactive: false,
            style: () => ({
                pane: 'roadSegmentMidlinePane',
                color: '#1e40af',
                weight: 1.5,
                opacity: 0.8,
                dashArray: '4 6',
                fill: false
            })
        });
        // Lane Width 레이어 그룹에 함께 추가 (같이 켜고 끄도록)
        addLayerToGroup(LANE_WIDTH_LAYER, roadSegmentMidlineGeoLayer);
        // addLayerToGroup이 options.pane을 덮어쓰므로 복원
        roadSegmentMidlineGeoLayer.options.pane = 'roadSegmentMidlinePane';
    }

    if (!roadLaneWidthExtCalcGeoLayer) {
        roadLaneWidthExtCalcGeoLayer = createLaneWidthGeoLayer(
            'roadLaneWidthExtCalcPane',
            roadCanvasRendererLaneExtCalc,
            laneWidthConfigExtCalc
        );
        addLayerToGroup(LANE_WIDTH_EXT_CALC_LAYER, roadLaneWidthExtCalcGeoLayer);
        // 계산형 확장 차선수 레이어도 기본 OFF
        setRoadLayerDefaultOff(LANE_WIDTH_EXT_CALC_LAYER);
    }

    if (!roadNodeGeoLayer) {
        roadNodeGeoLayer = createRoadPointGeoLayer({
            paneName: 'roadNodePane',
            renderer: roadCanvasRendererNode,
            styleFor: getRoadNodeStyle,
            popupKind: 'node',
            popupTitle: 'Road Node'
        });
        addLayerToGroup(ROAD_NODE_LAYER, roadNodeGeoLayer);
    }

    if (!roadLinkVertexGeoLayer) {
        roadLinkVertexGeoLayer = createRoadPointGeoLayer({
            paneName: 'roadLinkVertexPane',
            renderer: null,
            styleFor: getRoadLinkVertexStyle,
            popupKind: 'vertex',
            popupTitle: 'Road Link Vertex'
        });
        addLayerToGroup(ROAD_LINK_VERTEX_LAYER, roadLinkVertexGeoLayer);
    }

    if (!roadSegmentFbGeoLayer) {
        roadSegmentFbGeoLayer = L.geoJSON(null, {
            pane: 'roadSegmentFbPane',
            renderer: roadCanvasRendererSegFb,
            interactive: false,
            style: () => ({
                pane: 'roadSegmentFbPane',
                color: segmentFbConfig.color,
                weight: segmentFbConfig.weight,
                opacity: segmentFbConfig.opacity,
                fill: false
            }),
            pointToLayer: (feature, latlng) => {
                const r = Math.max(2, segmentFbConfig.weight / 2);
                const darker = darkenHexColor(segmentFbConfig.color, 0.3);
                return L.circleMarker(latlng, {
                    pane: 'roadSegmentFbPane',
                    renderer: roadCanvasRendererSegFb,
                    radius: r,
                    color: darker,
                    weight: segmentFbConfig.weight,
                    fillColor: darker,
                    fillOpacity: Math.min(1, segmentFbConfig.opacity + 0.3),
                    opacity: Math.min(1, segmentFbConfig.opacity + 0.3)
                });
            }
        });
        addLayerToGroup(SEGMENT_FB_LAYER, roadSegmentFbGeoLayer);
        roadSegmentFbGeoLayer.options.pane = 'roadSegmentFbPane';
        setRoadLayerDefaultOff(SEGMENT_FB_LAYER);
    }

    ROAD_SHAPE_LAYER_ORDER.forEach((name) => {
        if (!layerOrder.includes(name)) layerOrder.push(name);
    });
    // 나머지(차로폭2 / 확장 계산 / Segment FB)는 기본 OFF
    ROAD_SHAPE_DEFAULT_ON_LAYERS.forEach((name) => activeGroups.add(name));
}

// 렌더 대상 차로폭 레이어 목록(각자 geoLayer/설정/활성상태 보유).
function laneLayerEntries() {
    return [
        { name: LANE_WIDTH_LAYER, layer: roadLaneWidthGeoLayer, config: laneWidthConfig },
        { name: LANE_WIDTH_LAYER_2, layer: roadLaneWidth2GeoLayer, config: laneWidthConfig2 },
        // 계산형: 로그와 무관하게 뷰포트 내 모든 링크의 확장 차선수를 직접 계산해 그린다.
        {
            name: LANE_WIDTH_EXT_CALC_LAYER,
            layer: roadLaneWidthExtCalcGeoLayer,
            config: laneWidthConfigExtCalc,
            laneExtCalc: true
        }
    ];
}

// 계산형 확장 차선수 캐시 — 같은 뷰포트 링크 배열에 대해 한 번만 계산한다.
let laneExtCalcCache = { source: null, byLinkKey: null };

