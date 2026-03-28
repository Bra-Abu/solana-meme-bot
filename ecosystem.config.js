module.exports = {
  apps: [
    {
      name: 'solana-meme-bot',
      script: 'index.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
  ],
};
