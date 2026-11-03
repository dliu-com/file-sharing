'use strict';

// The CloudFront KeyValueStore is the only database: key = link id, value = the share record as JSON (max 1 KB).
// The viewer function reads it at the edge; this module writes it. Writes need the store's current ETag.

const MAX_VALUE_BYTES = 1024;

class TooLarge extends Error {}

let sdk;
function loadSdk() {
  if (!sdk) {
    // KeyValueStore requests are signed with SigV4A; requiring this package registers the signer.
    require('@aws-sdk/signature-v4a');
    sdk = require('@aws-sdk/client-cloudfront-keyvaluestore');
  }
  return sdk;
}

function createStore({ arn, client } = {}) {
  const api = loadSdk();
  const kvs = client || new api.CloudFrontKeyValueStoreClient({ region: 'us-east-1' });
  const send = (Command, input) => kvs.send(new api[Command]({ KvsARN: arn, ...input }));

  // Another write can land between reading the ETag and writing; then try again with the new ETag.
  async function withEtag(write) {
    for (let attempt = 1; ; attempt++) {
      const { ETag } = await send('DescribeKeyValueStoreCommand', {});
      try {
        return await write(ETag);
      } catch (error) {
        if (error.name !== 'ConflictException' || attempt >= 5) throw error;
      }
    }
  }

  async function get(id) {
    try {
      const { Value } = await send('GetKeyCommand', { Key: id });
      return JSON.parse(Value);
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') return null;
      throw error;
    }
  }

  async function list() {
    const items = [];
    let NextToken;
    do {
      const page = await send('ListKeysCommand', { MaxResults: 50, ...(NextToken ? { NextToken } : {}) });
      for (const item of page.Items || []) {
        try {
          items.push({ id: item.Key, ...JSON.parse(item.Value) });
        } catch {
          items.push({ id: item.Key, broken: true });
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return items;
  }

  async function put(id, record) {
    const Value = JSON.stringify(record);
    if (Buffer.byteLength(Value, 'utf8') > MAX_VALUE_BYTES) throw new TooLarge('The link and name are too long to store');
    await withEtag((IfMatch) => send('PutKeyCommand', { Key: id, Value, IfMatch }));
  }

  async function remove(id) {
    try {
      await withEtag((IfMatch) => send('DeleteKeyCommand', { Key: id, IfMatch }));
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
  }

  // The store's status (READY when usable), for /health. Reads no keys.
  async function describe() {
    const { Status } = await send('DescribeKeyValueStoreCommand', {});
    return Status;
  }

  return { get, list, put, remove, describe };
}

module.exports = { createStore, TooLarge, MAX_VALUE_BYTES };
