const { createApplication } = require('../lib/application.cjs');
const { createPool, createStore } = require('../lib/postgres-store.cjs');
const { waitUntil } = require('@vercel/functions');
let handler;
module.exports = async function (req, res) {
  if (!handler)
    handler = createApplication({
      cloud: true,
      background: waitUntil,
      store: process.env.DATABASE_URL ? createStore(createPool()) : undefined,
    });
  req.url = require('../lib/api-request-url.cjs').apiRequestUrl(req);
  return handler(req, res);
};
