import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'archive-data');
// 登录态属于当前 Windows 用户，不能放在项目目录（项目很容易被整体压缩或转发）。
const APP_DATA = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || ROOT, 'DouyinPublicArchive');
const PROFILE = path.join(APP_DATA, 'browser-profile');
const RESUME_FILE = path.join(APP_DATA, 'resume-job.json');
const RECORD_DIRNAME = '_记录'; // 程序运行记录目录，藏在博主文件夹内，平时不用管
const completedUrls = new Set();
const authorCounts = new Map(); // 博主名 -> 本地已归档数量
let activeProfileAuthor = '';
const IMAGE_EXT = /\.(avif|gif|jpe?g|png|webp)(?:$|[?#])/i;
const VIDEO_EXT = /\.(m3u8|mp4|webm|mov)(?:$|[?#])/i;

// ---------- 命令行参数 ----------
const FLAGS_WITH_VALUE = new Set(['--max', '--delay', '--start']);
function option(name, fallback) {
  const pos = process.argv.indexOf(name);
  return pos >= 0 && process.argv[pos + 1] ? process.argv[pos + 1] : fallback;
}
function positional() {
  const args = process.argv.slice(3);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUE.has(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    out.push(args[i]);
  }
  return out;
}

// ---------- 随机节奏（防风控核心：所有等待时间都是区间随机，绝不固定） ----------
function rand(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sleepRand(min, max) { return sleep(rand(min, max)); }

function safePart(value, fallback = '未命名', len = 80) {
  return String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, len) || fallback;
}
function datePart(value) {
  const match = String(value || '').match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const compact = String(value || '').match(/(\d{4})(\d{2})(\d{2})/);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : '';
}
function postDetails(data) {
  const visible = `${data.description}\n${data.pageText}`;
  const publishedAt = visible.match(/发布时间[：:]\s*([^\n]+)/)?.[1]?.trim()
    || data.description.match(/于\s*(\d{4}(?:[\-/]\d{1,2}[\-/]\d{1,2}|\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s*发布/)?.[1]
    || '';
  // 抖音作品页常不提供 meta[name=author]，但 OG 描述稳定包含“作者于日期发布在抖音”。
  const author = data.author
    || data.description.match(/-\s*([^\n]+?)\s*于\s*\d{4}(?:[\-/]\d{1,2}[\-/]\d{1,2}|\d{4}).*?发布在抖音/)?.[1]?.trim()
    || visible.match(/(?:^|\n)([^\n]{1,80}?)\s*于\s*\d{4}(?:[\-/]\d{1,2}[\-/]\d{1,2}|\d{4}).*?发布在抖音/)?.[1]?.trim();
  return { author, publishedAt, publishedDate: datePart(publishedAt) };
}
function unique(items) { return [...new Set(items.filter(Boolean))]; }
function normalizeName(value) { return String(value || '').toLowerCase().replace(/\s+/g, ''); }
function sameAuthor(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  return Boolean(x && y && x === y);
}
function extFrom(url, fallback) {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch { return fallback; }
}
function isPublicContentMedia(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const value = `${host}${parsed.pathname}`.toLowerCase();
    if (host.includes('douyinstatic.com') || host.includes('weboff.byteimg.com')) return false;
    if (value.includes('/uuu_') || value.includes('favicon') || value.includes('pwa_')) return false;
    return host.includes('douyinpic.com') || host.includes('byteimg.com') || host.includes('douyinvod.com') || host.includes('snssdk.com');
  } catch { return false; }
}
async function ensure(dir) { await fs.mkdir(dir, { recursive: true }); }
async function saveJson(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8'); }
function normalizeProfileUrl(value) {
  const url = new URL(value);
  return `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
}
async function loadResumeJob(profileUrl) {
  try {
    const job = JSON.parse(await fs.readFile(RESUME_FILE, 'utf8'));
    return job.projectRoot === ROOT && job.profileUrl === normalizeProfileUrl(profileUrl) && Array.isArray(job.urls) ? job : null;
  } catch { return null; }
}
async function saveResumeJob(job) {
  await ensure(APP_DATA);
  await saveJson(RESUME_FILE, { ...job, updatedAt: new Date().toISOString() });
}
async function clearResumeJob() {
  try { await fs.unlink(RESUME_FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// 读取历史归档记录：兼容旧版（作品子文件夹里的 metadata.json）和新版（_记录/*.json）两种结构。
async function loadCompletedArchives() {
  try {
    const files = await fs.readdir(OUTPUT, { recursive: true });
    for (const file of files) {
      const isLegacy = path.basename(file) === 'metadata.json';
      const isRecord = path.basename(path.dirname(file)) === RECORD_DIRNAME && file.endsWith('.json');
      if (!isLegacy && !isRecord) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(OUTPUT, file), 'utf8'));
        if (data.author) authorCounts.set(data.author, (authorCounts.get(data.author) || 0) + 1);
        if (data.url && Array.isArray(data.media) && data.media.length && data.media.every(item => item.ok)) completedUrls.add(data.url);
      } catch { /* 忽略手工修改或未完成的记录 */ }
    }
  } catch { /* 首次运行没有历史记录 */ }
}
async function download(request, url, file) {
  try {
    const response = await request.get(url, { timeout: 45000 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    await fs.writeFile(file, await response.body());
    return { ok: true, file: path.basename(file) };
  } catch (error) { return { ok: false, error: error.message }; }
}

async function readVisiblePost(page, url) {
  const playedVideos = new Set();
  const onResponse = response => {
    const contentType = response.headers()['content-type'] || '';
    const responseUrl = response.url();
    if (/^video\//i.test(contentType) || /\/aweme\/v\d+\/play|\/playwm|mime_type=video/i.test(responseUrl)) playedVideos.add(responseUrl);
  };
  page.on('response', onResponse);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleepRand(500, 1000); // 模拟真人打开后先看一看
  // 仅触发页面已有播放器的正常播放，让浏览器请求公开视频资源；不构造或破解媒体地址。
  await page.locator('video').evaluateAll(videos => videos.forEach(video => video.play().catch(() => {}))).catch(() => {});
  await sleepRand(1500, 2500); // 继续停留观看，单个作品页面总计约 2-4 秒
  const data = await page.evaluate(() => {
    const val = (selector, attr = 'content') => document.querySelector(selector)?.getAttribute(attr)?.trim() || '';
    const text = document.body?.innerText?.replace(/\n{3,}/g, '\n\n').trim() || '';
    const images = [...document.images].map(x => x.currentSrc || x.src).filter(Boolean);
    const videos = [...document.querySelectorAll('video')].flatMap(v => [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map(s => s.src)]).filter(Boolean);
    const resources = performance.getEntriesByType('resource').map(x => x.name).filter(x => /^https?:/i.test(x));
    const canonical = val('link[rel="canonical"]', 'href') || location.href;
    return {
      title: val('meta[property="og:title"]') || document.title,
      description: val('meta[property="og:description"]') || val('meta[name="description"]'),
      author: val('meta[name="author"]') || '', canonical, pageText: text.slice(0, 12000), images, videos, resources
    };
  });
  page.off('response', onResponse);
  const imageUrls = unique([...data.images, ...data.resources]).filter(url =>
    IMAGE_EXT.test(url) && isPublicContentMedia(url) && /biz_tag=aweme_images|s=PackSourceEnum_AWEME_DETAIL|aweme_images/i.test(url)
  );
  const videoUrls = unique([...playedVideos, ...data.videos, ...data.resources]).filter(url =>
    isPublicContentMedia(url) && (playedVideos.has(url) || VIDEO_EXT.test(url) || /\/aweme\/v\d+\/play|\/playwm|mime_type=video/i.test(url))
  );
  return { ...data, media: [...videoUrls.map(url => ({ url, kind: 'video' })), ...imageUrls.map(url => ({ url, kind: 'image' }))] };
}

async function appendCsv(dir, item) {
  const file = path.join(dir, '作品清单.csv');
  const header = '采集时间,作者,标题,作品链接,文件名\n';
  const quote = v => `"${String(v ?? '').replaceAll('"', '""').replaceAll('\n', ' ')}"`;
  try { await fs.access(file); } catch { await fs.writeFile(file, '\ufeff' + header, 'utf8'); }
  await fs.appendFile(file, [item.archivedAt, item.author, item.title, item.url, item.file].map(quote).join(',') + '\n', 'utf8');
}

// 归档单个作品；checkAuthor 为 true 时校验作者，非目标博主返回 foreign。
async function archiveOne(page, url, { checkAuthor = false } = {}) {
  const data = await readVisiblePost(page, url);
  if (new URL(data.canonical).pathname.startsWith('/user/')) {
    throw new Error('该链接跳转到了博主主页，请使用 profile 命令归档其公开作品。');
  }
  if (completedUrls.has(data.canonical)) {
    console.log(`跳过已完成：${data.title}`);
    return { status: 'skipped' };
  }
  const { author: rawAuthor, publishedAt, publishedDate } = postDetails(data);
  if (!rawAuthor) throw new Error(`无法从作品页识别作者，未归档：${data.canonical}`);
  if (!publishedDate) throw new Error(`无法从作品页识别发布时间，未归档：${data.canonical}`);
  if (checkAuthor && (!activeProfileAuthor || !sameAuthor(rawAuthor, activeProfileAuthor))) {
    return { status: 'foreign', author: rawAuthor, title: data.title };
  }
  const id = (data.canonical.match(/(?:video|note)\/(\d+)/)?.[1]) || crypto.createHash('sha1').update(data.canonical).digest('hex').slice(0, 12);
  const author = safePart(rawAuthor);
  const authorDir = path.join(OUTPUT, author);
  const recordDir = path.join(authorDir, RECORD_DIRNAME);
  await ensure(recordDir);
  // 扁平化命名：发布日期_标题_作品ID，直接放在博主文件夹下，不再建作品子文件夹。
  const base = `${publishedDate}_${safePart(data.title, '作品', 50)}_${id}`;
  const videos = data.media.filter(m => m.kind === 'video');
  const images = data.media.filter(m => m.kind === 'image');
  const downloads = [];
  // 页面常会暴露同一视频的多个清晰度/节点；拿到第一个可用文件便停止，避免重复下载。
  let lastVideoFailure;
  for (const media of videos) {
    const name = `${base}${extFrom(media.url, '.mp4')}`;
    const result = { url: media.url, ...await download(page.context().request, media.url, path.join(authorDir, name)) };
    if (result.ok) { downloads.push(result); break; }
    lastVideoFailure = result;
  }
  if (videos.length && !downloads.some(item => item.ok)) downloads.push(lastVideoFailure);
  let index = 0;
  for (const media of images) {
    index += 1;
    const name = images.length === 1 ? `${base}${extFrom(media.url, '.jpg')}` : `${base}_${String(index).padStart(2, '0')}${extFrom(media.url, '.jpg')}`;
    downloads.push({ url: media.url, ...await download(page.context().request, media.url, path.join(authorDir, name)) });
    await sleepRand(150, 350);
  }
  const metadata = { archivedAt: new Date().toISOString(), publishedAt, publishedDate, author: rawAuthor, title: data.title, description: data.description, url: data.canonical, file: base, media: downloads };
  await saveJson(path.join(recordDir, `${id}.json`), metadata);
  await appendCsv(authorDir, metadata);
  if (downloads.length && downloads.every(item => item.ok)) {
    completedUrls.add(data.canonical);
    authorCounts.set(rawAuthor, (authorCounts.get(rawAuthor) || 0) + 1);
  }
  console.log(`完成：${base}（成功 ${downloads.filter(x => x.ok).length}/${downloads.length} 个媒体）`);
  return { status: 'done' };
}

// 滚动收集主页作品链接。need = 起始位置 + 本批数量，收集够了就停；
// 连续 3 次滚动没有新作品则判定到底/被断供，立即停止（防风控也防抓推荐流）。
async function profileUrls(page, profileUrl, need) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('已打开主页；如需登录或验证码，请在浏览器窗口完成。正在加载公开作品…');
  await sleepRand(1500, 2500);
  activeProfileAuthor = await page.evaluate(() => {
    const title = document.title || '';
    const match = title.match(/^(.+?)的抖音(?:\s|\-|$)/);
    return match?.[1]?.trim() || document.querySelector('meta[name="author"]')?.getAttribute('content')?.trim() || '';
  });
  if (!activeProfileAuthor) throw new Error('无法从主页确认目标博主身份，已停止，避免混入推荐作品。');
  {
    const existing = authorCounts.get(activeProfileAuthor) || 0;
    console.log(`目标博主：${activeProfileAuthor}（本地已归档 ${existing} 个作品，已完成的会自动跳过）`);
  }
  const found = new Set();
  let stagnant = 0;
  let nextRest = rand(8, 12);
  for (let i = 0; i < 200 && found.size < need; i++) {
    const before = found.size;
    try {
      const links = await page.locator('a[href*="/video/"],a[href*="/note/"]').evaluateAll(els => els.map(a => a.href));
      for (const u of links) found.add(u);
    } catch (error) {
      // 页面首屏重定向、登录检查等会短暂销毁 DOM；等待稳定后再扫描。
      if (!/Execution context was destroyed|navigation/i.test(error.message)) throw error;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }
    if (found.size > before) { stagnant = 0; } else {
      stagnant += 1;
      if (stagnant >= 3) {
        console.log(`连续 ${stagnant} 次滚动没有加载出新作品，判定已到作品末尾或触发平台限制，停止收集（共收集到 ${found.size} 条）。`);
        break;
      }
    }
    await page.mouse.wheel(0, rand(1000, 1800));
    await sleepRand(900, 1600);
    if (i + 1 >= nextRest) {
      const rest = rand(3, 6);
      console.log(`已滚动 ${i + 1} 屏，休息 ${rest} 秒再继续…`);
      await sleep(rest * 1000);
      nextRest += rand(8, 12);
    }
  }
  return [...found];
}

async function runProfileBatch(page, profileUrl, start, max) {
  const profileKey = normalizeProfileUrl(profileUrl);
  let job = await loadResumeJob(profileUrl);
  let urls;
  let firstIndex;
  if (job && job.nextIndex < job.urls.length) {
    activeProfileAuthor = job.author;
    urls = job.urls;
    firstIndex = job.nextIndex;
    console.log(`发现未完成任务：${activeProfileAuthor}，从第 ${firstIndex + 1} 个候选链接继续。`);
  } else {
    // 主页会混入推荐链接；先收集更大的候选池，再用作者校验筛出目标作品。
    const need = Math.min(800, Math.max(start - 1 + max, (start - 1 + max) * 4));
    urls = await profileUrls(page, profileUrl, need);
    console.log(`共收集到 ${urls.length} 条候选链接。`);
    if (urls.length < start) {
      console.log(`只加载出 ${urls.length} 条候选链接，不够起始位置第 ${start} 个。`);
      return;
    }
    job = { projectRoot: ROOT, profileUrl: profileKey, author: activeProfileAuthor, urls, nextIndex: start - 1 };
    await saveResumeJob(job);
    firstIndex = job.nextIndex;
  }
  console.log(`开始扫描第 ${firstIndex + 1} 个候选链接，目标归档 ${max} 个已确认属于 ${activeProfileAuthor} 的作品。`);
  let done = 0, skipped = 0, failed = 0, verified = 0;
  for (let i = firstIndex; i < urls.length && verified < max; i++) {
    const seq = i + 1;
    let result;
    try {
      result = await archiveOne(page, urls[i], { checkAuthor: true });
    } catch (error) {
      if (/Target page, context or browser has been closed/i.test(error.message)) throw error;
      console.log(`第 ${seq} 个归档失败：${error.message}；等待后重试一次。`);
      await sleepRand(1000, 1800);
      try {
        result = await archiveOne(page, urls[i], { checkAuthor: true });
      } catch (retryError) {
        if (/Target page, context or browser has been closed/i.test(retryError.message)) throw retryError;
        failed += 1;
        skipped += 1;
        console.log(`第 ${seq} 个仍无法确认，已跳过该条并继续：${retryError.message}`);
        job = { ...job, nextIndex: i + 1 };
        await saveResumeJob(job);
        continue;
      }
    }
    if (result?.status === 'foreign') {
      skipped += 1;
      console.log(`第 ${seq} 个不是目标博主的作品（作者：${result.author || '无法识别'}），已跳过并继续扫描。`);
    } else if (result?.status === 'skipped') {
      skipped += 1;
      verified += 1;
    } else {
      done += 1;
      verified += 1;
    }
    job = { ...job, nextIndex: i + 1 };
    await saveResumeJob(job);
    if (i < urls.length - 1 && verified < max) await sleepRand(1500, 3000);
  }
  console.log(`本批结束：已确认目标作品 ${verified}/${max} 个；新归档 ${done} 个，跳过 ${skipped} 个，失败 ${failed} 个。`);
  if (job.nextIndex >= urls.length) await clearResumeJob();
}
async function main() {
  const command = process.argv[2];
  if (!['archive', 'profile'].includes(command)) throw new Error('用法：npm run archive -- <作品链接> 或 npm run profile -- <主页链接> --start 1 --max 20');
  await ensure(OUTPUT); await ensure(PROFILE);
  await loadCompletedArchives();
  // 某些 Windows 环境已有旧版 Playwright 浏览器，但新版本下载尚未完成。
  // 优先使用当前版本；不可用时只回退到本机已存在的 Chromium，不下载或修改任何系统浏览器。
  let executablePath;
  try { await fs.access(chromium.executablePath()); }
  catch {
    const browserRoot = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright');
    if (browserRoot) {
      const entries = await fs.readdir(browserRoot, { withFileTypes: true });
      const candidates = entries.filter(e => e.isDirectory() && /^chromium-\d+$/.test(e.name)).map(e => path.join(browserRoot, e.name, 'chrome-win64', 'chrome.exe'));
      for (const candidate of candidates.sort().reverse()) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
    }
  }
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1440, height: 900 }, ...(executablePath ? { executablePath } : {}) });
  const page = context.pages()[0] || await context.newPage();
  const start = Math.max(1, Number.parseInt(option('--start', '1'), 10) || 1);
  const max = Math.max(1, Number.parseInt(option('--max', '20'), 10) || 20);
  try {
    if (command === 'archive') {
      const urls = positional(); if (!urls.length) throw new Error('请至少提供一个作品链接。');
      for (const url of urls) {
        // 抖音分享短链可能会落到主页；此时自动切换为主页归档，而不是错误地保存主页装饰资源。
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const resolved = page.url();
        if (new URL(resolved).pathname.startsWith('/user/')) {
          await runProfileBatch(page, resolved, start, max);
        } else {
          try { await archiveOne(page, url); }
          catch (error) { console.log(`归档失败：${error.message}（继续处理下一个）`); }
          await sleepRand(1500, 3000);
        }
      }
    } else {
      const profile = positional()[0]; if (!profile) throw new Error('请提供博主主页链接。');
      await runProfileBatch(page, profile, start, max);
    }
  } finally { await context.close(); }
}

main().catch(error => { console.error(`失败：${error.message}`); process.exitCode = 1; });
