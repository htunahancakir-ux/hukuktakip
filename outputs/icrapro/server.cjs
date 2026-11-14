const http = require('node:http');
const { createApplication } = require('../../lib/application.cjs');
const { createStandaloneHandler } = require('../../lib/saas/deployment.cjs');
// With a database this is the production server: the same offices, console and add-on wiring
// as the hosted entry (api/index.js). Without one it stays the single-computer local mode.
const handler = process.env.DATABASE_URL ? createStandaloneHandler() : createApplication({});
http
  .createServer(handler)
  .listen(Number(process.env.HANHUKUK_PORT || 4317), '127.0.0.1', () => console.log('Han Hukuk ready'));
