'use strict';

importScripts('https://unpkg.com/shpjs@3.6.3/dist/shp.js');

const QUERY_BUFFER_WEST_EAST_DEG = 0.0015;
const QUERY_BUFFER_NORTH_DEG = 0.0015;
const QUERY_BUFFER_SOUTH_DEG = 0.0035;
const BBOX_CHUNK = 100000;

const BESSEL_A = 6377397.155;
const BESSEL_E2 = (() => {
    const f = 1 / 299.1528128;
    return 2 * f - (f * f);
})();
const WGS84_A = 6378137.0;
const WGS84_E2 = (() => {
    const f = 1 / 298.257223563;
    return 2 * f - (f * f);
})();
const DX = -147.0;
const DY = 506.0;
const DZ = 687.5;

const linkState = createDatasetState('link');
const nodeState = createDatasetState('node');
const PREVIEW_CACHE_LIMIT = 200000;
const DEFAULT_LINK_QUERY_PROP_KEYS = [
    'LINK_ID', 'IDXNAME', 'ROAD_CATE', 'LINK_FACIL', 'ST_ND_ID', 'ED_ND_ID',
    'LENGTH', 'ROAD_NO', 'LANE', 'SPEEDLH', 'ONEWAY', 'KEY', 'ROADSTATE',
    'ROADLEVEL', 'LINK_CATE', 'ST_DIR', 'ED_DIR'
];
let linkQueryPropKeys = new Set(DEFAULT_LINK_QUERY_PROP_KEYS);
const NODE_QUERY_PROP_KEYS = new Set([
    'NODE_ID', 'ND_ID', 'ID', 'IDXNAME', 'KEY', 'X', 'Y', 'LAT', 'LON'
]);

function createDatasetState(kind) {
    return {
        kind,
        geometries: [],
        bboxes: new Float64Array(0),
        attrSources: [],
        coordMode: 'auto',
        previewAttrCache: new Map(),
        fieldNames: new Set()
    };
}

function clearDataset(state) {
    state.geometries = [];
    state.bboxes = new Float64Array(0);
    state.attrSources = [];
    state.coordMode = 'auto';
    state.previewAttrCache = new Map();
    state.fieldNames = new Set();
}

function clearAll() {
    clearDataset(linkState);
    clearDataset(nodeState);
    linkQueryPropKeys = new Set(DEFAULT_LINK_QUERY_PROP_KEYS);
}

function sanitizePropKeyList(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    values.forEach((value) => {
        const key = String(value || '').trim();
        if (!key) return;
        out.push(key);
    });
    return out;
}

function sortFieldNames(setObj) {
    if (!(setObj instanceof Set)) return [];
    return Array.from(setObj)
        .map((name) => String(name || '').trim())
        .filter((name) => name.length > 0)
        .sort((a, b) => a.localeCompare(b));
}

function rememberFieldNames(state, fields) {
    if (!state || !(state.fieldNames instanceof Set) || !Array.isArray(fields)) return;
    fields.forEach((field) => {
        const name = String(field?.name || '').trim();
        if (!name) return;
        state.fieldNames.add(name);
    });
}

function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer) {
        return value;
    }
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    if (typeof value === 'string') {
        return new TextEncoder().encode(value).buffer;
    }
    return null;
}

function toText(value) {
    if (typeof value === 'string') {
        return value;
    }
    const buffer = toArrayBuffer(value);
    if (!buffer) return '';
    try {
        return new TextDecoder('utf-8').decode(buffer);
    } catch (_) {
        return '';
    }
}

function besselToWgs84(lon, lat) {
    const phi = lat * Math.PI / 180.0;
    const lam = lon * Math.PI / 180.0;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const n = BESSEL_A / Math.sqrt(1.0 - (BESSEL_E2 * sinPhi * sinPhi));
    const x2 = (n * cosPhi * Math.cos(lam)) + DX;
    const y2 = (n * cosPhi * Math.sin(lam)) + DY;
    const z2 = (n * (1.0 - BESSEL_E2) * sinPhi) + DZ;
    const lam2 = Math.atan2(y2, x2);
    const p = Math.sqrt((x2 * x2) + (y2 * y2));
    let phi2 = Math.atan2(z2, p * (1.0 - WGS84_E2));
    for (let i = 0; i < 10; i += 1) {
        const nw = WGS84_A / Math.sqrt(1.0 - (WGS84_E2 * Math.sin(phi2) ** 2));
        phi2 = Math.atan2(z2 + (WGS84_E2 * nw * Math.sin(phi2)), p);
    }
    return [lam2 * 180.0 / Math.PI, phi2 * 180.0 / Math.PI];
}

function inferCoordModeBySample(sampleCoord, hasPrj) {
    if (!sampleCoord || hasPrj) {
        return 'none';
    }

    const x = Number(sampleCoord[0]);
    const y = Number(sampleCoord[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return 'none';
    }

    // Known road-link sets without PRJ in this project are mostly
    // Bessel-degree lon/lat around KR.
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90 && x >= 120 && x <= 135 && y >= 30 && y <= 45) {
        return 'bessel';
    }

    return 'none';
}

function transformCoord(coord, mode) {
    const x = Number(coord?.[0]);
    const y = Number(coord?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return coord;
    if (mode === 'bessel') {
        return besselToWgs84(x, y);
    }
    return [x, y];
}

function transformGeometry(geometry, mode) {
    if (!geometry || mode === 'none') return geometry;

    const type = geometry.type;
    const c = geometry.coordinates;
    if (!c) return geometry;

    if (type === 'Point') {
        return { ...geometry, coordinates: transformCoord(c, mode) };
    }
    if (type === 'LineString' || type === 'MultiPoint') {
        return { ...geometry, coordinates: c.map((coord) => transformCoord(coord, mode)) };
    }
    if (type === 'MultiLineString' || type === 'Polygon') {
        return { ...geometry, coordinates: c.map((ring) => ring.map((coord) => transformCoord(coord, mode))) };
    }
    if (type === 'MultiPolygon') {
        return {
            ...geometry,
            coordinates: c.map((poly) => poly.map((ring) => ring.map((coord) => transformCoord(coord, mode))))
        };
    }
    return geometry;
}

function collectCoords(geometry, out) {
    if (!geometry) return;
    const type = geometry.type;
    const c = geometry.coordinates;
    if (!c) return;

    if (type === 'Point') {
        out.push(c);
        return;
    }
    if (type === 'LineString' || type === 'MultiPoint') {
        c.forEach((coord) => out.push(coord));
        return;
    }
    if (type === 'MultiLineString' || type === 'Polygon') {
        c.forEach((ring) => ring.forEach((coord) => out.push(coord)));
        return;
    }
    if (type === 'MultiPolygon') {
        c.forEach((poly) => poly.forEach((ring) => ring.forEach((coord) => out.push(coord))));
    }
}

function rawBbox(geometry) {
    const coords = [];
    collectCoords(geometry, coords);
    if (coords.length === 0) return [0, 0, 0, 0];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    coords.forEach((coord) => {
        const x = Number(coord?.[0]);
        const y = Number(coord?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    });

    if (!Number.isFinite(minX)) return [0, 0, 0, 0];
    return [minX, minY, maxX, maxY];
}

function intersects(b, q) {
    return b[2] >= q[0] && b[0] <= q[2] && b[3] >= q[1] && b[1] <= q[3];
}

function detectGeomType(geometries) {
    if (!Array.isArray(geometries)) return '';
    for (let i = 0; i < geometries.length; i += 1) {
        const t = geometries[i]?.type;
        if (typeof t === 'string' && t.length > 0) return t;
    }
    return '';
}

function classifyGeometryType(geomType) {
    if (geomType.includes('LineString')) return 'link';
    if (geomType.includes('Point')) return 'node';
    return '';
}

function firstCoordFromGeometry(geometry) {
    const coords = [];
    collectCoords(geometry, coords);
    return coords[0] || null;
}

function parseDbfHeader(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32) {
        return null;
    }

    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const headerSize = dv.getUint16(8, true);
    const recordSize = dv.getUint16(10, true);
    if (!headerSize || !recordSize) return null;

    const fields = [];
    for (let offset = 32; offset + 32 <= headerSize; offset += 32) {
        if (u8[offset] === 0x0D) break;

        let name = '';
        for (let i = 0; i < 11; i += 1) {
            const code = u8[offset + i];
            if (!code) break;
            name += String.fromCharCode(code);
        }
        name = name.trim();
        if (!name) continue;

        const type = String.fromCharCode(u8[offset + 11]);
        const length = u8[offset + 16];
        fields.push({ name, type, length });
    }

    return { fields, headerSize, recordSize };
}

function createDecoder(cpgText) {
    const candidates = [
        (cpgText || '').trim(),
        'euc-kr',
        'cp949',
        'utf-8'
    ].filter(Boolean);

    for (let i = 0; i < candidates.length; i += 1) {
        try {
            return new TextDecoder(candidates[i]);
        } catch (_) {
            // try next
        }
    }
    return new TextDecoder('utf-8');
}

function readDbfRecord(source, recordIndex, selectedKeys = null) {
    if (!source || !(source.dbfRaw instanceof ArrayBuffer)) return {};
    if (!Array.isArray(source.fields) || source.fields.length === 0) return {};

    const offset = source.headerSize + (recordIndex * source.recordSize);
    if (offset + source.recordSize > source.dbfRaw.byteLength) return {};

    const delFlag = new Uint8Array(source.dbfRaw, offset, 1)[0];
    if (delFlag === 0x2A) return {};

    const decoder = createDecoder(source.cpgText);
    let cursor = offset + 1;
    const props = {};

    for (let i = 0; i < source.fields.length; i += 1) {
        const f = source.fields[i];
        if (!f.length) continue;
        if (cursor + f.length > source.dbfRaw.byteLength) break;
        const keyName = String(f.name || '');
        const upperKey = keyName.toUpperCase();
        const shouldRead = !selectedKeys || selectedKeys.has(keyName) || selectedKeys.has(upperKey);
        if (!shouldRead) {
            cursor += f.length;
            continue;
        }

        const slice = new Uint8Array(source.dbfRaw, cursor, f.length);
        let value = decoder.decode(slice).trim();

        if (f.type === 'N' || f.type === 'F') {
            const num = Number.parseFloat(value);
            if (Number.isFinite(num)) {
                value = num;
            }
        }

        if (value !== '' && value !== null && value !== undefined) {
            props[f.name] = value;
        }

        cursor += f.length;
    }

    return props;
}

function findAttrSource(state, globalIndex) {
    for (let i = 0; i < state.attrSources.length; i += 1) {
        const source = state.attrSources[i];
        if (globalIndex >= source.start && globalIndex < source.end) {
            return source;
        }
    }
    return null;
}

function readAttributes(state, globalIndex, selectedKeys = null) {
    const source = findAttrSource(state, globalIndex);
    if (!source) return {};
    const localIndex = globalIndex - source.start;
    return readDbfRecord(source, localIndex, selectedKeys);
}

function getPreviewAttributes(state, globalIndex, selectedKeys) {
    if (!(selectedKeys instanceof Set)) {
        return readAttributes(state, globalIndex, selectedKeys);
    }

    const cached = state.previewAttrCache.get(globalIndex);
    if (cached) return cached;

    const attrs = readAttributes(state, globalIndex, selectedKeys);
    if (state.previewAttrCache.size >= PREVIEW_CACHE_LIMIT) {
        state.previewAttrCache.clear();
    }
    state.previewAttrCache.set(globalIndex, attrs);
    return attrs;
}

function buildBBoxes(state) {
    const total = state.geometries.length;
    state.bboxes = new Float64Array(total * 4);

    for (let i = 0; i < total; i += BBOX_CHUNK) {
        const end = Math.min(i + BBOX_CHUNK, total);
        for (let j = i; j < end; j += 1) {
            const box = rawBbox(state.geometries[j]);
            const idx = j * 4;
            state.bboxes[idx] = box[0];
            state.bboxes[idx + 1] = box[1];
            state.bboxes[idx + 2] = box[2];
            state.bboxes[idx + 3] = box[3];
        }

        if (total > 0) {
            const pct = 40 + Math.round((end / total) * 55);
            postMessage({
                type: 'progress',
                msg: `[인덱스] ${state.kind} ${end.toLocaleString()} / ${total.toLocaleString()}`,
                pct
            });
        }
    }
}

function normalizeShapeKind(kindValue) {
    const normalized = String(kindValue || '').trim().toLowerCase();
    if (normalized === 'link' || normalized === 'node') return normalized;
    return '';
}

function normalizeZipGroups(zipObj, forcedKind = '') {
    const groups = new Map();
    const normalizedKind = normalizeShapeKind(forcedKind);

    Object.entries(zipObj || {}).forEach(([rawPath, value]) => {
        const normalized = String(rawPath || '').replace(/\\/g, '/');
        const lower = normalized.toLowerCase();
        const dot = lower.lastIndexOf('.');
        if (dot <= 0) return;

        const ext = lower.slice(dot + 1);
        if (!['shp', 'dbf', 'prj', 'cpg', 'shx'].includes(ext)) return;

        const base = lower.slice(0, dot);
        if (!groups.has(base)) {
            const displayName = normalized.split('/').pop()?.replace(/\.[^.]+$/, '') || base;
            groups.set(base, {
                key: base,
                name: displayName,
                kind: normalizedKind,
                shpBuf: null,
                dbfBuf: null,
                prjText: '',
                cpgText: ''
            });
        }

        const g = groups.get(base);
        if (ext === 'shp') g.shpBuf = toArrayBuffer(value);
        if (ext === 'dbf') g.dbfBuf = toArrayBuffer(value);
        if (ext === 'prj') g.prjText = toText(value);
        if (ext === 'cpg') g.cpgText = toText(value);
    });

    return Array.from(groups.values()).filter((g) => g.shpBuf instanceof ArrayBuffer);
}

function normalizeIncomingGroups(rawGroups) {
    if (!Array.isArray(rawGroups)) return [];

    return rawGroups
        .map((g) => ({
            name: g?.name || 'shape',
            kind: normalizeShapeKind(g?.kind),
            shpBuf: toArrayBuffer(g?.shpBuf),
            dbfBuf: toArrayBuffer(g?.dbfBuf),
            prjText: typeof g?.prjText === 'string' ? g.prjText : '',
            cpgText: typeof g?.cpgText === 'string' ? g.cpgText : ''
        }))
        .filter((g) => g.shpBuf instanceof ArrayBuffer);
}

function toFeatureCollections(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) {
        return parsed.filter((item) => item && item.type === 'FeatureCollection');
    }
    if (parsed.type === 'FeatureCollection') {
        return [parsed];
    }
    if (parsed.type === 'Feature') {
        return [{ type: 'FeatureCollection', features: [parsed] }];
    }
    if (typeof parsed === 'object') {
        return Object.values(parsed).filter((item) => item && item.type === 'FeatureCollection');
    }
    return [];
}

function appendGeoJsonPayload(parsed, forcedKind = '') {
    const collections = toFeatureCollections(parsed);
    if (collections.length === 0) {
        throw new Error('ZIP 파싱 결과에서 FeatureCollection을 찾지 못했습니다.');
    }

    let appendedCount = 0;
    const normalizedKind = normalizeShapeKind(forcedKind);

    collections.forEach((fc) => {
        const features = Array.isArray(fc.features) ? fc.features : [];
        features.forEach((feature) => {
            const geometry = feature?.geometry;
            const geomType = geometry?.type || '';
            const kind = normalizedKind || classifyGeometryType(geomType);
            if (!kind || !geometry) return;
            if (kind === 'link') linkState.geometries.push(geometry);
            if (kind === 'node') nodeState.geometries.push(geometry);
            appendedCount += 1;

            const props = (feature?.properties && typeof feature.properties === 'object')
                ? feature.properties
                : null;
            if (!props) return;
            const names = Object.keys(props);
            if (kind === 'link') names.forEach((name) => linkState.fieldNames.add(name));
            if (kind === 'node') names.forEach((name) => nodeState.fieldNames.add(name));
        });
    });

    return appendedCount;
}

function postReadyMessage(linkAttrAvailable, nodeAttrAvailable) {
    postMessage({
        type: 'ready',
        linkCount: linkState.geometries.length,
        nodeCount: nodeState.geometries.length,
        linkCoordMode: linkState.coordMode,
        nodeCoordMode: nodeState.coordMode,
        linkAttrAvailable,
        nodeAttrAvailable,
        linkFieldNames: sortFieldNames(linkState.fieldNames),
        nodeFieldNames: sortFieldNames(nodeState.fieldNames)
    });
}

function loadGeoJsonPayload(parsed) {
    clearAll();
    const appendedCount = appendGeoJsonPayload(parsed);

    if (appendedCount === 0) {
        throw new Error('ZIP 파싱은 됐지만 Link/Node geometry를 찾지 못했습니다.');
    }

    if (linkState.geometries.length === 0 && nodeState.geometries.length === 0) {
        throw new Error('ZIP 파싱은 됐지만 Link/Node geometry를 찾지 못했습니다.');
    }

    linkState.coordMode = 'none';
    nodeState.coordMode = 'none';

    if (linkState.geometries.length > 0) buildBBoxes(linkState);
    if (nodeState.geometries.length > 0) buildBBoxes(nodeState);

    postReadyMessage(false, false);
}

function appendGeometries(target, geometries) {
    const start = target.geometries.length;
    for (let i = 0; i < geometries.length; i += 1) {
        target.geometries.push(geometries[i]);
    }
    return start;
}

function loadGroups(groups) {
    clearAll();

    if (!Array.isArray(groups) || groups.length === 0) {
        throw new Error('SHP 그룹이 없습니다.');
    }

    let parsedCount = 0;

    groups.forEach((group, groupIndex) => {
        postMessage({
            type: 'progress',
            msg: `[파싱] ${groupIndex + 1}/${groups.length} ${group.name}`,
            pct: 10 + Math.round(((groupIndex + 1) / groups.length) * 25)
        });

        const geometries = self.shp.parseShp(group.shpBuf);
        const geomType = detectGeomType(geometries);
        const explicitKind = normalizeShapeKind(group.kind);
        const kind = explicitKind || classifyGeometryType(geomType);
        if (!kind) return;

        const target = kind === 'link' ? linkState : nodeState;

        if (target.coordMode === 'auto') {
            const sampleGeom = geometries.find((g) => g && g.type);
            const sampleCoord = sampleGeom ? firstCoordFromGeometry(sampleGeom) : null;
            target.coordMode = inferCoordModeBySample(sampleCoord, !!group.prjText);
        }

        const start = appendGeometries(target, geometries);

        if (group.dbfBuf instanceof ArrayBuffer) {
            const header = parseDbfHeader(group.dbfBuf);
            if (header) {
                rememberFieldNames(target, header.fields);
                target.attrSources.push({
                    start,
                    end: start + geometries.length,
                    dbfRaw: group.dbfBuf,
                    fields: header.fields,
                    headerSize: header.headerSize,
                    recordSize: header.recordSize,
                    cpgText: group.cpgText
                });
            }
        }

        parsedCount += geometries.length;
    });

    if (parsedCount === 0) {
        throw new Error('SHP 파싱은 됐지만 유효한 Link/Node geometry를 찾지 못했습니다.');
    }

    if (linkState.geometries.length > 0) {
        buildBBoxes(linkState);
    }
    if (nodeState.geometries.length > 0) {
        buildBBoxes(nodeState);
    }

    postReadyMessage(linkState.attrSources.length > 0, nodeState.attrSources.length > 0);
}

function queryState(state, bounds, maxCount, selectedKeys = null) {
    const out = [];
    let matched = 0;
    const bboxes = state.bboxes;

    for (let i = 0; i < bboxes.length; i += 4) {
        const box = [bboxes[i], bboxes[i + 1], bboxes[i + 2], bboxes[i + 3]];
        if (!intersects(box, bounds)) continue;

        matched += 1;
        if (out.length >= maxCount) continue;

        const index = i >> 2;
        const geom = state.geometries[index];
        const props = getPreviewAttributes(state, index, selectedKeys);
        out.push({
            type: 'Feature',
            geometry: transformGeometry(geom, state.coordMode),
            properties: props,
            _shpIndex: index
        });
    }

    return { out, matched };
}

function pickFirstAttrValue(attrs, keys) {
    if (!attrs || !Array.isArray(keys)) return undefined;
    for (let i = 0; i < keys.length; i += 1) {
        const rawKey = String(keys[i] || '').trim();
        if (!rawKey) continue;
        const variants = [rawKey, rawKey.toUpperCase(), rawKey.toLowerCase()];
        for (let j = 0; j < variants.length; j += 1) {
            const key = variants[j];
            if (Object.prototype.hasOwnProperty.call(attrs, key)) {
                const value = attrs[key];
                if (value !== undefined && value !== null && value !== '') {
                    return value;
                }
            }
        }
    }
    return undefined;
}

function findFeatureByProperty(state, keys, needle) {
    const targetNeedle = String(needle ?? '').trim().toLowerCase();
    if (!targetNeedle) return null;

    for (let index = 0; index < state.geometries.length; index += 1) {
        const props = readAttributes(state, index);
        let matched = false;

        const candidate = pickFirstAttrValue(props, keys);
        if (candidate !== undefined && candidate !== null && candidate !== '') {
            const normalizedCandidate = String(candidate).trim().toLowerCase();
            if (normalizedCandidate === targetNeedle || normalizedCandidate.includes(targetNeedle)) {
                matched = true;
            }
        }

        if (!matched) {
            const entries = Object.entries(props || {});
            for (let i = 0; i < entries.length; i += 1) {
                const [, value] = entries[i];
                if (value === undefined || value === null || value === '') continue;
                const normalizedValue = String(value).trim().toLowerCase();
                if (normalizedValue === targetNeedle || normalizedValue.includes(targetNeedle)) {
                    matched = true;
                    break;
                }
            }
        }

        if (!matched) continue;

        return {
            type: 'Feature',
            geometry: transformGeometry(state.geometries[index], state.coordMode),
            properties: props,
            _shpIndex: index
        };
    }
    return null;
}

self.onmessage = async (event) => {
    const data = event.data || {};

    if (data.type === 'clear') {
        clearAll();
        return;
    }

    if (data.type === 'loadZip') {
        try {
            const buffer = data.buffer;
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
                throw new Error('zip 파일이 비어있습니다.');
            }

            postMessage({ type: 'progress', msg: 'ZIP 압축 해제 중...', pct: 5 });

            let zipObj;
            if (typeof self.shp.unzip === 'function') {
                zipObj = await self.shp.unzip(buffer);
            } else if (typeof self.shp === 'function') {
                const parsed = await self.shp(buffer);
                loadGeoJsonPayload(parsed);
                return;
            } else {
                throw new Error('shpjs가 정상적으로 로드되지 않았습니다.');
            }

            const groups = normalizeZipGroups(zipObj, data.kind);
            loadGroups(groups);
        } catch (e) {
            clearAll();
            postMessage({ type: 'error', message: e?.message || String(e) });
        }
        return;
    }

    if (data.type === 'loadKindedZips') {
        try {
            const bundles = Array.isArray(data.bundles) ? data.bundles : [];
            if (bundles.length === 0) {
                throw new Error('로딩할 ZIP 번들이 없습니다.');
            }

            const canUnzip = typeof self.shp.unzip === 'function';
            if (!canUnzip && typeof self.shp !== 'function') {
                throw new Error('ZIP 파서를 사용할 수 없습니다.');
            }

            if (canUnzip) {
                const allGroups = [];
                for (let i = 0; i < bundles.length; i += 1) {
                    const bundle = bundles[i];
                    const kind = normalizeShapeKind(bundle?.kind);
                    const buffer = toArrayBuffer(bundle?.buffer);
                    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
                        throw new Error(`${kind || 'unknown'} ZIP 데이터가 비어있습니다.`);
                    }

                    postMessage({
                        type: 'progress',
                        msg: `[ZIP] ${i + 1}/${bundles.length} 압축 해제 중...`,
                        pct: 5 + Math.round(((i + 1) / bundles.length) * 20)
                    });

                    const zipObj = await self.shp.unzip(buffer);
                    const groups = normalizeZipGroups(zipObj, kind);
                    groups.forEach((group) => allGroups.push(group));
                }

                if (allGroups.length === 0) {
                    throw new Error('ZIP에서 유효한 SHP 그룹을 찾지 못했습니다.');
                }
                loadGroups(allGroups);
                return;
            }

            // Fallback path when unzip helper is unavailable: parse each ZIP directly.
            clearAll();
            let appendedCount = 0;
            for (let i = 0; i < bundles.length; i += 1) {
                const bundle = bundles[i];
                const kind = normalizeShapeKind(bundle?.kind);
                const buffer = toArrayBuffer(bundle?.buffer);
                if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
                    throw new Error(`${kind || 'unknown'} ZIP 데이터가 비어있습니다.`);
                }

                postMessage({
                    type: 'progress',
                    msg: `[ZIP] ${i + 1}/${bundles.length} 로딩 중...`,
                    pct: 5 + Math.round(((i + 1) / bundles.length) * 35)
                });

                const parsed = await self.shp(buffer);
                appendedCount += appendGeoJsonPayload(parsed, kind);
            }

            if (appendedCount === 0) {
                throw new Error('ZIP 파싱은 됐지만 유효한 Link/Node geometry를 찾지 못했습니다.');
            }

            linkState.coordMode = 'none';
            nodeState.coordMode = 'none';
            if (linkState.geometries.length > 0) buildBBoxes(linkState);
            if (nodeState.geometries.length > 0) buildBBoxes(nodeState);
            postReadyMessage(false, false);
        } catch (e) {
            clearAll();
            postMessage({ type: 'error', message: e?.message || String(e) });
        }
        return;
    }

    if (data.type === 'loadGroups') {
        try {
            const groups = normalizeIncomingGroups(data.groups);
            loadGroups(groups);
        } catch (e) {
            clearAll();
            postMessage({ type: 'error', message: e?.message || String(e) });
        }
        return;
    }

    if (data.type === 'query') {
        const requestId = Number(data.requestId || 0);
        const bounds = Array.isArray(data.bounds) ? data.bounds : [0, 0, 0, 0];
        const buffered = [
            Number(bounds[0] || 0) - QUERY_BUFFER_WEST_EAST_DEG,
            Number(bounds[1] || 0) - QUERY_BUFFER_SOUTH_DEG,
            Number(bounds[2] || 0) + QUERY_BUFFER_WEST_EAST_DEG,
            Number(bounds[3] || 0) + QUERY_BUFFER_NORTH_DEG
        ];

        const includeLinks = data.includeLinks !== false;
        const includeNodes = data.includeNodes !== false;
        const maxLinks = Number.isFinite(data.maxLinks) ? data.maxLinks : 12000;
        const maxNodes = Number.isFinite(data.maxNodes) ? data.maxNodes : 8000;
        const queryKeys = new Set(linkQueryPropKeys);
        sanitizePropKeyList(data.linkPropKeys).forEach((key) => {
            queryKeys.add(key);
            queryKeys.add(key.toUpperCase());
        });

        const linkResult = includeLinks
            ? queryState(linkState, buffered, maxLinks, queryKeys)
            : { out: [], matched: 0 };
        const nodeResult = includeNodes
            ? queryState(nodeState, buffered, maxNodes, NODE_QUERY_PROP_KEYS)
            : { out: [], matched: 0 };

        postMessage({
            type: 'queryResult',
            requestId,
            links: linkResult.out,
            nodes: nodeResult.out,
            linkMatched: linkResult.matched,
            nodeMatched: nodeResult.matched
        });
        return;
    }

    if (data.type === 'attrs') {
        const requestId = Number(data.requestId || 0);
        const kind = data.kind === 'node' ? 'node' : 'link';
        const index = Number(data.index);
        const target = kind === 'node' ? nodeState : linkState;

        const props = Number.isFinite(index) && index >= 0
            ? readAttributes(target, index)
            : {};

        postMessage({
            type: 'attrs',
            requestId,
            kind,
            index,
            props
        });
        return;
    }

    if (data.type === 'findLinkByRid') {
        const requestId = Number(data.requestId || 0);
        const keys = sanitizePropKeyList(data.keys);
        const feature = findFeatureByProperty(linkState, keys, data.value);
        postMessage({
            type: 'findLinkByRidResult',
            requestId,
            feature
        });
        return;
    }

    if (data.type === 'setQueryKeys') {
        const nextKeys = new Set(DEFAULT_LINK_QUERY_PROP_KEYS);
        sanitizePropKeyList(data.linkPropKeys).forEach((key) => {
            nextKeys.add(key);
            nextKeys.add(key.toUpperCase());
        });
        linkQueryPropKeys = nextKeys;
    }
};
