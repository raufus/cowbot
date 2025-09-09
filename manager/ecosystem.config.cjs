module.exports = {
  apps: [
    {
      name: 'manager-api',
      script: 'src/api/server.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'manager-discord-bot',
      script: 'src/manager-bot/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
