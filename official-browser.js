/**
 * Automatic Edge context for the official usage plane.
 *
 * DeepSeek Platform usage endpoints sit behind an AWS WAF JavaScript
 * challenge, so the extension must run inside a signed-in Edge page. The Host
 * keeps that context available without hijacking the user's browsing:
 *
 * - Windows: reuse an already open Platform window, otherwise start Edge with
 *   `--app=<usage page>` (a separate app window, not a tab in the user's
 *   window), then hide that new window through Win32 `ShowWindowAsync`. Edge is
 *   started with background throttling disabled so the hidden page keeps
 *   collecting.
 * - macOS: the original behaviour is retained (`open -g` when Edge is already
 *   running, a hidden detached launch otherwise).
 *
 * The launch is one best-effort attempt per Host session. Nothing here touches
 * credentials: the browser keeps the Platform session, and the extension only
 * posts derived aggregates to the loopback bridge.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/usage';
export const WINDOWS_HIDE_TIMEOUT_MS = 20000;

const DARWIN_EDGE_BIN = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DARWIN_EDGE_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-first-run',
];
const execFileAsync = promisify(execFile);

/**
 * Candidate Edge executable paths in priority order.
 * `DSH_EDGE_PATH` wins so an unusual install can be pinned without editing code.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function candidateEdgePaths(env = process.env) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) candidates.push(value);
  };
  add(env.DSH_EDGE_PATH);
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env['ProgramFiles(x86)'];
  const programW6432 = env.ProgramW6432;
  const localAppData = env.LOCALAPPDATA;
  // Stable first, then Beta and Dev: users who run a preview channel still get
  // a working bridge, and the first existing executable wins.
  const channels = ['Edge', 'Edge Beta', 'Edge Dev'];
  for (const root of [programFilesX86, programFiles, programW6432]) {
    if (typeof root !== 'string' || root.length === 0) continue;
    for (const channel of channels) add(join(root, 'Microsoft', channel, 'Application', 'msedge.exe'));
  }
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    for (const channel of channels) add(join(localAppData, 'Microsoft', channel, 'Application', 'msedge.exe'));
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Read `msedge.exe` locations from the Windows App Paths registry keys.
 * Edge is not on PATH; the registry key is the canonical machine-wide record.
 * @param {{ runCommand?: Function }} options
 * @returns {Promise<string[]>}
 */
export async function queryRegistryEdgePaths({ runCommand = execFileAsync } = {}) {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ];
  const found = [];
  for (const key of keys) {
    try {
      const { stdout } = await runCommand('reg.exe', ['query', key, '/ve'], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      for (const line of String(stdout).split(/\r?\n/u)) {
        const match = line.match(/REG_SZ\s+(.+?)\s*$/u);
        if (match !== null) found.push(match[1].replace(/^"|"$/gu, ''));
      }
    } catch {
      // A missing key just means this install location is absent.
    }
  }
  const seen = new Set();
  return found.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve the Edge executable: known directories first, then App Paths.
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (path: string) => boolean, queryRegistry?: Function }} options
 * @returns {Promise<string | null>}
 */
export async function resolveEdgeExecutable({
  env = process.env,
  exists = existsSync,
  queryRegistry = queryRegistryEdgePaths,
} = {}) {
  for (const candidate of candidateEdgePaths(env)) {
    if (exists(candidate)) return candidate;
  }
  let registry = [];
  try {
    registry = await queryRegistry();
  } catch {
    registry = [];
  }
  for (const candidate of registry) {
    if (typeof candidate === 'string' && exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Flags for the hidden collection window.
 * @param {string} url
 * @returns {string[]}
 */
export function buildEdgeLaunchArgs(url = PLATFORM_USAGE_URL) {
  return [
    `--app=${url}`,
    '--window-size=1024,768',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // Windows can mark a hidden window as occluded; keep the renderer awake so
    // the 30-second extension loop continues while the window is invisible.
    '--disable-features=CalculateNativeWinOcclusion',
  ];
}

/** Inline PowerShell helpers shared by the probe and hide scripts. */
const WINDOW_HELPERS = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshTokenUsageWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
'@

function Get-DshEdgeWindows {
  $found = New-Object System.Collections.ArrayList
  $callback = [DshTokenUsageWindows+EnumWindowsProc]{
    param([IntPtr]$windowHandle, [IntPtr]$state)
    $ownerProcessId = 0
    [void][DshTokenUsageWindows]::GetWindowThreadProcessId($windowHandle, [ref]$ownerProcessId)
    if ($ownerProcessId -eq 0) { return $true }
    $classBuffer = New-Object System.Text.StringBuilder 256
    [void][DshTokenUsageWindows]::GetClassName($windowHandle, $classBuffer, 256)
    if ($classBuffer.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
    $owner = Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue
    if ($null -eq $owner) { return $true }
    if ($owner.ProcessName -ne 'msedge') { return $true }
    $titleBuffer = New-Object System.Text.StringBuilder 512
    [void][DshTokenUsageWindows]::GetWindowText($windowHandle, $titleBuffer, 512)
    [void]$found.Add([pscustomobject]@{ Handle = [long]$windowHandle; Title = $titleBuffer.ToString(); Visible = [DshTokenUsageWindows]::IsWindowVisible($windowHandle) })
    return $true
  }
  [void][DshTokenUsageWindows]::EnumWindows($callback, [IntPtr]::Zero)
  return $found
}
`;

/**
 * PowerShell that reports Edge windows and how many already show DeepSeek.
 * @returns {string}
 */
export function buildWindowProbeScript() {
  return `$ErrorActionPreference = 'SilentlyContinue'
${WINDOW_HELPERS}
$windows = @(Get-DshEdgeWindows)
$handles = @($windows | ForEach-Object { $_.Handle })
$platformCount = @($windows | Where-Object { $_.Title -match '(?i)deepseek' }).Count
'HANDLES=' + ($handles -join ',')
'PLATFORM_COUNT=' + $platformCount
'WINDOW_COUNT=' + $windows.Count
`;
}

/**
 * PowerShell that waits for a new Edge window and hides it.
 * Only windows that are new since `beforeHandles`, visible, and either show
 * DeepSeek or look like an app window are touched.
 * @param {{ beforeHandles?: number[], timeoutMs?: number }} options
 * @returns {string}
 */
export function buildWindowHideScript({ beforeHandles = [], timeoutMs = WINDOWS_HIDE_TIMEOUT_MS } = {}) {
  const handles = beforeHandles.filter((handle) => Number.isSafeInteger(handle) && handle > 0);
  const beforeExpression = handles.length > 0 ? `@(${handles.join(',')})` : '@()';
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : WINDOWS_HIDE_TIMEOUT_MS;
  return `$ErrorActionPreference = 'SilentlyContinue'
${WINDOW_HELPERS}
$before = ${beforeExpression}
$deadline = (Get-Date).AddMilliseconds(${timeout})
$hidden = New-Object System.Collections.ArrayList
$lastHide = $null
while ((Get-Date) -lt $deadline) {
  foreach ($window in @(Get-DshEdgeWindows)) {
    if ($before -contains $window.Handle) { continue }
    if ($hidden -contains $window.Handle) { continue }
    if (-not $window.Visible) {
      [void]$hidden.Add([long]$window.Handle)
      $lastHide = Get-Date
      continue
    }
    if ($window.Title.Length -eq 0 -or $window.Title -match '(?i)Microsoft[\\s\\u200b]*Edge\\s*$') {
      'SKIPPED=' + $window.Handle
      continue
    }
    [void][DshTokenUsageWindows]::ShowWindowAsync([IntPtr]$window.Handle, 0)
    Start-Sleep -Milliseconds 250
    if ([DshTokenUsageWindows]::IsWindowVisible([IntPtr]$window.Handle)) {
      'VISIBLE=' + $window.Handle
    } else {
      [void]$hidden.Add([long]$window.Handle)
      $lastHide = Get-Date
      'HIDDEN=' + $window.Handle
    }
  }
  if ($hidden.Count -gt 0 -and $null -ne $lastHide -and ((Get-Date) - $lastHide).TotalMilliseconds -gt 1500) { break }
  Start-Sleep -Milliseconds 400
}
'HIDDEN_COUNT=' + $hidden.Count
`;
}

/**
 * Run an inline PowerShell script with a predictable, non-interactive policy.
 * @param {string} script
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function runPowerShell(script, { timeoutMs = 45000 } = {}) {
  const executables = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh'];
  let lastError;
  for (const executable of executables) {
    try {
      const { stdout } = await execFileAsync(
        executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      );
      return String(stdout);
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw lastError ?? new Error('PowerShell is not available');
}

/**
 * Parse probe output into handles and existing Platform window count.
 * @param {string} stdout
 * @returns {{ handles: number[], platformWindows: number, windowCount: number }}
 */
export function parseWindowProbe(stdout) {
  const result = { handles: [], platformWindows: 0, windowCount: 0 };
  for (const line of String(stdout).split(/\r?\n/u)) {
    const match = line.match(/^(HANDLES|PLATFORM_COUNT|WINDOW_COUNT)=(.*)$/u);
    if (match === null) continue;
    const [, key, raw] = match;
    if (key === 'HANDLES') {
      result.handles = raw
        .split(',')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    } else if (key === 'PLATFORM_COUNT') {
      result.platformWindows = Number.parseInt(raw, 10) || 0;
    } else {
      result.windowCount = Number.parseInt(raw, 10) || 0;
    }
  }
  return result;
}

/**
 * Parse hide output.
 * @param {string} stdout
 * @returns {{ hiddenHandles: number[], skippedHandles: number[], visibleHandles: number[] }}
 */
export function parseWindowHide(stdout) {
  const result = { hiddenHandles: [], skippedHandles: [], visibleHandles: [] };
  for (const line of String(stdout).split(/\r?\n/u)) {
    const match = line.match(/^(HIDDEN|SKIPPED|VISIBLE)=(\d+)$/u);
    if (match === null) continue;
    const handle = Number.parseInt(match[2], 10);
    if (match[1] === 'HIDDEN') result.hiddenHandles.push(handle);
    else if (match[1] === 'SKIPPED') result.skippedHandles.push(handle);
    else result.visibleHandles.push(handle);
  }
  return result;
}

/** Enumerate Edge windows with the Python-free PowerShell helper. */
export async function listEdgeWindows({ run = runPowerShell } = {}) {
  const stdout = await run(buildWindowProbeScript());
  return parseWindowProbe(stdout);
}

/** Wait briefly for the launched window and hide it. */
export async function hideNewEdgeWindows(
  { beforeHandles = [], timeoutMs = WINDOWS_HIDE_TIMEOUT_MS } = {},
  { run = runPowerShell } = {},
) {
  const stdout = await run(buildWindowHideScript({ beforeHandles, timeoutMs }), { timeoutMs: timeoutMs + 20000 });
  return parseWindowHide(stdout);
}

/**
 * Create the one-shot launcher.
 * @param {{
 *   platform?: NodeJS.Platform | string,
 *   env?: NodeJS.ProcessEnv,
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 *   deps?: object,
 * }} options
 */
export function createOfficialBrowser({ platform = process.platform, env = process.env, logger, deps = {} } = {}) {
  let attempted = false;
  let status = { platform, state: 'idle', detail: null, at: 0 };

  const dependencies = {
    runPowerShell,
    getEdgePath: () => resolveEdgeExecutable({ env }),
    listWindows: () => listEdgeWindows(),
    hideWindows: (options) => hideNewEdgeWindows(options),
    spawnEdge: (file, args) => spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }),
    execFile: execFileAsync,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...deps,
  };

  const setStatus = (state, detail = null) => {
    status = { platform, state, detail, at: Date.now() };
    return status;
  };

  const ensureWindows = async () => {
    let probe;
    try {
      probe = await dependencies.listWindows();
    } catch (error) {
      return { state: 'failed', detail: `window enumeration failed: ${String(error)}` };
    }
    if (probe.platformWindows > 0) {
      return { state: 'reused', detail: `found ${probe.platformWindows} existing Platform window(s)` };
    }
    let edgePath = null;
    try {
      edgePath = await dependencies.getEdgePath();
    } catch (error) {
      return { state: 'failed', detail: `Edge lookup failed: ${String(error)}` };
    }
    if (edgePath === null) {
      return { state: 'no-edge', detail: 'Microsoft Edge was not found' };
    }
    let child;
    try {
      child = dependencies.spawnEdge(edgePath, buildEdgeLaunchArgs(PLATFORM_USAGE_URL));
      child?.unref?.();
    } catch (error) {
      return { state: 'failed', detail: `Edge launch failed: ${String(error)}` };
    }
    if (child?.on !== undefined && typeof child.on === 'function') {
      child.on('error', (error) => {
        logger?.warn?.(`token-usage-dashboard: Edge process error: ${String(error)}`);
      });
    }
    let hidden;
    try {
      hidden = await dependencies.hideWindows({ beforeHandles: probe.handles, timeoutMs: WINDOWS_HIDE_TIMEOUT_MS });
    } catch (error) {
      return { state: 'visible', detail: `Edge started but hiding failed: ${String(error)}` };
    }
    if (hidden.hiddenHandles.length > 0) {
      return { state: 'hidden', detail: `hid ${hidden.hiddenHandles.length} Edge window(s)` };
    }
    if (hidden.skippedHandles.length > 0) {
      return { state: 'visible', detail: 'a new Edge window was left visible because it was not recognised' };
    }
    return { state: 'failed', detail: 'Edge started but no new window appeared' };
  };

  const ensureDarwin = async () => {
    let running = false;
    try {
      await dependencies.execFile('pgrep', ['-x', 'Microsoft Edge']);
      running = true;
    } catch {
      running = false;
    }
    if (running) {
      // Open a background tab without activating the user's browser.
      await dependencies.execFile('open', ['-g', '-a', 'Microsoft Edge', PLATFORM_USAGE_URL]);
      return { state: 'reused', detail: 'opened a background Platform tab' };
    }
    const child = dependencies.spawnEdge(DARWIN_EDGE_BIN, [...DARWIN_EDGE_FLAGS, PLATFORM_USAGE_URL]);
    child?.unref?.();
    await dependencies.sleep(4000);
    await dependencies.execFile('osascript', [
      '-e',
      'tell application "System Events" to set visible of process "Microsoft Edge" to false',
    ]);
    return { state: 'hidden', detail: 'started and hid Edge' };
  };

  return {
    platform,
    /** One attempt per Host session; later calls return the recorded status. */
    async ensure() {
      if (attempted) return status;
      attempted = true;
      if (env.DSH_TOKEN_USAGE_NO_AUTO_LAUNCH === '1') {
        return setStatus('disabled', 'DSH_TOKEN_USAGE_NO_AUTO_LAUNCH=1');
      }
      setStatus('launching');
      try {
        const result =
          platform === 'win32'
            ? await ensureWindows()
            : platform === 'darwin'
              ? await ensureDarwin()
              : { state: 'unsupported', detail: `automatic launch is not implemented for ${platform}` };
        const next = setStatus(result.state, result.detail ?? null);
        const message = `token-usage-dashboard: automatic official browser: ${result.state}${result.detail ? ` (${result.detail})` : ''}`;
        if (result.state === 'failed' || result.state === 'no-edge' || result.state === 'visible') logger?.warn?.(message);
        else logger?.info?.(message);
        return next;
      } catch (error) {
        setStatus('failed', String(error));
        logger?.warn?.(`token-usage-dashboard: automatic official browser failed: ${String(error)}`);
        return status;
      }
    },
    /** Snapshot for the dashboard route. */
    status() {
      return { ...status };
    },
  };
}
