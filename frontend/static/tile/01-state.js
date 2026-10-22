// 앱 전역 상태. 조각 파일들이 하나의 <script> 로 이어붙여지므로 여기 선언한
// 것은 이후 조각에서 그대로 보인다.
const TILE_ZOOM_DEFAULT = 15;

let map = null;
let tileGridLayer = null;     // 화면에 보이는 z15 타일 격자
let meshGridLayer = null;     // 화면에 보이는 메시 격자
let sdiTileLayer = null;      // SDI 가 들어 있는 타일 강조
let sdiMarkerLayer = null;    // SDI 마커
let targetLayer = null;       // 조회한 타일 / 메시 강조

let currentTarget = null;     // /api/resolve 응답
let currentCell = null;       // 조회한 타일이 속한 SDI 셀
let sdiSummary = null;        // 업로드한 로그의 SDI 요약
let allSdiPoints = [];        // 지도 전체에 뿌리는 SDI

// 이 페이지가 붙어 있는 경로 접두어. 단독 실행이면 "", positioning-tool 안에
// 마운트되면 "/sdi". 페이지가 인라인으로 먼저 선언해 둔다.
const API_BASE = typeof TILE_API_BASE === 'string' ? TILE_API_BASE : '';

const $ = (id) => document.getElementById(id);

function fmtNum(value) {
    return Number(value).toLocaleString('ko-KR');
}

async function getJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({ ok: false, error: '응답을 읽지 못했습니다.' }));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || `요청 실패 (${response.status})`);
    }
    return data;
}
