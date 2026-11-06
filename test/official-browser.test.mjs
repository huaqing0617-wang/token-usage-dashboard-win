import assert from 'node:assert/strict';
import {
  PLATFORM_USAGE_URL,
  buildEdgeLaunchArgs,
  buildWindowHideScript,
  buildWindowProbeScript,
  candidateEdgePaths,
  createOfficialBrowser,
  parseWindowHide,
  parseWindowProbe,
  queryRegistryEdgePaths,
  resolveEdgeExecutable,
} from '../official-browser.js';

const env = {
  DSH_EDGE_PATH: 'D:\\Edge\\msedge.exe',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};

// Candidate order: explicit override, then x86 (the normal Edge location), then
// 64-bit Program Files, then the per-user install, with no duplicates.
const candidates = candidateEdgePaths(env);
assert.equal(candidates[0], 'D:\\Edge\\msedge.exe');
assert.equal(candidates[1], 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
assert.ok(candidates.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
assert.ok(candidates.includes('C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe'));
assert.ok(candidates.includes('C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe'));
assert.ok(candidates.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));
assert.equal(new Set(candidates.map((value) => value.toLowerCase())).size, candidates.length);
assert.deepEqual(candidateEdgePaths({}), []);

// App Paths parsing.
const registry = await queryRegistryEdgePaths({
  runCommand: async (file) => {
    assert.equal(file, 'reg.exe');
    return { stdout: 'HKEY_LOCAL_MACHINE\\...\\msedge.exe\r\n    (Default)    REG_SZ    C:\\Edge\\msedge.exe\r\n' };
  },
});
assert.deepEqual(registry, ['C:\\Edge\\msedge.exe']);
const registryFailure = await queryRegistryEdgePaths({
  runCommand: async () => {
    throw new Error('reg.exe missing');
  },
});
assert.deepEqual(registryFailure, []);

// Resolution prefers an existing known path and falls back to the registry.
const resolved = await resolveEdgeExecutable({
  env,
  exists: (path) => path === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  queryRegistry: async () => [],
});
assert.equal(resolved, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const fromRegistry = await resolveEdgeExecutable({
  env: {},
  exists: (path) => path === 'D:\\Custom\\msedge.exe',
  queryRegistry: async () => ['D:\\Custom\\msedge.exe'],
});
assert.equal(fromRegistry, 'D:\\Custom\\msedge.exe');
assert.equal(await resolveEdgeExecutable({ env: {}, exists: () => false, queryRegistry: async () => [] }), null);

// Launch flags keep the hidden window awake and use an app window, not a tab.
const args = buildEdgeLaunchArgs();
assert.equal(args[0], `--app=${PLATFORM_USAGE_URL}`);
for (const flag of [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
]) {
  assert.ok(args.includes(flag), `missing ${flag}`);
}

// Generated PowerShell only ever contains validated integer handles.
const probeScript = buildWindowProbeScript();
assert.ok(probeScript.includes('Chrome_WidgetWin_1'));
assert.ok(probeScript.includes('EnumWindows'));
assert.ok(probeScript.includes("$owner.ProcessName -ne 'msedge'"));
const hideScript = buildWindowHideScript({ beforeHandles: [12, 34], timeoutMs: 5000 });
assert.ok(hideScript.includes('$before = @(12,34)'));
assert.ok(hideScript.includes('AddMilliseconds(5000)'));
assert.ok(hideScript.includes('ShowWindowAsync'));
assert.ok(hideScript.includes('IsWindowVisible'));
const sanitized = buildWindowHideScript({ beforeHandles: [1, 'x; Remove-Item -Recurse', 2.5], timeoutMs: -5 });
assert.ok(sanitized.includes('$before = @(1)'));
assert.ok(sanitized.includes('AddMilliseconds(20000)'));

// Output parsers tolerate CRLF and unknown lines.
assert.deepEqual(parseWindowProbe('HANDLES=1,2\r\nPLATFORM_COUNT=1\r\nWINDOW_COUNT=2\r\n'), {
  handles: [1, 2],
  platformWindows: 1,
  windowCount: 2,
});
assert.deepEqual(parseWindowProbe(''), { handles: [], platformWindows: 0, windowCount: 0 });
assert.deepEqual(parseWindowHide('HIDDEN=5\nSKIPPED=6\nVISIBLE=7\nHIDDEN_COUNT=1\n'), {
  hiddenHandles: [5],
  skippedHandles: [6],
  visibleHandles: [7],
});

const logger = { info() {}, warn() {} };

// Windows success: probe, spawn, hide, report.
let spawned = null;
let hideCalls = 0;
const winDeps = {
  listWindows: async () => ({ handles: [10, 11], platformWindows: 0, windowCount: 2 }),
  getEdgePath: async () => 'C:\\Edge\\msedge.exe',
  spawnEdge: (file, launchArgs) => {
    spawned = { file, args: launchArgs };
    return { unref() {}, on() {} };
  },
  hideWindows: async (options) => {
    hideCalls += 1;
    assert.deepEqual(options.beforeHandles, [10, 11]);
    return { hiddenHandles: [12], skippedHandles: [], visibleHandles: [] };
  },
};
const browser = createOfficialBrowser({ platform: 'win32', env: {}, deps: winDeps, logger });
assert.equal(browser.platform, 'win32');
assert.deepEqual(browser.status(), { platform: 'win32', state: 'idle', detail: null, at: 0 });
const status = await browser.ensure();
assert.equal(status.state, 'hidden');
assert.equal(spawned.file, 'C:\\Edge\\msedge.exe');
assert.deepEqual(spawned.args, buildEdgeLaunchArgs());
assert.equal(hideCalls, 1);
// One attempt per Host session, even if ensure() is called again.
assert.equal((await browser.ensure()).state, 'hidden');
assert.equal(hideCalls, 1);

// Existing Platform window: reuse and do not launch.
let reuseSpawned = false;
const reused = await createOfficialBrowser({
  platform: 'win32',
  env: {},
  logger,
  deps: {
    listWindows: async () => ({ handles: [1], platformWindows: 1, windowCount: 1 }),
    spawnEdge: () => {
      reuseSpawned = true;
    },
  },
}).ensure();
assert.equal(reused.state, 'reused');
assert.equal(reuseSpawned, false);

// No Edge installed.
const noEdge = await createOfficialBrowser({
  platform: 'win32',
  env: {},
  logger,
  deps: {
    listWindows: async () => ({ handles: [], platformWindows: 0, windowCount: 0 }),
    getEdgePath: async () => null,
  },
}).ensure();
assert.equal(noEdge.state, 'no-edge');

// Enterprise policy can block PowerShell; the launch fails closed.
const enumerationFailed = await createOfficialBrowser({
  platform: 'win32',
  env: {},
  logger,
  deps: {
    listWindows: async () => {
      throw new Error('Add-Type blocked');
    },
  },
}).ensure();
assert.equal(enumerationFailed.state, 'failed');

// Window opened but could not be identified as ours: report, do not claim hidden.
const visible = await createOfficialBrowser({
  platform: 'win32',
  env: {},
  logger,
  deps: {
    listWindows: async () => ({ handles: [], platformWindows: 0, windowCount: 0 }),
    getEdgePath: async () => 'C:\\Edge\\msedge.exe',
    spawnEdge: () => ({ unref() {}, on() {} }),
    hideWindows: async () => ({ hiddenHandles: [], skippedHandles: [99], visibleHandles: [] }),
  },
}).ensure();
assert.equal(visible.state, 'visible');

// Explicit opt-out.
let disabledSpawned = false;
const disabled = await createOfficialBrowser({
  platform: 'win32',
  env: { DSH_TOKEN_USAGE_NO_AUTO_LAUNCH: '1' },
  logger,
  deps: {
    spawnEdge: () => {
      disabledSpawned = true;
    },
  },
}).ensure();
assert.equal(disabled.state, 'disabled');
assert.equal(disabledSpawned, false);

// macOS parity: an already running Edge gets a background tab via `open -g`.
const macCommands = [];
const macReuse = await createOfficialBrowser({
  platform: 'darwin',
  env: {},
  logger,
  deps: {
    execFile: async (file, commandArgs) => {
      macCommands.push([file, ...commandArgs]);
    },
    spawnEdge: () => ({ unref() {} }),
    sleep: async () => {},
  },
}).ensure();
assert.equal(macReuse.state, 'reused');
assert.deepEqual(macCommands[1], ['open', '-g', '-a', 'Microsoft Edge', PLATFORM_USAGE_URL]);

// macOS parity: a closed Edge is started and hidden with osascript.
const macLaunch = [];
const macHidden = await createOfficialBrowser({
  platform: 'darwin',
  env: {},
  logger,
  deps: {
    execFile: async (file, commandArgs) => {
      macLaunch.push([file, ...commandArgs]);
      if (file === 'pgrep') throw new Error('not running');
    },
    spawnEdge: () => ({ unref() {} }),
    sleep: async () => {},
  },
}).ensure();
assert.equal(macHidden.state, 'hidden');
assert.equal(macLaunch[0][0], 'pgrep');
assert.equal(macLaunch[1][0], 'osascript');

// Unsupported platforms are explicit rather than silently doing nothing.
const unsupported = await createOfficialBrowser({ platform: 'linux', env: {}, logger }).ensure();
assert.equal(unsupported.state, 'unsupported');

console.log(JSON.stringify({ ok: true, candidates: candidates.length, states: [status.state, reused.state, noEdge.state, visible.state, disabled.state, macReuse.state, macHidden.state, unsupported.state] }));
