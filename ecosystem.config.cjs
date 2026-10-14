// /root/.pm2/ecosystem.config.cjs
//
// Deployed alongside /var/lib/brownhill/app. Owns the brownhill-next process.
// Author: brownhill-fleet background session, 2026-10-14.
//
// Memory policy: 384M (PM2 restarts on sustained memory growth above this).
//   Heap sizing: --max-old-space-size=512 so V8 has headroom to GC cleanly
//   while still triggering the 384M restart on a real leak.
// Heap snapshot: SIGUSR2 produces a .heapsnapshot in /var/lib/brownhill/app/.
//   Run as `kill -SIGUSR2 <pid>` to capture — required for root-causing the
//   steady heap growth upstream (issue #125, see HANDOFF-BROWNHILL.md).
//
// Started with:  cd /var/lib/brownhill/app && pm2 start ecosystem.config.cjs
// Persisted with: pm2 save  (and `pm2 startup` once at first install).

module.exports = {
  apps: [
    {
      name: 'brownhill-next',
      cwd: '/var/lib/brownhill/app',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,

      // Restart policy
      autorestart: true,
      restart_delay: 2000,           // back off briefly between restarts to avoid loops
      max_restarts: 10,              // if we hit this in 60 s, PM2 marks errored
      min_uptime: '60s',
      max_memory_restart: '384M',    // <-- the new safety net vs issue #125

      // Node tuning
      node_args: [
        '--max-old-space-size=512',  // V8 old-gen cap. Larger than max_memory_restart
                                     // so the GC can breathe and trigger a CLEAN restart
                                     // before the process OOMs itself into a wedge.
        '--heapsnapshot-signal=SIGUSR2',
      ],

      // Env (mirrors what brownhill-next.service used to set under systemd;
      // matches the PATH that pm2 itself was launched under, so the same
      // /usr/local/bin/node (v22.11.0) the previous incarnation was using
      // stays the interpreter)
      env: {
        NODE_ENV: 'production',
        DEPLOYMENT_PROFILE: 'standalone',
        PORT: 55431,
        HOSTNAME: '127.0.0.1',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
      },

      // Logs
      out_file: '/var/log/brownhill-next.out.log',
      error_file: '/var/log/brownhill-next.error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      time: true,
    },
  ],
};
