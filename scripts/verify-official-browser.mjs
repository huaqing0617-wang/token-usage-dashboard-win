#!/usr/bin/env node
/**
 * Windows diagnostic for the automatic official Edge context.
 *
 *   node scripts/verify-official-browser.mjs           # inspect only
 *   node scripts/verify-official-browser.mjs --launch  # launch and hide Edge
 *
 * `--launch` is the real Host behaviour: it reuses an existing Platform window
 * or starts Edge with an app window and hides it. The hidden window is left
 * running on purpose so the dashboard can keep syncing; close Edge or restart
 * the machine to remove it.
 */

import { createOfficialBrowser, listEdgeWindows, PLATFORM_USAGE_URL, resolveEdgeExecutable } from '../official-browser.js';

const launch = process.argv.includes('--launch');
const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.warn(`[warn] ${message}`),
};

if (process.platform !== 'win32') {
  console.warn(`This diagnostic targets Windows; current platform is ${process.platform}.`);
}

const edgePath = process.platform === 'win32' ? await resolveEdgeExecutable() : null;
let windows = null;
if (process.platform === 'win32') {
  try {
    windows = await listEdgeWindows();
  } catch (error) {
    windows = { error: String(error) };
  }
}

console.log(
  JSON.stringify(
    {
      platform: process.platform,
      edgeExecutable: edgePath,
      platformUsageUrl: PLATFORM_USAGE_URL,
      edgeWindows: windows,
      hint:
        edgePath === null
          ? 'Set DSH_EDGE_PATH to msedge.exe if Edge is installed in a non-standard location.'
          : 'Load the edge-bridge folder at edge://extensions (Developer mode, Load unpacked) once before expecting Official data.',
    },
    null,
    2,
  ),
);

if (!launch) {
  console.log('Dry run only. Re-run with --launch to exercise the hidden Edge launch.');
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.error('--launch is implemented for Windows in this fork.');
  process.exit(2);
}

const browser = createOfficialBrowser({ platform: process.platform, logger });
const status = await browser.ensure();
const after = await listEdgeWindows().catch((error) => ({ error: String(error) }));
console.log(JSON.stringify({ autoLaunch: status, after }, null, 2));
process.exit(status.state === 'hidden' || status.state === 'reused' ? 0 : 1);
