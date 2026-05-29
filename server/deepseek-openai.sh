#!/bin/bash
LOGFILE="server/deepseek-openai.log"
DEFAULT_PORT=${PORT:-8899}
DEFAULT_HOST=${HOST:-127.0.0.1}
SCRIPT_DIR="$(dirname "$0")"

if command -v bun &> /dev/null; then
  RUNNER="bun run ./${SCRIPT_DIR}/bin/deepseek-openai.ts"
else
  RUNNER="npx tsx ${SCRIPT_DIR}/bin/deepseek-openai.ts"
fi

start() {
  if pgrep -f "deepseek-openai.ts" > /dev/null; then
    echo "服务已在运行"
    return 1
  fi
  nohup $RUNNER serve --host "$DEFAULT_HOST" --port "$DEFAULT_PORT" "$@" >> "$LOGFILE" 2>&1 &
  echo "服务已启动在 http://${DEFAULT_HOST}:${DEFAULT_PORT} (PID: $!)"
}

stop() {
  pkill -f "deepseek-openai.ts" && echo "服务已停止" || echo "服务未在运行"
}

restart() { stop; sleep 1; start "$@"; }

status() {
  pgrep -f "deepseek-openai.ts" > /dev/null && echo "运行中" || echo "未运行"
}

logs() { tail -f "$LOGFILE"; }

case "${1:-}" in
  start)   shift; start "$@" ;;
  stop)    stop ;;
  restart) shift; restart "$@" ;;
  status)  status ;;
  logs)    logs ;;
  *)       echo "用法: $0 {start|stop|restart|status|logs} [--debug]" ;;
esac
