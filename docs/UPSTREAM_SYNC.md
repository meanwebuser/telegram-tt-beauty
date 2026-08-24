# Upstream sync

This checkout is a fork with local product and deployment changes. Updating
from the original project is manageable, but it is not a blind `git pull`:
upstream changes in Telegram Web internals can overlap with our OAuth handoff,
multi-account UI, and generated build output.

## Remotes and roles

`origin` is the repository used for this checkout and `main` is the branch
deployed to the dev host. The original Telegram Web upstream is
`TelegramOrg/telegram-tt`:

```bash
git remote -v
git remote add upstream https://github.com/TelegramOrg/telegram-tt.git
git fetch upstream --prune
```

Do not point the dev service at `/opt/telegram-tt-beauty`. The canonical local
source remains `/opt/telegram-tt-beauty-dev`; see [AGENTS_deploy.md](../AGENTS_deploy.md).

## Safe update sequence

Run this from `/opt/telegram-tt-beauty-dev` after committing or otherwise
preserving local work:

```bash
git fetch upstream --prune
git log --oneline --left-right main...upstream/main
git diff --stat main...upstream/main
```

This fork and `TelegramOrg/telegram-tt` currently have unrelated Git roots, so
there is no merge-base. A direct merge is therefore a large history import,
not a normal small update. Review the changed files and prefer a disposable
compatibility port or a patch series over a blind merge. If a merge is
explicitly approved, the usual safety step is:

```bash
git branch backup/main-before-upstream-$(date +%Y%m%d)
git merge --no-ff upstream/main
npm install
npm run check:ts
npm run build:dev
```

Resolve conflicts in source files, then run the focused UI checks and inspect
the generated bundle. `dist/` is build output and is intentionally not the
place where source changes are merged or reviewed.

## Expected conflict areas

Local changes are most likely to overlap in:

- `src/components/App.tsx`: the small `<BrowserSessionHandoff />` extension
  mount and normal Telegram app lifecycle;
- `src/components/left/main/AccountMenuItems.tsx`: the small
  `getNewAccountLoginUrlIfAvailable(accounts)` policy call;
- `src/global/helpers/misc.ts`: removed Telegram Web account-cap helpers;
- `src/api/gramjs/methods/client.ts`: Telegram client/runtime primitives only;
- `src/extensions/accountSlotPolicy.ts`: unlimited slot selection and first-load
  recovery policy;
- `src/extensions/browserSessionHandoff.ts` and
  `src/extensions/BrowserSessionHandoff.tsx`: browser OAuth token exchange,
  storage markers, account choice, and redirect UI;
- deployment environment and public routing documented in `AGENTS_deploy.md`.

Keep the upstream Telegram UI/runtime changes where they do not conflict, then
re-apply the local product behavior deliberately. Do not resolve a conflict by
accepting all of upstream or all of the fork automatically.

## After a successful sync

1. Run `npm run check:ts` and record any baseline errors separately from new
   errors.
2. Run `npm run build:dev`.
3. Test the local account switcher and the OAuth handoff with a fresh
   `handoff_id`.
4. Deploy only after reviewing the bundle and explicitly approving the dev
   service restart.
5. Verify `https://tgb.example.com/`, `/mcp`, and the OAuth handoff route.

The current audit found about 2,475 changed paths against upstream, including
1,791 generated `dist` paths and 630 source paths. The useful local product
delta is much smaller: MCP/AI modules plus focused changes in `App.tsx`, the
GramJS client handoff, multi-account UI, and account-limit helpers.

Upstream has `plugins/gitInfo.ts`, but it does not provide a general application
extension registry. This fork now has a small `src/extensions/` boundary: OAuth
handoff and account policy live there, while MCP remains in `src/mcp/`. When
syncing upstream, preserve the upstream component/runtime files and port only
the small extension imports/mounts plus any changed extension contracts.

The handoff API intentionally imports the existing client `invokeRequest`
primitive; the client does not import the extension back, so the dependency
direction remains one-way and avoids a runtime cycle.
