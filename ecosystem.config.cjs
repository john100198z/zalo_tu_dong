// Chạy bằng pm2 (không dùng Docker): pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "zalo-autoreply",
      cwd: "./server",
      script: "dist/index.js",
      node_args: "--env-file=../.env",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_memory_restart: "500M",
    },
  ],
};
