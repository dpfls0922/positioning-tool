/* ===================== 카카오 로드뷰 ===================== */
/* 로드뷰는 카카오맵 JS SDK 전용 기능이라 타일 레이어로 겹칠 수 없다.
   그래서 떠 있는 패널로 띄우고, 마커 팝업과 지도 클릭에서 열 수 있게 한다.
   KAKAO_JS_KEY 환경변수가 있어야 SDK 스크립트가 주입된다(kakaoJsKeySet). */

const ROADVIEW_RADII_M = [50, 150, 500];
const ROADVIEW_PANEL_ID = 'roadviewPanel';

let roadviewApi = null;
let roadviewInstance = null;
let roadviewClient = null;
let roadviewPickMode = false;
let kakaoSdkPromise = null;
const roadviewTargetLayer = L.layerGroup().addTo(map);

/** 지금 페이지에 심긴 카카오 JS 키를 앞뒤만 남겨 보여준다(앱 불일치 확인용). */
function maskedKakaoJsKey() {
    const tag = Array.from(document.scripts).find((el) => (el.src || '').includes('dapi.kakao.com'));
    const key = tag ? new URL(tag.src).searchParams.get('appkey') : null;
    if (!key) return '없음';
    return key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : key;
}

class KakaoSdkSetupError extends Error {
    constructor(message, guide) {
        super(message);
        this.guide = guide || null;
    }
}

/** 카카오맵 JS SDK 준비. 로드뷰/스카이뷰가 함께 쓴다. */
function loadKakaoMapsSdk() {
    if (kakaoSdkPromise) return kakaoSdkPromise;
    kakaoSdkPromise = new Promise((resolve, reject) => {
        if (typeof kakaoJsKeySet === 'undefined' || !kakaoJsKeySet) {
            reject(new KakaoSdkSetupError(
                'KAKAO_JS_KEY 환경변수가 없어 카카오 지도 기능을 쓸 수 없습니다.',
                {
                    steps: ['카카오 개발자센터 > 내 애플리케이션 > 앱 키 > JavaScript 키 복사'],
                    code: 'KAKAO_JS_KEY=복사한_JavaScript_키   (프로젝트 루트 .env)'
                }
            ));
            return;
        }
        if (!window.kakao || !window.kakao.maps) {
            // 스크립트 자체가 401 로 막힌 경우다. 등록해야 할 주소를 그대로 보여준다.
            // 주의: '플랫폼 > Web > 사이트 도메인' 이 아니라 'JavaScript SDK 도메인' 이어야 한다.
            reject(new KakaoSdkSetupError(
                `카카오 지도 SDK 가 차단됐습니다. (사용 중인 JS 키: ${maskedKakaoJsKey()})`,
                {
                    steps: [
                        '카카오 개발자센터 > 내 애플리케이션 > 해당 앱 > [앱 설정] 플랫폼 및 키',
                        '"JavaScript SDK 도메인" 항목에 아래 주소를 등록하고 저장 (플랫폼 > Web 사이트 도메인이 아닙니다)',
                        '저장 후 이 페이지를 새로고침. 그래도 안 되면 그 화면의 JavaScript 키가 위 키와 같은지 확인'
                    ],
                    code: window.location.origin
                }
            ));
            return;
        }
        try {
            kakao.maps.load(() => resolve(window.kakao));
        } catch (err) {
            reject(err);
        }
    });
    return kakaoSdkPromise;
}

/** SDK 설정 오류를 패널 안에 단계별 안내로 그린다. */
function kakaoSetupGuideHtml(message, guide) {
    const steps = (guide?.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('');
    return `
        <div class="panel-message">
            <div class="panel-message-inner">
                <div class="panel-message-text">${escapeHtml(message)}</div>
                ${steps ? `<ol class="panel-message-steps">${steps}</ol>` : ''}
                ${guide?.code ? `<code class="panel-message-code">${escapeHtml(guide.code)}</code>` : ''}
            </div>
        </div>
    `;
}

function ensureRoadviewPanel() {
    if (roadviewApi) return roadviewApi;
    roadviewApi = createFloatingPanel({
        id: ROADVIEW_PANEL_ID,
        title: '로드뷰',
        bodyHtml: '<div class="roadview-view"></div><div class="roadview-message-slot"></div>',
        defaultSize: { width: 460, height: 320 },
        storageKey: 'positioningTool.roadviewSize',
        // 컨테이너 크기가 바뀌면 로드뷰는 relayout 을 해줘야 다시 그려진다.
        onResize: () => {
            if (roadviewInstance) roadviewInstance.relayout();
        },
        onClose: () => roadviewTargetLayer.clearLayers()
    });
    return roadviewApi;
}

function setRoadviewMessage(message, guide = null) {
    const api = ensureRoadviewPanel();
    const slot = api.panel.querySelector('.roadview-message-slot');
    const view = api.panel.querySelector('.roadview-view');
    if (!message) {
        slot.innerHTML = '';
        view.classList.remove('dim');
        return;
    }
    slot.innerHTML = kakaoSetupGuideHtml(message, guide);
    view.classList.add('dim');
}

function closeRoadview() {
    if (roadviewApi) roadviewApi.close();
    roadviewTargetLayer.clearLayers();
}

function markRoadviewTarget(lat, lon) {
    roadviewTargetLayer.clearLayers();
    L.circleMarker([lat, lon], {
        radius: 9,
        color: '#f59e0b',
        fillColor: '#fef08a',
        fillOpacity: 0.9,
        weight: 3,
        interactive: false
    }).addTo(roadviewTargetLayer);
}

/** 가장 가까운 파노라마를 반경을 넓혀가며 찾는다. 없으면 panoId 가 null 이다. */
function findNearestPanoId(latlng, radiusIndex = 0) {
    return new Promise((resolve) => {
        const radius = ROADVIEW_RADII_M[radiusIndex];
        if (radius === undefined) {
            resolve({ panoId: null, radius: ROADVIEW_RADII_M[ROADVIEW_RADII_M.length - 1] });
            return;
        }
        roadviewClient.getNearestPanoId(latlng, radius, (panoId) => {
            if (panoId) {
                resolve({ panoId, radius });
                return;
            }
            findNearestPanoId(latlng, radiusIndex + 1).then(resolve);
        });
    });
}

async function openRoadview(lat, lon, { heading = null, label = '' } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const api = ensureRoadviewPanel();
    api.open();
    api.setSubtitle(`${label ? label + ' · ' : ''}${lat.toFixed(7)}, ${lon.toFixed(7)}`);
    setRoadviewMessage('로드뷰를 불러오는 중...');
    markRoadviewTarget(lat, lon);

    let kakaoNs;
    try {
        kakaoNs = await loadKakaoMapsSdk();
    } catch (err) {
        // 다음 시도에서 다시 검사할 수 있도록 실패한 프라미스는 버린다.
        kakaoSdkPromise = null;
        setRoadviewMessage(err.message || '카카오 지도 SDK 로드 실패', err.guide);
        return;
    }

    const viewEl = api.panel.querySelector('.roadview-view');
    if (!roadviewInstance) {
        roadviewInstance = new kakaoNs.maps.Roadview(viewEl);
        roadviewClient = new kakaoNs.maps.RoadviewClient();
    }

    const position = new kakaoNs.maps.LatLng(lat, lon);
    const { panoId, radius } = await findNearestPanoId(position);
    if (!panoId) {
        setRoadviewMessage(`반경 ${radius}m 안에 로드뷰가 없는 지점입니다.`);
        return;
    }

    setRoadviewMessage('');
    kakaoNs.maps.event.addListener(roadviewInstance, 'init', function onInit() {
        kakaoNs.maps.event.removeListener(roadviewInstance, 'init', onInit);
        roadviewInstance.relayout();
        if (Number.isFinite(heading)) {
            // 로그의 진행 방향(heading)으로 시점을 맞춘다.
            roadviewInstance.setViewpoint({ pan: heading, tilt: 0, zoom: 0 });
        }
    });
    roadviewInstance.setPanoId(panoId, position);
}

function setRoadviewPickMode(enabled) {
    roadviewPickMode = !!enabled;
    const btn = document.getElementById('toolRoadviewBtn');
    if (btn) {
        btn.classList.toggle('active', roadviewPickMode);
        btn.title = roadviewPickMode ? '로드뷰: 지도에서 지점 클릭' : '로드뷰';
    }
    if (roadviewPickMode) setKakaoPickMode('roadview');
    const container = map.getContainer();
    if (container) container.style.cursor = roadviewPickMode ? 'crosshair' : '';
}

function buildRoadviewControls() {
    const btn = addKakaoToolbarButton({
        id: 'toolRoadviewBtn',
        icon: 'fa-street-view',
        title: '로드뷰',
        onClick: () => setRoadviewPickMode(!roadviewPickMode)
    });
    if (btn && typeof kakaoJsKeySet !== 'undefined' && !kakaoJsKeySet) {
        btn.disabled = true;
        btn.title = '로드뷰 (KAKAO_JS_KEY 환경변수를 설정하면 활성화됩니다)';
    }
}

function bindRoadviewEvents() {
    buildRoadviewControls();
    registerKakaoPickMode('roadview', () => {
        if (roadviewPickMode) setRoadviewPickMode(false);
    });

    // 마커 팝업이 열릴 때 '로드뷰' 버튼을 끼워 넣는다.
    // (마커 생성 코드를 건드리지 않고 팝업 DOM 에만 추가한다)
    map.on('popupopen', (event) => {
        const popup = event?.popup;
        const source = popup?._source;
        if (!popup || !source || typeof source.getLatLng !== 'function') return;

        const content = popup.getElement()?.querySelector('.leaflet-popup-content');
        if (!content || content.querySelector('.roadview-popup-btn')) return;

        const latlng = source.getLatLng();
        const data = source.data || {};
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'roadview-popup-btn';
        btn.textContent = '로드뷰 보기';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dltId = Number.isFinite(data.dlt_id) ? `DLT ${data.dlt_id}` : '';
            openRoadview(latlng.lat, latlng.lng, {
                heading: Number.isFinite(data.heading) ? data.heading : null,
                label: dltId
            });
        });
        content.appendChild(btn);
    });

    map.on('click', (e) => {
        if (!roadviewPickMode) return;
        if (typeof distancePickMode !== 'undefined' && distancePickMode) return;
        if (typeof radiusPickMode !== 'undefined' && radiusPickMode) return;
        openRoadview(e.latlng.lat, e.latlng.lng);
    });
}

bindRoadviewEvents();
