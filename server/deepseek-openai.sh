#!/bin/bash
LOGFILE="server/deepseek-openai.log"
DEFAULT_PORT=${PORT:-8899}
DEFAULT_HOST=${HOST:-127.0.0.1}

start() {
  if pgrep -f "deepseek-openai.ts" > /dev/null; then
    echo "服务已在运行"
    return 1
  fi
  nohup npx tsx "$(dirname "$0")/bin/deepseek-openai.ts" serve --host "$DEFAULT_HOST" --port "$DEFAULT_PORT" >> "$LOGFILE" 2>&1 &
  echo "服务已启动在 http://${DEFAULT_HOST}:${DEFAULT_PORT} (PID: $!)"
}

stop() {
  pkill -f "deepseek-openai.ts" && echo "服务已停止" || echo "服务未在运行"
}

restart() { stop; sleep 1; start; }

status() {
  pgrep -f "deepseek-openai.ts" > /dev/null && echo "运行中" || echo "未运行"
}

logs() { tail -f "$LOGFILE"; }

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  logs)    logs ;;
  *)       echo "用法: $0 {start|stop|restart|status|logs}" ;;
esac
