/* eslint-env es6 */
// Official website APIs. No browser profile, credentials, or signed media URL is stored here.
const mallBase = 'https://mall.bilibili.com/mall-search-items/items/course/';
const cheeseBase = 'https://api.bilibili.com/pugv/';

function serverHint(result) {
  const message =
    typeof result?.message === 'string' ? result.message : typeof result?.msg === 'string' ? result.msg : '';
  // Classify known wording rather than echoing an arbitrary server response, which
  // could include account identifiers, URLs or authentication material.
  const hints = [
    [/csrf/i, 'CSRF 校验'],
    [/未登[录陆]|没有登[录陆]|登录失效|登录过期/, '登录状态无效'],
    [/cookie/i, 'Cookie 校验'],
    [/参数/, '请求参数'],
    [/签名/, '请求签名'],
    [/权限|购买/, '购买或观看权限'],
    [/频繁|风控|验证码/, '网站验证'],
    [/非法|来源|referer|origin/i, '请求来源或合法性校验'],
    [/系统异常/, '服务器系统异常'],
  ]
    .filter(([pattern]) => pattern.test(message))
    .map(([, hint]) => hint);
  return hints.length ? `；服务器提示类型：${hints.join('、')}` : '';
}

function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('课程 ID 超出安全整数范围。');
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('课程链接或接口中的 ID 无效。');
  return text;
}

export function courseTarget(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const cheese = /^(?:\/cheese\/play\/)(ep|ss)(\d+)\/?$/.exec(url.pathname);
  if (['www.bilibili.com', 'bilibili.com'].includes(url.hostname) && cheese) {
    return { source: 'cheese', [cheese[1] === 'ep' ? 'episode' : 'season']: id(cheese[2]) };
  }
  if (url.hostname === 'mall.bilibili.com' && /^\/lesson\/play\/?$/.test(url.pathname)) {
    const target = { source: 'mall' };
    for (const key of ['courseId', 'lessonId', 'itemId']) target[key] = id(url.searchParams.get(key));
    if (url.searchParams.has('sectionId')) target.sectionId = id(url.searchParams.get('sectionId'));
    return target;
  }
  return null;
}

async function request(url, settings, fetcher, body) {
  const isMall = url.startsWith(mallBase);
  const cookie = (isMall ? settings.mallCookie?.trim() || settings.cookie?.trim() : settings.cookie?.trim()) || '';
  const site = isMall ? '会员购' : '课堂';
  if (!cookie)
    throw new Error(`${site}未配置 Cookie，请在扩展设置中填写购买账号的${isMall ? '会员购 Cookie' : '网站 Cookie'}。`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let failure = `${site}接口请求失败，请检查网络或更新${isMall ? '会员购 Cookie' : '网站 Cookie'}。`;
  try {
    const headers = {
      Referer: url.startsWith(mallBase) ? 'https://mall.bilibili.com/' : 'https://www.bilibili.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
    };
    if (isMall) {
      headers.Origin = 'https://mall.bilibili.com';
      headers.Referer = `https://mall.bilibili.com/lesson/play?courseId=${id(body.courseId)}&lessonId=${id(
        body.lessonId
      )}&itemId=${id(body.itemId)}`;
    }
    headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetcher(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      failure = `${site}接口 HTTP ${Number(response.status) || '错误'}；Cookie 已附带，请检查登录状态或网络。`;
      throw new Error();
    }
    const result = await response.json();
    if (result?.code !== 0 || !result.data || typeof result.data !== 'object') {
      const code = Number.isSafeInteger(result?.code) ? result.code : '未知';
      failure = `${site}接口拒绝或返回无效数据（code=${code}，已设置 Cookie 请求头）${serverHint(result)}；请在${
        isMall ? '会员购课程页面' : '课堂页面'
      }确认登录和购买权限后更新 Cookie。`;
      throw new Error();
    }
    return result.data;
  } catch (_) {
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
  }
}

function mallParams(target) {
  return Object.fromEntries(['courseId', 'lessonId', 'itemId'].map((key) => [key, Number(id(target[key]))]));
}

export async function courseCatalog(target, settings, fetcher) {
  let data, entries, title;
  if (target.source === 'cheese') {
    const query = target.episode ? `ep_id=${id(target.episode)}` : `season_id=${id(target.season)}`;
    data = await request(cheeseBase + 'view/web/season?' + query, settings, fetcher);
    if (target.season && id(data.season_id) !== target.season) throw new Error('课程目录与链接不匹配。');
    entries = (data.episodes || []).map((entry, index) => ({
      source: 'cheese',
      episode: id(entry.id),
      cid: id(entry.cid),
      aid: id(entry.aid),
      title: entry.title,
      order: index + 1,
      allowed:
        (data.user_status?.payed === 1 || data.user_status?.payed === true) &&
        data.user_status?.is_expired !== true &&
        (entry.playable === true || entry.playable === 1),
    }));
    if (
      entries.length !== data.ep_count ||
      (target.episode && !entries.some((entry) => entry.episode === target.episode))
    )
      throw new Error('课堂目录未完整返回，不能确认全部课时，请使用其他课程链接或等待接口适配。');
    title = data.title;
  } else {
    data = await request(mallBase + 'h5/detail', settings, fetcher, mallParams(target));
    if (id(data.courseId) !== target.courseId || id(data.lessonId) !== target.lessonId)
      throw new Error('会员购目录与链接不匹配。');
    entries = (data.chapterList || [])
      .flatMap((chapter) => chapter.sectionList || [])
      .map((entry, index) => ({
        ...target,
        sectionId: id(entry.sectionId),
        lessonId: id(entry.lessonId),
        title: entry.sectionName,
        order: index + 1,
        expectedSeconds: Number(entry.videoTime) / 1000,
        allowed: data.hasBought === true && entry.hasWatchRight === true,
      }));
    if (
      entries.length !== data.sectionCount ||
      entries.some((entry) => entry.lessonId !== target.lessonId) ||
      (target.sectionId && !entries.some((entry) => entry.sectionId === target.sectionId))
    )
      throw new Error('会员购课程目录不完整或课时不匹配。');
    title = data.itemsName || data.lessonName;
  }
  if (
    !entries.length ||
    entries.length > 2000 ||
    new Set(entries.map((entry) => entry.episode || entry.sectionId)).size !== entries.length ||
    entries.some((entry) => typeof entry.title !== 'string' || !entry.title.trim())
  )
    throw new Error('课程目录为空或包含无效课时。');
  return { title, entries };
}

function protectedMedia(value) {
  return (
    value &&
    ['drm_type', 'drmType', 'drm_info', 'drmInfo', 'pssh', 'is_drm', 'encrypted'].some(
      (key) => value[key] && value[key] !== '0'
    )
  );
}

export function courseMediaURL(address, mall = false) {
  let url;
  try {
    url = new URL(address);
  } catch (_) {
    throw new Error('课程没有可用的媒体地址。');
  }
  if (url.username || url.password || url.port || url.hash || !url.hostname.endsWith('.bilivideo.com'))
    throw new Error('课程媒体地址不在支持的 CDN 范围内。');
  if (mall && !/^\/mallxcodeboss\/.+\.mp4$/i.test(url.pathname)) throw new Error('会员购未返回普通 MP4。');
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('课程媒体协议不受支持。');
  url.protocol = 'https:';
  return url.href;
}

export async function coursePlayback(labels, settings, fetcher) {
  if (labels.source === 'mall') {
    const data = await request(mallBase + 'section/play/detail', settings, fetcher, {
      ...mallParams(labels),
      sectionId: Number(id(labels.sectionId)),
    });
    if (
      id(data.lessonId) !== id(labels.lessonId) ||
      id(data.sectionId) !== id(labels.sectionId) ||
      data.hasWatchRight !== true
    )
      throw new Error('账号没有本节课程的完整观看权限。');
    if (
      protectedMedia(data) ||
      !(labels.expectedSeconds > 0) ||
      Math.abs(Number(data.videoTime) - labels.expectedSeconds) > 3 ||
      !Number.isFinite(Number(data.videoTime))
    )
      throw new Error('会员购没有提供匹配的普通整节视频。');
    return { direct: courseMediaURL(data.videoUrl, true) };
  }
  const flags = 16 | 2048 | 128 | 1024 | (settings.hdr ? 64 : 0) | (settings.dbs ? 256 | 512 : 0);
  const query = `avid=${id(labels.aid)}&cid=${id(labels.cid)}&ep_id=${id(
    labels.episode
  )}&qn=127&fnval=${flags}&fourk=1`;
  const data = await request(cheeseBase + 'player/web/playurl?' + query, settings, fetcher);
  if (data.has_paid !== true && data.has_paid !== 1) throw new Error('账号没有本节课程的购买权限，请更新扩展 Cookie。');
  if (
    data.is_preview ||
    data.isPreview ||
    (data.play_video_type && data.play_video_type !== 'whole') ||
    protectedMedia(data) ||
    !(data.timelength > 0)
  )
    throw new Error('课堂未提供普通完整课时，不下载试看或加密媒体。');
  if (!data.dash?.video?.length || !data.dash?.audio?.length)
    throw new Error('课堂未返回可合并的音视频轨道，请检查购买权限和 Cookie。');
  for (const track of [...data.dash.video, ...data.dash.audio]) {
    if (protectedMedia(track)) throw new Error('该课程使用受保护的音视频轨道。');
    track.baseUrl = courseMediaURL(track.baseUrl || track.base_url);
    track.backupUrl = (track.backupUrl || track.backup_url || []).map((url) => courseMediaURL(url));
    delete track.base_url;
    delete track.backup_url;
  }
  return data;
}
