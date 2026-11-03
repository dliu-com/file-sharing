'use strict';

const PREFIX = process.env.PARAMETER_PREFIX || '/share';
// The tenant ID is shared by every dliu.com app and lives in the dliu-com/audit stack.
const TENANT_PARAMETER = process.env.TENANT_PARAMETER || '/dliu/entra-tenant-id';
const OWN = ['entra-client-id', 'entra-client-secret'];
const TTL_MS = 5 * 60 * 1000;

let cached;
let cachedAt = 0;

let ssmClient;
function client() {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

class NotConfigured extends Error {}

async function loadConfig(ssm = client(), now = Date.now()) {
  if (cached && now - cachedAt < TTL_MS) return cached;
  const { GetParametersCommand } = require('@aws-sdk/client-ssm');
  const names = [TENANT_PARAMETER, ...OWN.map((name) => `${PREFIX}/${name}`)];
  const result = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const values = Object.fromEntries((result.Parameters || []).map((p) => [p.Name, p.Value]));
  const missing = names.filter((name) => !values[name]);
  if (missing.length) {
    throw new NotConfigured(`Missing SSM parameters: ${missing.join(', ')}. Run "make set-secrets" (the tenant ID comes from the dliu-com/audit stack).`);
  }
  cached = {
    tenantId: values[TENANT_PARAMETER].trim(),
    clientId: values[`${PREFIX}/entra-client-id`].trim(),
    clientSecret: values[`${PREFIX}/entra-client-secret`],
    allowedDomain: (process.env.ALLOWED_DOMAIN || process.env.ROOT_DOMAIN || 'dliu.com').trim().toLowerCase(),
  };
  cachedAt = now;
  return cached;
}

function resetConfigCache() {
  cached = undefined;
  cachedAt = 0;
}

module.exports = { loadConfig, resetConfigCache, NotConfigured };
