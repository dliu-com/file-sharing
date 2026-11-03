'use strict';

// GET /health for status.dliu.com (the dliu.com health contract, dliu-com/status HEALTH.md). Anyone may call it:
// it takes no input at all (no cookies, headers or query string), makes one cheap read per dependency, never calls
// OneDrive or Microsoft, and reports only pass/warn/fail with a generic reason. CloudFront caches it for 60 s.

const CHECK_TIMEOUT_MS = 2000;
const SLOW_MS = 1000;
const RANK = { pass: 0, warn: 1, fail: 2 };

// The keys match the functions on /docs/health and in /docs/health.md.
const FUNCTIONS = [
  { key: 'links', name: 'Share links' },
  { key: 'signin', name: 'Owner sign-in' },
];

const { NotConfigured } = require('./config');

class Failed extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Failed('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function run(key, check, clock, flagSlow) {
  const started = clock();
  try {
    const result = await withTimeout(Promise.resolve().then(check), CHECK_TIMEOUT_MS);
    if (result && result.status === 'warn') return { status: 'warn', output: result.output };
    return flagSlow && clock() - started > SLOW_MS ? { status: 'warn', output: 'slow' } : { status: 'pass' };
  } catch (error) {
    const output = error instanceof Failed ? error.message : 'read failed';
    console.warn(JSON.stringify({ message: 'Health check failed', key, error: error.name, reason: output }));
    return { status: 'fail', output };
  }
}

/**
 * checks: { links: () => KeyValueStore status, signin: () => sign-in settings }.
 * Returns the Lambda function URL response.
 */
function createHealth({ checks, now = Date.now }) {
  // A cold start's first run includes SDK start-up and new connections, so it isn't judged slow.
  let warm = false;
  return async function health() {
    const flagSlow = warm;
    warm = true;
    const results = await Promise.all(FUNCTIONS.map(async ({ key, name }) => ({ key, name, ...(await run(key, checks[key], now, flagSlow)) })));
    const status = results.reduce((worst, result) => (RANK[result.status] > RANK[worst] ? result.status : worst), 'pass');
    return {
      statusCode: status === 'fail' ? 503 : 200,
      headers: {
        'content-type': 'application/health+json',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff',
      },
      body: JSON.stringify({ status, time: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'), functions: results }),
    };
  };
}

// links: the KeyValueStore that holds every share link (one DescribeKeyValueStore call; no list, no count shown).
async function checkLinks(store) {
  const status = await store.describe();
  if (status !== 'READY') return { status: 'warn', output: 'not ready' };
  return null;
}

// signin: the Microsoft sign-in settings in SSM. loadConfig is the read every sign-in already does (cached 5 min);
// it fails when a parameter is missing. Microsoft itself is not called.
async function checkSignin(loadConfig) {
  try {
    await loadConfig();
  } catch (error) {
    if (error instanceof NotConfigured) throw new Failed('not configured');
    throw error;
  }
  return null;
}

module.exports = { createHealth, checkLinks, checkSignin, FUNCTIONS, CHECK_TIMEOUT_MS, SLOW_MS };
