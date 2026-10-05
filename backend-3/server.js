'use strict';

/**
 * HONEST backend - long-running server entry point.
 *
 *   npm start          start the API
 *   npm run dev        start with file watching
 *   npm test           run the behaviour test suite
 *
 * This is the entry point for a machine that keeps the process alive: a laptop,
 * a VPS, Render, Railway, Fly.io, Docker. On a serverless platform (Vercel) use
 * `api/index.js` instead, which exports the same Express app as a function.
 *
 * Every environment variable is documented in config/env.js and README.md.
 */

const { createBootstrap } = require('./bootstrap');
const { readEnv } = require('./config/env');

function main() {
  let env;
  try {
    env = readEnv();
  } catch (err) {
    console.error(`[honest] Configuration error: ${err.message}`);
    process.exit(1);
  }

  const bootstrap = createBootstrap({ env, verbose: true });

  // Opening the database here makes a misconfiguration fail loudly at start-up
  // instead of on the first request.
  try {
    bootstrap.start();
  } catch (err) {
    console.error(`[honest] Could not start: ${err.message}`);
    process.exit(1);
  }

  const state = bootstrap.state;
  const server = bootstrap.app.listen(env.port, () => {
    // Report the port the server actually bound (PORT=0 asks the OS to choose).
    const actualPort = server.address() && server.address().port ? server.address().port : env.port;
    console.log(`  API            http://localhost:${actualPort}/api`);
    console.log(`  Endpoint index http://localhost:${actualPort}/api`);
    console.log(`  Health         http://localhost:${actualPort}/health`);
    if (state.scheduler.mode !== 'timer') {
      console.log(
        `  Scheduler      on demand - schedule: curl -H "x-cron-secret: $CRON_SECRET" http://localhost:${actualPort}/api/cron/tick`
      );
    }
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${env.port} is already in use. Start with a different port:  PORT=3001 npm start  (PowerShell: $env:PORT=3001; npm start)`
      );
    } else {
      console.error('[honest] server error:', err.message);
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[honest] ${signal} received - shutting down.`);
    server.close(() => {
      Promise.resolve(bootstrap.stop())
        .catch(() => {})
        .then(() => process.exit(0));
    });
    // Do not hang forever on stubborn keep-alive connections.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { main };
