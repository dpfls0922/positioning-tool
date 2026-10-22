/* ===================== 화면 전환 (포지셔닝 ↔ SDI 검색) =====================
   두 화면은 각각 독립된 문서다(전역 이름이 겹쳐 한 문서에 합칠 수 없다).
   그래서 링크로 이동하는 대신, 먼저 열린 쪽이 다른 쪽을 iframe 으로 한 번만
   띄우고 이후로는 숨겼다 보여주기만 한다. 두 화면 모두 살아 있으므로 탭을
   오가도 상태가 유지된다.

   iframe 안에서 눌린 탭은 자기가 전환할 수 없으므로(자기 창만 덮는다) 부모에게
   postMessage 로 넘긴다. 부모는 자기 화면을 다시 보여주면 된다 — 화면이 둘이라
   자식이 요청할 수 있는 대상은 항상 부모 자신이다.

   호스트를 display:none 으로 숨기는 대신 iframe 을 화면 전체에 덮는다
   (position: fixed). 숨기면 호스트가 흐름에서 빠져 레이아웃을 다시 잡아야 하고,
   Leaflet 은 그동안 컨테이너 크기를 잃어 다시 보일 때 타일이 비는 구간이
   생긴다. 덮어두면 호스트 레이아웃이 그대로라 복구할 것이 없다.

   JS 가 없거나 이 파일이 안 읽혔으면 탭은 원래대로 링크로 동작한다(href 유지). */
(function () {
    const SELF = document.body.dataset.app;
    if (!SELF) return;

    const OTHER = SELF === 'sdi' ? 'positioning' : 'sdi';
    const MSG = '__appSwitch';
    const framed = window.parent !== window;

    let frame = null;

    function tabs() {
        return document.querySelectorAll('[data-app-switch]');
    }

    function setActive(app) {
        tabs().forEach((el) => el.classList.toggle('active', el.dataset.appSwitch === app));
    }

    // 덮여 있는 동안 창 크기가 바뀌었을 수 있다. 다시 보일 때 한 번 알려준다.
    function refreshLayout() {
        requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
            if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') {
                map.invalidateSize();
            }
        });
    }

    function revealSelf() {
        if (frame) frame.classList.add('app-hidden');
        setActive(SELF);
        refreshLayout();
    }

    function showOther(url) {
        if (!url) return;
        if (!frame) {
            frame = document.createElement('iframe');
            frame.className = 'app-frame';
            frame.title = OTHER === 'sdi' ? 'SDI 검색' : '포지셔닝';
            frame.src = url;
            document.body.appendChild(frame);
        }
        frame.classList.remove('app-hidden');
        setActive(OTHER);
    }

    function askParent(to) {
        window.parent.postMessage({ [MSG]: to }, location.origin);
    }

    tabs().forEach((el) => {
        el.addEventListener('click', (event) => {
            const to = el.dataset.appSwitch;
            event.preventDefault();
            if (to === SELF) {
                if (framed) askParent(to); else revealSelf();
                return;
            }
            if (framed) {
                // 부모가 이 화면(=자식이 요청한 화면)을 이미 들고 있다.
                askParent(to);
                return;
            }
            showOther(el.getAttribute('href') || el.dataset.appUrl || '');
        });
    });

    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const to = event.data && event.data[MSG];
        if (!to) return;
        if (to === SELF) revealSelf();
    });
})();
