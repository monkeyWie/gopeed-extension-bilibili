/* eslint-env es6 */
import { Video } from '@renmu/bili-api';
import { enc } from './av2bv.js';

function createVideo() {
  // Keep the SDK's browser UA: anonymous playurl requests without it can require verification.
  return new Video({ cookie: gopeed.settings.cookie?.trim() || undefined }, true);
}

function getBvid(url) {
  const match = url.match(/\/(BV\w{10})/);
  return match ? match[1] : null;
}

function getAid(url) {
  const match = url.match(/\/av(\d+)/);
  return match ? match[1] : null;
}

// Resolve only the short-link redirects; the video page HTML is not needed.
async function resolveVideoURL(rawURL) {
  let url = new URL(rawURL);
  if (url.hostname !== 'b23.tv') return url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetch(url.toString(), { redirect: 'manual', signal: controller.signal });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        throw new MessageError('B站短链未返回有效跳转，请检查链接是否有效。');
      }
      url = new URL(location, url);
      if (!['http:', 'https:'].includes(url.protocol)) break;
      if (url.hostname === 'b23.tv') continue;
      if (
        (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) &&
        url.pathname.startsWith('/video/') &&
        (getBvid(url.pathname) || getAid(url.pathname))
      )
        return url;
      throw new MessageError('该B站短链不是普通视频链接，目前仅支持视频和分P视频。');
    }
    throw new MessageError('B站短链跳转次数过多或跳转地址无效，请使用完整视频链接。');
  } catch (error) {
    if (error instanceof MessageError) throw error;
    throw new MessageError('B站短链解析失败，请检查网络或使用完整视频链接重试。');
  } finally {
    clearTimeout(timer);
  }
}

// https://www.npmjs.com/package/bilibili-api-ts
// https://nemo2011.github.io/bilibili-api/
gopeed.events.onResolve(async (ctx) => {
  requireHostVersion();
  const url = await resolveVideoURL(ctx.req.url);
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
  const filenameId = aid ? `av${aid}` : videoId.bvid;

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
      // Resolve the actual track before naming; a requested quality may fall back.
      const tracks = await mediaTracks(labels);
      labels.selectedQuality = tracks.quality;
      labels.resolution = tracks.resolution;
      const blobUrl = await createMergedURL(labels);
      files.push({
        name: videoFilename(filenameId, info.title, tracks.resolution, isMultiPart ? p + 1 : undefined),
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

function requireHostVersion() {
  // gopeed.host 仅在 Gopeed v2.0.0-beta 及以上版本提供。
  if (!gopeed.host?.env?.version) {
    throw new MessageError('该扩展需要 Gopeed v2.0.0-beta 及以上版本，请升级 Gopeed 后再使用。');
  }
}

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

function videoFilename(id, title, resolution, part) {
  const prefix = `${id}.`;
  const suffix = `${part === undefined ? '' : `(P${part})`}.${resolution}.mp4`;
  const encoder = new TextEncoder();
  // Gopeed truncates filenames to 100 UTF-8 bytes, preserving only the final extension.
  // Reserve the ID, part and resolution first so it never clips those fields.
  let remaining = 100 - encoder.encode(prefix + suffix).length;
  let clippedTitle = '';
  // eslint-disable-next-line no-control-regex -- Control characters are invalid in filenames.
  const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  for (const character of safeTitle) {
    const size = encoder.encode(character).length;
    if (size > remaining) break;
    clippedTitle += character;
    remaining -= size;
  }
  return prefix + clippedTitle + suffix;
}

function trackResolution(track) {
  const width = Number(track.width);
  const height = Number(track.height);
  // Use the short edge for portrait videos as well as landscape videos.
  const pixels = width > 0 && height > 0 ? Math.min(width, height) : height;
  const names = { 1440: '2k', 2160: '4k', 4320: '8k' };
  if (Number.isInteger(pixels) && pixels > 0) return names[pixels] || `${pixels}p`;
  // Some API responses omit dimensions; use the selected quality, never the requested one.
  const resolutions = {
    6: 240,
    16: 360,
    32: 480,
    64: 720,
    74: 720,
    80: 1080,
    112: 1080,
    116: 1080,
    120: 2160,
    125: 1080,
    126: 1080,
    127: 4320,
  };
  const resolution = resolutions[track.id];
  if (resolution) return names[resolution] || `${resolution}p`;
  throw new MessageError('无法确定所选视频轨道的分辨率，请重新解析视频。');
}

function playurlParams(labels) {
  // Ask for the full quality ladder, then apply the user's quality/fallback settings.
  return { bvid: labels.bvid, cid: labels.cid, qn: 127, fnval: dashFlags(), fourk: 1 };
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
  const params = playurlParams(labels);
  const started = Date.now();
  const requestId = `${labels.bvid}/${labels.cid}/${started}`;
  gopeed.logger.debug(
    'Bilibili playurl request',
    JSON.stringify({
      requestId,
      ...params,
      requestedQuality: labels.selectedQuality ?? labels.quality,
      hasCookie: !!cookie,
      userAgent: api.request.defaults.headers['User-Agent'],
    })
  );
  const result = await api.playurl(params);
  // Record the response structure, never Cookie, voucher tokens or signed media URLs.
  gopeed.logger.debug(
    'Bilibili playurl response',
    JSON.stringify({
      requestId,
      elapsedMs: Date.now() - started,
      keys: Object.keys(result || {}),
      format: result?.format,
      quality: result?.quality,
      acceptQuality: result?.accept_quality,
      hasVoucher: !!result?.v_voucher,
      dashKeys: Object.keys(result?.dash || {}),
      videoQualities: result?.dash?.video?.map((track) => track.id),
      audioQualities: result?.dash?.audio?.map((track) => track.id),
      dolbyAudioCount: result?.dash?.dolby?.audio?.length || 0,
      hasFlacAudio: !!result?.dash?.flac?.audio,
      durlCount: result?.durl?.length || 0,
      viewInfoKeys: Object.keys(result?.view_info || {}),
    })
  );
  if (result.v_voucher) {
    throw new MessageError('B站要求风控验证，未返回视频地址。请在浏览器打开该视频完成验证后重试，或更新扩展 Cookie。');
  }
  const quality = labels.selectedQuality ?? labels.quality ?? gopeed.settings.quality;
  const video = selectTrack(result.dash?.video, quality);
  const audio = selectTrack(result.dash?.audio);
  if (!video || !audio) throw new MessageError('该视频未提供可合并的 DASH 音视频轨道，请检查登录状态和画质设置。');
  const resolution = trackResolution(video);
  // A refreshed URL must still match the filename shown when the task was created.
  if (labels.selectedQuality != null && (video.id != labels.selectedQuality || resolution !== labels.resolution)) {
    throw new MessageError('任务创建时的画质已不可用，请检查 Cookie 或重新创建任务以选择当前可用画质。');
  }
  gopeed.logger.debug(
    'DASH quality',
    JSON.stringify({
      requested: quality,
      available: [...new Set(result.dash.video.map((track) => track.id))],
      selected: video.id,
      resolution,
    })
  );
  return { video: mediaURLs(video), audio: mediaURLs(audio), cookie, quality: video.id, resolution };
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
  const { bvid, cid, quality, selectedQuality, resolution } = labels;
  return await gopeed.runtime.blob.createObjectURL(
    async () => {
      const tracks = preparedTracks || (await mediaTracks({ bvid, cid, quality, selectedQuality, resolution }));
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
    await req.setUrl(next);
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
    const videoUrl = await video.playurl(playurlParams(lables));
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
