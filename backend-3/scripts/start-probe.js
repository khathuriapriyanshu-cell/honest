'use strict';

/**
 * Boots the real server entry point on an ephemeral port, makes a genuine HTTP
 * request against it, then triggers a graceful shutdown. Used by the process
 * level test so "npm start" is exercised end to end rather than assumed.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const serverPath = path.resolve(__dirname, '..', 'server.js');

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: process.env.PORT || '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  const match = /http:\/\/localhost:(\d+)\/api/.exec(stdout);
  if (match && !child.probed) {
    child.probed = true;
    probe(Number(match[1]));
  }
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await res.json();
    console.log(`health -> ${res.status} ${JSON.stringify(body.status)} ${JSON.stringify(body.database)}`);
    const today = await fetch(`http://127.0.0.1:${port}/api/today`);
    const todayBody = await today.json();
    console.log(`today -> ${today.status} tasks=${todayBody.tasks.length}`);
  } catch (err) {
    console.error('probe failed:', err.message);
    process.exitCode = 1;
  } finally {
    // Graceful shutdown through the real SIGTERM handler.
    child.kill('SIGTERM');
  }
}

child.on('exit', (code, signal) => {
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (signal === 'SIGTERM' && process.exitCode === undefined) {
    // Some platforms report the signal rather than a zero exit code; treat a
    // clean SIGTERM shutdown as success.
    process.exitCode = 0;
  } else if (code !== 0 && process.exitCode === undefined) {
    process.exitCode = code === null ? 1 : code;
  }
});

setTimeout(() => {
  console.error('server did not become ready in time');
  child.kill('SIGKILL');
  process.exitCode = 1;
}, 20000).unref();
