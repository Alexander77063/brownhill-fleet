# /tmp/sock-trace.sh
echo "=== current full process args ==="
pm2 jlist | python3 -c "import json,sys; d=json.load(sys.stdin); print('pid:', d[0]['pid']); print('cwd:', d[0]['pm2_env'].get('pm_cwd')); print('args:', d[0]['pm2_env'].get('args')); print('node_args:', d[0]['pm2_env'].get('node_args')); print('exec_mode:', d[0]['pm2_env'].get('exec_mode')); print('unstable_restarts:', d[0].get('unstable_restarts')); print('restart_time:', d[0]['pm2_env'].get('restart_time')); print('status:', d[0]['pm2_env'].get('status'))"

echo "=== TCP connect probe from box ==="
for i in 1 2 3 4 5; do
  date '+%H:%M:%S'
  timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/55431 && echo connected || echo failed'
done

echo "=== ss states ==="
ss -tn 2>&1 | head -10
echo
ss -s 2>&1 | head -10

echo "=== FDs of brownhill-next ==="
PID=$(pm2 jlist | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['pid'])")
echo "PID=$PID"
ls -la /proc/$PID/fd/ 2>/dev/null | grep socket | head -20
echo "..."
ls -la /proc/$PID/fd/ 2>/dev/null | grep socket | wc -l
