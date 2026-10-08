// pm2 processes for Maharashtra Political Watch (separate from Chhattisgarh).
// Start:  pm2 start ecosystem.config.js   (from this folder)
module.exports = {
  apps: [
    {
      name: 'maharashtra-saga-backend',
      cwd: __dirname + '/backend',
      script: 'src/index.js',
      // Cap memory so this process can never starve the other projects on the box.
      // V8 heap cap: if Maharashtra needs more, only this process restarts —
      // it never pushes the box into a kernel OOM (which restarts every pm2 app).
      node_args: '--max-old-space-size=1024',
      max_memory_restart: '1500M',
    },
    {
      name: 'maharashtra-saga-frontend',
      script: 'serve',
      env: {
        PM2_SERVE_PATH: __dirname + '/frontend/build',
        PM2_SERVE_PORT: 3012,
        PM2_SERVE_SPA: 'true',
      },
    },
  ],
};
