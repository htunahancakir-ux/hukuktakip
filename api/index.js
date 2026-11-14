const { createDeploymentHandler } = require('../lib/saas/deployment.cjs');
const { waitUntil } = require('@vercel/functions');
let router;
module.exports = async function (req, res) {
  router ||= createDeploymentHandler({ background: waitUntil });
  req.url = require('../lib/api-request-url.cjs').apiRequestUrl(req);
  return router(req, res);
};
