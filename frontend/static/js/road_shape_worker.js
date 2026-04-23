'use strict';

importScripts('https://unpkg.com/shpjs@4.0.4/dist/shp.js');

let linkFeatures = [];
let nodeFeatures = [];
let linkBBoxes = [];
let nodeBBoxes = [];

const QUERY_BUFFER_DEG = 0.01;

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

function emptyState() {
    linkFeatures = [];
    nodeFeatures = [];
    linkBBoxes = [];
    nodeBBoxes = [];
}

function compactProperties(properties) {
    if (!properties || typeof properties !== 'object') return {};
    const out = {};
    Object.entries(properties).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return;
        out[key] = value;
    });
    return out;
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
    for (let i = 0; i < 8; i += 1) {
        const nw = WGS84_A / Math.sqrt(1.0 - (WGS84_E2 * Math.sin(phi2) ** 2));
        phi2 = Math.atan2(z2 + (WGS84_E2 * nw * Math.sin(phi2)), p);
    }
    return [lam2 * 180.0 / Math.PI, phi2 * 180.0 / Math.PI];
}

function maybeTransformCoord(coord) {
    const lon = Number(coord?.[0]);
    const lat = Number(coord?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return coord;

    // If values are plausible geographic coords around KR, treat as Bessel lon/lat.
    if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
        return besselToWgs84(lon, lat);
    }
    return [lon, lat];
}

function transformGeometry(geometry) {
    if (!geometry) return geometry;
    const type = geometry.type;
    const c = geometry.coordinates;
    if (!c) return geometry;

    if (type === 'Point') {
        return { ...geometry, coordinates: maybeTransformCoord(c) };
    }
    if (type === 'LineString' || type === 'MultiPoint') {
        return { ...geometry, coordinates: c.map((coord) => maybeTransformCoord(coord)) };
    }
    if (type === 'MultiLineString' || type === 'Polygon') {
        return { ...geometry, coordinates: c.map((ring) => ring.map((coord) => maybeTransformCoord(coord))) };
    }
    if (type === 'MultiPolygon') {
        return {
            ...geometry,
            coordinates: c.map((poly) => poly.map((ring) => ring.map((coord) => maybeTransformCoord(coord))))
        };
    }
    return geometry;
}

function normalizeGeoPayload(payload) {
    const collections = Array.isArray(payload) ? payload : [payload];
    const links = [];
    const nodes = [];

    collections.forEach((collection) => {
        const features = Array.isArray(collection?.features) ? collection.features : [];
        features.forEach((feature) => {
            const geometry = feature?.geometry;
            const geomType = geometry?.type;
            if (!geomType) return;

            const normalized = {
                type: 'Feature',
                geometry,
                properties: compactProperties(feature?.properties || {})
            };

            if (geomType.includes('LineString')) {
                links.push(normalized);
                return;
            }
            if (geomType.includes('Point')) {
                nodes.push(normalized);
            }
        });
    });

    return { links, nodes };
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

function featureBBox(feature) {
    const coords = [];
    collectCoords(feature?.geometry, coords);
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

function querySubset(features, bboxes, bounds, maxCount) {
    const out = [];
    let matched = 0;
    for (let i = 0; i < features.length; i += 1) {
        const bbox = bboxes[i];
        if (!bbox || !intersects(bbox, bounds)) continue;
        matched += 1;
        if (out.length >= maxCount) continue;
        out.push({
            ...features[i],
            geometry: transformGeometry(features[i].geometry)
        });
    }
    return { out, matched };
}

self.onmessage = async (event) => {
    const data = event.data || {};

    if (data.type === 'clear') {
        emptyState();
        return;
    }

    if (data.type === 'loadZip') {
        try {
            const buffer = data.buffer;
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
                throw new Error('zip 파일이 비어있습니다.');
            }

            postMessage({ type: 'progress', msg: 'Shape 파싱 중...' });
            const parsed = await self.shp(buffer);

            postMessage({ type: 'progress', msg: '레이어 분류/인덱스 생성 중...' });
            const normalized = normalizeGeoPayload(parsed);

            linkFeatures = normalized.links;
            nodeFeatures = normalized.nodes;
            linkBBoxes = linkFeatures.map((f) => featureBBox(f));
            nodeBBoxes = nodeFeatures.map((f) => featureBBox(f));

            postMessage({
                type: 'ready',
                linkCount: linkFeatures.length,
                nodeCount: nodeFeatures.length
            });
        } catch (e) {
            emptyState();
            postMessage({ type: 'error', message: e?.message || String(e) });
        }
        return;
    }

    if (data.type === 'query') {
        const requestId = Number(data.requestId || 0);
        const bounds = Array.isArray(data.bounds) ? data.bounds : [0, 0, 0, 0];
        const bufferedBounds = [
            Number(bounds[0] || 0) - QUERY_BUFFER_DEG,
            Number(bounds[1] || 0) - QUERY_BUFFER_DEG,
            Number(bounds[2] || 0) + QUERY_BUFFER_DEG,
            Number(bounds[3] || 0) + QUERY_BUFFER_DEG
        ];
        const includeLinks = data.includeLinks !== false;
        const includeNodes = data.includeNodes !== false;
        const maxLinks = Number.isFinite(data.maxLinks) ? data.maxLinks : 12000;
        const maxNodes = Number.isFinite(data.maxNodes) ? data.maxNodes : 8000;

        const linkResult = includeLinks
            ? querySubset(linkFeatures, linkBBoxes, bufferedBounds, maxLinks)
            : { out: [], matched: 0 };
        const nodeResult = includeNodes
            ? querySubset(nodeFeatures, nodeBBoxes, bufferedBounds, maxNodes)
            : { out: [], matched: 0 };

        postMessage({
            type: 'queryResult',
            requestId,
            links: linkResult.out,
            nodes: nodeResult.out,
            linkMatched: linkResult.matched,
            nodeMatched: nodeResult.matched
        });
    }
};
