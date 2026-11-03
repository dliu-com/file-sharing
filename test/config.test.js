const { loadConfig, resetConfigCache, NotConfigured } = require('../lambda/api/config');

const fakeSsm = (params) => {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command.input);
      return { Parameters: command.input.Names.filter((n) => n in params).map((Name) => ({ Name, Value: params[Name] })) };
    },
  };
};

beforeEach(resetConfigCache);

test('tenant ID comes from the shared /dliu parameter, client ID and secret from /share', async () => {
  const ssm = fakeSsm({
    '/dliu/entra-tenant-id': ' tenant-1 ',
    '/share/entra-client-id': 'client-1',
    '/share/entra-client-secret': 'secret',
    '/share/entra-tenant-id': 'old-copy',
  });
  const config = await loadConfig(ssm, 0);
  expect(config).toMatchObject({ tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret' });
  expect(ssm.calls[0].Names).toEqual(['/dliu/entra-tenant-id', '/share/entra-client-id', '/share/entra-client-secret']);
});

test('a missing shared tenant ID is reported, not replaced by an old /share copy', async () => {
  const ssm = fakeSsm({ '/share/entra-tenant-id': 'old-copy', '/share/entra-client-id': 'c', '/share/entra-client-secret': 's' });
  await expect(loadConfig(ssm, 0)).rejects.toThrow(NotConfigured);
  await expect(loadConfig(ssm, 0)).rejects.toThrow('/dliu/entra-tenant-id');
});
