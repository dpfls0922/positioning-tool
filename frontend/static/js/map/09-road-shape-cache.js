// ===== Road Shape 로컬 캐시(OPFS) 저장·복원 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function isRoadShapeOpfsAvailable() {
    return typeof navigator !== 'undefined'
        && !!navigator.storage
        && typeof navigator.storage.getDirectory === 'function';
}

function getRoadShapeManifestName(kind) {
    return `${kind}${ROAD_SHAPE_MANIFEST_SUFFIX}`;
}

function toRoadShapeCacheFileToken(value) {
    const token = String(value || 'shape')
        .trim()
        .replace(/[^0-9a-zA-Z._-]+/g, '_')
        .slice(0, 72);
    return token || 'shape';
}

async function getRoadShapeCacheDirHandle(create = true) {
    if (!isRoadShapeOpfsAvailable()) return null;

    if (roadShapeCacheDirHandlePromise) {
        try {
            return await roadShapeCacheDirHandlePromise;
        } catch (_) {
            roadShapeCacheDirHandlePromise = null;
        }
    }

    const openPromise = (async () => {
        const root = await navigator.storage.getDirectory();
        if (!create) {
            try {
                return await root.getDirectoryHandle(ROAD_SHAPE_CACHE_DIR);
            } catch (err) {
                if (err?.name === 'NotFoundError') return null;
                throw err;
            }
        }
        return root.getDirectoryHandle(ROAD_SHAPE_CACHE_DIR, { create: true });
    })();

    if (create) roadShapeCacheDirHandlePromise = openPromise;
    const handle = await openPromise;
    if (!create && handle) roadShapeCacheDirHandlePromise = Promise.resolve(handle);
    return handle;
}

async function writeRoadShapeCacheFile(fileName, payload) {
    const dir = await getRoadShapeCacheDirHandle(true);
    if (!dir) throw new Error('브라우저 파일 캐시를 사용할 수 없습니다. (OPFS 미지원)');

    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
}

async function readRoadShapeCacheFile(fileName, asText = false) {
    const dir = await getRoadShapeCacheDirHandle(false);
    if (!dir) return null;
    try {
        const handle = await dir.getFileHandle(fileName);
        const file = await handle.getFile();
        return asText ? file.text() : file.arrayBuffer();
    } catch (err) {
        if (err?.name === 'NotFoundError') return null;
        throw err;
    }
}

async function removeRoadShapeCacheFile(fileName) {
    const dir = await getRoadShapeCacheDirHandle(false);
    if (!dir) return;
    try {
        await dir.removeEntry(fileName);
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
    }
}

async function loadRoadShapeManifest(kind) {
    const manifestText = await readRoadShapeCacheFile(getRoadShapeManifestName(kind), true);
    if (!manifestText) return null;
    try {
        return JSON.parse(manifestText);
    } catch (_) {
        return null;
    }
}

async function loadRoadShapeKindFromLocalDb(kind) {
    if (!isRoadShapeOpfsAvailable()) return null;

    const manifest = await loadRoadShapeManifest(kind);
    if (!manifest) return null;
    const groupMetas = Array.isArray(manifest?.groups) ? manifest.groups : [];
    if (groupMetas.length === 0) {
        return {
            kind,
            meta: manifest.meta || null,
            groups: [],
            manifest
        };
    }

    const groups = [];
    for (let i = 0; i < groupMetas.length; i += 1) {
        const meta = groupMetas[i];
        const shpFile = String(meta?.shpFile || '').trim();
        if (!shpFile) continue;

        const shpBuf = await readRoadShapeCacheFile(shpFile, false);
        if (!(shpBuf instanceof ArrayBuffer)) continue;

        let dbfBuf = null;
        const dbfFile = String(meta?.dbfFile || '').trim();
        if (dbfFile) {
            const dbfLoaded = await readRoadShapeCacheFile(dbfFile, false);
            if (dbfLoaded instanceof ArrayBuffer) {
                dbfBuf = dbfLoaded;
            }
        }

        groups.push({
            kind,
            name: String(meta?.name || `${kind}_shape`),
            shpBuf,
            dbfBuf,
            prjText: typeof meta?.prjText === 'string' ? meta.prjText : '',
            cpgText: typeof meta?.cpgText === 'string' ? meta.cpgText : ''
        });
    }

    return {
        kind,
        meta: manifest.meta || null,
        groups,
        manifest
    };
}

async function saveRoadShapeKindToLocalDb(kind, meta, groups) {
    if (!isRoadShapeOpfsAvailable()) return;

    const normalizedGroups = Array.isArray(groups) ? groups : [];
    const oldManifest = await loadRoadShapeManifest(kind);
    const oldGroupMetas = Array.isArray(oldManifest?.groups)
        ? oldManifest.groups
        : [];

    const newManifestGroups = [];
    for (let i = 0; i < normalizedGroups.length; i += 1) {
        const group = normalizedGroups[i];
        const safeName = toRoadShapeCacheFileToken(group?.name || `${kind}_${i + 1}`);
        const shpFile = `${kind}_${i}_${safeName}.shp.bin`;
        const dbfFile = group?.dbfBuf instanceof ArrayBuffer ? `${kind}_${i}_${safeName}.dbf.bin` : '';

        if (!(group?.shpBuf instanceof ArrayBuffer)) continue;
        await writeRoadShapeCacheFile(shpFile, group.shpBuf);
        if (dbfFile) {
            await writeRoadShapeCacheFile(dbfFile, group.dbfBuf);
        }

        newManifestGroups.push({
            name: String(group?.name || `${kind}_shape`),
            prjText: typeof group?.prjText === 'string' ? group.prjText : '',
            cpgText: typeof group?.cpgText === 'string' ? group.cpgText : '',
            shpFile,
            dbfFile
        });
    }

    const manifest = {
        kind,
        meta: meta || null,
        updated_at: new Date().toISOString(),
        groups: newManifestGroups
    };
    await writeRoadShapeCacheFile(getRoadShapeManifestName(kind), JSON.stringify(manifest));

    const preservedFiles = new Set([getRoadShapeManifestName(kind)]);
    newManifestGroups.forEach((groupMeta) => {
        preservedFiles.add(groupMeta.shpFile);
        if (groupMeta.dbfFile) preservedFiles.add(groupMeta.dbfFile);
    });

    const oldFiles = new Set();
    oldGroupMetas.forEach((groupMeta) => {
        const oldShp = String(groupMeta?.shpFile || '').trim();
        const oldDbf = String(groupMeta?.dbfFile || '').trim();
        if (oldShp) oldFiles.add(oldShp);
        if (oldDbf) oldFiles.add(oldDbf);
    });
    for (const fileName of oldFiles) {
        if (!preservedFiles.has(fileName)) {
            await removeRoadShapeCacheFile(fileName);
        }
    }
}

async function clearRoadShapeLocalDb() {
    if (!isRoadShapeOpfsAvailable()) return;
    const root = await navigator.storage.getDirectory();
    try {
        await root.removeEntry(ROAD_SHAPE_CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
    }
    roadShapeCacheDirHandlePromise = null;
}

async function restoreRoadShapeFromLocalDb() {
    try {
        const [linkRecord, nodeRecord] = await Promise.all([
            loadRoadShapeKindFromLocalDb('link'),
            loadRoadShapeKindFromLocalDb('node')
        ]);

        const linkGroups = Array.isArray(linkRecord?.groups) ? linkRecord.groups : [];
        const nodeGroups = Array.isArray(nodeRecord?.groups) ? nodeRecord.groups : [];
        if (linkGroups.length === 0 && nodeGroups.length === 0) return;

        roadShapeLocalGroupsByKind = {
            link: linkGroups,
            node: nodeGroups
        };
        roadShapeMetaByKind = {
            link: linkRecord?.meta || null,
            node: nodeRecord?.meta || null
        };
        roadShapePendingLoad = true;
        roadShapeLoading = false;
        updateRoadShapeStateText(roadShapeMetaByKind, `로컬 캐시 복원됨 | zoom ${roadMinZoom}+에서 표시`);
        handleRoadZoomChanged();
    } catch (_) {
        // Ignore restore failure and continue in upload-only mode.
    }
}

function bindFileSelectionSummary(inputId, outputId, asFolder = false) {
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    if (!input || !output) return;

    const update = () => {
        const files = Array.from(input.files || []);
        if (files.length === 0) {
            output.textContent = asFolder ? '폴더 미선택' : '선택된 파일 없음';
            return;
        }
        if (!asFolder) {
            output.textContent = files[0].name || '선택된 파일';
            return;
        }
        const firstPath = files[0]?.webkitRelativePath || files[0]?.name || '';
        const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : 'folder';
        output.textContent = `${folderName} / ${files.length}개 파일`;
    };

    input.addEventListener('change', update);
    update();
}

