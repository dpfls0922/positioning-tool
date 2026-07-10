import json
import os
import time
from textwrap import dedent

from backend.positioning_tool.service.paths import PATHS


def render_html(markers_data=None, lines_data=None):
    markers_data = markers_data or []
    lines_data = lines_data or []

    head = build_html_head(int(time.time()))
    body = build_html_body()
    script_content = load_file_content(PATHS.js_file)
    data_vars = init_data_vars(markers_data, lines_data)

    html = dedent(
        f"""
        <!DOCTYPE html>
        <html lang="ko">
        <head>{head}</head>
        <body>
        <div id="container">
            <div id="sidebar" class="open">
                <div id="sidebar-header">
                    <span id="sidebar-brand">positioning map</span>
                </div>
                <div id="sidebar-search">
                    <div class="search-group search-group-full">
                        <input id="searchBox" type="text" placeholder="DLT ID 검색">
                        <button id="searchButton">DLT 검색</button>
                    </div>
                    <div class="search-group search-group-full">
                        <input id="idSearchBox" type="text" placeholder="Marker/Line ID 검색">
                        <button id="idSearchButton">ID 검색</button>
                    </div>
                    <div class="search-group search-group-full">
                        <input id="latLonSearchBox" type="text" placeholder="Lat, Lon 검색">
                        <button id="latLonSearchButton">좌표 검색</button>
                    </div>
                    <div class="search-group search-group-full">
                        <input id="ridSearchBox" type="text" placeholder="RID / LINK_ID 검색">
                        <button id="ridSearchButton">RID 검색</button>
                    </div>
                    <div class="search-group search-group-full">
                        <input id="requestIdSearchBox" type="text" placeholder="Request ID 검색 (예: 10000011)">
                        <button id="requestIdSearchButton">경로 검색</button>
                    </div>
                    <div class="interaction-mode-group">
                        <button id="markerInspectModeButton" class="interaction-mode-btn active" type="button">마커 클릭</button>
                        <button id="roadInspectModeButton" class="interaction-mode-btn" type="button">Road 클릭</button>
                    </div>
                </div>
                <div id="sidebar-result-header">
                    <span id="sidebar-title">검색 결과</span>
                </div>
                <div id="sidebar-filter">
                    <div class="filter-title">레이어 관리</div>
                    <div id="layerControlList"></div>
                </div>
                <div id="infoPanel"></div>
                <button id="btnCloseSidebar" title="접기/펼치기">◀</button>
            </div>
            <div id="main-content">
                {body}
            </div>
        </div>
        <script>
        {data_vars}
        {script_content}
        init();
        </script>
        </body>
        </html>
        """
    ).strip()
    return html


def write_html_file(markers_data=None, lines_data=None, out_path=None):
    out_path = out_path or PATHS.output_html
    html = render_html(markers_data, lines_data)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as file:
        file.write(html)


def build_html_head(static_version):
    return dedent(
        f"""
        <meta charset="UTF-8">
        <title>포지셔닝 시각화</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.css">
        <script src="https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.js"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css" />
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/Leaflet.awesome-markers/2.0.2/leaflet.awesome-markers.css" />
        <script src="https://cdnjs.cloudflare.com/ajax/libs/Leaflet.awesome-markers/2.0.2/leaflet.awesome-markers.min.js"></script>
        <script src="https://unpkg.com/shpjs@latest/dist/shp.min.js"></script>
        <script src="./static/js/tmap_coord.js?v={static_version}"></script>
        <script src="./static/js/tmap_tvas_parser.js?v={static_version}"></script>
        <link rel="stylesheet" href="./static/css/map.css?v={static_version}" type="text/css">
        <style>
        /* ===== 새 업로드 패널 UI ===== */
        .upload-section {{ margin-bottom: 10px; }}
        .upload-section-label {{
            font-size: 11px; font-weight: 600; color: #334155;
            text-transform: uppercase; letter-spacing: .04em;
            display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
        }}
        .upload-hint {{
            font-size: 10px; color: #475569; font-weight: 400;
            text-transform: none; letter-spacing: 0;
        }}
        .upload-divider {{
            border: none; border-top: 1px solid #dbe3ef; margin: 10px 0;
        }}
        .drop-zone {{
            display: flex; align-items: center; justify-content: center;
            flex-direction: column; gap: 4px;
            border: 1.5px dashed #cbd5e1; border-radius: 8px;
            padding: 10px 8px; cursor: pointer; transition: border-color .18s, background .18s;
            background: #f8fafc; min-height: 52px; box-sizing: border-box;
        }}
        .drop-zone:hover {{ border-color: #3b82f6; background: #eef2ff; }}
        .drop-zone-icon {{ font-size: 16px; color: #334155; }}
        .drop-zone-text {{ font-size: 11px; color: #334155; text-align: center; line-height: 1.3; }}
        .drop-zone-text-sm {{ font-size: 10px; color: #475569; text-align: center; line-height: 1.3; }}
        .drop-zone-badge {{
            font-size: 10px; font-weight: 700; padding: 1px 6px;
            border-radius: 4px; margin-bottom: 2px;
        }}
        .drop-zone-badge-link {{ background: #dbeafe; color: #1d4ed8; }}
        .drop-zone-badge-node {{ background: #e2e8f0; color: #334155; }}
        .shape-upload-row {{
            display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;
        }}
        .drop-zone-half {{ min-height: 58px; }}
        .shape-btn-row {{
            display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;
        }}
        .upload-action-btn {{
            width: 100%; padding: 7px 0; font-size: 12px; font-weight: 600;
            background: #2563eb; color: #fff; border: none; border-radius: 6px;
            cursor: pointer; transition: background .15s;
        }}
        .upload-action-btn:hover {{ background: #3b82f6; }}
        .upload-action-btn:disabled {{ background: #93c5fd; cursor: not-allowed; color: #ffffff; }}
        .upload-action-half {{ width: 100%; }}
        .upload-clear-btn {{
            width: 100%; padding: 6px 0; font-size: 11px; font-weight: 500;
            background: #fff; color: #ef4444; border: 1px solid #ef4444;
            border-radius: 6px; cursor: pointer; transition: background .15s;
        }}
        .upload-clear-btn:hover {{ background: #fef2f2; }}
        .road-shape-state-bar {{
            font-size: 10px; color: #334155; padding: 4px 6px;
            background: #eff6ff; border-radius: 5px; margin-bottom: 7px;
            border-left: 2px solid #3b82f6; line-height: 1.4;
        }}
        .upload-status-text {{
            font-size: 10px; color: #475569; margin-top: 8px; padding: 0 2px;
        }}
        /* ===== Progress bar — indeterminate shimmer ===== */
        @keyframes shimmer {{
            0%   {{ background-position: -400px 0; }}
            100% {{ background-position: 400px 0; }}
        }}
        @keyframes progress-pulse {{
            0%,100% {{ opacity: 1; }}
            50%      {{ opacity: .65; }}
        }}
        #uploadProgressWrap {{
            height: 5px; border-radius: 3px; background: #dbeafe;
            margin-top: 6px; overflow: hidden;
        }}
        #uploadProgressBar {{
            height: 100%; width: 0; border-radius: 3px;
            background: #3b82f6; transition: width .25s ease;
        }}
        #uploadProgressBar.progress-active {{
            background: linear-gradient(90deg,
                #2563eb 0%, #60a5fa 40%, #2563eb 60%, #60a5fa 100%);
            background-size: 400px 100%;
            animation: shimmer 1.2s linear infinite;
        }}
        #uploadProgressBar.progress-indeterminate {{
            width: 100% !important;
            background: linear-gradient(90deg,
                #bfdbfe 0%, #3b82f6 30%, #60a5fa 50%, #3b82f6 70%, #bfdbfe 100%);
            background-size: 400px 100%;
            animation: shimmer 1.4s linear infinite, progress-pulse 2s ease-in-out infinite;
        }}

        /* ===== 레이어 우클릭 컨텍스트 메뉴 ===== */
        .layer-ctx-trigger {{
            background: none; border: none; color: #64748b; cursor: pointer;
            padding: 2px 4px; font-size: 11px; border-radius: 3px; margin-left: 2px;
        }}
        .layer-ctx-trigger:hover {{ color: #2563eb; background: #eff6ff; }}
        .layer-ctx-menu {{
            position: fixed; z-index: 9999; min-width: 270px; max-width: 320px;
            background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px;
            padding: 12px; box-shadow: 0 8px 20px rgba(15, 23, 42, .15);
        }}
        .layer-ctx-menu.hidden {{ display: none; }}
        .layer-ctx-title {{
            font-size: 12px; font-weight: 700; color: #1f2937;
            margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #dbe3ef;
        }}
        .layer-ctx-subtitle {{
            font-size: 10px; font-weight: 600; color: #475569;
            text-transform: uppercase; letter-spacing: .04em; margin: 8px 0 5px;
        }}
        .layer-ctx-row {{
            display: flex; align-items: center; gap: 5px; margin-bottom: 5px; flex-wrap: wrap;
        }}
        .layer-ctx-input {{
            flex: 1; min-width: 0; padding: 5px 7px; font-size: 11px;
            background: #fff; border: 1px solid #cbd5e1; border-radius: 5px;
            color: #1f2937;
        }}
        .layer-ctx-color {{
            width: 30px; height: 28px; padding: 1px; border-radius: 4px;
            border: 1px solid #cbd5e1; cursor: pointer; background: #fff;
        }}
        .layer-ctx-weight {{
            width: 54px; padding: 5px 5px; font-size: 11px;
            background: #fff; border: 1px solid #cbd5e1; border-radius: 5px;
            color: #1f2937;
        }}
        .layer-ctx-label {{
            font-size: 10px; color: #64748b; white-space: nowrap;
        }}
        .layer-ctx-btn {{
            padding: 5px 10px; font-size: 11px; font-weight: 600;
            background: #2563eb; color: #fff; border: none; border-radius: 5px; cursor: pointer;
        }}
        .layer-ctx-btn:hover {{ background: #3b82f6; }}
        .layer-ctx-close {{
            margin-top: 10px; width: 100%; padding: 5px 0; font-size: 11px;
            background: #fff; border: 1px solid #cbd5e1; border-radius: 5px;
            color: #475569; cursor: pointer;
        }}
        .layer-ctx-close:hover {{ background: #eff6ff; }}

        /* ===== Tmap route panel ===== */
        .route-waypoint-bar {{
            min-height: 34px; padding: 8px; border: 1px solid #dbe3ef; border-radius: 8px;
            background: #f8fafc; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start;
        }}
        .route-waypoint-empty {{
            font-size: 11px; color: #64748b; line-height: 1.5;
        }}
        .route-wp-chip {{
            display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px;
            border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid transparent;
        }}
        .route-wp-chip button {{
            border: none; background: transparent; cursor: pointer; font-size: 13px; line-height: 1;
            padding: 0; color: inherit;
        }}
        .route-wp-chip-start {{ background: rgba(34, 197, 94, 0.14); color: #15803d; border-color: rgba(34, 197, 94, 0.28); }}
        .route-wp-chip-via {{ background: rgba(245, 158, 11, 0.14); color: #b45309; border-color: rgba(245, 158, 11, 0.28); }}
        .route-wp-chip-dest {{ background: rgba(239, 68, 68, 0.14); color: #b91c1c; border-color: rgba(239, 68, 68, 0.28); }}
        .route-panel-note {{
            font-size: 11px; color: #64748b; line-height: 1.45; margin-bottom: 8px;
        }}
        .route-panel-grid {{
            display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;
        }}
        .route-panel-grid .route-panel-col {{
            display: flex; flex-direction: column; gap: 4px;
        }}
        .route-panel-grid label {{
            font-size: 11px; color: #475569; font-weight: 600;
        }}
        .route-panel-grid input,
        .route-panel-grid select {{
            width: 100%; box-sizing: border-box; padding: 7px 8px; font-size: 12px;
            border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #1f2937;
        }}
        .route-panel-status {{
            font-size: 11px; color: #475569; margin-top: 8px; line-height: 1.45; white-space: pre-wrap;
        }}
        </style>
        """
    ).strip()


def build_html_body():
    return dedent(
        f"""
        <div id="map"></div>
        {add_right_toolbar()}
        {add_upload_panel()}
        {add_export_panel()}
        {add_route_tool()}
        {add_distance_tool()}
        {add_radius_tool()}
        {add_marker_table_panel()}
        {add_playback_tool()}
        {add_legend()}
        <div id="toolBackdrop"></div>
        """
    ).strip()


def load_file_content(filepath):
    try:
        with open(filepath, "r", encoding="utf-8") as file:
            return file.read()
    except FileNotFoundError:
        return ""


def init_data_vars(markers_data, lines_data):
    valid_ids = [data["id"] for data in markers_data if data.get("id") is not None]
    max_id = max(valid_ids) if valid_ids else 1

    min_ts = min((data.get("timestamp_ms") for data in markers_data if data.get("timestamp_ms") is not None), default=0)
    max_ts = max((data.get("timestamp_ms") for data in markers_data if data.get("timestamp_ms") is not None), default=1)

    markers_json = json.dumps(markers_data)
    lines_json = json.dumps(lines_data)

    return dedent(
        f"""
        let markersData = {markers_json};
        let linesData = {lines_json};
        let minTs = {min_ts};
        let maxTs = {max_ts};
        let maxId = {max_id};
        """
    ).strip()


def add_playback_tool():
    return """
    <div id="playbackPanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>타임라인</span>
            <button class="panel-close-btn" data-close-panel="playbackPanel">닫기</button>
        </div>
        <div class="tool-panel-body">
            <div class="playback-controls">
                <div id="slider"></div>
                <span id="rangeLabel">00:00:00.000 ~ 00:00:00.000</span>
            </div>
        </div>
    </div>
    """


def add_upload_panel():
    return """
    <div id="uploadPanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>파일 업로드</span>
            <button class="panel-close-btn" data-close-panel="uploadPanel">닫기</button>
        </div>
        <div class="tool-panel-body">

            <div class="upload-section">
                <div class="upload-section-label">
                    <i class="fa fa-file-text-o"></i> DLT 로그
                </div>
                <label class="drop-zone" id="logDropZone">
                    <input id="logFileInput" type="file" accept=".txt,.log,.dlt" style="display:none">
                    <i class="fa fa-upload drop-zone-icon"></i>
                    <span id="logFileNameText" class="drop-zone-text">파일 선택 또는 드래그</span>
                </label>
                <button id="parseUploadButton" class="upload-action-btn">파싱 시작</button>
            </div>

            <div class="upload-divider"></div>

            <div class="upload-section">
                <div class="upload-section-label">
                    <i class="fa fa-map-o"></i> Road Shape
                    <span class="upload-hint">브라우저 로컬 파싱(.shp/.shx/.dbf 폴더), 레이어 우클릭으로 스타일 설정</span>
                </div>
                <div id="roadShapeStateText" class="road-shape-state-bar">저장된 파일 없음</div>
                <div class="shape-upload-row">
                    <label class="drop-zone drop-zone-half" id="linkDropZone">
                        <input id="linkShpFolderInput" type="file" webkitdirectory directory multiple style="display:none">
                        <span class="drop-zone-badge drop-zone-badge-link">Link</span>
                        <span id="linkShpFileText" class="drop-zone-text-sm">폴더 선택</span>
                    </label>
                    <label class="drop-zone drop-zone-half" id="nodeDropZone">
                        <input id="nodeShpFolderInput" type="file" webkitdirectory directory multiple style="display:none">
                        <span class="drop-zone-badge drop-zone-badge-node">Node</span>
                        <span id="nodeShpFileText" class="drop-zone-text-sm">폴더 선택</span>
                    </label>
                </div>
                <div class="shape-btn-row">
                    <button id="parseLinkShpButton" class="upload-action-btn upload-action-half">링크 업로드</button>
                    <button id="parseNodeShpButton" class="upload-action-btn upload-action-half">노드 업로드</button>
                </div>
                <button id="clearShpButton" class="upload-clear-btn">
                    <i class="fa fa-trash-o"></i> 저장된 Shape 삭제
                </button>
            </div>

            <div id="uploadStatusText" class="upload-status-text">대기 중</div>
            <div id="uploadProgressWrap"><div id="uploadProgressBar"></div></div>
        </div>
    </div>

    <!-- 레이어 우클릭 컨텍스트 메뉴 -->
    <div id="layerContextMenu" class="layer-ctx-menu hidden">
        <div class="layer-ctx-title" id="layerCtxTitle">레이어 스타일</div>
        <div id="layerCtxLinkSection">
            <div class="layer-ctx-subtitle">링크 스타일 규칙 추가</div>
            <div class="layer-ctx-row">
                <select id="linkStylePropSelect" class="layer-ctx-input">
                    <option value="">필드 선택</option>
                </select>
                <input id="linkStyleValueInput" type="text" placeholder="값 (예: 10)" class="layer-ctx-input">
            </div>
            <div class="layer-ctx-row">
                <input id="linkStyleColorInput" type="color" value="#8b5cf6" title="선 색상" class="layer-ctx-color">
                <input id="linkStyleWeightInput" type="number" min="0.5" max="12" step="0.1" value="2.1" title="선 두께" class="layer-ctx-weight" placeholder="두께">
                <button id="addLinkStyleRuleButton" class="layer-ctx-btn">규칙 추가</button>
            </div>
            <div id="linkStyleRuleList" class="style-rule-list"></div>
            <div id="linkBaseRuleEditor" class="style-rule-list"></div>
        </div>
        <div id="layerCtxNodeSection">
            <div class="layer-ctx-subtitle">노드 스타일</div>
            <div class="layer-ctx-row">
                <label class="layer-ctx-label">색상</label>
                <input id="nodeColorInput" type="color" value="#22c3d6" class="layer-ctx-color">
                <label class="layer-ctx-label">외곽</label>
                <input id="nodeStrokeInput" type="color" value="#0f8aa6" class="layer-ctx-color">
                <label class="layer-ctx-label">크기</label>
                <input id="nodeRadiusInput" type="number" min="1" max="12" step="0.1" value="3.2" class="layer-ctx-weight">
                <label class="layer-ctx-label">두께</label>
                <input id="nodeWeightInput" type="number" min="0" max="5" step="0.1" value="1" class="layer-ctx-weight">
            </div>
            <button id="applyNodeStyleButton" class="layer-ctx-btn">노드 스타일 적용</button>
        </div>
        <button class="layer-ctx-close" id="layerCtxClose">닫기</button>
    </div>
    """


def add_export_panel():
    return """
    <div id="exportPanel" class="tool-panel export-panel hidden">
        <div class="tool-panel-header">
            <span>내보내기</span>
            <button class="panel-close-btn" data-close-panel="exportPanel">닫기</button>
        </div>
        <div class="tool-panel-body export-panel-body">
            <input id="issueIdInput" type="text" placeholder="이슈번호(예: TAMB-16753)">
            <button id="exportHtmlMenuButton" class="menu-action-btn" disabled>
                <i class="fa fa-file-text-o"></i><span>HTML 내보내기</span>
            </button>
            <button id="exportCsvMenuButton" class="menu-action-btn" disabled>
                <i class="fa fa-file-excel-o"></i><span>CSV 내보내기</span>
            </button>
        </div>
    </div>
    """


def add_route_tool():
    return """
    <div id="routePanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>경로 요청</span>
            <button class="panel-close-btn" data-close-panel="routePanel">닫기</button>
        </div>
        <div class="tool-panel-body">
            <div class="route-panel-note">
                지도 우클릭으로 출발지, 경유지, 목적지를 선택하고 Tmap 경로 요청을 보냅니다.
            </div>
            <div id="routeWaypointBar" class="route-waypoint-bar">
                <span class="route-waypoint-empty">지도 우클릭으로 경로점을 지정하세요.</span>
            </div>
            <div class="route-panel-grid">
                <div class="route-panel-col">
                    <label for="tmapAppKeyInput">TMAP_ACCESS_KEY</label>
                    <input id="tmapAppKeyInput" type="password" placeholder="TMAP_ACCESS_KEY 입력">
                </div>
                <div class="route-panel-col">
                    <label for="tmapRouteOptionSelect">경로 옵션</label>
                    <select id="tmapRouteOptionSelect">
                        <option value="0">교통최적+추천</option>
                        <option value="1">교통최적+무료우선</option>
                        <option value="2">교통최적+최소시간</option>
                        <option value="3">교통최적+초보</option>
                    </select>
                </div>
            </div>
            <div class="shape-btn-row" style="margin-top:10px;">
                <button id="tmapRouteRequestButton" class="upload-action-btn upload-action-half">경로 요청</button>
                <button id="tmapRouteClearButton" class="upload-clear-btn">경로/선택 초기화</button>
            </div>
            <div id="tmapRouteStatus" class="route-panel-status">대기 중</div>
        </div>
    </div>
    """


def add_distance_tool():
    return """
    <div id="distancePanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>거리 재기</span>
            <button class="panel-close-btn" data-close-panel="distancePanel">닫기</button>
        </div>
        <div class="tool-panel-body" id="distancePanelBody">
            <div class="distance-pick">
                <select id="distanceMode">
                    <option value="map">지도 점 거리</option>
                    <option value="marker">마커 거리</option>
                </select>
                <button id="distancePickToggle">선택 시작</button>
                <button id="distancePickReset">초기화</button>
            </div>
            <div class="distance-inputs">
                <input id="lat1Input" type="text" placeholder="Lat1">
                <input id="lon1Input" type="text" placeholder="Lon1">
                <input id="lat2Input" type="text" placeholder="Lat2">
                <input id="lon2Input" type="text" placeholder="Lon2">
                <button id="distanceCalcInput">거리 계산</button>
            </div>
            <div id="distanceResult">거리 결과: -</div>
        </div>
    </div>
    """


def add_radius_tool():
    return """
    <div id="radiusPanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>반경 재기</span>
            <button class="panel-close-btn" data-close-panel="radiusPanel">닫기</button>
        </div>
        <div class="tool-panel-body">
            <div class="distance-pick">
                <select id="radiusMode">
                    <option value="map">지도 중심</option>
                    <option value="marker">마커 중심</option>
                </select>
                <button id="radiusPickToggle">중심 선택</button>
            </div>
            <div class="distance-inputs">
                <input id="radiusLatInput" type="text" placeholder="Center Lat">
                <input id="radiusLonInput" type="text" placeholder="Center Lon">
                <input id="radiusMeterInput" type="text" placeholder="Radius(m)">
                <button id="radiusApplyButton">반경 적용</button>
                <button id="radiusResetButton">초기화</button>
            </div>
            <div id="radiusResult">반경 결과: -</div>
        </div>
    </div>
    """


def add_marker_table_panel():
    return """
    <div id="markerTablePanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>마커 테이블</span>
            <button class="panel-close-btn" data-close-panel="markerTablePanel">닫기</button>
        </div>
        <div class="tool-panel-body marker-table-panel-body">
            <div class="marker-table-toolbar">
                <select id="markerTableTypeSelect"></select>
                <input id="markerTableSearchInput" type="text" placeholder="ID, DLT, 시간, 값 검색">
            </div>
            <div id="markerTableSummary" class="marker-table-summary">데이터 없음</div>
            <div class="marker-table-wrap">
                <table class="marker-table">
                    <thead id="markerTableHead"></thead>
                    <tbody id="markerTableBody"></tbody>
                </table>
            </div>
        </div>
    </div>
    """


def add_legend():
    return """
    <div id="legendPanel" class="tool-panel hidden">
        <div class="tool-panel-header">
            <span>범례</span>
            <button class="panel-close-btn" data-close-panel="legendPanel">닫기</button>
        </div>
        <div class="tool-panel-body legend-list">
            <div class="legend-toggle-card">
                <label class="legend-toggle-label" for="drHeadingToggle">
                    <input id="drHeadingToggle" type="checkbox">
                    <span>DR Heading 화살표 표시</span>
                </label>
            </div>
            <div><i style="background:purple; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> Raw GNSS</div>
            <div><i style="background:yellow; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> Filtered GNSS</div>
            <div><i style="background:orange; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> GNSS-based</div>
            <div><i style="background:red; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> DR-based</div>
            <div><i style="background:cyan; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> Road Match</div>
            <div><i style="background:lime; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> Route Match</div>
            <div><i style="background:blue; width:10px; height:10px; display:inline-block; border-radius:50%;"></i> VPM</div>
            <div><img src="https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-grey.png" style="width:10px; height:15px; display:inline-block;"> Request</div>
        </div>
    </div>
    """


def add_right_toolbar():
    return """
    <div id="rightToolbar">
        <div class="tool-stack" id="zoomGroup">
            <button class="tool-btn tool-zoom-btn" id="toolZoomInBtn" title="확대"><i class="fa fa-plus"></i></button>
            <button class="tool-btn tool-zoom-btn" id="toolZoomOutBtn" title="축소"><i class="fa fa-minus"></i></button>
        </div>
        <div class="tool-stack" id="measureGroup">
            <button class="tool-btn" id="toolRouteBtn" title="경로 요청"><i class="fa fa-code-fork"></i></button>
            <button class="tool-btn" id="toolDistanceBtn" title="거리 재기"><i class="fa fa-arrows-h"></i></button>
            <button class="tool-btn" id="toolRadiusBtn" title="반경 재기"><i class="fa fa-circle-o"></i></button>
        </div>
        <div class="tool-stack" id="utilityGroup">
            <button class="tool-btn" id="toolUploadBtn" title="업로드/파싱"><i class="fa fa-upload"></i></button>
            <button class="tool-btn" id="toolExportBtn" title="내보내기"><i class="fa fa-share-square-o"></i></button>
            <button class="tool-btn" id="toolMarkerTableBtn" title="마커 테이블"><i class="fa fa-table"></i></button>
            <button class="tool-btn" id="toolPlaybackBtn" title="타임라인"><i class="fa fa-clock-o"></i></button>
            <button class="tool-btn" id="toolLegendBtn" title="범례"><i class="fa fa-list"></i></button>
        </div>
    </div>
    """
