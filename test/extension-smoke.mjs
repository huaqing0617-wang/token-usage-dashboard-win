import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../edge-bridge/content.js', import.meta.url), 'utf8');
const today = new Date();
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
const todayEndSec = Math.floor(todayEnd / 1000);
const olderEndSec = todayEndSec - 30 * 86400;
const currentDate = dayKey(today);
const olderDate = dayKey(new Date((olderEndSec - 86400) * 1000));
const currentBucket = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 1000;
const olderBucket = olderEndSec - 86400;

const manifestCheck = JSON.parse(fs.readFileSync(new URL('../edge-bridge/manifest.json', import.meta.url), 'utf8'));
if (manifestCheck.manifest_version !== 3) throw new Error('manifest version');
if (manifestCheck.version !== '1.1.0') throw new Error(`manifest version ${manifestCheck.version}`);

/**
 * Run the real content script against a mocked Platform page.
 * `visibilityState` is a parameter because the Host keeps the page in a hidden
 * Edge window on Windows; collection must not wait for visibility.
 */
async function runScenario(visibilityState) {
  const store = new Map();
  const posts = [];
  const state = { posted: undefined };
  const sandbox = {
    console,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
    location: { href: 'https://platform.deepseek.com/usage' },
    document: { visibilityState, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem() { return JSON.stringify({ value: 'x'.repeat(64) }); } },
    chrome: {
      storage: {
        local: {
          async get(key) { return { [key]: store.get(key) }; },
          async set(value) { for (const [k, v] of Object.entries(value)) store.set(k, v); },
        },
      },
    },
    fetch: async (url, options) => {
      url = String(url);
      if (url.startsWith('http://127.0.0.1:17654/')) {
        state.posted = JSON.parse(options.body);
        posts.push(state.posted);
        return { ok: true, status: 204 };
      }
      const u = new URL(url, 'https://platform.deepseek.com');
      const endSec = Number(u.searchParams.get('end'));
      if (u.pathname === '/api/v0/users/get_user_summary') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: 'CNY', balance: '100.50' }], bonus_wallets: [{ currency: 'CNY', balance: '5.25' }] } } }) };
      }
      if (u.pathname === '/api/v0/usage/by_api_key/amount') {
        if (endSec === todayEndSec) {
          return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { series: [{ api_key: { tracking_id: 'key-1', name: 'Main key' }, model: 'deepseek-flash', buckets: [{ time: currentBucket, usage: { REQUEST: '2', PROMPT_CACHE_HIT_TOKEN: '1000', PROMPT_CACHE_MISS_TOKEN: '100', RESPONSE_TOKEN: '50' } }] }] } } }) };
        }
        if (endSec === olderEndSec) {
          return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { series: [{ api_key: { tracking_id: 'key-1', name: 'Main key' }, model: 'deepseek-flash', buckets: [{ time: olderBucket, usage: { REQUEST: '1', PROMPT_CACHE_HIT_TOKEN: '700' } }] }] } } }) };
        }
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { series: [] } } }) };
      }
      if (u.pathname === '/api/v0/usage/by_api_key/cost') {
        if (endSec === todayEndSec) {
          return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { data: [{ currency: 'CNY', series: [{ api_key: { tracking_id: 'key-1', name: 'Main key' }, model: 'deepseek-flash', buckets: [{ time: currentBucket, cost: '0.25' }] }] }] } } }) };
        }
        if (endSec === olderEndSec) {
          return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { data: [{ currency: 'CNY', series: [{ api_key: { tracking_id: 'key-1', name: 'Main key' }, model: 'deepseek-flash', buckets: [{ time: olderBucket, cost: '1.25' }] }] }] } } }) };
        }
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: { data: [{ currency: 'CNY', series: [] }] } } }) };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: `content.js (${visibilityState})` });
  const deadline = Date.now() + 5000;
  while (state.posted === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const posted = state.posted;
  if (posted === undefined) throw new Error(`extension did not post a snapshot while document was ${visibilityState}`);

  if (posted.allTime.tokens !== 1850) throw new Error(`${visibilityState}: allTime tokens ${posted.allTime.tokens}`);
  if (posted.allTime.requests !== 3) throw new Error(`${visibilityState}: allTime requests ${posted.allTime.requests}`);
  if (Math.abs(posted.allTime.cost - 1.5) > 1e-9) throw new Error(`${visibilityState}: allTime cost ${posted.allTime.cost}`);
  if (posted.today.tokens !== 1150) throw new Error(`${visibilityState}: today tokens ${posted.today.tokens}`);
  if (posted.today.requests !== 2) throw new Error(`${visibilityState}: today requests ${posted.today.requests}`);
  if (posted.balance.wallets[0].total !== 105.75) throw new Error(`${visibilityState}: balance ${posted.balance.wallets[0].total}`);
  if (posted.apiKeyCount !== 1) throw new Error(`${visibilityState}: apiKeyCount ${posted.apiKeyCount}`);
  if (posted.keys[0].tokens !== 1850) throw new Error(`${visibilityState}: key tokens ${posted.keys[0].tokens}`);
  if (posted.models[0].model !== 'deepseek-flash') throw new Error(`${visibilityState}: model missing`);
  if (posted.coverage.complete !== true) throw new Error(`${visibilityState}: coverage should be complete`);
  if (posts.length < 2) throw new Error(`${visibilityState}: expected progressive snapshots, got ${posts.length}`);

  return { posted, posts: posts.length };
}

const visible = await runScenario('visible');
const hidden = await runScenario('hidden');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    { document: 'visible', posts: visible.posts, allTime: visible.posted.allTime, today: visible.posted.today },
    { document: 'hidden', posts: hidden.posts, allTime: hidden.posted.allTime, today: hidden.posted.today },
  ],
  balance: hidden.posted.balance,
  coverage: hidden.posted.coverage,
}));
