const { createApplication } = require('../lib/application.cjs');
const { createPool, createStore } = require('../lib/postgres-store.cjs');
let handler;
module.exports = async function(req, res) {
  if (!handler) handler = createApplication({ cloud: true,
    store: process.env.DATABASE_URL ? createStore(createPool()) : undefined });
  const url = new URL(req.url, 'https://localhost');
  const route = req.query?.route || url.searchParams.get('route');
  if (typeof route === 'string') { url.pathname = '/api/' + route; url.searchParams.delete('route'); req.url = url.pathname + url.search; }
  return handler(req, res);
};
