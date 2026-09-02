/* ===================== 카카오 스카이뷰(위성) 패널 ===================== */
/* 카카오 타일은 Leaflet 배경지도로 쓸 수 없다(자체 SDK 렌더러만 제공).
   그래서 별도 패널에 카카오 지도를 띄우고 Leaflet 지도와 중심/줌을 동기화한다.
   차선 수·분기 형상을 위성사진으로 확인하는 용도. */

const SKYVIEW_PANEL_ID = 'skyviewPanel';
// Leaflet zoom(0~22, 클수록 확대) ↔ 카카오 level(1~14, 작을수록 확대)
const SKYVIEW_ZOOM_OFFSET = 20;
const SKYVIEW_LEVEL_RANGE = { min: 1, max: 14 };

let skyviewApi = null;
let skyviewMap = null;
let skyviewMarker = null;
let skyviewSyncEnabled = true;
let skyviewSyncing = false;

function leafletZoomToKakaoLevel(zoom) {
    const level = SKYVIEW_ZOOM_OFFSET - Math.round(zoom);
    return Math.min(SKYVIEW_LEVEL_RANGE.max, Math.max(SKYVIEW_LEVEL_RANGE.min, level));
}

function kakaoLevelToLeafletZoom(level) {
    return SKYVIEW_ZOOM_OFFSET - level;
}

function ensureSkyviewPanel() {
    if (skyviewApi) return skyviewApi;
    skyviewApi = createFloatingPanel({
        id: SKYVIEW_PANEL_ID,
        title: '카카오맵 (위성 / 일반)',
        defaultSize: { width: 460, height: 340 },
        storageKey: 'positioningTool.skyviewSize',
        bodyHtml: `
            <div class="skyview-toolbar">
                <label class="skyview-check"><input type="checkbox" data-skyview-sync checked> 지도와 동기화</label>
                <label class="skyview-check"><input type="checkbox" data-skyview-roadview> 로드뷰 도로</label>
                <select data-skyview-type>
                    <option value="SKYVIEW" selected>위성</option>
                    <option value="HYBRID">위성+라벨</option>
                    <option value="ROADMAP">일반</option>
                </select>
            </div>
            <div class="skyview-view"></div>
            <div class="skyview-message-slot"></div>
        `,
        onResize: () => {
            if (skyviewMap) skyviewMap.relayout();
        }
    });
    bindSkyviewPanelControls(skyviewApi.panel);
    return skyviewApi;
}

function bindSkyviewPanelControls(panel) {
    panel.querySelector('[data-skyview-sync]')?.addEventListener('change', (e) => {
        skyviewSyncEnabled = !!e.target.checked;
        if (skyviewSyncEnabled) syncSkyviewToLeaflet();
    });

    panel.querySelector('[data-skyview-type]')?.addEventListener('change', (e) => {
        if (!skyviewMap || !window.kakao?.maps) return;
        const typeId = kakao.maps.MapTypeId[e.target.value] || kakao.maps.MapTypeId.SKYVIEW;
        skyviewMap.setMapTypeId(typeId);
    });

    panel.querySelector('[data-skyview-roadview]')?.addEventListener('change', (e) => {
        if (!skyviewMap || !window.kakao?.maps) return;
        const overlay = kakao.maps.MapTypeId.ROADVIEW;
        if (e.target.checked) skyviewMap.addOverlayMapTypeId(overlay);
        else skyviewMap.removeOverlayMapTypeId(overlay);
    });
}

function setSkyviewMessage(message, guide = null) {
    const api = ensureSkyviewPanel();
    const slot = api.panel.querySelector('.skyview-message-slot');
    const view = api.panel.querySelector('.skyview-view');
    if (!message) {
        slot.innerHTML = '';
        view.classList.remove('dim');
        return;
    }
    slot.innerHTML = kakaoSetupGuideHtml(message, guide);
    view.classList.add('dim');
}

/** Leaflet → 카카오 방향 동기화. */
function syncSkyviewToLeaflet() {
    if (!skyviewMap || !skyviewSyncEnabled || skyviewSyncing || !window.kakao?.maps) return;
    skyviewSyncing = true;
    try {
        const center = map.getCenter();
        skyviewMap.setCenter(new kakao.maps.LatLng(center.lat, center.lng));
        skyviewMap.setLevel(leafletZoomToKakaoLevel(map.getZoom()));
        updateSkyviewMarker(center.lat, center.lng);
    } finally {
        skyviewSyncing = false;
    }
}

/** 카카오 → Leaflet 방향 동기화(위성 패널을 끌어서 움직인 경우). */
function syncLeafletToSkyview() {
    if (!skyviewMap || !skyviewSyncEnabled || skyviewSyncing) return;
    skyviewSyncing = true;
    try {
        const center = skyviewMap.getCenter();
        map.setView(
            [center.getLat(), center.getLng()],
            kakaoLevelToLeafletZoom(skyviewMap.getLevel()),
            { animate: false }
        );
        updateSkyviewMarker(center.getLat(), center.getLng());
    } finally {
        skyviewSyncing = false;
    }
}

function updateSkyviewMarker(lat, lon) {
    if (!skyviewMap || !window.kakao?.maps) return;
    const position = new kakao.maps.LatLng(lat, lon);
    if (!skyviewMarker) {
        skyviewMarker = new kakao.maps.Marker({ position, map: skyviewMap });
        return;
    }
    skyviewMarker.setPosition(position);
}

async function openSkyview(lat = null, lon = null) {
    const api = ensureSkyviewPanel();
    api.open();

    const center = Number.isFinite(lat) && Number.isFinite(lon)
        ? { lat, lng: lon }
        : map.getCenter();
    api.setSubtitle(`${center.lat.toFixed(7)}, ${center.lng.toFixed(7)}`);

    let kakaoNs;
    try {
        setSkyviewMessage('위성 지도를 불러오는 중...');
        kakaoNs = await loadKakaoMapsSdk();
    } catch (err) {
        kakaoSdkPromise = null;
        setSkyviewMessage(err.message || '카카오 지도 SDK 로드 실패', err.guide);
        return;
    }

    setSkyviewMessage('');
    const viewEl = api.panel.querySelector('.skyview-view');
    if (!skyviewMap) {
        skyviewMap = new kakaoNs.maps.Map(viewEl, {
            center: new kakaoNs.maps.LatLng(center.lat, center.lng),
            level: leafletZoomToKakaoLevel(map.getZoom()),
            mapTypeId: kakaoNs.maps.MapTypeId.SKYVIEW
        });
        kakaoNs.maps.event.addListener(skyviewMap, 'center_changed', syncLeafletToSkyview);
        kakaoNs.maps.event.addListener(skyviewMap, 'zoom_changed', syncLeafletToSkyview);
    }
    skyviewMap.relayout();
    skyviewMap.setCenter(new kakaoNs.maps.LatLng(center.lat, center.lng));
    skyviewMap.setLevel(leafletZoomToKakaoLevel(map.getZoom()));
    updateSkyviewMarker(center.lat, center.lng);
}

function bindSkyviewEvents() {
    const btn = addKakaoToolbarButton({
        id: 'toolSkyviewBtn',
        icon: 'fa-globe',
        title: '카카오맵 (위성 / 일반) — 카카오 타일은 배경지도로 못 쓰므로 별도 창',
        onClick: () => {
            if (skyviewApi && skyviewApi.isOpen()) {
                skyviewApi.close();
                return;
            }
            openSkyview();
        }
    });
    if (btn && typeof kakaoJsKeySet !== 'undefined' && !kakaoJsKeySet) {
        btn.disabled = true;
        btn.title = '카카오맵 — KAKAO_JS_KEY 환경변수를 설정하면 활성화됩니다';
    }

    // Leaflet 을 움직이면 위성 패널도 따라간다.
    map.on('moveend zoomend', () => {
        if (skyviewApi && skyviewApi.isOpen()) syncSkyviewToLeaflet();
    });
}

bindSkyviewEvents();
