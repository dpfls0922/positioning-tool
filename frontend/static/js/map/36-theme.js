/* ===================== 라이트 / 다크 테마 전환 ===================== */
/* CSS 는 다크가 기본이고, html[data-theme="light"] 에서 밝은 값으로 덮어쓴다.
   선택은 localStorage 에 남겨 다음 실행에도 유지한다. */

const THEME_STORAGE_KEY = 'positioningTool.theme';

function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;

    const btn = document.getElementById('toolThemeBtn');
    if (btn) {
        btn.title = next === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환';
        btn.innerHTML = `<i class="fa ${next === 'light' ? 'fa-moon-o' : 'fa-sun-o'}"></i>`;
    }
    try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (_) {
        // 저장 실패(프라이빗 모드 등)는 무시한다.
    }
    // 지도 타일은 그대로지만, 컨트롤 크기가 바뀔 수 있어 한 번 다시 계산한다.
    requestAnimationFrame(() => map.invalidateSize());
}

function storedTheme() {
    try {
        return localStorage.getItem(THEME_STORAGE_KEY);
    } catch (_) {
        return null;
    }
}

function bindThemeToggle() {
    addKakaoToolbarButton({
        id: 'toolThemeBtn',
        icon: 'fa-sun-o',
        title: '라이트 모드로 전환',
        onClick: () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light')
    });
    // 저장된 선택이 없으면 지금 모습(다크)을 유지한다.
    applyTheme(storedTheme() || 'dark');
}

bindThemeToggle();
