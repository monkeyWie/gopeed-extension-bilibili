// import * as bilibili from 'bilibili-api-ts';
// import { Video } from 'bilibili-api-ts/video.js';
import { Video } from '@renmu/bili-api';

// https://www.npmjs.com/package/bilibili-api-ts
// https://nemo2011.github.io/bilibili-api/
gopeed.events.onResolve(async (ctx) => {
  gopeed.logger.debug('bilibili video', ctx.req.url);
  // 匹配B站bv号 https://www.bilibili.com/video/BV1ej41117VW
  const match = ctx.req.url.match(/\/(BV\w{10})/);
  if (!match) {
    return;
  }
  const bvid = match[1];

  const video = new Video({ cookie: gopeed.settings.cookie }, true);
  const info = await video.info({ bvid });
  const videoUrl = await video.playurl({ bvid, cid: info.pages[0].cid, fnval: 16 | 2048, fourk: 1 });
  const fallbackBest = gopeed.settings.qualityFallback === 'best';
  // 优先匹配指定清晰度，如果没有则按照清晰度排序规则选择第一个
  const matchVideo =
    videoUrl.dash.video.find((item) => item.id == gopeed.settings.quality) ||
    videoUrl.dash.video.sort((a, b) => (fallbackBest ? b.id - a.id : a.id - b.id))[0];
  // 按清晰度排序规则选择音频文件
  const matchAudio = videoUrl.dash.audio.sort((a, b) => (fallbackBest ? b.id - a.id : a.id - b.id))[0];
  // 获取清晰度标签
  const qualityLabel =
    videoUrl.support_formats?.find((e) => e.quality === matchVideo.id)?.display_desc || matchVideo.id;

  gopeed.logger.debug('matchVideo', matchVideo.baseUrl);
  gopeed.logger.debug('matchAudio', matchAudio.baseUrl);

  ctx.res = {
    name: info.title,
    files: [
      {
        name: `video.${qualityLabel}.mp4`,
        req: {
          url: matchVideo.baseUrl,
          extra: {
            header: {
              Referer: 'https://www.bilibili.com/',
            },
          },
        },
      },
      {
        name: `audio.${qualityLabel}.mp4`,
        req: {
          url: matchAudio.baseUrl,
          extra: {
            header: {
              Referer: 'https://www.bilibili.com/',
            },
          },
        },
      },
    ],
  };
});
