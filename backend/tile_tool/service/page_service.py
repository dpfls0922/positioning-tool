"""타일 조회 페이지를 만든다.

기존 툴과 같은 방식: CSS / JS 를 HTML 에 인라인해서 내려보낸다. 브라우저가
예전 조각을 캐시해 두는 문제를 아예 없애기 위해서다.
"""

import os

from backend.tile_tool.service.paths import (
    APP_SWITCH_CSS,
    APP_SWITCH_JS,
    BUILD_STAMP_FILE,
    TILE_ASSET_DIR,
    TILE_CSS,
    TILE_JS_FILES,
)


def _read(path):
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def build_stamp():
    """패키지로 받은 빌드면 언제 만든 것인지. 저장소에서 바로 돌리면 빈 값."""
    return _read(BUILD_STAMP_FILE).strip()


def load_script():
    parts = []
    for name in TILE_JS_FILES:
        body = _read(os.path.join(TILE_ASSET_DIR, name))
        if body:
            parts.append(f"/* ---- {name} ---- */\n{body}")
    return "\n\n".join(parts)


# positioning-tool 안에 마운트됐을 때만 두 화면을 오가는 탭을 보여준다.
# 단독 패키지로 떼어 가면 포지셔닝 화면이 없으므로 탭도 없다.
_APP_TABS = """<nav class="app-tabs">
      <a class="app-tab" href="/" data-app-switch="positioning">포지셔닝</a>
      <a class="app-tab active" href="{base}" data-app-switch="sdi">SDI 검색</a>
    </nav>"""


def render_page(base=""):
    """base 는 이 페이지가 붙어 있는 경로 접두어.

    단독 실행이면 "" 이고, positioning-tool 안에 마운트되면 "/sdi" 가 들어온다.
    프런트가 API 를 부를 때 이 값을 앞에 붙인다.
    """
    app_tabs = _APP_TABS.format(base=base) if base else ""
    # 마운트되면 positioning-tool 의 테마(기본 다크)를 따라가고, 단독으로 떼어
    # 가면 밝은 화면으로 연다. tile.css 가 두 팔레트를 다 들고 있다.
    theme = "" if base else ' data-theme="light"'
    stamp = build_stamp()
    build_line = f'<span class="build">빌드 {stamp}</span>' if stamp else ""
    # 화면 전환 자산은 탭이 있을 때만 심는다 — 단독 패키지로 떼어 가면 오갈
    # 상대 화면이 없다.
    app_switch_css = "<style>\n" + _read(APP_SWITCH_CSS) + "\n</style>" if base else ""
    app_switch_js = "<script>\n" + _read(APP_SWITCH_JS) + "\n</script>" if base else ""
    app_body_attr = ' data-app="sdi"' if base else ""
    return f"""<!DOCTYPE html>
<html lang="ko"{theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SDI 검색 — positioning map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
{_read(TILE_CSS)}
</style>
{app_switch_css}
</head>
<body{app_body_attr}>
<div id="app">
  <aside id="sidebar">
    <header class="side-head">
      <span id="brand">positioning map</span>
    </header>
    {app_tabs}

    <section class="card">
      <div class="search-row">
        <span class="search-icon"><i class="fa-solid fa-magnifying-glass"></i></span>
        <input id="searchBox" type="text" autocomplete="off" spellcheck="false"
               placeholder="37.5665,126.978 · t:27941,12690 · m:4787">
        <button id="searchBtn" type="button">조회</button>
      </div>
      <div id="searchError" class="error" hidden></div>
      <details id="searchHint" class="hint">
        <summary>입력 형식</summary>
        <dl class="hint-list">
          <dt><code>37.5665,126.978</code></dt><dd>위경도</dd>
          <dt><code>t:27941,12690</code></dt><dd>타일 인덱스</dd>
          <dt><code>t:1268927941</code></dt><dd>타일 id</dd>
          <dt><code>m:4787</code></dt><dd>메시 코드</dd>
          <dt><code>z:14</code></dt><dd>줌 지정 (덧붙임)</dd>
        </dl>
        <p class="hint-tip">지도를 클릭해도 그 타일이 조회됩니다.</p>
      </details>
    </section>

    <section id="targetCard" class="card" hidden>
      <div class="card-head">
        <h2>선택한 타일</h2>
        <button id="clearTargetBtn" type="button" class="link-btn">지우기</button>
      </div>
      <dl id="targetInfo" class="kv"></dl>
      <div id="vsmPointHint" class="point-hint" hidden></div>
      <div class="legend">
        <span class="legend-item">
          <span class="legend-pin"><img src="/static/img/sdi/SDI_SPEED_LIMIT_POS.png" alt=""></span>
          설치점
        </span>
        <span class="legend-item">
          <span class="legend-pin ahead"><img src="/static/img/sdi/SDI_SPEED_LIMIT_POS.png" alt=""></span>
          안내점
        </span>
        <button id="legendHelpBtn" type="button" class="link-btn" title="차이 설명">?</button>
      </div>
      <p id="legendHelp" class="note" hidden>
        <b>설치점</b>은 시설이 실제로 있는 자리로 제한속도가 붙습니다.
        <b>안내점</b>은 그 외 지점 — 카메라는 상류 예고점이 보통 2개 붙고,
        구간형(사고다발·CCTV 등)은 안내점만 있습니다.
      </p>
      <details id="targetDetail" class="hint">
        <summary>자세히</summary>
        <dl id="targetInfoMore" class="kv"></dl>
        <button id="copyTileBtn" type="button" class="ghost">타일 정보 복사</button>
      </details>
    </section>

    <details id="logSection" class="card fold">
      <summary>
        주행 로그 대조 <span class="opt">선택</span>
        <span id="logState" class="fold-state"></span>
      </summary>
      <div class="fold-body">
        <label id="dropZone" class="drop">
          <input id="logInput" type="file" accept=".dlt,.txt,.log" hidden>
          <i class="fa-solid fa-file-arrow-up"></i>
          <span id="dropLabel">DLT 로그를 올리면 단말이 실제로 쓴 SDI 와 대조합니다</span>
        </label>
        <div class="path-row">
          <input id="logPath" type="text" autocomplete="off" spellcheck="false"
                 placeholder="또는 로컬 경로: ~/Downloads/test0826.dlt">
          <button id="logPathBtn" type="button">읽기</button>
        </div>
        <div id="sdiSummary" class="summary" hidden></div>
        <button id="clearLogBtn" type="button" class="link-btn" hidden>지우기</button>
      </div>
    </details>

    <section id="sdiListCard" class="card grow" hidden>
      <h2>로그 SDI <span id="sdiCount" class="badge">0</span> <span class="opt">이 타일</span></h2>
      <div id="sdiList" class="sdi-list"></div>
    </section>

    <div class="spacer"></div>
    <footer class="src-line">
      <span id="vsmStatus"></span>
      {build_line}
    </footer>
  </aside>

  <main id="mapWrap">
    <div id="map"></div>
    <div id="layerBox">
      <div class="layer-group">SDI</div>
      <label><input type="checkbox" id="toggleVsmPoints" checked> SDI (메시 단위)</label>
      <label class="sub-opt"><input type="checkbox" id="toggleExactOnly"> 설치점만</label>
      <label><input type="checkbox" id="toggleSdiCells" checked> 셀 밀도</label>
      <label><input type="checkbox" id="toggleSdi" checked> 로그 SDI</label>
      <div class="layer-group">격자</div>
      <label><input type="checkbox" id="toggleTileGrid" checked> 타일</label>
      <label><input type="checkbox" id="toggleMeshGrid" checked> 메시</label>
      <label><input type="checkbox" id="toggleSdiTiles" checked> 로그 SDI 있는 타일</label>
    </div>
    <div id="cursorBox">
      <span class="cursor-line"><b>좌표</b> <span id="curLatLng">-</span></span>
      <span class="cursor-line"><b>타일</b> <span id="curTile">-</span></span>
      <span class="cursor-line"><b>메시</b> <span id="curMesh">-</span></span>
    </div>
  </main>
</div>
<script>
const TILE_API_BASE = {base!r};
{load_script()}
</script>
{app_switch_js}
</body>
</html>
"""
