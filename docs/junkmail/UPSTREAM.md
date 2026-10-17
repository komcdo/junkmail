# Keeping junkmail on top of upstream T3 Code

junkmail is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The fork has to absorb upstream often, so its code is laid out to keep each merge small and easy for an agent to resolve.

## The rule

Fork code lives in fork-owned files. An upstream file only gets a **hook**: the smallest line that plugs fork code in (an import, a spread, a wrapper), with a `junkmail` comment on it or on the first line of its block.

`node scripts/junkmail/seams.mjs` lists every hook and fails on any change to an upstream file that has no marker. Run it before you commit fork work. If it flags something, move the logic into a fork-owned file and leave a marked one-liner in its place.

Fork-owned locations:

| Layer          | Fork-owned                                                                |
| -------------- | ------------------------------------------------------------------------- |
| Contracts      | `packages/contracts/src/junkmail.ts` (barrel), `inbox.ts`, `inbox.rpc.ts` |
| Server         | `apps/server/src/inbox/`, `apps/server/src/mcp/toolkits/inbox/`           |
| Client runtime | `packages/client-runtime/src/state/inbox.ts`, `inboxAtoms.ts`             |
| Web            | `apps/web/src/components/inbox/`, `apps/web/src/routes/_chat.inbox.tsx`   |
| Mobile         | `apps/mobile/src/features/inbox/`                                         |
| Tooling, docs  | `scripts/junkmail/`, `docs/junkmail/`, `docs/inbox/`                      |

New fork features (pullers, triage, settings pages) follow the same pattern: add a directory, add exports to the `junkmail.ts` barrel, and hook into upstream with marked one-liners.

## Hooks and why each exists

- **RPC surface.** `rpc.ts` spreads `INBOX_WS_METHODS` into `WS_METHODS` and calls `.merge(InboxRpcGroup)` on `WsRpcGroup`. The scope tables (`clientRpcPermissions.ts`, `RpcAuthorization.ts`) and `RpcInstrumentation.ts` each spread one fork constant. `ws.ts` spreads `makeInboxRpcHandlers(inbox)` into its handler table. `rpc/client.ts` adds the subscribe tag to the subscription union.
- **Persistence.** `Sqlite.ts` runs `runInboxMigrations()` after upstream migrations. The fork writes to its own `junkmail_migrations` ledger, because upstream's migrator skips any id at or below the highest recorded one. Never add fork migrations to upstream's list.
- **Services.** `runtimeLayer.ts` provides `InboxService.layer`. `McpHttpServer.ts` registers the inbox toolkit. Two MCP tests mock `InboxService` because the toolkit layer needs it.
- **Client atoms.** `state/server.ts` spreads `createInboxEnvironmentAtoms(runtime)`.
- **Web.** `AppSidebarLayout.tsx` wraps upstream's `<ThreadSidebar />` in `<PrimarySidebar threads={…} />`, which shows the inbox unless the user switches back from the inbox sidebar's menu or the command palette. `_chat.index.tsx` wraps its component in `withInboxLanding`, so `/` opens the inbox instead of auto-starting a draft. `CommandPalette.tsx` spreads `useInboxPaletteActions()`.
- **Mobile.** The Inbox screen is registered in `Stack.tsx`, listed in Settings and the mobile command palette, and gets a `tray` icon mapping.
- **Unmarkable.** `routeTree.gen.ts` is generated (regenerate it; never hand-merge it). `packages/client-runtime/package.json` exports `./state/inbox`.

## Syncing

```sh
scripts/junkmail/sync-upstream.sh
```

The script refuses to run with uncommitted changes. It turns on `git rerere`, fetches `upstream`, and merges `upstream/main` into the current branch. A conflict in `routeTree.gen.ts` is resolved automatically by regenerating it. After the merge it installs, typechecks contracts, client-runtime, server, web, and mobile, runs the inbox tests, and checks the seams.

Merge, don't rebase: a merge resolves each conflict once, and rerere replays it if the same hunk conflicts again.

If conflicts remain, resolve them, `git add` the files, `git commit --no-edit`, then run `scripts/junkmail/sync-upstream.sh --verify`. To back out, use `git merge --abort` during the merge or `git reset --hard ORIG_HEAD` after it.

## Resolving conflicts (instructions for an agent)

1. **Keep upstream's change and re-apply the hook.** A hook is one marked line, so the resolution is almost always "take theirs, then put the `junkmail` line back where it fits."
2. **When upstream renames or moves what a hook targets**, move the hook to the new location. Examples: `WsRpcGroup` gets split, the handler table in `ws.ts` moves, or `<ThreadSidebar />` is renamed. Don't restore the old structure.
3. **Fork files can break without conflicting**, for example when upstream changes a type the fork imports, such as `EnvironmentThreadShell`, `Sidebar.logic` helpers, `useNewThreadHandler`, or `ThreadLaunchService`. Typecheck finds these; fix them in the fork file. Typecheck can't see one dependency: the full-width inbox CSS in `PrimarySidebar.tsx` relies on the `data-slot` names in `components/ui/sidebar.tsx` (`sidebar`, `sidebar-wrapper`, `sidebar-inset`, `sidebar-rail`) and on `data-app-sidebar`. If upstream renames them, update the selectors.
4. **If upstream ships something that overlaps a fork feature** (its own inbox, or new sidebar modes), stop and ask the user before choosing a side.
5. Finish with `scripts/junkmail/sync-upstream.sh --verify`, and confirm `seams.mjs` reports no unmarked changes.
