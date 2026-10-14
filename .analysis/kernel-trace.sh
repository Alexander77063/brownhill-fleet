# /tmp/kernel-trace.sh — kernel-side TCP state during connection attempts
echo "=== ss listen state for 55431 ==="
ss -ltnp 2>&1 | grep 55431
echo
echo "=== a connection attempt via curl from the box ==="
curl -sS -o /dev/null -w "box-to-55431: HTTP %{http_code} in %{time_total}s\n" --max-time 5 http://127.0.0.1:55431/api/auth/local/setup
echo
echo "=== connections in flight RIGHT after ==="
ss -tn state all '( sport = :55431 or dport = :55431 )' 2>&1
echo
echo "=== /proc/net/tcp row for port 55431 ==="
awk '$2 ~ /:D853$/ || $3 ~ /:D853$/' /proc/net/tcp 2>&1 | head
echo
echo "=== /proc/sys/net/ipv4/tcp_synack_retries (high) ==="
cat /proc/sys/net/ipv4/tcp_synack_retries 2>/dev/null
echo
echo "=== Now try a HTTP request with longer timeout ==="
curl -sS -o /dev/null -w "long-timeout: HTTP %{http_code} in %{time_total}s\n" --max-time 30 http://127.0.0.1:55431/api/auth/local/setup
