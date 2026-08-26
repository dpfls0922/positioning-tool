// ===== 차로폭 · 확장 차선수 계산과 박스 피처 생성 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
// LANE 원값(없으면 0). 확장 계산은 펌웨어처럼 raw nLane 을 그대로 쓴다.
function rawLaneCountForProps(props) {
    const raw = toRoadInt(findRoadPropValue(props, 'LANE'));
    return (raw !== null && raw > 0) ? raw : 0;
}

// 펌웨어 LocalLinkV2::getExtendedLaneCount() 재현:
//   확장 차선수 = max(자기 LANE, 시작노드에 연결된 링크들의 최대 LANE, 끝노드에 연결된 링크들의 최대 LANE)
// 연결성은 ST_ND_ID/ED_ND_ID 공유로 판단하며, 일방통행/회전제한은 보지 않는다(펌웨어와 동일).
// 주의: 인접 링크 탐색 범위는 '현재 뷰포트에 로드된 링크'로 한정되므로
//       화면 경계에 걸친 링크는 실제보다 작게 나올 수 있다(펌웨어도 타일 단위로 제한됨).
function buildExtendedLaneMap(linkFeatures) {
    if (laneExtCalcCache.source === linkFeatures && laneExtCalcCache.byLinkKey) {
        return laneExtCalcCache.byLinkKey;
    }

    const links = Array.isArray(linkFeatures) ? linkFeatures : [];
    const nodeMaxLane = new Map();

    links.forEach((feature) => {
        const props = feature?.properties || {};
        const lane = rawLaneCountForProps(props);
        ['ST_ND_ID', 'ED_ND_ID'].forEach((key) => {
            const nodeKey = normalizeLinkKey(findRoadPropValue(props, key));
            if (nodeKey === null) return;
            nodeMaxLane.set(nodeKey, Math.max(nodeMaxLane.get(nodeKey) || 0, lane));
        });
    });

    const byLinkKey = new Map();
    links.forEach((feature) => {
        const props = feature?.properties || {};
        const linkKey = normalizeLinkKey(pickRoadLinkId(props));
        if (linkKey === null) return;
        const lane = rawLaneCountForProps(props);
        const stKey = normalizeLinkKey(findRoadPropValue(props, 'ST_ND_ID'));
        const edKey = normalizeLinkKey(findRoadPropValue(props, 'ED_ND_ID'));
        const ext = Math.max(
            lane,
            stKey === null ? 0 : (nodeMaxLane.get(stKey) || 0),
            edKey === null ? 0 : (nodeMaxLane.get(edKey) || 0)
        );
        byLinkKey.set(linkKey, { lane, ext });
    });

    laneExtCalcCache = { source: linkFeatures, byLinkKey };
    return byLinkKey;
}

// 현재 뷰포트 기준 계산형 확장 차선수(없으면 null).
function laneExtCalcEntryForProps(props) {
    if (!Array.isArray(lastRenderedRoadLinks) || lastRenderedRoadLinks.length === 0) return null;
    const linkKey = normalizeLinkKey(pickRoadLinkId(props));
    if (linkKey === null) return null;
    return buildExtendedLaneMap(lastRenderedRoadLinks).get(linkKey) || null;
}

// LINK_ID 비교용 키 — 숫자로 읽히면 숫자 표기를 통일한다('16446.0'/' 16446' -> '16446').
function normalizeLinkKey(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (text === '') return null;
    const num = Number(text);
    return Number.isFinite(num) ? String(num) : text;
}

// 링크의 차선수(LANE, 최소 1). 파싱 불가 시 1로 간주.
function laneCountForProps(props) {
    const raw = toRoadInt(findRoadPropValue(props, 'LANE'));
    return (raw !== null && raw >= 1) ? raw : 1;
}

// 박스 반폭(중심선→가장자리) = ceil(max(1, 차선수)/2) * (타입별 한 차선 폭).
// roadCate <= 1 이면 확장(EXTENDED_LANE_WIDTH), 그 외 기본(LANE_WIDTH). 차선수/2는 올림.
function laneWidthForProps(props, config, laneCountOverride = null) {
    const roadCate = toRoadInt(findRoadPropValue(props, 'ROAD_CATE'));
    const extended = roadCate !== null && roadCate <= 1;
    const oneLaneWidth = extended ? Number(config.extended) : Number(config.normal);
    const laneCount = (Number.isFinite(laneCountOverride) && laneCountOverride >= 1)
        ? Math.floor(laneCountOverride)
        : laneCountForProps(props);
    const halfLaneCount = Math.ceil(laneCount / 2); // 소수점 올림
    const halfWidth = halfLaneCount * oneLaneWidth;  // 미터
    return { halfWidth, oneLaneWidth, laneCount, extended };
}

function getLaneWidthStyle(props = {}, config = laneWidthConfig) {
    const extended = props.__laneExtended === true;
    const color = extended ? config.extendedColor : config.normalColor;
    return {
        color,
        weight: 0.6,
        opacity: 0.7,
        fillColor: color,
        fillOpacity: Number(config.fillOpacity)
    };
}

// 하나의 폴리라인 세그먼트를 중심선 기준 ±half 만큼 수직으로 확장한 사각형(폴리곤) 코너를 만든다.
// 로컬 ENU(미터) 평면에서 계산 후 위경도로 되돌린다. 반환값은 GeoJSON [lon, lat] 배열.
function laneRectCornersForSegment(a, b, halfWidthMeters) {
    const lon1 = Number(a[0]);
    const lat1 = Number(a[1]);
    const lon2 = Number(b[0]);
    const lat2 = Number(b[1]);
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return null;

    const metersPerDegLat = 111320.0;
    const metersPerDegLon = 111320.0 * Math.cos(lat1 * DEG2RAD);
    if (!Number.isFinite(metersPerDegLon) || metersPerDegLon === 0) return null;

    // 세그먼트를 기준점(lat1,lon1) 로컬 평면 미터 좌표로 변환.
    const ax = 0;
    const ay = 0;
    const bx = (lon2 - lon1) * metersPerDegLon;
    const by = (lat2 - lat1) * metersPerDegLat;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) return null;

    // 진행 방향 단위벡터와 그에 수직인 법선벡터.
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    const nx = -dy;
    const ny = dx;
    const h = halfWidthMeters;

    const toLonLat = (x, y) => [lon1 + x / metersPerDegLon, lat1 + y / metersPerDegLat];

    return [
        toLonLat(ax + nx * h, ay + ny * h),
        toLonLat(bx + nx * h, by + ny * h),
        toLonLat(bx - nx * h, by - ny * h),
        toLonLat(ax - nx * h, ay - ny * h)
    ];
}

// 링크 폴리라인들을 세그먼트별 차로폭 사각형 폴리곤 피처로 변환(주어진 config 기준).
function buildLaneWidthFeatures(linkFeatures, config, options = {}) {
    const out = [];
    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];
    const extCalcMap = options.laneExtCalc === true ? buildExtendedLaneMap(sourceLinks) : null;
    const maxFeatures = extCalcMap ? LANE_EXT_CALC_MAX_FEATURES : 0;
    // 상한에 걸릴 때 확장이 적용된 링크(ext > LANE)가 먼저 그려지도록 정렬한다.
    const orderedLinks = extCalcMap
        ? sourceLinks.slice().sort((a, b) => {
            const ea = extCalcMap.get(normalizeLinkKey(pickRoadLinkId(a?.properties || {})));
            const eb = extCalcMap.get(normalizeLinkKey(pickRoadLinkId(b?.properties || {})));
            const wa = (ea && ea.ext > ea.lane) ? 0 : 1;
            const wb = (eb && eb.ext > eb.lane) ? 0 : 1;
            return wa - wb;
        })
        : sourceLinks;

    orderedLinks.forEach((feature) => {
        if (maxFeatures > 0 && out.length >= maxFeatures) return;
        const geometry = feature?.geometry;
        const props = feature?.properties || {};
        if (!geometry) return;
        // 계산형 레이어는 뷰포트 위상으로 직접 구한 확장 차선수를 쓴다.
        const extCalcEntry = extCalcMap ? extCalcMap.get(normalizeLinkKey(pickRoadLinkId(props))) : null;
        if (extCalcMap && !extCalcEntry) return;
        const laneCountOverride = extCalcEntry ? Number(extCalcEntry.ext) : null;
        const { halfWidth, oneLaneWidth, laneCount, extended } = laneWidthForProps(props, config, laneCountOverride);
        if (!Number.isFinite(halfWidth) || halfWidth <= 0) return;

        const linkId = pickRoadLinkId(props);

        const emitLine = (coords) => {
            if (!Array.isArray(coords)) return;
            for (let i = 0; i < coords.length - 1; i += 1) {
                const corners = laneRectCornersForSegment(coords[i], coords[i + 1], halfWidth);
                if (!corners) continue;
                out.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[...corners, corners[0]]]
                    },
                    properties: {
                        LINK_ID: linkId,
                        LANE: laneCount,
                        ONE_LANE_WIDTH_M: oneLaneWidth,
                        HALF_WIDTH_M: halfWidth,
                        LANE_EXT_CALC: extCalcEntry ? extCalcEntry.ext : undefined,
                        LANE_EXT_CALC_BASE: extCalcEntry ? extCalcEntry.lane : undefined,
                        // 계산형 레이어는 '확장이 실제로 적용됐는지(ext > LANE)'로 색을 나눈다.
                        __laneExtended: extCalcEntry ? (extCalcEntry.ext > extCalcEntry.lane) : extended
                    }
                });
            }
        };

        if (geometry.type === 'LineString') {
            emitLine(geometry.coordinates);
        } else if (geometry.type === 'MultiLineString') {
            (geometry.coordinates || []).forEach((line) => emitLine(line));
        }
    });

    return out;
}

function darkenHexColor(hex, amount) {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - amount)));
    const g = Math.max(0, Math.round(((n >> 8)  & 0xff) * (1 - amount)));
    const b = Math.max(0, Math.round((n & 0xff)          * (1 - amount)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// 각 세그먼트의 fb 0.25→0.75 구간 폴리라인 + fb 0.5 중점 피처 생성 (20m 이상만)
function buildSegmentFbFeatures(linkFeatures) {
    const out = [];
    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];
    sourceLinks.forEach((feature) => {
        const geometry = feature?.geometry;
        if (!geometry) return;
        const emitLine = (coords) => {
            if (!Array.isArray(coords)) return;
            for (let i = 0; i < coords.length - 1; i++) {
                const a = coords[i], b = coords[i + 1];
                if (segmentLengthM(a, b) < 20) continue;
                const p025 = [a[0] + 0.25 * (b[0] - a[0]), a[1] + 0.25 * (b[1] - a[1])];
                const p075 = [a[0] + 0.75 * (b[0] - a[0]), a[1] + 0.75 * (b[1] - a[1])];
                out.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [p025, p075] },
                    properties: {}
                });
            }
        };
        if (geometry.type === 'LineString') emitLine(geometry.coordinates);
        else if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(emitLine);
    });
    return out;
}

// 세그먼트 길이(m) 계산
function segmentLengthM(a, b) {
    const latRad = (a[1] + b[1]) / 2 * Math.PI / 180;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(latRad);
    const dx = (b[0] - a[0]) * mPerDegLon;
    const dy = (b[1] - a[1]) * mPerDegLat;
    return Math.sqrt(dx * dx + dy * dy);
}

// 각 세그먼트 중점에 수직 틱 선 생성 (길이 20m 이상 세그먼트만, 차로폭 절반 길이)
function buildSegmentMidlineFeatures(linkFeatures, config) {
    const out = [];
    const sourceLinks = Array.isArray(linkFeatures) ? linkFeatures : [];
    sourceLinks.forEach((feature) => {
        const geometry = feature?.geometry;
        const props = feature?.properties || {};
        if (!geometry) return;
        const { halfWidth } = laneWidthForProps(props, config || laneWidthConfig);
        const tickHalf = (Number.isFinite(halfWidth) && halfWidth > 0) ? halfWidth : 3.0;

        const emitLine = (coords) => {
            if (!Array.isArray(coords)) return;
            for (let i = 0; i < coords.length - 1; i++) {
                const a = coords[i], b = coords[i + 1];
                if (segmentLengthM(a, b) < 20) continue;

                const latRad = (a[1] + b[1]) / 2 * Math.PI / 180;
                const mPerDegLat = 111320;
                const mPerDegLon = 111320 * Math.cos(latRad);

                // 세그먼트 방향 벡터 → 수직 단위벡터
                const dx = (b[0] - a[0]) * mPerDegLon;
                const dy = (b[1] - a[1]) * mPerDegLat;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len === 0) continue;
                const px = -dy / len; // 수직 방향 (경도 성분)
                const py =  dx / len; // 수직 방향 (위도 성분)

                const midLon = (a[0] + b[0]) / 2;
                const midLat = (a[1] + b[1]) / 2;

                const t1 = [midLon + px * tickHalf / mPerDegLon, midLat + py * tickHalf / mPerDegLat];
                const t2 = [midLon - px * tickHalf / mPerDegLon, midLat - py * tickHalf / mPerDegLat];

                out.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [t1, t2] },
                    properties: {}
                });
            }
        };
        if (geometry.type === 'LineString') emitLine(geometry.coordinates);
        else if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(emitLine);
    });
    return out;
}

// 캐시된 뷰포트 링크로부터 차로폭 레이어들(차로폭/차로폭2)을 다시 채운다(zoom 17+에서만).
function refreshLaneWidthLayer() {
    const zoom = map.getZoom();
    const noLinks = !Array.isArray(lastRenderedRoadLinks) || lastRenderedRoadLinks.length === 0;
    laneLayerEntries().forEach(({ name, layer, config, laneExtCalc }) => {
        if (!layer) return;
        layer.clearLayers();
        if (!activeGroups.has(name) || zoom < LANE_WIDTH_MIN_ZOOM || noLinks) return;
        const features = buildLaneWidthFeatures(lastRenderedRoadLinks, config, { laneExtCalc });
        if (features.length > 0) {
            layer.addData({ type: 'FeatureCollection', features });
        }
    });
    // 세그먼트 수직 틱 비활성화 (fb 레이어에서 midpoint 표시로 대체)
    if (roadSegmentMidlineGeoLayer) roadSegmentMidlineGeoLayer.clearLayers();

    // Segment FB 0.25-0.75 가로선 (독립 토글, zoom 16+)
    if (roadSegmentFbGeoLayer) {
        roadSegmentFbGeoLayer.clearLayers();
        if (activeGroups.has(SEGMENT_FB_LAYER) && !noLinks && map.getZoom() >= ROAD_RENDER_MIN_ZOOM) {
            const fbFeatures = buildSegmentFbFeatures(lastRenderedRoadLinks);
            if (fbFeatures.length > 0) {
                roadSegmentFbGeoLayer.addData({ type: 'FeatureCollection', features: fbFeatures });
            }
        }
    }
}

