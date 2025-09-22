// import * as bilibili from 'bilibili-api-ts';
// import { Video } from 'bilibili-api-ts/video.js';
import { Video } from '@renmu/bili-api';
import { enc } from './av2bv.js';

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

  const video = new Video({ cookie: gopeed.settings.cookie }, true);
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

  const files = parts.flatMap((p) => {
    const namePrefix = `${info.title}${isMultiPart ? `(P${p + 1})` : ''}`;

    function buildFile(type) {
      /** @type { import('@gopeed/types').FileInfo } */
      const t = { video: 'mp4', audio: 'm4a' };
      return {
        name: `${namePrefix}.${type}.${t[type]}`,
        req: {
          url: ctx.req.url,
          extra: {
            header: {
              Referer: `https://www.bilibili.com`,
            },
          },
          labels: {
            [gopeed.info.identity]: '1',
            bvid: videoId.bvid,
            cid: info.pages[p].cid,
            p,
            type,
          },
        },
      };
    }

    return [buildFile('video'), buildFile('audio')];
  });

  // // 获取清晰度标签
  // const qualityLabel =
  //   videoUrl.support_formats?.find((e) => e.quality === matchVideo.id)?.display_desc || matchVideo.id;

  ctx.res = {
    name: info.title,
    files: files,
  };
});

/** @param { import('gopeed').OnStartContext } ctx */
gopeed.events.onStart(async (ctx) => {
  await updateDownloadUrl(ctx.task);
});

/** @param { import('gopeed').OnErrorContext } ctx */
gopeed.events.onError(async (ctx) => {
  await updateDownloadUrl(ctx.task);

  ctx.task.continue();
});

/** @param { import('@gopeed/types').Task } task */
async function updateDownloadUrl(task) {
  const req = task.meta.req;
  // 如果没有获取过下载链接或者任务状态为错误，则重新获取下载链接
  if (!req.labels.gotDlink || task.status === 'error') {
    const lables = task.meta.req.labels;
    const video = new Video({ cookie: gopeed.settings.cookie?.trim() || undefined }, true);
    // 使用dash格式av1编码，
    let fnval = 16 | 2048;
    // 开启4k
    fnval |= 128;
    // 开启8k
    fnval |= 1024;
    // 开启HDR
    if (gopeed.settings.hdr) {
      fnval |= 64;
    }
    // 开启杜比视界
    if (gopeed.settings.dbs) {
      fnval |= 256;
      fnval |= 512;
    }

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
