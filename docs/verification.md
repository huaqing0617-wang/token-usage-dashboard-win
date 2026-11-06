# Verification

This document separates what was executed from what is still an assertion.

## Environment

- Windows 10 Pro 22H2, build 19045 (x64).
- DeepSeek Harness desktop `0.2.2-rc.1` (`ProductVersion 0.2.2.0`).
- Microsoft Edge `156.0.4314.58`, installed at
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`; the
  `App Paths\msedge.exe` registry key resolves to the same path.
- Node.js `v24.21.0` (the runtime bundled with DSH) for the test suite.
- Windows PowerShell 5.1 for the window probe and hide steps.
- Date of the checks below: 2026-11-06.

The unpacked `edge-bridge/` extension was **not** loaded in Edge during this
port's verification. That limits the live claims below; it does not affect the
unit and smoke tests, which use synthetic fixtures.

## Automated Checks

`npm` is not installed on this machine, so the commands from `npm test` were run
directly with the bundled Node:

```powershell
node --check index.js
node --check client.js
node --check usage.js
node --check pricing.js
node --check bridge.js
node --check official-browser.js
node --check edge-bridge/content.js
node --check scripts/verify-official-browser.mjs
node test/official-browser.test.mjs
node test/bridge.test.mjs
node test/extension-smoke.mjs
node test/client-smoke.mjs
```

Observed result: every syntax check passed and every test printed `"ok": true`.

| Test | Coverage | Observed |
|---|---|---|
| `test/official-browser.test.mjs` | Edge candidate paths for stable/Beta/Dev and dedupe, App Paths parsing, resolution order, `--app` and anti-throttling flags, PowerShell script construction, handle injection rejection, probe/hide parsers, Windows `hidden`/`reused`/`no-edge`/`visible`/`failed`/`disabled` states, one-attempt guard, macOS `open -g` and `osascript` parity, unsupported platform | 8 states, 10 candidate paths |
| `test/bridge.test.mjs` | Ingest token gate, CORS/private-network preflight, snapshot normalization | HTTP `204`, token gate `403`, preflight `204` |
| `test/extension-smoke.mjs` | The real content script against a mocked Platform page in **both** a visible and a hidden document: current window, historical window, progressive snapshots, all-time aggregate, key totals, models, balance, bridge POST | 5 posts per scenario; all-time `1850` tokens / `3` requests / `1.5` CNY; coverage complete |
| `test/client-smoke.mjs` | The real browser factory in two scenarios. Official data plus the Windows auto-launch line; and a disconnected Windows bridge with local values, `details.bridgeHelpWin`, and an `autoLaunch: failed` line. Covers both slot registrations, style lifetime, 5-second timer, bar, expanded details, and collapsed launcher. | 2 slots, timer `5000`, 1 style node; disconnected help and failure line both present |

The extension hidden-document case is a regression test for the Windows design:
the Host hides the Edge window, so collection must not wait for
`document.visibilityState === 'visible'`.

## Live Windows Launcher Checks

These were executed on the machine described above, using the real Edge install
and the real Win32 window API. No synthetic browser was substituted.

1. **Edge discovery.** `resolveEdgeExecutable()` returned
   `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` from the
   standard path; the registry query also returned the same path.
2. **Probe.** The generated PowerShell probe found the user's one Edge window and
   reported `PLATFORM_COUNT=0` (no Platform page open).
3. **Hidden launch.** `createOfficialBrowser({ platform: 'win32' }).ensure()`
   returned
   `{"state":"hidden","detail":"hid 1 Edge window(s)"}` in about 6.0 seconds.
   A follow-up probe showed a second Edge window whose title matched DeepSeek,
   and `IsWindowVisible` was false after `ShowWindowAsync(SW_HIDE)`.
4. **No focus steal / no user window change.** The launcher used `--app`, so the
   new window was a separate app window titled `DeepSeek Platform`; the user's
   existing window title was unchanged.
5. **Cleanup.** The test window was closed with `WM_CLOSE`; the next probe
   returned to one Edge window and `PLATFORM_COUNT=0`.
6. **Diagnostic script.** `node scripts/verify-official-browser.mjs` printed the
   resolved Edge path, the window count, and the extension hint.

## Repository Parity

The upstream `token-usage-dashboard-mac` tree on `main` contains 32 tracked
blobs. A tree comparison against this port shows that every upstream file is
still present (some adapted for Windows), and that exactly four files were added:

- `.gitattributes`
- `official-browser.js`
- `scripts/verify-official-browser.mjs`
- `test/official-browser.test.mjs`

No upstream file was dropped.

## Inherited Live Checks (macOS Original)

The upstream macOS project recorded these observations on 2026-11-03. They are
retained as context, not as evidence for this Windows port:

- Direct Node requests to the Platform usage endpoints returned AWS WAF
  challenges (`202`, `x-amzn-waf-action: challenge`) even with a valid Platform
  user token.
- The signed-in Platform summary endpoint returned a valid account session from
  the Edge profile.
- The Host API-key fallback resolved a live CN¥ balance from
  `https://api.deepseek.com/user/balance`.
- Host provider discovery returned two providers and four models with zero
  failures.
- A POST to the loopback bridge returned HTTP `204` with the expected
  normalization.
- The Edge extension was loaded and the dashboard badge changed from `Local` to
  `Official`.
- The first live all-time attempt used monthly endpoints and received WAF
  challenges for older months; the collector was changed to consecutive 30-day
  by-key windows.

## Not Verified

- **Windows end-to-end official sync.** The unpacked extension was not installed
  in Edge during this port, so no real Platform snapshot reached the bridge from
  a browser. The bridge path is covered by the smoke test and the extension
  content script is covered in both visible and hidden documents, but the two
  were not exercised together against the live Platform WAF on Windows.
- **Dashboard render after a DSH restart.** The running DSH instance still had
  the previous Host module loaded while this port was developed. The client
  fixture covers the new auto-launch line, but the desktop window was not
  restarted to display it.
- **Live WAF behaviour on this network.** The extension's Platform endpoints
  were not called from this Windows browser session.
- **All-time completion on Windows.** Covered by the mocked extension test only.
- **GitHub-rendered Mermaid.** The diagrams were reviewed as text, not rendered.
- **GitHub Actions.** No workflow is included, so there is no CI run.

## Reproducing Local Checks

The smoke tests use synthetic fixtures and do not read the user's Platform
account, Session logs, cookies, API keys, or wallet balances:

```powershell
npm test
```

The launcher diagnostic reads the local Edge install and window list:

```powershell
node scripts/verify-official-browser.mjs           # dry run
node scripts/verify-official-browser.mjs --launch  # launch + hide Edge
```

`--launch` leaves the hidden window running so the dashboard can collect. Close
Edge or restart the machine to remove it.

The dashboard's live path additionally requires a DSH desktop profile, a
signed-in Edge Platform session, and the unpacked bridge extension.
