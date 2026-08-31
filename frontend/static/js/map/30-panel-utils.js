/* ===================== 떠 있는 패널 공용 유틸 ===================== */
/* 로드뷰 / 카카오 정보 / 위성 패널이 같은 방식으로 동작하게 한다.
   - 우하단 고정, 좌상단 핸들 드래그로 크기 조절
   - 헤더 더블클릭으로 최대화 토글
   - 크기는 localStorage 에 저장해 다음에 열 때 복원 */

const FLOATING_PANEL_MIN = { width: 320, height: 220 };

function floatingPanelViewport() {
    // 숨겨진 탭/프리뷰에서는 innerWidth 가 0 으로 오기도 한다. 그때는 상한을 걸지 않는다.
    return {
        width: window.innerWidth || document.documentElement?.clientWidth || 0,
        height: window.innerHeight || document.documentElement?.clientHeight || 0
    };
}

function clampFloatingPanelSize(width, height, min = FLOATING_PANEL_MIN) {
    const viewport = floatingPanelViewport();
    const maxWidth = viewport.width > min.width ? viewport.width - 32 : Infinity;
    const maxHeight = viewport.height > min.height ? viewport.height - 32 : Infinity;
    return {
        width: Math.round(Math.min(Math.max(width, min.width), maxWidth)),
        height: Math.round(Math.min(Math.max(height, min.height), maxHeight))
    };
}

function readStoredPanelSize(storageKey) {
    if (!storageKey) return null;
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (parsed && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) return parsed;
    } catch (_) {
        // 프라이빗 모드 등에서 접근이 막히면 무시한다.
    }
    return null;
}

function writeStoredPanelSize(storageKey, size) {
    if (!storageKey) return;
    try {
        localStorage.setItem(storageKey, JSON.stringify(size));
    } catch (_) {
        // 저장 실패는 무시한다.
    }
}

function setFloatingPanelSize(panel, width, height, { persist = true } = {}) {
    const config = panel.__floatingConfig || {};
    const size = clampFloatingPanelSize(width, height, config.min || FLOATING_PANEL_MIN);
    panel.style.width = `${size.width}px`;
    panel.style.height = `${size.height}px`;
    if (typeof config.onResize === 'function') config.onResize(size);
    if (persist) writeStoredPanelSize(config.storageKey, size);
    return size;
}

function toggleFloatingPanelMaximized(panel) {
    const config = panel.__floatingConfig || {};
    const defaults = config.defaultSize || { width: 460, height: 320 };
    if (panel.dataset.maximized === 'true') {
        panel.dataset.maximized = 'false';
        const stored = readStoredPanelSize(config.storageKey) || defaults;
        setFloatingPanelSize(panel, stored.width, stored.height, { persist: false });
        return;
    }
    panel.dataset.maximized = 'true';
    const viewport = floatingPanelViewport();
    setFloatingPanelSize(
        panel,
        (viewport.width || defaults.width) - 32,
        (viewport.height || defaults.height) - 32,
        { persist: false }
    );
}

/** 좌상단 핸들을 끌어 패널을 키운다(우하단 고정이라 위/왼쪽으로 커진다). */
function bindFloatingPanelResize(panel) {
    const handle = panel.querySelector('.floating-panel-resize-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            handle.setPointerCapture(event.pointerId);
        } catch (_) {
            // 캡처 실패해도 이벤트는 핸들에서 계속 받는다.
        }

        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = panel.offsetWidth;
        const startHeight = panel.offsetHeight;
        panel.classList.add('resizing');
        panel.dataset.maximized = 'false';

        const onMove = (moveEvent) => {
            setFloatingPanelSize(
                panel,
                startWidth + (startX - moveEvent.clientX),
                startHeight + (startY - moveEvent.clientY),
                { persist: false }
            );
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            panel.classList.remove('resizing');
            setFloatingPanelSize(panel, panel.offsetWidth, panel.offsetHeight);
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
}

/** 헤더를 끌어 패널을 옮긴다(우하단 기준 right/bottom 을 조정). */
function bindFloatingPanelDrag(panel) {
    const header = panel.querySelector('.floating-panel-header');
    if (!header) return;

    header.addEventListener('pointerdown', (event) => {
        // 닫기 버튼이나 리사이즈 핸들에서 시작한 드래그는 무시한다.
        if (event.target.closest('.floating-panel-close, .floating-panel-resize-handle')) return;
        event.preventDefault();
        try {
            header.setPointerCapture(event.pointerId);
        } catch (_) {
            // 캡처 실패해도 핸들러는 계속 동작한다.
        }

        const startX = event.clientX;
        const startY = event.clientY;
        const startRight = parseFloat(panel.style.right || '16');
        const startBottom = parseFloat(panel.style.bottom || '16');
        panel.classList.add('dragging');

        const onMove = (moveEvent) => {
            const viewport = floatingPanelViewport();
            const maxRight = Math.max(0, (viewport.width || panel.offsetWidth) - panel.offsetWidth);
            const maxBottom = Math.max(0, (viewport.height || panel.offsetHeight) - panel.offsetHeight);
            const right = startRight - (moveEvent.clientX - startX);
            const bottom = startBottom - (moveEvent.clientY - startY);
            panel.style.right = `${Math.min(Math.max(right, 0), maxRight)}px`;
            panel.style.bottom = `${Math.min(Math.max(bottom, 0), maxBottom)}px`;
        };
        const onUp = () => {
            header.removeEventListener('pointermove', onMove);
            header.removeEventListener('pointerup', onUp);
            header.removeEventListener('pointercancel', onUp);
            panel.classList.remove('dragging');
        };

        header.addEventListener('pointermove', onMove);
        header.addEventListener('pointerup', onUp);
        header.addEventListener('pointercancel', onUp);
    });
}

/** 이미 떠 있는 패널과 완전히 겹치지 않게 계단식으로 배치한다. */
function cascadeFloatingPanel(panel) {
    const others = Array.from(document.querySelectorAll('.floating-panel'))
        .filter((el) => el !== panel);
    const step = 28 * others.length;
    panel.style.right = `${16 + step}px`;
    panel.style.bottom = `${16 + step}px`;
}

/**
 * 우하단에 떠 있는 크기 조절 가능한 패널을 만든다.
 * @returns {{panel: HTMLElement, body: HTMLElement, setSubtitle: Function, open: Function, close: Function}}
 */
function createFloatingPanel({
    id,
    title,
    bodyHtml = '',
    min = FLOATING_PANEL_MIN,
    defaultSize = { width: 460, height: 320 },
    storageKey = null,
    onResize = null,
    onClose = null
}) {
    const existing = document.getElementById(id);
    if (existing) return existing.__floatingApi;

    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'floating-panel hidden';
    panel.innerHTML = `
        <div class="floating-panel-resize-handle" title="드래그해서 크기 조절"></div>
        <div class="floating-panel-header">
            <span class="floating-panel-title">${escapeHtml(title)}</span>
            <span class="floating-panel-subtitle"></span>
            <button type="button" class="floating-panel-close" title="닫기">✕</button>
        </div>
        <div class="floating-panel-body">${bodyHtml}</div>
    `;
    document.body.appendChild(panel);

    panel.__floatingConfig = { min, defaultSize, storageKey, onResize };

    // 패널 안에서의 조작이 지도로 새지 않게 막는다.
    ['mousedown', 'dblclick', 'wheel', 'click'].forEach((type) => {
        panel.addEventListener(type, (e) => e.stopPropagation());
    });

    const api = {
        panel,
        body: panel.querySelector('.floating-panel-body'),
        setSubtitle(text) {
            panel.querySelector('.floating-panel-subtitle').textContent = text || '';
        },
        open() {
            panel.classList.remove('hidden');
            bringFloatingPanelToFront(panel);
            if (typeof onResize === 'function') onResize({ width: panel.offsetWidth, height: panel.offsetHeight });
        },
        close() {
            panel.classList.add('hidden');
            if (typeof onClose === 'function') onClose();
        },
        isOpen() {
            return !panel.classList.contains('hidden');
        }
    };

    panel.querySelector('.floating-panel-close').addEventListener('click', api.close);
    panel.querySelector('.floating-panel-header')
        .addEventListener('dblclick', () => toggleFloatingPanelMaximized(panel));
    bindFloatingPanelResize(panel);
    bindFloatingPanelDrag(panel);
    cascadeFloatingPanel(panel);

    const stored = readStoredPanelSize(storageKey) || defaultSize;
    setFloatingPanelSize(panel, stored.width, stored.height, { persist: false });

    panel.__floatingApi = api;
    return api;
}

let floatingPanelTopZ = 2200;

function bringFloatingPanelToFront(panel) {
    floatingPanelTopZ += 1;
    panel.style.zIndex = String(floatingPanelTopZ);
}

window.addEventListener('resize', () => {
    document.querySelectorAll('.floating-panel:not(.hidden)').forEach((panel) => {
        setFloatingPanelSize(panel, panel.offsetWidth, panel.offsetHeight, { persist: false });
    });
});

/* ===================== 카카오 기능 공용 컨트롤 ===================== */

/** 우측 아이콘 툴바(측정 도구 그룹)에 버튼을 추가한다. 툴바 마크업은 건드리지 않는다. */
function addKakaoToolbarButton({ id, icon, title, onClick }) {
    const group = document.getElementById('measureGroup') || document.getElementById('rightToolbar');
    if (!group) return null;
    const existing = document.getElementById(id);
    if (existing) return existing;

    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.className = 'tool-btn';
    btn.title = title;
    btn.innerHTML = `<i class="fa ${icon}"></i>`;
    btn.addEventListener('click', onClick);
    group.appendChild(btn);
    return btn;
}

/* 지도 클릭을 쓰는 카카오 기능(로드뷰/주소 조회/주변 검색)은 하나만 켜져 있어야 한다. */
const kakaoPickModeResetters = {};
let kakaoActivePickMode = null;

function registerKakaoPickMode(name, reset) {
    kakaoPickModeResetters[name] = reset;
}

function setKakaoPickMode(name) {
    Object.entries(kakaoPickModeResetters).forEach(([key, reset]) => {
        if (key !== name) reset();
    });
    kakaoActivePickMode = name;
}

/** 다른 도구(거리/반경 재기)가 지도 클릭을 쓰는 중이면 카카오 기능은 양보한다. */
function otherMapToolActive() {
    if (typeof distancePickMode !== 'undefined' && distancePickMode) return true;
    if (typeof radiusPickMode !== 'undefined' && radiusPickMode) return true;
    return false;
}
