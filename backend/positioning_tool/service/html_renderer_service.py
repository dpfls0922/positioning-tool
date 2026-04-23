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
        <link rel="stylesheet" href="./static/css/map.css?v={static_version}" type="text/css">
        """
    ).strip()


def build_html_body():
    return dedent(
        f"""
        <div id="map"></div>
        {add_right_toolbar()}
        {add_upload_panel()}
        {add_distance_tool()}
        {add_radius_tool()}
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
            <span>파일 업로드/파싱</span>
            <button class="panel-close-btn" data-close-panel="uploadPanel">닫기</button>
        </div>
        <div class="tool-panel-body">
            <div class="upload-card">
                <div class="upload-subtitle">DLT 로그</div>
                <input id="logFileInput" type="file" accept=".txt,.log,.dlt">
                <button id="parseUploadButton">업로드 후 파싱</button>
                <input id="issueIdInput" type="text" placeholder="이슈번호(예: TAMB-16753)">
                <button id="exportHtmlButton" disabled>Export HTML</button>
            </div>
            <div class="upload-card">
                <div class="upload-subtitle">도로 링크/노드 Shape</div>
                <div id="roadShapeStateText" class="road-shape-state">저장된 파일 없음</div>
                <input id="shpFolderInput" type="file" webkitdirectory directory multiple>
                <div class="shp-zoom-config">
                    <label for="shpMinZoomInput">표시 시작 줌</label>
                    <input id="shpMinZoomInput" type="number" min="0" max="22" step="1" value="16">
                </div>
                <button id="parseShpButton">SHP 폴더 업로드</button>
                <button id="clearShpButton" class="secondary-btn">저장된 Shape 삭제</button>
            </div>
            <div id="uploadStatusText">대기 중</div>
            <div id="uploadProgressWrap"><div id="uploadProgressBar"></div></div>
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
            </div>
            <div id="radiusResult">반경 결과: -</div>
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
            <button class="tool-btn" id="toolDistanceBtn" title="거리 재기"><i class="fa fa-arrows-h"></i></button>
            <button class="tool-btn" id="toolRadiusBtn" title="반경 재기"><i class="fa fa-circle-o"></i></button>
        </div>
        <div class="tool-stack" id="utilityGroup">
            <button class="tool-btn" id="toolUploadBtn" title="업로드/파싱"><i class="fa fa-upload"></i></button>
            <button class="tool-btn" id="toolPlaybackBtn" title="타임라인"><i class="fa fa-clock-o"></i></button>
            <button class="tool-btn" id="toolLegendBtn" title="범례"><i class="fa fa-list"></i></button>
        </div>
    </div>
    """
