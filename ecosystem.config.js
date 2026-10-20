// PM2 Ecosystem Config — keeps your API running 24/7
module.exports = {
  apps: [{
    name: 'docfero-api',
    script: 'server.js',
    instances: 1,           // LibreOffice is single-threaded, keep at 1
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 4000
    },
    // Logging
    error_file: '/var/log/docfero/error.log',
    out_file: '/var/log/docfero/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Restart policy
    exp_backoff_restart_delay: 1000,
    max_restarts: 10,
    restart_delay: 3000
  }]
};
