#!/usr/bin/env python3
"""SDI 타일 조회 툴.

    python3 run.py                     웹 UI (http://127.0.0.1:5002)
    python3 run.py 37.5665,126.978     터미널에서 바로 조회
    python3 run.py m:4787 --html a.html  단독 HTML 로 저장
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.tile_tool.cli import main

if __name__ == "__main__":
    main()
