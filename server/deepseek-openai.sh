#!/bin/bash
PIDFILE="server/.deepseek-openai.pid"
LOGFILE="server/deepseek-openai.log"
DEFAULT_PORT=${PORT:-8899}
DEFAULT_HOST=${HOST:-127.0.0.1}

start() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "服务已在运行 (PID: $(cat $PIDFILE))"
    return 1
  fi
  nohup node --import tsx server/bin/deepseek-openai.ts serve --host "$DEFAULT_HOST" --port "$DEFAULT_PORT" >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "服务已启动在 http://${DEFAULT_HOST}:${DEFAULT_PORT} (PID: $!)"
}

stop() {
  if [ -f "$PIDFILE" ]; then
    kill $(cat "$PIDFILE") 2>/dev/null && echo "服务已停止" || echo "服务未在运行"
    rm -f "$PIDFILE"
  else
    echo "PID 文件不存在"
  fi
}

restart() { stop; sleep 1; start; }
status() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "运行中 (PID: $(cat $PIDFILE))"
  else
    echo "未运行"
  fi
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
