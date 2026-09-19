/* eslint-env es6 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { enc } from '../src/av2bv.js';

const script = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const bvid = 'BV1BJ4m1e7g8';
class MessageError extends Error {}

function setup(options = {}) {
  const handlers = {},
    blobs = new Map(),
    revoked = [],
    merges = [],
    calls = [];
  let serial = 0;
  const dash = options.dash || {
    video: [
      { id: 64, baseUrl: 'https://cdn/video64' },
      { id: 80, baseUrl: 'https://cdn/video80' },
    ],
    audio: [
      { id: 30216, baseUrl: 'https://cdn/audio16' },
      { id: 30280, baseUrl: 'https://cdn/audio80' },
    ],
  };
  class Video {
    constructor(config) {
      this.config = config;
      this.request = { defaults: { headers: { 'User-Agent': 'SDK-UA' } } };
    }
    async info(id) {
      assert.equal(this.request.defaults.headers['User-Agent'], undefined);
      calls.push({ kind: 'info', id });
      return { title: '测试', pages: Array.from({ length: options.parts || 1 }, (_, i) => ({ cid: i + 100 })) };
    }
    async playurl(args) {
      assert.equal(this.request.defaults.headers['User-Agent'], undefined);
      calls.push({ kind: 'playurl', args, cookie: this.config.cookie });
      if (options.playError) throw new Error('API unavailable');
      return { dash };
    }
  }
  const gopeed = {
    info: { identity: 'monkeyWie@bilibili' },
    settings: { quality: 80, qualityFallback: 'best', cookie: ' session=secret ', ...options.settings },
    host: { env: { version: '2.0.0-beta.3', os: 'darwin', arch: 'arm64' } },
    events: Object.fromEntries(
      ['onResolve', 'onStart', 'onError'].map((key) => [
        key,
        (fn) => {
          handlers[key] = fn;
        },
      ])
    ),
    logger: { debug() {} },
    runtime: {
      ffmpeg: {
        merge(args) {
          merges.push(args);
          return { stream: merges.length };
        },
      },
      blob: {
        async createObjectURL(open, config) {
          const url = `http://127.0.0.1/__blob/${++serial}`;
          blobs.set(url, { open, config });
          return url;
        },
        async revokeObjectURL(url) {
          revoked.push(url);
          if (!blobs.delete(url)) throw new Error('expired registration');
        },
      },
    },
  };
  if (options.noRuntime) delete gopeed.runtime;
  if (options.legacyHost) delete gopeed.host;
  vm.runInNewContext(script, { Video, enc, gopeed, URL, MessageError, AbortController, setTimeout, clearTimeout, fetch: options.fetch });
  const resolve = async (suffix = '') => {
    const ctx = { req: { url: `https://www.bilibili.com/video/${bvid}${suffix}` } };
    await handlers.onResolve(ctx);
    return ctx.res;
  };
  function task(file) {
    const req = file.req;
    req.putLabel = async (key, value) => {
      req.labels[key] = value;
    };
    return {
      meta: { req },
      async setUrl(url) {
        req.url = url;
      },
      continued: 0,
      async continue() {
        this.continued++;
      },
    };
  }
  return { handlers, blobs, revoked, merges, calls, gopeed, resolve, task };
}

test('one lazy merged MP4 per part; unknown size and no output ranges', async () => {
  const h = setup({ parts: 3 });
  const res = await h.resolve('?p=2-3');
  assert.equal(res.range, false);
  assert.equal(res.name, '测试');
  assert.deepEqual(
    Array.from(res.files, (f) => f.name),
    ['测试(P2).mp4', '测试(P3).mp4']
  );
  assert.equal(h.calls.filter((c) => c.kind === 'playurl').length, 0);
  assert.equal(h.merges.length, 0);
  for (const file of res.files) {
    assert.equal(file.size, undefined);
    assert.equal(file.req.labels.type, 'merged');
    assert.match(file.req.rawUrl, /bilibili.com\/video/);
    const blob = h.blobs.get(file.req.url);
    assert.equal(blob.config.size, undefined);
    assert.equal(blob.config.range, false);
    assert.equal(blob.config.contentType, 'video/mp4');
    await blob.open();
  }
  assert.deepEqual(
    h.calls.filter((c) => c.kind === 'playurl').map((c) => c.args.cid),
    [101, 102]
  );
});

test('each Blob open refreshes URLs and creates a fresh merge with authenticated HTTP inputs', async () => {
  const h = setup({ settings: { hdr: true, dbs: true } });
  const res = await h.resolve();
  assert.equal(Object.hasOwn(res, 'name'), false);
  const blob = h.blobs.get(res.files[0].req.url);
  assert.notEqual(await blob.open(), await blob.open());
  assert.equal(h.merges.length, 2);
  for (const merge of h.merges) {
    assert.equal(merge.video.url, 'https://cdn/video80');
    assert.equal(merge.audio.url, 'https://cdn/audio80');
    assert.equal(merge.video.headers.Cookie, 'session=secret');
    assert.equal(merge.audio.headers.Referer, `https://www.bilibili.com/video/${bvid}`);
    assert.equal(merge.format, undefined); // Runtime defaults to streaming MP4 and copy.
  }
  const calls = h.calls.filter((c) => c.kind === 'playurl');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.fnval, 16 | 2048 | 128 | 1024 | 64 | 256 | 512);
  assert.equal(calls[0].cookie, 'session=secret');
});

test('quality fallbacks and snake_case media URLs', async () => {
  for (const fallback of ['best', 'lowest']) {
    const h = setup({ settings: { quality: 120, qualityFallback: fallback, cookie: '' } });
    const res = await h.resolve();
    await h.blobs.get(res.files[0].req.url).open();
    assert.equal(h.merges[0].video.url, fallback === 'best' ? 'https://cdn/video80' : 'https://cdn/video64');
    assert.equal(h.merges[0].audio.url, fallback === 'best' ? 'https://cdn/audio80' : 'https://cdn/audio16');
    assert.equal(h.merges[0].video.headers.Cookie, undefined);
  }
  const h = setup({
    dash: { video: [{ id: 80, base_url: 'https://cdn/v' }], audio: [{ id: 1, base_url: 'https://cdn/a' }] },
  });
  const res = await h.resolve();
  await h.blobs.get(res.files[0].req.url).open();
  assert.equal(h.merges[0].video.url, 'https://cdn/v');
});

test('missing tracks and API errors propagate; older runtimes fail clearly', async () => {
  for (const options of [{ dash: { video: [] } }, { playError: true }]) {
    const h = setup(options);
    const res = await h.resolve();
    await assert.rejects(h.blobs.get(res.files[0].req.url).open, (error) =>
      options.playError
        ? !(error instanceof MessageError) && /API unavailable/.test(error.message)
        : error instanceof MessageError && /DASH/.test(error.message)
    );
    assert.equal(h.merges.length, 0);
  }
  await assert.rejects(
    setup({ noRuntime: true }).resolve(),
    (error) => error instanceof MessageError && /FFmpeg WASM/.test(error.message)
  );
});

test('legacy Gopeed without gopeed.host is asked to upgrade on resolve', async () => {
  await assert.rejects(
    setup({ legacyHost: true }).resolve(),
    (error) => error instanceof MessageError && /Gopeed v2\.0\.0-beta/.test(error.message)
  );
});

test('start rebuilds/revokes Blob; stale registrations after restart are tolerated', async () => {
  const h = setup();
  const res = await h.resolve();
  const task = h.task(res.files[0]);
  const first = task.meta.req.url;
  await h.handlers.onStart({ task });
  assert.notEqual(task.meta.req.url, first);
  assert.equal(h.blobs.has(first), false);
  h.blobs.clear(); // Simulate losing all native registrations after an app restart.
  await h.handlers.onStart({ task });
  assert.equal(h.blobs.has(task.meta.req.url), true);
  await h.blobs.get(task.meta.req.url).open();
  assert.equal(h.merges.length, 1);
});

test('CDN pair history survives restart and skips failed pairs without blacklisting healthy inputs', async () => {
  const dash = {
    video: [{ id: 80, baseUrl: 'https://v1.example/video?sign=old', backupUrl: ['https://v2.example/video'] }],
    audio: [{ id: 30280, baseUrl: 'https://a1.example/audio', backupUrl: ['https://a2.example/audio'] }],
  };
  let h = setup({ dash });
  let task = h.task((await h.resolve()).files[0]);
  await h.handlers.onStart({ task });
  await h.blobs.get(task.meta.req.url).open();
  const observed = [[h.merges[0].video.url, h.merges[0].audio.url]];
  for (let i = 0; i < 3; i++) {
    // Deserialize into a fresh engine to exercise persisted labels, not closures.
    const file = { req: JSON.parse(JSON.stringify(task.meta.req)) };
    h = setup({ dash });
    task = h.task(file);
    task.continue = async () => {
      task.continued++;
      await h.handlers.onStart({ task });
    };
    await h.handlers.onError({ task });
    assert.equal(task.continued, 1);
    await h.blobs.get(task.meta.req.url).open();
    observed.push([h.merges[0].video.url, h.merges[0].audio.url]);
    assert.equal(h.blobs.size, 1);
    assert.equal(task.meta.req.labels.mergeCdnState.includes('sign='), false);
  }
  assert.deepEqual(observed, [
    ['https://v1.example/video?sign=old', 'https://a1.example/audio'],
    ['https://v1.example/video?sign=old', 'https://a2.example/audio'],
    ['https://v2.example/video', 'https://a1.example/audio'],
    ['https://v2.example/video', 'https://a2.example/audio'],
  ]);
  await assert.rejects(
    h.handlers.onError({ task }),
    (error) => error instanceof MessageError && /所有可用/.test(error.message)
  );
  assert.equal(task.continued, 1);
});

test('CDN retries are bounded even if the API keeps returning new origins', async () => {
  const dash = {
    video: [{ id: 80, baseUrl: 'https://v0.example/video' }],
    audio: [{ id: 1, baseUrl: 'https://audio.example/audio' }],
  };
  const h = setup({ dash });
  const task = h.task((await h.resolve()).files[0]);
  await h.handlers.onStart({ task });
  for (let i = 1; i <= 8; i++) {
    dash.video[0].baseUrl = `https://v${i}.example/video`;
    await h.handlers.onError({ task });
  }
  assert.equal(task.continued, 7);
  assert.equal(JSON.parse(task.meta.req.labels.mergeCdnState).retries, 8);
});

test('expired signatures are refreshed while a successful CDN choice is retained', async () => {
  const dash = {
    video: [{ id: 80, baseUrl: 'https://video.example/video?sign=old' }],
    audio: [{ id: 1, baseUrl: 'https://audio.example/audio' }],
  };
  const h = setup({ dash });
  const task = h.task((await h.resolve()).files[0]);
  await h.handlers.onStart({ task });
  dash.video[0].baseUrl = 'https://video.example/video?sign=new';
  await h.handlers.onStart({ task });
  await h.blobs.get(task.meta.req.url).open();
  assert.equal(h.merges[0].video.url, dash.video[0].baseUrl);
  assert.equal(JSON.parse(task.meta.req.labels.mergeCdnState).current.video, 'https://video.example');
});

test('legacy separate-track tasks still obtain a direct URL', async () => {
  const h = setup();
  const task = h.task({ req: { url: 'old', labels: { bvid, cid: 100, type: 'video' } } });
  await h.handlers.onStart({ task });
  assert.equal(task.meta.req.url, 'https://cdn/video80');
  assert.equal(h.blobs.size, 0);
});

test('partial resolve failure revokes previously created Blob registrations', async () => {
  const h = setup({ parts: 2 });
  const create = h.gopeed.runtime.blob.createObjectURL;
  let count = 0;
  h.gopeed.runtime.blob.createObjectURL = async (...args) => {
    if (++count === 2) throw new Error('registration failed');
    return create(...args);
  };
  await assert.rejects(h.resolve(), /registration failed/);
  assert.equal(h.blobs.size, 0);
});

test('FFmpeg setup errors reach the Blob consumer', async () => {
  const h = setup();
  h.gopeed.runtime.ffmpeg.merge = () => {
    throw new Error('unsupported media');
  };
  const res = await h.resolve();
  await assert.rejects(h.blobs.get(res.files[0].req.url).open, /unsupported media/);
});

test('prefer supplied UPOS backups over failing MCDN/edge primary URLs', async () => {
  const videoURL = 'https://upos-sz-mirrorhw.bilivideo.com/video?sign=keep-me';
  const audioURL = 'https://upos-sz-mirrorcos.bilivideo.com/audio?sign=keep-me-too';
  const h = setup({
    dash: {
      video: [
        {
          id: 80,
          baseUrl: 'https://xy1.mcdn.bilivideo.cn:8082/video',
          backupUrl: ['https://example.edge.mountaintoys.cn:4483/video', videoURL],
        },
      ],
      audio: [{ id: 30280, base_url: 'https://xy2.mcdn.bilivideo.cn:8082/audio', backup_url: [audioURL] }],
    },
  });
  const res = await h.resolve();
  await h.blobs.get(res.files[0].req.url).open();
  assert.equal(h.merges[0].video.url, videoURL);
  assert.equal(h.merges[0].audio.url, audioURL);
});

test('tracks can use a backup when no primary URL is available', async () => {
  const h = setup({
    dash: {
      video: [{ id: 80, backupUrl: ['https://cdn/video'] }],
      audio: [{ id: 30280, backup_url: ['https://cdn/audio'] }],
    },
  });
  const res = await h.resolve();
  await h.blobs.get(res.files[0].req.url).open();
  assert.equal(h.merges[0].video.url, 'https://cdn/video');
  assert.equal(h.merges[0].audio.url, 'https://cdn/audio');
});

test('missing media URLs use MessageError; one attempt keeps its selected signed URLs', async () => {
  const missing = setup({ dash: { video: [{ id: 80 }], audio: [{ id: 1, baseUrl: 'https://audio.example/audio' }] } });
  const res = await missing.resolve();
  await assert.rejects(
    missing.blobs.get(res.files[0].req.url).open,
    (error) => error instanceof MessageError && /没有可用的 HTTP/.test(error.message)
  );
  const dash = {
    video: [{ id: 80, baseUrl: 'https://video.example/video' }],
    audio: [{ id: 1, baseUrl: 'https://audio.example/audio' }],
  };
  const h = setup({ dash });
  const task = h.task((await h.resolve()).files[0]);
  await h.handlers.onStart({ task });
  const original = task.meta.req.url;
  const before = h.calls.filter((call) => call.kind === 'playurl').length;
  dash.video[0].baseUrl = 'https://changed.example/video';
  await h.blobs.get(original).open();
  await h.blobs.get(original).open();
  assert.equal(h.merges[0].video.url, 'https://video.example/video');
  assert.equal(h.merges[1].video.url, 'https://video.example/video');
  assert.equal(h.calls.filter((call) => call.kind === 'playurl').length, before);
  await h.handlers.onStart({ task });
  await h.blobs.get(task.meta.req.url).open();
  assert.equal(h.merges[2].video.url, 'https://changed.example/video');
  assert.equal(JSON.parse(task.meta.req.labels.mergeCdnState).current.video, 'https://changed.example');
});


test('short link resolves a video without fetching its HTML and preserves the selected part', async () => {
  let cancelled = false;
  const h = setup({ parts: 3, fetch: async (url, options) => {
    assert.equal(url, 'https://b23.tv/5s1tsW1');
    assert.equal(options.redirect, 'manual');
    return { status: 302, headers: new Headers({ location: `https://www.bilibili.com/video/${bvid}?p=2` }),
      body: { async cancel() { cancelled = true; } } };
  } });
  const ctx = { req: { url: 'https://b23.tv/5s1tsW1' } };
  await h.handlers.onResolve(ctx);
  assert.equal(cancelled, true);
  assert.equal(ctx.res.files.length, 1);
  assert.equal(ctx.res.files[0].name, '测试(P2).mp4');
  assert.equal(ctx.res.files[0].req.rawUrl, ctx.req.url);
  assert.equal(ctx.res.files[0].req.labels.bvid, bvid);
});

test('short links support relative redirects and AV video targets', async () => {
  const urls = [];
  const h = setup({ fetch: async url => {
    urls.push(url);
    return { status: 302, headers: new Headers({ location: urls.length === 1 ? '/next' : 'https://www.bilibili.com/video/av170001' }) };
  } });
  const ctx = { req: { url: 'https://b23.tv/first' } };
  await h.handlers.onResolve(ctx);
  assert.deepEqual(urls, ['https://b23.tv/first', 'https://b23.tv/next']);
  assert.equal(ctx.res.files[0].req.labels.bvid, enc(170001n));
});

test('invalid short links report MessageError instead of falling back to downloading HTML', async () => {
  for (const location of [null, 'https://www.bilibili.com/read/cv123', 'https://example.com/video/' + bvid, '/loop']) {
    let requests = 0;
    const h = setup({ fetch: async () => {
      requests++;
      return { status: location ? 302 : 200, headers: new Headers(location ? { location } : {}) };
    } });
    await assert.rejects(h.handlers.onResolve({ req: { url: 'https://b23.tv/test' } }), MessageError);
    assert.ok(requests <= 5);
    assert.equal(h.calls.length, 0);
  }
});
