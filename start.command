#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  Claude Code Web UI 시작 중..."
echo ""

MARKER=".server_started"

# Check if server is already running on port 8321
if lsof -ti:8321 >/dev/null 2>&1; then
    NEEDS_RESTART=false
    if [ -f "$MARKER" ]; then
        SERVER_MOD=$(stat -f %m server.py 2>/dev/null)
        MARKER_MOD=$(stat -f %m "$MARKER" 2>/dev/null)
        if [ -n "$SERVER_MOD" ] && [ -n "$MARKER_MOD" ] && [ "$SERVER_MOD" -gt "$MARKER_MOD" ]; then
            NEEDS_RESTART=true
        fi
    fi
    if [ "$NEEDS_RESTART" = true ]; then
        echo "  코드가 변경되었습니다. 서버를 재시작합니다..."
        kill "$(lsof -ti:8321)" 2>/dev/null
        sleep 0.5
    else
        echo "  이미 실행 중입니다. 브라우저를 열겠습니다."
        open http://127.0.0.1:8321
        exit 0
    fi
fi

# Server is not running — start it
touch "$MARKER"
open http://127.0.0.1:8321 &
python3 server.py
