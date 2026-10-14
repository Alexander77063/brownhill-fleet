# /opt/brownhill/heap-probe.sh — drive traffic + snapshot
PID="$(pm2 jlist | grep -oE '\"pid\":[0-9]+' | head -1 | cut -d: -f2)"
echo "PID=$PID"

echo "=== take post-traffic snapshot ==="
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sS -o /dev/null -m 5 https://brownhillmanagementfleet.online/login || echo "login=$?"
  curl -sS -o /dev/null -m 5 https://brownhillmanagementfleet.online/api/auth/local/setup || echo "setup=$?"
done

kill -SIGUSR2 "$PID"
sleep 2
ls -lt /var/lib/brownhill/app/Heap.*.heapsnapshot | head -2

echo "=== heap right now ==="
pm2 jlist | tr "," "\n" | grep "Heap Usage\|Used Heap" | head -4
