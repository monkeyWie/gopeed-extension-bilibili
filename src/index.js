import { Video } from '@renmu/bili-api';
import { enc } from './av2bv.js';

function createVideo() {
  const api = new Video({ cookie: gopeed.settings.cookie?.trim() || undefined }, true);
  // Remove the SDK's browser UA so Gopeed supplies the configured HTTP default.
  delete api.request.defaults.headers['User-Agent'];
  return api;
}

function getBvid(url) {
  const match = url.match(/\/(BV\w{10})/);
  return match ? match[1] : null;
}

function getAid(url) {
  const match = url.match(/\/av(\d+)/);
  return match ? match[1] : null;
}

// https://www.npmjs.com/package/bilibili-api-ts
// https://nemo2011.github.io/bilibili-api/
gopeed.events.onResolve(async (ctx) => {
  const url = new URL(ctx.req.url);
  const videoId = {};
  const bvid = getBvid(url.pathname);
  if (bvid) {
    videoId.bvid = bvid;
  }
  const aid = getAid(url.pathname);
  if (aid) {
    // eslint-disable-next-line no-undef
    videoId.bvid = enc(BigInt(aid));
  }
  if (!videoId.bvid) {
    return;
  }

  requireMergeRuntime();
  const video = createVideo();
  const info = await video.info(videoId);

  // 判断是否为分P视频
  const isMultiPart = info.pages.length > 1;
  // 组装出要下载的视频P数
  let parts = [0];
  if (isMultiPart) {
    // 获取分P参数，如果没有则默认下载所有分P
    const p = url.searchParams.get('p');
    if (!p) {
      parts = Array.from({ length: info.pages.length }, (_, i) => i);
    } else {
      // 如果是指定分p范围，格式为[start]-[end]，例如：?p=1-3 or ?p=1- or ?p=-3
      const arr = p.split('-');
      if (arr.length > 1) {
        let start = parseInt(arr[0]) || 1;
        let end = parseInt(arr[1]) || info.pages.length;
        if (start > end) {
          [start, end] = [end, start];
        }
        parts = Array.from({ length: end - start + 1 }, (_, i) => i + start - 1);
      } else {
        parts = [parseInt(p) - 1];
      }
      // 过滤掉不在范围内的分P
      parts = parts.filter((p) => p >= 0 && p < info.pages.length);
    }
  }

  const files = [];
  try {
    for (const p of parts) {
      const labels = {
        [gopeed.info.identity]: '1',
        bvid: videoId.bvid,
        cid: info.pages[p].cid,
        p,
        type: 'merged',
        quality: gopeed.settings.quality,
      };
      const blobUrl = await createMergedURL(labels);
      files.push({
        name: `${info.title}${isMultiPart ? `(P${p + 1})` : ''}.mp4`,
        req: { url: blobUrl, rawUrl: ctx.req.url, labels },
      });
    }
  } catch (error) {
    for (const file of files) await gopeed.runtime.blob.revokeObjectURL(file.req.url);
    throw error;
  }

  ctx.res = {
    ...(files.length > 1 ? { name: info.title } : {}),
    range: false,
    files,
  };
});

/** @param { import('gopeed').OnStartContext } ctx */
gopeed.events.onStart(async (ctx) => {
  if (ctx.task.meta.req.labels.type === 'merged') {
    await refreshMergedURL(ctx.task);
  } else {
    await updateDownloadUrl(ctx.task);
  }
});

/** @param { import('gopeed').OnErrorContext } ctx */
gopeed.events.onError(async (ctx) => {
  if (ctx.task.meta.req.labels.type === 'merged') {
    const req = ctx.task.meta.req;
    const state = cdnState(req.labels);
    if (state.current && !state.failed.some((pair) => samePair(pair, state.current))) {
      state.failed.push(state.current);
    }
    state.retries++;
    await req.putLabel('mergeCdnState', JSON.stringify(state));
    if (state.retries >= 8) return;
    // Prepare the replacement before continue: restored Blob registrations may
    // have to be resolved before the next onStart event can run.
    await refreshMergedURL(ctx.task);
  } else {
    await updateDownloadUrl(ctx.task);
  }
  await ctx.task.continue();
});

function requireMergeRuntime() {
  if (
    typeof gopeed.runtime?.ffmpeg?.merge !== 'function' ||
    typeof gopeed.runtime?.blob?.createObjectURL !== 'function'
  ) {
    throw new MessageError('音视频合并需要支持 FFmpeg WASM 和 Blob 的 Gopeed 版本，请升级 Gopeed。');
  }
}

function dashFlags() {
  let flags = 16 | 2048 | 128 | 1024;
  if (gopeed.settings.hdr) flags |= 64;
  if (gopeed.settings.dbs) flags |= 256 | 512;
  return flags;
}

function selectTrack(tracks, quality) {
  if (!tracks?.length) return undefined;
  return (
    (quality !== undefined && tracks.find((track) => track.id == quality)) ||
    [...tracks].sort((a, b) => (gopeed.settings.qualityFallback === 'best' ? b.id - a.id : a.id - b.id))[0]
  );
}

function mediaURLs(track) {
  const urls = [track.baseUrl, track.base_url, ...(track.backupUrl || []), ...(track.backup_url || [])];
  const candidates = [];
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      // Different signed URLs on one origin do not represent a new CDN.
      if (candidates.some((entry) => entry.origin === url.origin)) continue;
      candidates.push({
        url: value,
        origin: url.origin,
        priority: url.hostname.startsWith('upos-') && url.hostname.endsWith('.bilivideo.com') ? 0 : 1,
      });
    } catch (_) {
      // Ignore malformed API entries.
    }
  }
  if (!candidates.length) throw new MessageError('该音视频轨道没有可用的 HTTP 下载地址。');
  return candidates.sort((a, b) => a.priority - b.priority);
}

function samePair(a, b) {
  return a.video === b.video && a.audio === b.audio;
}

function cdnState(labels) {
  try {
    const state = JSON.parse(labels.mergeCdnState);
    if (Array.isArray(state.failed) && Number.isInteger(state.retries) && state.retries >= 0) return state;
  } catch (_) {
    // Existing tasks have no CDN history.
  }
  return { failed: [], retries: 0, current: null };
}

async function mediaTracks(labels) {
  const cookie = gopeed.settings.cookie?.trim() || undefined;
  const api = createVideo();
  const result = await api.playurl({ bvid: labels.bvid, cid: labels.cid, fnval: dashFlags(), fourk: 1 });
  const video = selectTrack(result.dash?.video, labels.quality ?? gopeed.settings.quality);
  const audio = selectTrack(result.dash?.audio);
  if (!video || !audio) throw new MessageError('该视频未提供可合并的 DASH 音视频轨道，请检查登录状态和画质设置。');
  return { video: mediaURLs(video), audio: mediaURLs(audio), cookie };
}

function nextPair(tracks, state) {
  const pairs = tracks.video.flatMap((video) =>
    tracks.audio.map((audio) => ({ video: video.origin, audio: audio.origin }))
  );
  // FFmpeg currently reports a job error, not always the failed input. Track
  // combinations so a healthy audio/video CDN is not permanently blacklisted.
  const available = pairs.filter((pair) => !state.failed.some((failed) => samePair(pair, failed)));
  const selected = available.find((pair) => state.current && samePair(pair, state.current)) || available[0];
  if (!selected) throw new MessageError('已尝试所有可用的音视频 CDN 组合，请稍后重新创建任务。');
  return selected;
}

async function createMergedURL(labels, selected, preparedTracks) {
  requireMergeRuntime();
  // Capture serializable task identity; never retain an event/task wrapper in the opener.
  const { bvid, cid, quality } = labels;
  return await gopeed.runtime.blob.createObjectURL(
    async () => {
      const tracks = preparedTracks || (await mediaTracks({ bvid, cid, quality }));
      const cookie = tracks.cookie;
      const pair = selected || nextPair(tracks, { failed: [] });
      const video = tracks.video.find((entry) => entry.origin === pair.video);
      const audio = tracks.audio.find((entry) => entry.origin === pair.audio);
      if (!video || !audio) throw new MessageError('所选 CDN 已不在最新媒体地址列表中，请切换 CDN 重试。');
      const headers = {
        Referer: `https://www.bilibili.com/video/${bvid}`,
      };
      if (cookie) headers.Cookie = cookie;
      return gopeed.runtime.ffmpeg.merge({
        video: { url: video.url, headers },
        audio: { url: audio.url, headers },
      });
    },
    { contentType: 'video/mp4', range: false }
  );
}

async function refreshMergedURL(task) {
  const req = task.meta.req;
  const previous = req.url;
  const state = cdnState(req.labels);
  const tracks = await mediaTracks(req.labels);
  state.current = nextPair(tracks, state);
  const next = await createMergedURL(req.labels, state.current, tracks);
  try {
    await req.putLabel('mergeCdnState', JSON.stringify(state));
    await task.setUrl(next);
  } catch (error) {
    await gopeed.runtime.blob.revokeObjectURL(next);
    throw error;
  }
  if (previous !== next) {
    try {
      await gopeed.runtime.blob.revokeObjectURL(previous);
    } catch (_) {
      // Registrations from a previous Gopeed process no longer exist.
    }
  }
}

// Compatibility with existing separate video/audio tasks.
/** @param { import('@gopeed/types').Task } task */
async function updateDownloadUrl(task) {
  const req = task.meta.req;
  // 如果没有获取过下载链接或者任务状态为错误，则重新获取下载链接
  if (!req.labels.gotDlink || task.status === 'error') {
    const lables = task.meta.req.labels;
    const video = createVideo();
    const fnval = dashFlags();

    const videoUrl = await video.playurl({ bvid: lables.bvid, cid: lables.cid, fnval, fourk: 1 });
    gopeed.logger.debug('video list', JSON.stringify(videoUrl.dash.video));
    const fallbackBest = gopeed.settings.qualityFallback === 'best';
    // 优先匹配指定清晰度，如果没有则按照清晰度排序规则选择第一个
    let downloadUrl;
    if (lables.type === 'video') {
      const targetQuality = lables.quality || gopeed.settings.quality;
      const matchVideo =
        videoUrl.dash.video.find((item) => item.id == targetQuality) ||
        videoUrl.dash.video.sort((a, b) => (fallbackBest ? b.id - a.id : a.id - b.id))[0];
      req.labels.quality = matchVideo.id;
      downloadUrl = matchVideo.baseUrl;
    } else {
      // 按清晰度排序规则选择音频文件
      const matchAudio = videoUrl.dash.audio.sort((a, b) => (fallbackBest ? b.id - a.id : a.id - b.id))[0];
      downloadUrl = matchAudio.baseUrl;
    }

    req.url = downloadUrl;
    req.labels.gotDlink = '1';
  }
}
