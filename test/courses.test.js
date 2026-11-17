/* eslint-env es6 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courseTarget, courseCatalog, coursePlayback, courseMediaURL } from '../src/courses.js';

const mall = { source: 'mall', courseId: '1000625147', lessonId: '180281190609920', itemId: '10302975' };
const settings = { cookie: ' SESSDATA=fixture-only ' };
const media = 'http://upos-sz-mirrorcos.bilivideo.com/mallxcodeboss/example.mp4?deadline=123&sign=fixture';
const reply = (data) => async () => ({ ok: true, json: async () => ({ code: 0, data }) });
const mallData = () => ({
  ...mall,
  hasBought: true,
  itemsName: '测试课程',
  sectionCount: 2,
  chapterList: [
    {
      sectionList: [1, 2].map((n) => ({
        lessonId: Number(mall.lessonId),
        sectionId: 100 + n,
        sectionName: `课程${n}`,
        hasWatchRight: true,
        videoTime: 221500,
      })),
    },
  ],
});
const cheeseData = () => ({
  season_id: 42,
  title: '课堂',
  ep_count: 2,
  user_status: { payed: 1 },
  episodes: [1, 2].map((n) => ({ id: n, cid: n + 100, aid: n + 200, title: `课程${n}`, playable: true })),
});

test('course routes are exact and preserve safe ID strings', () => {
  assert.deepEqual(courseTarget(new URL('https://www.bilibili.com/cheese/play/ep124227')), {
    source: 'cheese',
    episode: '124227',
  });
  assert.deepEqual(courseTarget(new URL('https://bilibili.com/cheese/play/ss42')), { source: 'cheese', season: '42' });
  assert.deepEqual(
    courseTarget(
      new URL(
        `https://mall.bilibili.com/lesson/play?courseId=${mall.courseId}&lessonId=${mall.lessonId}&itemId=${mall.itemId}`
      )
    ),
    mall
  );
  for (const url of [
    'https://evil.test/cheese/play/ep1',
    'https://www.bilibili.com/cheese/play/ep1/evil',
    'http://mall.bilibili.com/lesson/play',
    'https://name@www.bilibili.com/cheese/play/ep1',
  ])
    assert.equal(courseTarget(new URL(url)), null);
  assert.throws(() => courseTarget(new URL('https://www.bilibili.com/cheese/play/ep9007199254740993')), /ID/);
});

test('mall catalog uses the website POST body and validates complete sections', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://mall.bilibili.com/mall-search-items/items/course/h5/detail');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, 'SESSDATA=fixture-only');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { courseId: 1000625147, lessonId: 180281190609920, itemId: 10302975 });
    return reply(mallData())();
  };
  const catalog = await courseCatalog(mall, settings, fetcher);
  assert.equal(catalog.entries.length, 2);
  assert.equal(catalog.entries[1].sectionId, '102');
  assert.equal(catalog.entries[1].allowed, true);
  assert.equal(JSON.stringify(catalog).includes('fixture-only'), false);
  for (const mutate of [
    (d) => d.sectionCount++,
    (d) => (d.chapterList[0].sectionList[1].sectionId = 101),
    (d) => (d.courseId = '999'),
    (d) => (d.chapterList[0].sectionList[1].lessonId = 999),
  ]) {
    const data = mallData();
    mutate(data);
    await assert.rejects(courseCatalog(mall, settings, reply(data)));
  }
});

test('cheese catalog requires purchase and rejects incomplete, duplicate, or unrelated lists', async () => {
  const target = { source: 'cheese', episode: '1' };
  assert.equal((await courseCatalog(target, settings, reply(cheeseData()))).entries.length, 2);
  const unpaid = cheeseData();
  unpaid.user_status.payed = 0;
  assert.equal((await courseCatalog(target, settings, reply(unpaid))).entries[0].allowed, false);
  const expired = cheeseData();
  expired.user_status.is_expired = true;
  assert.equal((await courseCatalog(target, settings, reply(expired))).entries[0].allowed, false);
  for (const mutate of [(d) => d.ep_count++, (d) => (d.episodes[1].id = 1), (d) => (d.episodes[0].id = 99)]) {
    const data = cheeseData();
    mutate(data);
    await assert.rejects(courseCatalog(target, settings, reply(data)));
  }
});

test('mall refresh verifies lesson, section, rights and full duration before HTTPS media', async () => {
  const labels = { ...mall, sectionId: '101', expectedSeconds: 221.5 };
  const data = {
    lessonId: Number(mall.lessonId),
    sectionId: 101,
    videoTime: 221,
    hasWatchRight: true,
    videoUrl: media,
  };
  const result = await coursePlayback(labels, settings, async (url, options) => {
    assert.match(url, /section\/play\/detail$/);
    assert.equal(JSON.parse(options.body).sectionId, 101);
    return reply(data)();
  });
  assert.equal(result.direct, media.replace('http:', 'https:'));
  for (const change of [
    { hasWatchRight: false },
    { sectionId: 102 },
    { lessonId: 1 },
    { videoTime: 30 },
    { encrypted: true },
    { videoTime: 'invalid' },
  ])
    await assert.rejects(coursePlayback(labels, settings, reply({ ...data, ...change })));
});

test('course media accepts only HTTPS-upgraded official CDN paths and rejects credentials/DRM', async () => {
  for (const address of [
    'http://evil.test/mallxcodeboss/a.mp4',
    'https://bilivideo.com.evil.test/a.mp4',
    'https://name:pass@cdn.bilivideo.com/a.mp4',
    'file:///a.mp4',
    'https://cdn.bilivideo.com/a.m3u8',
    'https://cdn.bilivideo.com:444/mallxcodeboss/a.mp4',
  ])
    assert.throws(() => courseMediaURL(address, true));
  const data = {
    has_paid: true,
    is_preview: 0,
    timelength: 100000,
    dash: {
      video: [{ id: 80, base_url: 'http://cdn.bilivideo.com/v.m4s' }],
      audio: [{ id: 30280, base_url: 'https://cdn.bilivideo.com/a.m4s' }],
    },
  };
  const labels = { source: 'cheese', aid: '201', cid: '101', episode: '1' };
  const result = await coursePlayback(labels, settings, reply(structuredClone(data)));
  assert.equal(result.dash.video[0].baseUrl, 'https://cdn.bilivideo.com/v.m4s');
  for (const change of [{ has_paid: false }, { is_preview: 1 }, { drm_type: 1 }, { play_video_type: 'preview' }])
    await assert.rejects(coursePlayback(labels, settings, reply({ ...data, ...change })));
});

test('API errors are sanitized and do not leak response or credentials', async () => {
  for (const fetcher of [
    async () => {
      throw new Error('SESSDATA=fixture-only https://signed.example');
    },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ code: -101, message: 'private data' }) }),
  ]) {
    await assert.rejects(
      courseCatalog(mall, settings, fetcher),
      (error) => !/fixture-only|private data|signed.example/.test(error.message)
    );
  }
});
