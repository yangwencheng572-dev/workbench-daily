// 云端版：小红书抓取（GitHub Actions）—— 大学生/年轻人定位版
// 登录态从环境变量 XHS_COOKIES（JSON 数组字符串）注入，无需本地浏览器
// 失败时不崩溃：把错误信息写入输出 JSON，供 build_daily_cloud.py 生成 alerts
// 云端用 puppeteer（自带 Chromium），本地测试用 puppeteer-core（配合 Edge）
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) { puppeteer = require('puppeteer-core'); }
const fs = require('fs');
const path = require('path');

const OUT = process.env.XHS_OUT || 'data/xhs_hot_raw.json';
const KEYWORDS = ['大学生活', '考研'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseCookies(envStr) {
  if (!envStr) return null;
  try {
    const arr = JSON.parse(envStr);
    if (!Array.isArray(arr)) return null;
    return arr.map(c => ({
      name: c.name, value: c.value, domain: c.domain || '.xiaohongshu.com',
      path: c.path || '/', expires: c.expires || -1,
      secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'Lax'
    }));
  } catch (e) { return null; }
}

function writeError(msg) {
  const result = {
    platform: '小红书',
    fetchedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    error: msg,
    sources: {}
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf-8');
  console.error('[XHS-FAIL]', msg);
}

(async () => {
  const cookies = parseCookies(process.env.XHS_COOKIES);
  if (!cookies) { writeError('XHS_COOKIES 环境变量缺失或格式错误'); process.exit(0); }

  console.log('启动 Chromium...');
  const launchOpts = {
    headless: 'new',
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu']
  };
  // 本地测试时可指定 XHS_EXECUTABLE_PATH（如 Edge），云端默认用 puppeteer 自带 Chromium
  if (process.env.XHS_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.XHS_EXECUTABLE_PATH;
    launchOpts.headless = false;
  }
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 900 });
  page.setDefaultNavigationTimeout(60000);

  // 注入登录态 cookies
  await page.setCookie(...cookies);
  console.log(`已注入 ${cookies.length} 个 cookies`);

  const result = { platform: '小红书', fetchedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), sources: {} };

  for (const kw of KEYWORDS) {
    console.log(`\n--- 搜索：${kw} ---`);
    try {
      await page.goto('https://www.xiaohongshu.com', { waitUntil: 'networkidle2' });
      await sleep(3000);
    } catch (e) { console.log('回首页超时但继续'); }

    // 检测是否被登出（登录弹窗）
    const masked = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      return txt.includes('登录后查看搜索结果') || txt.includes('手机号登录');
    }).catch(() => false);
    if (masked) {
      console.log(`[!] ${kw} 登录态失效（被登出），跳过`);
      result.sources['小红书搜索_' + kw + '_最热'] = { error: '登录态失效，需重新导出 cookies' };
      continue;
    }

    // 搜索：优先搜索框，失败用 URL
    let searched = false;
    for (const sel of ['input[class*="search-input"]', 'input[placeholder*="搜索"]', 'input[type="text"]', '.search input']) {
      const input = await page.$(sel);
      if (input) {
        try {
          await input.click();
          await input.type(kw, { delay: 20 });
          await input.press('Enter');
          searched = true; console.log('通过搜索框提交:', sel); break;
        } catch (e) { console.log('搜索框失败:', e.message); }
      }
    }
    if (!searched) {
      console.log('未找到搜索框，改用 URL');
      await page.goto('https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(kw), { waitUntil: 'networkidle2' }).catch(() => {});
    }
    await sleep(6000);

    // 点击「最热」
    try {
      const tabs = await page.$$('div, span, a');
      for (const t of tabs) {
        const txt = (await t.evaluate(el => (el.textContent || '').trim())).trim();
        if (txt === '最热') { await t.click(); console.log('点击[最热]'); break; }
      }
    } catch (e) {}
    await sleep(4000);

    // 滚动加载
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await sleep(1500);
    }

    // 多策略提取
    const items = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const push = (el) => {
        try {
          const link = el.querySelector('a[href*="/explore/"], a[href*="/search_result/"]') || el.closest('a');
          const href = link ? link.getAttribute('href') : '';
          const m = (href || '').match(/\/(?:explore|search_result)\/([0-9a-f]{16,})/);
          if (!m) return;
          const id = m[1];
          if (seen.has(id)) return; seen.add(id);
          const titleEl = el.querySelector('.title, [class*="title"]') || el.querySelector('span') || el;
          const title = (titleEl.innerText || '').trim().split('\n')[0].slice(0, 80);
          if (!title || title.length < 2) return;
          const authorEl = el.querySelector('.author, [class*="author"], .name');
          const author = authorEl ? (authorEl.innerText || '').trim().split('\n')[0].slice(0, 30) : '';
          const likeEl = el.querySelector('.count, .like, [class*="like"]');
          const likes = likeEl ? likeEl.innerText.trim() : '';
          out.push({ title, author, likes, link: 'https://www.xiaohongshu.com/explore/' + id });
        } catch (e) {}
      };
      document.querySelectorAll('section').forEach(push);
      document.querySelectorAll('div[class*="note"]').forEach(push);
      document.querySelectorAll('div[class*="card"]').forEach(push);
      document.querySelectorAll('a[href*="/explore/"]').forEach(a => {
        const parent = a.closest('section, div[class*="note"], div[class*="card"]') || a.parentElement;
        if (parent) push(parent);
      });
      return out;
    });

    const filtered = items.filter(i => /大学生|考研|宿舍|校园|期末|实习|社团|学习|食堂|图书馆|毕业|面试|课|高考|保研|绩点/.test(i.title));
    console.log(`  抓到 ${items.length} 条，过滤后 ${filtered.length} 条`);
    filtered.slice(0, 5).forEach(i => console.log('   -', i.title.slice(0, 40), '|', i.likes));
    result.sources['小红书搜索_' + kw + '_最热'] = filtered;
  }

  const hasError = Object.values(result.sources).some(v => v && v.error);
  if (hasError) {
    // 部分关键词失败也算整体异常，但保留成功数据
    result.error = '部分关键词抓取失败（登录态可能失效）';
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf-8');
  const total = Object.values(result.sources).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
  console.log(`\n[DONE] 共 ${total} 条，已保存到 ${OUT}`);
  await browser.close();
})().catch(e => { writeError('脚本异常: ' + e.message); process.exit(0); });
