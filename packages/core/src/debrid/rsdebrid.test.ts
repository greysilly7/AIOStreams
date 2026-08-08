import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, IncomingMessage, ServerResponse } from 'node:http';
import { toUrlSafeBase64 } from '../utils/index.js';
import { initDb } from '../db/index.js';
import { initialiseConfig } from '../config/index.js';
import { DebridError } from './base.js';

await initDb('sqlite::memory:');
await initialiseConfig();

//
// Test harness: a real local HTTP server stands in for the rsdebrid API. No
// module mocking needed — works under plain tsx. fetchBytes() fetches real
// URLs, so binary routes are served by the same server.
//

interface Call {
  url: string;
  method: string;
  headers: IncomingMessage['headers'];
  bodyText: string;
}

const calls: Call[] = [];

interface HandlerResult {
  status?: number;
  body?: unknown;
  raw?: string;
  contentType?: string;
}

let handler:
  | ((url: string, method: string, bodyText: string) => Promise<HandlerResult> | HandlerResult)
  | undefined;

function send(res: ServerResponse, result: HandlerResult): void {
  if (result.body === undefined && result.contentType === undefined) {
    res.writeHead(result.status ?? 404).end();
    return;
  }
  const body = result.raw ?? JSON.stringify(result.body);
  res.writeHead(result.status ?? 200, {
    'Content-Type':
      result.contentType ?? (result.body === undefined ? 'text/plain' : 'application/json'),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const url = req.url ?? '';
  const method = req.method ?? 'GET';
  calls.push({ url, method, headers: req.headers, bodyText });
  const result = handler ? await handler(url, method, bodyText) : {};
  send(res, result);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

function config(overrides: Record<string, string> = {}): string {
  // A unique apiKey per test keeps the bundled in-memory library cache from
  // leaking listings between tests (cache key = hash of the token).
  const token = {
    url: baseUrl,
    apiKey: randomBytes(8).toString('hex'),
    ...overrides,
  };
  return toUrlSafeBase64(JSON.stringify(token));
}

function json(body: unknown, status = 200): HandlerResult {
  return { status, body };
}

function magnetFor(hash: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=Movie`;
}

function setupNext(
  next: (url: string, method: string, bodyText: string) => HandlerResult | Promise<HandlerResult>
): void {
  handler = next;
  calls.length = 0;
}

afterEach(() => {
  handler = undefined;
  calls.length = 0;
});

const { RSDebridService } = await import('./rsdebrid.js');

test('config parsing: valid base64 JSON with and without apiKey', () => {
  const service = new RSDebridService({ token: config({ apiKey: 'secret' }) });
  assert.equal(service.serviceName, 'rsdebrid');

  const noKey = new RSDebridService({ token: config({}) });
  assert.equal(noKey.serviceName, 'rsdebrid');
});

test('config parsing: invalid base64 is rejected', () => {
  assert.throws(
    () => new RSDebridService({ token: 'not-json-or-base64' }),
    (err: any) =>
      err instanceof DebridError &&
      err.code === 'BAD_REQUEST' &&
      /credentials/.test(err.message)
  );
});

test('checkMagnets: owned completed is cached, unowned is queued', async () => {
  const ownedHash = randomBytes(20).toString('hex');
  const unownedHash = randomBytes(20).toString('hex');
  setupNext(() =>
    json([
      {
        id: 'dl-1',
        info_hash: ownedHash,
        source_type: 'torrent',
        status: 'completed',
      },
    ])
  );

  const service = new RSDebridService({ token: config({}) });
  const results = await service.checkMagnets([
    magnetFor(ownedHash),
    magnetFor(unownedHash),
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'cached');
  assert.equal(results[0].id, 'dl-1');
  assert.equal(results[1].status, 'queued');
});

test('checkMagnets: owned non-completed download reflects real status', async () => {
  const hash = randomBytes(20).toString('hex');
  setupNext(() =>
    json([
      { id: 'dl-1', info_hash: hash, source_type: 'torrent', status: 'downloading' },
    ])
  );

  const service = new RSDebridService({ token: config({}) });
  const [result] = await service.checkMagnets([magnetFor(hash)]);
  assert.equal(result.status, 'downloading');
});

test('checkMagnets: checkOwned=false returns all queued without listing', async () => {
  const service = new RSDebridService({ token: config({}) });
  const results = await service.checkMagnets(
    [magnetFor(randomBytes(20).toString('hex'))],
    undefined,
    false
  );
  assert.ok(results.every((r) => r.status === 'queued'));
  assert.equal(calls.length, 0);
});

test('checkNzbs: owned hash is cached, unowned queued', async () => {
  const ownedHash = randomBytes(20).toString('hex');
  setupNext(() =>
    json([
      {
        id: 'nzb-1',
        info_hash: ownedHash,
        source_type: 'nzb',
        status: 'completed',
      },
    ])
  );

  const service = new RSDebridService({ token: config({}) });
  const results = await service.checkNzbs([
    { hash: ownedHash },
    { hash: randomBytes(20).toString('hex') },
  ]);

  assert.equal(results[0].status, 'cached');
  assert.equal(results[0].id, 'nzb-1');
  assert.equal(results[1].status, 'queued');
});

test('checkNzbs: checkOwned=false returns all queued', async () => {
  const service = new RSDebridService({ token: config({}) });
  const results = await service.checkNzbs(
    [{ hash: randomBytes(20).toString('hex') }],
    false
  );
  assert.ok(results.every((r) => r.status === 'queued'));
  assert.equal(calls.length, 0);
});

test('resolve: add -> poll -> completed -> link built from file UUID path', async () => {
  const hash = randomBytes(20).toString('hex');
  let getDownloadCalls = 0;

  setupNext((url, method) => {
    if (method === 'GET' && url.endsWith('/downloads')) return json([]);
    if (method === 'POST' && url.endsWith('/downloads')) {
      assert.ok(calls.length > 0);
      assert.match(calls[calls.length - 1].bodyText, /magnet:/);
      return json({ id: 'dl-1' });
    }
    if (method === 'GET' && url.endsWith('/downloads/dl-1')) {
      getDownloadCalls++;
      if (getDownloadCalls === 1) {
        return json({
          download: { id: 'dl-1', info_hash: hash, source_type: 'torrent', status: 'pending' },
          files: [],
          last_error: null,
        });
      }
      return json({
        download: { id: 'dl-1', info_hash: hash, source_type: 'torrent', status: 'completed' },
        files: [
          {
            id: 'uuid-1',
            file_path: '/data/My Movie.mkv',
            size: 1024,
            mime_type: 'video/x-matroska',
          },
        ],
        last_error: null,
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  const service = new RSDebridService(
    { token: config({ publicUrl: 'http://public.example.com', apiKey: 'secret' }) },
    { pollInterval: 10, maxWaitTime: 1000 }
  );

  const link = await service.resolve(
    {
      type: 'torrent',
      hash,
      sources: [],
      filename: 'Movie.mkv',
    },
    'Movie.mkv',
    true
  );

  assert.equal(link, 'http://public.example.com/files/uuid-1/download');
  // The Bearer token rides in request headers, not in the resolved URL — the
  // URL must stay clean because it ends up in the Stremio stream manifest.
  const authHeaders = calls
    .map((c) => String(c.headers.authorization ?? ''))
    .filter(Boolean);
  assert.ok(authHeaders.length > 0);
  assert.ok(authHeaders.every((h) => h === 'Bearer secret'));
});

test('resolve: last_error short-circuits the poll loop before maxWaitTime', async () => {
  const hash = randomBytes(20).toString('hex');
  let getDownloadCalls = 0;

  setupNext((url, method) => {
    if (method === 'GET' && url.endsWith('/downloads')) return json([]);
    if (method === 'POST' && url.endsWith('/downloads')) return json({ id: 'dl-1' });
    if (method === 'GET' && url.endsWith('/downloads/dl-1')) {
      getDownloadCalls++;
      // rsdebrid never flips status to 'failed' — last_error is the only
      // failure signal, and it must abort the poll loop immediately.
      return json({
        download: { id: 'dl-1', info_hash: hash, source_type: 'torrent', status: 'pending' },
        files: [],
        last_error: 'no peers found',
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  const service = new RSDebridService(
    { token: config({}) },
    { pollInterval: 5, maxWaitTime: 10000 }
  );

  await assert.rejects(
    service.resolve(
      { type: 'torrent', hash, sources: [], filename: 'Movie.mkv' },
      'Movie.mkv',
      true
    ),
    (err: any) =>
      err instanceof DebridError &&
      err.code === 'DOWNLOAD_FAILED' &&
      /failed/.test(err.message)
  );

  assert.ok(
    getDownloadCalls < Math.ceil(10000 / 5),
    `poll loop ran ${getDownloadCalls} times, expected to short-circuit well before maxWaitTime`
  );
});

test('resolve: cacheAndPlay=false returns undefined for non-completed download without polling', async () => {
  const hash = randomBytes(20).toString('hex');
  let getDownloadCalls = 0;

  setupNext((url, method) => {
    if (method === 'GET' && url.endsWith('/downloads')) return json([]);
    if (method === 'POST' && url.endsWith('/downloads')) return json({ id: 'dl-1' });
    if (method === 'GET' && url.endsWith('/downloads/dl-1')) {
      getDownloadCalls++;
      return json({
        download: { id: 'dl-1', info_hash: hash, source_type: 'torrent', status: 'pending' },
        files: [],
        last_error: null,
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  const service = new RSDebridService(
    { token: config({}) },
    { pollInterval: 5, maxWaitTime: 1000 }
  );

  const result = await service.resolve(
    { type: 'torrent', hash, sources: [], filename: 'Movie.mkv' },
    'Movie.mkv',
    false
  );

  assert.equal(result, undefined);
  assert.equal(getDownloadCalls, 1);
});

test('resolve: addTorrent re-uploads fetched .torrent bytes', async () => {
  const hash = randomBytes(20).toString('hex');
  let torrentFetched = 0;

  setupNext(async (url, method) => {
    if (method === 'GET' && url.endsWith('/torrent-source')) {
      torrentFetched++;
      return { status: 200, raw: 'fake-torrent-bytes', contentType: 'application/x-bittorrent' };
    }
    if (method === 'GET' && url.endsWith('/downloads')) return json([]);
    if (method === 'POST' && url.endsWith('/downloads')) {
      const body = calls[calls.length - 1].bodyText;
      assert.match(body, /name="torrent_file"/);
      assert.ok(body.includes('fake-torrent-bytes'));
      return json({ id: 'dl-2' });
    }
    if (method === 'GET' && url.endsWith('/downloads/dl-2')) {
      return json({
        download: { id: 'dl-2', info_hash: hash, source_type: 'torrent', status: 'completed' },
        files: [{ id: 'uuid-2', file_path: '/data/Movie.mkv', size: 1024, mime_type: 'video/x-matroska' }],
        last_error: null,
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  const service = new RSDebridService(
    { token: config({}) },
    { pollInterval: 5, maxWaitTime: 1000 }
  );

  const link = await service.resolve(
    {
      type: 'torrent',
      hash,
      sources: [],
      downloadUrl: `${baseUrl}/torrent-source`,
      filename: 'Movie.mkv',
    },
    'Movie.mkv',
    true
  );

  assert.equal(link, `${baseUrl}/files/uuid-2/download`);
  assert.equal(torrentFetched, 1);
});

test('getNzb maps CachedFile UUID into path and index into id', async () => {
  const hash = randomBytes(20).toString('hex');
  setupNext(() =>
    json({
      download: { id: 'nzb-1', info_hash: hash, source_type: 'nzb', status: 'completed' },
      files: [
        { id: 'uuid-a', file_path: '/data/Release 1.mkv', size: 10, mime_type: 'video/x-matroska' },
        { id: 'uuid-b', file_path: '/data/Release 2.mkv', size: 20, mime_type: 'video/x-matroska' },
      ],
      last_error: null,
    })
  );

  const service = new RSDebridService({ token: config({}) });
  const download = await service.getNzb('nzb-1');

  assert.equal(download.status, 'downloaded');
  assert.equal(download.files?.length, 2);
  assert.equal(download.files![0].id, 0);
  assert.equal(download.files![0].path, 'uuid-a');
  assert.equal(download.files![1].id, 1);
  assert.equal(download.files![1].path, 'uuid-b');
});