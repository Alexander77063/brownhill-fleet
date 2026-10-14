# /tmp/ipt-fix.sh — drop the bad iptables rule + restart brownhill-next + smoke
echo "=== BEFORE rules ==="
iptables -L INPUT -n -v 2>&1 | head -5
echo
echo "=== kill any orphan direct node process ==="
DIRECT_PID=$(cat /tmp/direct-pid.txt 2>/dev/null)
if [ -n "$DIRECT_PID" ]; then
  kill "$DIRECT_PID" 2>/dev/null
fi
sleep 1
echo
echo "=== delete the DROP rule on 55431 ==="
iptables -D INPUT -p tcp --dport 55431 -j DROP 2>&1
echo "=== delete the now-dead ACCEPT rule ==="
iptables -D INPUT -s 127.0.0.1/32 -p tcp --dport 55431 -j ACCEPT 2>&1
echo
echo "=== AFTER ==="
iptables -L INPUT -n -v 2>&1 | head
echo
echo "=== restart brownhill-next under PM2 ==="
cd /var/lib/brownhill/app
env $(cat /etc/brownhill/secrets/jwt.env /etc/brownhill/secrets/db.env /etc/brownhill/secrets/pg.env /etc/brownhill/secrets/bootstrap.env 2>&1 | xargs) \
  DEPLOYMENT_PROFILE=standalone NODE_ENV=production PORT=55431 HOSTNAME=127.0.0.1 \
  pm2 start server.js --name brownhill-next \
  --max-memory-restart 384M \
  --node-args="--max-old-space-size=512 --heapsnapshot-signal=SIGUSR2" 2>&1 | tail -5
sleep 6
echo
echo "=== smoke tests via nginx ==="
curl -sS -o /dev/null -w "/api/auth/local/setup: HTTP %{http_code} in %{time_total}s\n" --max-time 5 https://brownhillmanagementfleet.online/api/auth/local/setup
curl -sS -o /dev/null -w "/login:              HTTP %{http_code} in %{time_total}s\n" --max-time 5 https://brownhillmanagementfleet.online/login
curl -sS -o /dev/null -w "/icon.svg:           HTTP %{http_code} in %{time_total}s\n" --max-time 5 https://brownhillmanagementfleet.online/icon.svg
echo
echo "=== state ==="
pm2 list 2>&1 | tail -5
ss -tnp 2>&1 | grep 55431
echo
echo "=== persist iptables change ==="
if [ -d /etc/iptables ]; then
  iptables-save > /etc/iptables/rules.v4
  echo "saved"
else
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
  echo "saved (created dir)"
fi
ls -la /etc/iptables/rules.v4
