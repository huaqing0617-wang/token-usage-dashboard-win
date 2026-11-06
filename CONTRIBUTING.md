# Contributing

Thanks for improving Token Usage Dashboard. Keep changes narrow and preserve the
two data-plane boundary: official Platform values and local DSH values must not
be silently merged.

## Before Opening a Pull Request

1. Open an issue for a behavior change or a new data source.
2. Run the local checks:

   ```powershell
   npm test
   ```

   On Windows, the launcher can be exercised without DSH:

   ```powershell
   node scripts/verify-official-browser.mjs           # dry run
   node scripts/verify-official-browser.mjs --launch  # launch + hide Edge
   ```

3. Update the relevant document when changing a data source, endpoint, cache
   lifetime, launch behavior, or failure state:
   - `docs/architecture.md`
   - `docs/verification.md`
   - `README.md`

## Windows Launcher Changes

- Keep the launch one-shot per Host session and fail-soft: a blocked PowerShell
  or a missing Edge must never break the dashboard or prevent local data.
- Do not hide windows that existed before the launch or that belong to another
  process.
- Keep `--app` and the anti-throttling flags unless a live Windows check proves
  an equivalent; the hidden page must keep collecting.
- Generated PowerShell may only interpolate validated integers and fixed
  strings.

## Security and Privacy

- Never commit API keys, Platform tokens, cookies, Session logs, wallet
  balances, or private host paths.
- Keep test fixtures synthetic.
- Do not add analytics, tracking pixels, or third-party upload paths.
- Report credential or bridge concerns through the process in `SECURITY.md`,
  not a public issue.

## Scope

This repository is a local DSH bundle plus a browser bridge, not a hosted
service. Changes that require a new server, a public account endpoint, or an
unverified private Platform API must be discussed first.
