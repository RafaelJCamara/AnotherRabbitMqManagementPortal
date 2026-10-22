# Assumptions to review: OQ-653 to OQ-823

Prepared 2026-10-22 by an agent, against `main` at a056296. Agents worked in agile mode this week: they used a working default and logged it as a row in `docs/open-questions.md` instead of stopping. This digest covers all 149 rows from OQ-653 to OQ-823 (the ids 692 to 699, 707 to 709 and 799 to 809 are unused).

How to read it, in about 20 minutes:

- **Section 1** (12 decisions, about 10 minutes): the assumptions that are hard to undo, touch security, trust, an invariant or a budget, or change what a person sees. Each says what the code does today (checked against the code, with `file:line`), why it could be wrong, what overriding it costs, and my recommendation.
- **Section 3** (about 4 minutes): what only you can do, with the exact change.
- **Section 4** (about 4 minutes): rows that contradict each other, rows that are stale, and rows whose default is not what the code does. The discrepancies are the most useful part.
- **Section 2**: every other row, one line each. Skim it and stop at any `med`.

The recommendations are mine. Nothing here decides a question, edits a row, or changes code. Cost scale: small is under a day and local, medium touches a contract or several projects, large changes an architecture or needs a dependency or a human-only path. "Today" means the code on `main`, not only the row.

Already prepared for you elsewhere: [BATCH.md](BATCH.md) and `apply-batch.ps1` hold the vite override, the release-please setting and the CODEOWNERS lines (it notes that the `svc-explorer` line of OQ-653 is already on `main`). Section 3 repeats nothing from it except where a new item depends on it.

## 1. The decisions that matter most

### D1. OQ-783 (with OQ-770, OQ-786): `scope: 'local'` lets six commands past the prod lock

- **Today.** A contract may declare `scope: 'local'` (`libs/shared/contracts/src/kit/define-action.ts:49`). A mutating call then passes the lock only if the contract declares it and the call names no target (`libs/engine/kernel/src/guardrails/policy.ts:268-271`, helper in `libs/engine/kernel/src/actions/local-scope.ts:25`). That check comes after the AI-client refusal (`policy.ts:250-261`), so an AI client still cannot mutate. The executor refuses a local action that names a target (`libs/engine/kernel/src/actions/executor.ts:343`). `checkRegistry` rejects the broker-address field names `cid, connectionId, vhost, qkey, queue, exchange` in the input or path (`libs/shared/contracts/src/kit/invariants.ts:42-89`). Declared on `connections.create`, `bundles.import`, `views.create`, `views.delete`, `settings.put`, `keybindings.put` (`libs/shared/contracts/src/registry/*.ts`). This matches the row.
- **Why it might be wrong.** (1) The field-name list is the only static guard, so a field with another name that addresses a broker passes; a human must review every new `scope: 'local'`. (2) `connections.create` and `bundles.import` save endpoints that the engine later dials, and they need no arming in any environment class, including a profile someone labels prod; the SSRF policy (I-9, issue #221) is not built. (3) The files that carry the rule are not under CODEOWNERS (section 4, item 1), although the row says they are.
- **Cost to override.** Medium (commit b2deda8 touched about 40 files: contracts, kernel, an architecture rule, six HTTP specs).
- **Recommendation.** Keep. Add the CODEOWNERS lines of section 3 A and run the security review of section 3 B before relying on it.

### D2. OQ-784 and OQ-785: a layout save is refused on every connection until it is armed

- **Today.** `layouts.put` names its connection as the target (`libs/shared/contracts/src/registry/layouts-put.ts:25`). The router sends no environment class, so every call counts as prod (OQ-283), so the lock answers 422 `GATE_BLOCKED` until `ops.arm`. The shell keeps the layout in memory, shows the Problem, and a restart restores nothing. `connections.update` and `connections.delete` are locked the same way even for a profile labelled dev (pinned by `libs/testkit/src/http/connections.http.spec.ts:78-96`).
- **Why it might be wrong.** Every first session can see a refused save on the first panel resize. Option (a) of OQ-784 ("drop the target and keep `cid` in the input", described as a one-line change) would fail `checkRegistry`: the input has `cid` (`layouts-put.ts:9`) and the path has `{cid}` (`:26`), both on the forbidden list (`invariants.ts:42-49,73-76`). So (a) is not one line (section 4, item 3).
- **Cost to override.** Small to medium for `layouts.put` (rename the field and route, or allow a second kind of target); medium to large for the root cause, resolving the environment class per target (OQ-283).
- **Recommendation.** Change. Decide between a renamed field for `layouts.put` and a per-target class. Leave `connections.update` and `connections.delete` armed-only.

### D3. OQ-811 to OQ-815: how the local web mode and the container take a launch token

- **Today.** Native mode binds loopback only; any other `--host` is refused (`apps/engine/src/modes/web-binding.ts:52-61`). Container mode binds `0.0.0.0:8765` and prints the publish line `-p 127.0.0.1:...` (`web-binding.ts:63-71,197-223`). A public origin must be a loopback origin (`web-binding.ts:107-112`). The token is `--token-file`, else `APP_TOKEN` or `APP_TOKEN_FILE`, else 32 random bytes; 32 to 512 characters of `A-Za-z0-9_-` (`web-binding.ts:117-143`). The URL carries it after `#t=` (`web-binding.ts:193`); the browser moves it to `sessionStorage` and cleans the address (`libs/ui/platform/src/bootstrap.ts:183-185`). `--open` is off by default (`web-binding.ts:177`).
- **Why it might be wrong.** `APP_TOKEN` is visible to `docker inspect`; a generated token goes to `docker logs`; `sessionStorage` is readable by any script in the page (the CSP and Trusted Types limit that). The banner is wrong when `APP_TOKEN_FILE` is used (section 4, item 6): it tells the person the token came from `APP_TOKEN`.
- **Cost to override.** Small (a refusal in `resolveToken`, one banner fix).
- **Recommendation.** Keep the defaults and fix the banner. Optional: make the container refuse to start without `APP_TOKEN_FILE` (the alternative in OQ-815).

### D4. OQ-816 (commit 7b05e06): `--open` writes the token to a redirect file

- **Today.** To keep the token out of the process list, the engine writes `open.html` (a meta refresh to the launch URL, mode 0600) into a fresh `mkdtemp` directory, hands that path to `rundll32`, `open` or `xdg-open`, and removes the directory after 30 s or when the spawn fails (`apps/engine/src/entry/open-browser.ts:42-54,71-107`). Run by hand once, on Windows only.
- **Why it might be wrong.** On Linux `xdg-open` follows the default handler for `.html`, which may be an editor and not a browser; macOS `open` is untested; the token sits on disk for up to 30 s (user temp directory; mode 0600 on POSIX, not enforced on Windows). A file page redirecting to `http://127.0.0.1` may be blocked by some browsers.
- **Cost to override.** Small (drop `--open`, or serve the redirect from a one-shot listener, which adds a listener).
- **Recommendation.** Keep; the default stays off. Run the two checks of section 3 D before anyone relies on `--open`.

### D5. OQ-769 (with OQ-300, OQ-301, OQ-351): there is no real key story for stored passwords yet

- **Today.** `nx run engine:serve` makes a random key file `tmp/engine-data.kek` (mode 0600) next to the database and passes `--kek-file` (`apps/engine/scripts/serve.mjs:31,49-68`). A `--mode=local` start without `--kek-file` keeps the credential vault locked, because no OS keyring binding is bundled and nothing can type a passphrase (`apps/engine/src/modes/local.ts:5-8,39-44,58-64`); the container banner says connections with stored passwords cannot be used (`web-binding.ts:214-218`).
- **Why it might be wrong.** The file beside the database protects nothing against anyone who can read the directory (the row says so). For users it matters more that anyone who starts the engine any way except `engine:serve` cannot use a connection that has a password. A tester hits this first.
- **Cost to override.** Large (a keyring native dependency, or a passphrase prompt in the UI, plus a protected-path dependency change).
- **Recommendation.** Change, but not now. Pick one first-run story (keyring when present, else a generated key file with a warning, else a passphrase) before showing local mode to anyone beyond you.

### D6. OQ-761 and OQ-762: how the served page gets its CSP nonce and quiets Trusted Types

- **Today.** `apps/web/src/index.html:13,16` carries the nonce placeholder in a `<meta name="csp-nonce">` and on `<app-root ngCspNonce>`; the policy is unchanged. `@app/contracts` calls `z.config({ jitless: true })` only when the page has the `trustedTypes` API (`libs/shared/contracts/src/config/no-dynamic-code.ts:17-23`), and `apps/web/src/main.ts:3` imports it first. The engine in Node keeps the compiled path.
- **Why it might be wrong.** Object schemas in the browser use zod's interpreted parser; nobody measured the cost on 500-row windows. The nonce carrier has not been tried under the desktop `app://` handler (M2-P15, #188).
- **Cost to override.** Small.
- **Recommendation.** Keep. Re-measure when the browser perf run includes real engine answers.

### D7. OQ-701, OQ-757, OQ-781 (3), OQ-690: the grid chunk has its own bundle limit

- **Today.** `tools/web-budgets/check-budgets.mjs:15-32`: initial 350,000 bytes gzip, lazy chunk 200,000, except any chunk that contains the string `ag-root-wrapper`, which may be 240,000. The measured chunk is 219,724 (ADR-021 addendum, status "proposed"). The initial bundle grew to about 194 kB gzip, mostly zod, plus about 10 kB later; the Angular raw-size warning at 500 kB now fires on every production build (`apps/web/project.json:31`).
- **Why it might be wrong.** `.claude/rules/ui.md` and the blueprint still say a feature chunk is at most 200 kB, so the code and the rule disagree. The test is "chunk contains a marker string", so any future chunk with AG Grid inside gets the 240 kB, not only the explorer's. An agent granted this exception, not you.
- **Cost to override.** Small (move the number or change the chunking). A different grid library would be large.
- **Recommendation.** Keep for now; amend the rule text and accept the ADR-021 addendum, or pick another option from OQ-757. Decide before the next feature that shows a grid.

### D8. OQ-665 and OQ-724: the in-process index meets the event-loop budget at 20,000 queues, not at 100,000

- **Today.** The index lives in the engine process (`libs/engine/svc-explorer/src/internal/index.ts`). Limits: 250,000 rows and 128 MiB per connection, 5,000 vhosts per sweep (`libs/engine/svc-explorer/src/deps.ts:55-72`). The synthetic perf harness asserts the loop delay only above the platform's idle floor, at 20,000 queues; at 100,000 it measured a p99 of 47 to 55 ms above the floor against the 20 ms budget of I-5, and the row says the cause "was not taken apart". The M0-48l AC-15 test (OQ-775) now asserts counts of loop turns, not time.
- **Why it might be wrong.** I-5 is a hard invariant and the blueprint put the index in a worker. If a 100,000-queue broker is in scope for the first release, a worker or a chunked build becomes necessary, which is an architecture change.
- **Cost to override.** Large (a worker and a message protocol for windows).
- **Recommendation.** Keep for M0 at 20,000 queues. Open the worker issue now (none exists) and claim no 100,000-queue figure in any doc until the Linux numbers exist (section 3 E).

### D9. OQ-670 and OQ-682 (3): the explorer index is shared, and a subscription checks visibility once

- **Today.** Every principal that may see a connection and holds `broker.read` sees every row of its index; row filtering by `svc-access` does not exist (OQ-670). A topic subscription checks visibility when it subscribes, so a connection made private or deleted later keeps streaming until the client resubscribes (OQ-682 (3)). In local mode the one UI principal may do everything (`apps/engine/src/modes/local.ts:91-92`). Team mode refuses to start in this build (`apps/engine/src/modes/team.ts:7-12`), so nothing is exposed today; but `coreModules` registers the explorer with no mode condition (`apps/engine/src/modules/index.ts:112-142`).
- **Why it might be wrong.** When M3 turns team mode on, the explorer would be served to every principal unless something stops it; the only guard is the row text. A revoked right is honoured late.
- **Cost to override.** Large for row filtering (belongs to `svc-access`); small for a refusal to register the module outside local mode, or a recheck on each install.
- **Recommendation.** Keep for local mode. Add the small guard now (module not registered where row filtering is absent), so M3 cannot expose the index by default.

### D10. OQ-657, OQ-683, OQ-736, OQ-737: the live follow protocol resubscribes while you scroll

- **Today.** The UI names the visible rows in `sub.params.keys` and sends `unsub` then `sub` after the grid's 100 ms settle (`libs/shared/explorer-model/src/window-source.ts:376`). One `sub` carries at most 500 keys and 48 KiB of key text (`libs/shared/explorer-model/src/key-budget.ts:8,20-34`), because the hub closes the whole connection on a client frame over 64 KiB (`libs/engine/live/src/hub.ts:37`), which would drop every other subscription. Keys left out are counted and the page says "live updates paused for N rows". Keys are base64url, so length equals bytes.
- **Why it might be wrong.** Each `sub` costs an access check and a profile read in the engine; nobody measured the resubscribe rate while scrolling (the browser run uses a stand-in socket, OQ-788). Past 48 KiB the lower rows of a screen stop updating.
- **Cost to override.** Medium (a frame that replaces params, or a larger frame limit in the carriers; both touch trust-critical transport or live).
- **Recommendation.** Keep. Measure once with the real topic, then decide between a margin, a longer settle, or a protocol frame.

### D11. OQ-821 and OQ-768: a never-checked connection needs `probe.run`, and a broker 401 looks like an engine 401

- **Today.** The connection form probes once after a successful create (best effort); otherwise the explorer shows a "has not been checked yet" panel with one button that runs `probe.run` (`libs/ui/feature-explorer/src/lib/profile/profile-store.ts`, `probe-prompt.component.ts`). `probe.run` is declared a query (`libs/shared/contracts/src/registry/probe-run.ts:49`, permission `connection.manage`, audit `outcome`) although it dials the broker with the stored login and writes the profile. A broker 401 reaches the page as the same `UNAUTHENTICATED` as a refused launch token (OQ-768).
- **Why it might be wrong.** A "query" that stores state is easy to mistake for a pure read when someone later adds caching or prefetch. The first-run path was never seen against a real engine and broker (the row says "proved with fakes"). No UI signs out on a 401 today (no such handler under `libs/ui` or `apps/web`).
- **Cost to override.** Small to medium (a distinct code for a refused broker login is a contracts and adapter change; probing on demand inside `svc-explorer` needs a probe port).
- **Recommendation.** Keep. Add a distinct broker-auth code before any UI adds a global 401 handler. Run the first-run path once on a seeded lab broker (section 3 D).

### D12. OQ-705: the grid copies broker-controlled text verbatim

- **Today.** `libs/ui/grid/src/clipboard.ts:48-71`: cells are tab-separated and quoted only for a tab, line break or quote; a value starting with `=`, `+`, `-` or `@` is copied as is. A queue, exchange or vhost name is chosen by whoever can create one on the broker, and the copy goes to the system clipboard.
- **Why it might be wrong.** Pasted into a spreadsheet the text can run as a formula (the CSV-injection class). The row leaves it open ("OQ-549 b stays open").
- **Cost to override.** Small (prefix such a value with a quote, or offer a plain-text copy).
- **Recommendation.** Change: neutralise a leading `=`, `+`, `-`, `@`, tab or carriage return in the copy, with a test. The data is not trusted and the fix is small.

## 2. Every other row

Rows covered in section 1 are not repeated: OQ-657, OQ-665, OQ-670, OQ-683, OQ-690, OQ-701, OQ-705, OQ-724, OQ-736, OQ-737, OQ-757, OQ-761, OQ-762, OQ-768, OQ-769, OQ-770, OQ-783 to OQ-786, OQ-811 to OQ-816, OQ-821 (and OQ-682 (3), OQ-781 (3) in part). Risk is low, med or high (none is high). The default is "keep" unless the note says otherwise. "Superseded" and "stale" are explained in section 4.

### Explorer engine: M0-48 and M0-48l

| ID | Area | Working default today | Risk | Note |
| --- | --- | --- | --- | --- |
| OQ-653 | CODEOWNERS | `svc-explorer` is trust-critical, line proposed | low | Line already on main (`CODEOWNERS:34`). Close. |
| OQ-654 | process | Split M0-48 into eight child issues | low | Issues #263 to #271 exist; slices landed whole at 2 to 3 times budget. Label `oversize-approved` or accept (section 3 F). |
| OQ-655 | contract | `inventory.query` windows: `offset`/`limit` (200, max 500) plus a pinned `version` | low | `explorer-types.ts:20,22`. Answer at OQ-546. |
| OQ-656 | UX | Windows from the resident index; first query starts the sweep and answers at once as `loading`; filters apply to loaded rows only | med | A filter on a half-loaded index can look complete. The banner says so. |
| OQ-658 | live | `~version` marker item tells the grid membership changed; refresh at most every 5 s | low | |
| OQ-659 | data | Overview message totals are the sum over the queue sweep, source `queue-sweep` | low | |
| OQ-660 | data | Alarms from node flags then `/api/health/checks/alarms`; unattributed is `unknown`, never none | med | No recording of a raised alarm exists; the shape is assumed. |
| OQ-661 | data | Rates from the broker overview; `unavailable` with a reason otherwise | low | |
| OQ-662 | perf | Sweep per vhost, page 500, with `disable_stats` and `enable_queue_totals` | med | OQ-725: the flags may double broker time on idle queues; not separated. |
| OQ-663 | cadence | `clamp(30 s, 15 min, 50 x last sweep)`, idle stop 10 min, no stored snapshot | low | Matches `deps.ts:60-63`. |
| OQ-664 | budgets | 250,000 rows, 128 MiB, 5,000 vhosts, topic ring 1,000 items and 1 MiB, 2 Hz, window 200/500, search 50 | med | Verified in `deps.ts:55-72` and `explorer-window-topic.ts:63-64`. The memory limits are guesses. |
| OQ-666 | scope | No regex filter; substring plus exact facets | low | The feature text asks for regex. |
| OQ-667 | scope | Kinds: queues, exchanges, connections, bindings; no channels, consumers, policies, users | low | |
| OQ-668 | API | `inventory.query`, `overview.get`, `search.query`, topic `explorer.window`; permission `broker.read`; no MCP or CLI | low | Verified in the contracts. |
| OQ-669 | wiring | Module not wired | low | Superseded: wired by #278. |
| OQ-671 | perf | Window p95 at most 100 ms and loop p99 at most 20 ms at 20,000; CI placement open | low | |
| OQ-672 | evidence | S-13 at 20,000 queues on five versions, 100,000 on two | med | Run on Windows with Docker Desktop, not Linux CI. |
| OQ-673 | design | Copy the 15-line visibility helper rather than lift it to the kernel | low | |
| OQ-674 | data | Policy fields stay absent below 4.2.5; the hazard is named | low | The hazard text disagrees with the recordings; noted in the row. |
| OQ-675 | scope | Ranked substring and prefix search, 50 results | low | p95 about 3.6 ms at 20,000. |
| OQ-676 | process | M0-53 sliced into six parts | low | |
| OQ-677 | grid | Upsert of an unseen id is dropped and counted; `remove` refreshes | low | Superseded by the `refresh` change (OQ-735, OQ-772). |
| OQ-678 | scope | Slice A: queues and exchanges only | low | Superseded: connections (OQ-691), bindings (OQ-686). |
| OQ-679 | cadence | Fixed 60 s between sweeps | low | Superseded by OQ-687. |
| OQ-680 | slice C | Index installs all kinds as one version; `expected` from the broker's `total_count`; stream-queue rows carry no totals | low | Stream totals need a lab recording. |
| OQ-681 | slice D | Alarm check `ok` reads `none`; a failure reads `unknown`; overview asks the sweeper for demand | low | |
| OQ-682 | slice E | Topic item is `{key, version, row without key}`; subscription admitted before the visibility read; visibility checked once | med | Part (3) is D9. |
| OQ-684 | budget | Worst-case snapshot 793,812 bytes (76 % of the 1 MiB frame); with every string at 255 characters 5 % over, which ends the subscription loudly | med | Row schemas do not bound strings. |
| OQ-685 | search | Rank is a word; order is rank, shorter name, key, kind; `toLowerCase` fold | low | |
| OQ-686 | bindings | First query awaits the whole read; 500,000 rows per connection with LRU eviction; 60 s refresh; arguments cut at 512 characters | med | Parts replaced by OQ-688, OQ-721, OQ-730. |
| OQ-687 | cadence | A failed sweep waits by the same formula; idle stop is checked when a wait ends | low | |
| OQ-688 | bindings | Schema accepts bare array and envelope; cap applied after the read | low | Slice H failed on every real broker version until this fix, because a scripted broker hid the shape. Superseded by the stream reader. |
| OQ-691 | connections | One global connection list per sweep; a failure makes the whole index stale | med | A broker that refuses that list to the sweep account would keep queues stale. The capability text and the recording disagree for 4.2.6. |
| OQ-710 | structure | `libs/shared/json-stream`, `type:pure` | low | |
| OQ-711 | dependency | Hand-written reader, no new package | med | It parses untrusted broker bytes. Declining the package is in BATCH. |
| OQ-712 | port | No port or adapter change; reader and glue enforce the byte limit and deadline | low | |
| OQ-713 | kernel | Scheduler's `holdMs` does not abort the body; reader deadline 90 s is below it | low | |
| OQ-714 | answer | A cut read says `dropped` is a minimum and `expected` is absent, with a fixed reason | low | |
| OQ-715 | limits | 256 MiB body, 256 KiB item, 8 MiB envelope, 90 s deadline; fails closed | low | Verified `deps.ts:66-69`. |
| OQ-716 | parsing | Envelope vs bare array told by the first byte | low | |
| OQ-717 | scope | Only bindings use the reader | low | |
| OQ-718 | trust | `json-stream` has no trust tag and no CODEOWNERS line | med | Parses untrusted bytes; BATCH lists it as undecided. |
| OQ-719 | scheduling | Bindings stream on the interactive lane, 2 per connection | low | Verified `deps.ts:70`. |
| OQ-720 | test | Loop-delay assertion on the CI runner | low | Superseded by OQ-775. |
| OQ-721 | process | Stream reader replaces the `maxBodyBytes` proposal | low | Close OQ-688 when you agree. |
| OQ-722 | process | Four child issues for M0-48l | low | #273 to #276 exist. |
| OQ-723 | slice F | Delivered at 2.8 times budget; 100,000 run measures three variants once | low | |
| OQ-725 | evidence | Defaults unchanged after S-13: the broker spends about 14 % of its time on sweeps at 100,000 queues | med | Windows host, idle queues, not a busy broker. |
| OQ-726 | CI | Golden replay, lab run and perf harness are in no workflow | med | The gates exist but nothing runs them on CI. |
| OQ-730 | slice C | Read timeout is `BROKER_UNREACHABLE`; schema check after the body; 64 waiting reads then `BUDGET_EXCEEDED` | low | |
| OQ-731 | slice D | AC-15 asserts added delay over a control run | low | Superseded by OQ-775. |
| OQ-775 | slice D | AC-15 asserts loop-turn counts and bytes per turn; the p99 is printed, not asserted | med | No time budget for the stream reader is asserted anywhere; json-stream AC-7 is the unit gate. |

### Web shell, grid and explorer UI

| ID | Area | Working default today | Risk | Note |
| --- | --- | --- | --- | --- |
| OQ-689 | routing | UI accepts connection ids matching `^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`, else "no connection" | low | An engine id outside that set would be unreachable. |
| OQ-700 | tooling | Grid bundle check lives in `tools/grid-bundle-check` | low | |
| OQ-702 | grid | Adapter owns the selection set; nonce under jsdom unproven | low | |
| OQ-703 | i18n | AG Grid's own ARIA strings stay English | med | An accessibility and translation gap, not listed anywhere else. |
| OQ-704 | grid | Context menu and key chord choices | low | |
| OQ-706 | grid | Column chooser is a disclosure; chooser and status bar always shown | low | |
| OQ-727 | shell | Layout notices include `load-failed`; over-limit documents become the default, not truncated | low | |
| OQ-728 | shell | Tabs: manual activation, delete closes, tree capped at 500 rows | low | |
| OQ-729 | shell | Strict profile parse: an unknown field reads the profile as unknown | low | A UI older than the engine shows no capability; fails closed. |
| OQ-732 | process | M0-54 in ten child issues, proposed not opened | low | Slices landed whole. |
| OQ-733 | wiring | Modules proved against fakes | low | Superseded: wired by #278. |
| OQ-734 | CSP | Browser proofs wait for #277 | low | Superseded: #277 closed. |
| OQ-735 | grid | `refresh` change, `refreshed()` and `sortMode` added to ui-grid | low | Landed (OQ-772). |
| OQ-738 | live | Marker always at the current version; at most one extra reload per sweep | low | |
| OQ-739 | UX | No regex in the UI | low | See OQ-666. |
| OQ-740 | UX | Facet values are typed or static suggestions; no `inventory.facets` action | med | Plugin exchange types and vhosts must be typed by hand. |
| OQ-741 | UX | One sort column | low | |
| OQ-742 | design | Sortable column lists duplicated in `explorer-model`, checked by a testkit spec | low | |
| OQ-743 | data | Saved view `{version: 1, kind, filter, columns}`; replace is create then delete; 200 listed | med | A stored format; changing it later needs a migration. |
| OQ-744 | UX | Save and Delete gated; views answer 422 | low | Stale: views are local now (OQ-783) and the authorizer is wired. |
| OQ-745 | UX | Applying a view on another kind drops, and lists, what does not apply | low | |
| OQ-746 | UX | A restored tab keeps only its address | low | |
| OQ-747 | URL | Routes `/c/:cid/explorer/{queues,exchanges,connections,bindings}` | low | May need a redirect when M1-42 adds object pages. |
| OQ-748 | i18n | `explorer` scope registered by the feature route | low | |
| OQ-749 | UX | Tree is five static nodes, no counts | low | |
| OQ-750 | load | Overview loads on open and on Refresh with a 10 s floor; no polling | low | |
| OQ-751 | scope | Backlogs, DLQ totals, lint highlights and Prometheus rates are not delivered | med | The EXP-02 text lists them; no placeholder. |
| OQ-752 | design | Capability card is built in the feature, duplicated in connections | low | #281 tracks it. |
| OQ-753 | UX | Hazard texts from a UI key table; an unknown id is shown as the id | low | |
| OQ-754 | UX | A missing field reads "not reported"; no menu, no row activation | low | |
| OQ-755 | perf | Interaction time defined as call to first block; p95 300 ms | low | |
| OQ-756 | tests | No `@explorer` Playwright/axe spec; jsdom specs and a manual run instead | med | `.claude/rules/ui.md` asks for axe per feature. Follow-up issue not opened. |
| OQ-758 | a11y | ARIA patterns written locally (aria and cdk are not in the catalog) | med | Swapping needs a dependency decision (OQ-340). |
| OQ-759 | wording | Explorer strings avoid the banned phrases | low | Checked: no hit in the i18n JSON of `libs/ui/*` or `apps/web`. |
| OQ-760 | structure | Plain logic in `libs/shared/explorer-model` | low | |
| OQ-763 | CI | `csp-check` runs in the `affected` job with a required browser | low | `.github/workflows/ci.yml:78-80`. |
| OQ-772 | slice A | Grid deltas, route removed, scope loader, component spec list | low | |
| OQ-773 | slice B | Facets dropped before sending when they do not apply | low | |
| OQ-774 | slice C | The followed set is exactly what the grid reports | low | |
| OQ-776 | slice D | Pages translate via `*transloco`; banner is plain text plus a polite region | low | |
| OQ-777 | slice E | Facet suggestions; filter pause 200 ms | low | |
| OQ-778 | slice F | Gates built from `profile.get` `allowedActions`; page specs get a 20 s timeout; a ui-grid datasource bug fixed | low | |
| OQ-779 | slice G | Refresh floor is a timer | low | |
| OQ-780 | slice H | Each gate read on its own; a source link only if absolute https without credentials | low | |
| OQ-781 | slice I | Shell mounts the explorer by `loadChildren`; two-half i18n proof; no browser run | low | Budget exception is D7. |
| OQ-782 | slice J | Node perf run plus request allow-list; AC-27 browser follow-up | low | Part (4) is stale. |
| OQ-787 | browser proof | Real build under the real CSP, fake data port at the HTTP boundary, stand-in socket; up to 3 attempts, pass if one meets the budget | med | A flaky regression passes on a retry. Blocking in CI. |
| OQ-788 | evidence | What the AC-27 browser run does not prove | low | Partly stale (the engine now registers the module). |
| OQ-789 | UX | A new filter keeps the scroll position | med | Found by the browser run; looks like a bug. Recommend change (small: scroll to row 0 on filter). |
| OQ-798 | tests | Web unit specs run one file at a time | low | `apps/web/vitest.config.mts:10`. |

### Connections UI

| ID | Area | Working default today | Risk | Note |
| --- | --- | --- | --- | --- |
| OQ-790 | routing | Connections page at `/connections`, outside the shell | low | |
| OQ-791 | UX | Create form preselects environment class `dev` (`libs/ui/feature-connections/src/lib/form/form-model.ts:100`) | med | A prod broker saved without a change is labelled dev. Today the class only changes the chrome (OQ-283). Recommend no preselection. |
| OQ-792 | UX | "Same login for AMQP" is on in the create form | low | |
| OQ-793 | UX | Arming state remembered from the UI's own `ops.arm` answer; a reload reads locked | low | Fails closed. |
| OQ-794 | design | Two capability cards | low | #281. |
| OQ-795 | trust | UI builds the lock gate from `envClass` and the `ops.arm` answer | med | AGENTS.md section 9 says the UI never computes authorisation. The engine stays the authority and its 422 is shown as sent. |
| OQ-796 | UX | The switcher falls back to the explorer root with a notice when an address is not a page | low | |
| OQ-797 | process | No human-only action for M0-52 | low | Recorded for the report. |
| OQ-819 | API | `EngineApi.call` makes an `Idempotency-Key` per call for every non-query (`libs/ui/data/src/engine-api.ts:97-100`) | med | One key per `call()`, not per intent: a second click is a new key, so it gives no duplicate protection. It was needed for commands to work at all. |
| OQ-820 | tests | Pointer clicks intermittently swallowed in the Playwright run; undiagnosed | med | Could be the app; M0-60 should reproduce or clear it. |

### Engine wiring, local web mode, first run

| ID | Area | Working default today | Risk | Note |
| --- | --- | --- | --- | --- |
| OQ-764 | pipeline | No `ProfileResolver`: the executor uses `noProfiles` (no fingerprint, no gates on a plan) | med | Fine while every served action is a query or a local command; a hole at the first broker-mutating action. |
| OQ-765 | diagnostics | The bundle lists no broker profiles | low | `compose-core.ts:385`. |
| OQ-766 | drain | Explorer stops in `taps-firehose` for quit, SIGTERM, emergency; not on suspend | low | `modules/index.ts:86,135-141`. |
| OQ-767 | network | Direct route only; TLS trust is the process's; `auth.kind: none` is sent as an empty basic login; a locked vault fails closed | med | A broker with a private CA or a self-signed certificate cannot be reached; no per-profile CA or insecure option (`apps/engine/src/broker/mgmt.ts:42-56,87`). |
| OQ-771 | wiring | Writes, ConnectionManager, re-probe, Prometheus stay unwired | low | Honest about the gap. |
| OQ-810 | location | Local web mode lives in the engine bundle, not `apps/cli` | low | Issue #51 verifies with `nx test cli` and `e2e-web`; neither target exists. |
| OQ-817 | container | Healthcheck is `apps/engine/scripts/healthcheck.mjs` against `/healthz` on 127.0.0.1 | low | `/readyz` exists but would restart a draining container. |
| OQ-818 | container | `--host` in container mode: `0.0.0.0`, `::` or loopback only; `meta.get` still says `local` | low | Verified `web-binding.ts:63-71`. Tests bind the wildcard. |
| OQ-822 | tooling | `testkit:seed-lab` creates vhosts, exchanges, queues, bindings; no messages | low | Not run against a real broker. |
| OQ-823 | UX | Edge states keep the engine's Problem and add one sentence by code; an empty broker says so only when live and complete | low | The sweep failure text is not in the inventory answer. |

## 3. What needs a human

Protected paths, repo settings and anything an agent may not do. "Proposed" means an agent wrote it and did not apply it.

### A. CODEOWNERS (protected path), proposed lines

BATCH.md already adds the scheduler, ports, broker-lab, testkit, arch-tests and workflow-actions lines. These are not in it:

```text
/libs/engine/kernel/src/guardrails/                     @RafaelJCamara
/libs/shared/contracts/src/kit/                         @RafaelJCamara
/apps/engine/src/modes/                                 @RafaelJCamara
/apps/engine/src/entry/                                 @RafaelJCamara
/apps/engine/src/broker/                                @RafaelJCamara
```

Reasons: the prod lock policy and the `scope: 'local'` rule (D1), the launch token and bind rules (D3), the opener (D4), and the code that opens stored broker logins (D11, OQ-767). Optional, from OQ-718: `/libs/shared/json-stream/ @RafaelJCamara`. The choice of paths is yours. CODEOWNERS acts only on pull requests (BATCH.md section 4), so without PRs the lines matter once outside contributors open them.

### B. Reviews of trust-critical commits landed without a human review

None of these had `/review-wp` or the adversarial pass that CLAUDE.md asks for trust-critical work. Suggested order:

| Commit | What | Look at |
| --- | --- | --- |
| b2deda8 | `scope: 'local'` in kernel and contracts | `policy.ts:249-277`, `local-scope.ts`, `executor.ts:341-348`, `invariants.ts:40-89`, `tools/arch-tests/src/rules.ts` (a syntactic check) |
| e9b3353, 148d4d6, 05a7e84 | M0-59 local web mode, container runtime, healthcheck, runbook | `apps/engine/src/modes/web-binding.ts`, `local.ts`, `entry/env.ts`, `entry/args.ts` |
| 7b05e06 (with e9b3353) | `--open` opener | `apps/engine/src/entry/open-browser.ts` |
| 0203d1c | Engine wiring: service modules, topics, drain | `apps/engine/src/broker/endpoints.ts`, `mgmt.ts`, `connection-prober.ts` (they read stored logins) |
| f38cdd8, 230eb88 | CSP nonce, `jitless`, launch-token fragment | `libs/shared/contracts/src/config/no-dynamic-code.ts`, `libs/ui/platform/src/bootstrap.ts` |
| 261630e, 7746a33 | CI steps for the browser proofs | `.github/workflows/ci.yml:76-87` (CODEOWNERS covers workflows) |

Security-review pass (the `security-review` skill reviews the pending changes of the branch it runs on). Proposed recipe for the first row; repeat per commit:

```powershell
git worktree add ../wt/sec-scope-local -b review/sec-scope-local b2deda8~1
git -C ../wt/sec-scope-local cherry-pick -n b2deda8
# in a fresh session started in ../wt/sec-scope-local: /security-review
```

Questions for the reviewer of b2deda8: can any local action reach a broker port; is the field-name guard enough; does `bundles.import` carry anything that gets dialled before the SSRF policy exists.

### C. Repository settings and CI

- release-please cannot open its PR. Tick Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests", or run the command in BATCH.md section 2. The latest `release-please` run on main failed again today (run 39756845644).
- `osv-scanner` is red on main (scheduled run 39762366263 today): the vite override of BATCH.md section 1. The `ignoreUntil` dates in `osv-scanner.toml` expire 2026-11-14 (OQ-40).
- Decide whether the browser perf step (`ci.yml:85`, OQ-787) stays blocking now that a failed timing is retried up to three times; the OQ-720 precedent would make a timing miss a printed measurement.

### D. Checks only a person can run

- **macOS and Linux `--open` (OQ-816).** On each: `pnpm nx run engine:serve -- --open`. Expected: the default browser opens and shows the app, the address bar ends without a token once the page has loaded, and no `app-open-*` directory remains in the temp folder after 30 s. On Linux also check that `xdg-mime query default text/html` names a browser. Record the result in the OQ-816 row.
- **Real browser against the real engine and a lab broker.** `pnpm nx run testkit:seed-lab` (needs Docker), connect, press "Check capabilities and load", then scroll and filter the queue list. No test has run this path end to end (OQ-821, OQ-822, OQ-788).

### E. Lab recordings and Docker or Linux runs (agents cannot do these)

| Run | Command | Closes |
| --- | --- | --- |
| Explorer against 20,000 queues | `pnpm nx run svc-explorer:it '--versions=4.2.9,4.3.6'` | OQ-672, OQ-726 |
| 100,000 queues on Linux | `IT_QUEUES=100000 pnpm nx run svc-explorer:it '--versions=4.2.9,4.3.6'` | OQ-725, D8 |
| Composed engine against a lab broker | `pnpm nx run engine:it` | OQ-771 |
| Golden re-record check | `pnpm nx run adapter-mgmt-http:record-golden --versions=4.3.6 --check` | OQ-686 (8) |
| New recordings wanted | a raised alarm (OQ-660); a stream queue with statistics off (OQ-680); `/api/connections` with a connection open, with and without `disable_stats`, on 4.2.6 or later (OQ-691 (8)) | those rows |

Nothing here touches `testing/lab-evidence/**`; recordings go through `record-golden` and CI.

### F. Issues

- Landed work whose child issues are still open (verify the acceptance criteria, then close): #263 to #271 (M0-48 slices B to J: fc3be45, 6d42494, 6645fbb, c9d2111, 4458d3e, 2c38d5d, 7208f4f, 33e325d, 1b9cb87) and #273 to #276 (M0-48l: a14a07e, e563c1c, 64acd52, a23c84c). Keep the parents #44 (M0-48) and #272 open until the Linux runs of section 3 E exist. #48 (M0-52), #49 (M0-53) and #50 (M0-54) are open with all slices landed; keep them until the `@explorer` Playwright and axe spec exists.
- Closed but not fully verified: #51 (M0-59) is closed although its verification commands (`pnpm nx test cli`, `pnpm nx e2e e2e-web --grep=@local-security`) do not exist (OQ-810). The `@local-security` cases belong to #52 (M0-60), still open. Consider a comment on #51.
- Oversize: `gh issue edit 44 --add-label oversize-approved` (and #48, #49, #50, #272) if you accept the 2 to 3 times overruns (OQ-654, OQ-722, OQ-732). The label may not exist; check `gh label list`.
- No issue yet for these (check before opening): the `@explorer` Playwright and axe spec (OQ-756, OQ-782); a worker or chunked index for 100,000 queues (D8); a distinct broker-login-refused code (OQ-768); `layouts.put` and the per-target environment class (D2, OQ-283); a bounded `inventory.facets` action (OQ-740); a scroll reset on filter (OQ-789); the kernel stream-abort watchdog (OQ-713); a guard so that only local mode registers `svc-explorer` (D9); copy neutralisation (D12).

### G. Dependencies

No row in range needs a new package. OQ-711 (a streaming JSON package) is optional and the default declines it. The UI packages of OQ-340 and OQ-758 are already in BATCH.md section 3.

## 4. Contradictions, stale rows, and rows that do not match the code

### Where the code differs from the row (most useful)

1. **OQ-783 says CODEOWNERS covers the kernel and the contracts. It does not cover the files the change touched.** `CODEOWNERS:35` has only `/libs/engine/kernel/src/actions/`. The policy that grants the exemption, `libs/engine/kernel/src/guardrails/policy.ts`, and the contract rules, `libs/shared/contracts/src/kit/define-action.ts` and `invariants.ts`, have no owner line, and the batch script does not add one. Fix: section 3 A.
2. **OQ-744 and OQ-782 (4) say `views.create` and `views.delete` answer 422 `GATE_BLOCKED`.** They are `scope: 'local'` now (`views-create.ts:33`, `views-delete.ts:24`) and the router test expects success (`libs/testkit/src/explorer-ui/explorer-calls.spec.ts:117-137`). OQ-744 also says the `allowedActions` gate is deny-all until the authorizer is wired; local mode wires `allowUiPrincipals()` (`apps/engine/src/modes/local.ts:91`, `modules/index.ts:106`).
3. **OQ-784's option (a) ("a one-line change plus a test") cannot pass the check OQ-783 added.** Keeping `cid` in the input of `layouts.put`, or in its path, is rejected by `checkLocalScope` (`libs/shared/contracts/src/kit/invariants.ts:42-49,73-76`). The input has `cid` (`layouts-put.ts:9`) and the path has `{cid}` (`:26`).
4. **OQ-787 (2), OQ-788 and OQ-733 say the engine registers no explorer module or that nothing owns the wiring.** `apps/engine/src/modules/index.ts:112-142` registers it with its topic and drain phase (#278, OQ-764 to OQ-771). OQ-669 was updated; these three were not.
5. **OQ-737 mentions an interim "at most 60 ids".** The code has the 48 KiB and 500-key rule (`key-budget.ts:8`).
6. **OQ-812 and OQ-813 say the log and the banner report where the token came from, with `APP_TOKEN_FILE` as the safer file form.** The environment layer reads `APP_TOKEN_FILE` through the kernel's `*_FILE` handling (`libs/engine/kernel/src/config/layers.ts:135`), so `resolveToken` sees an env token and reports source `env` (`web-binding.ts:131-135`). So a container started with `APP_TOKEN_FILE` logs `authSource: env` (`local.ts:70-77`), the banner prints "comes from APP_TOKEN, which docker inspect can show" (`web-binding.ts:221`), and a weak token in the file is reported as an `APP_TOKEN` problem (`web-binding.ts:139`). Cosmetic, but it tells the person the opposite of what they did. The test checks only the value (`web-binding.spec.ts:166-169`).
7. **OQ-810 and issue #51.** The row says the issue verifies with `nx test cli` and `e2e-web`; neither target exists, and #51 is closed.
8. **OQ-763: the CI step is conditional.** The row says it runs in the `affected` job, and it does (`ci.yml:78-80`), so a change that affects nothing in the web graph skips the proof. Not wrong, but the gate is not unconditional.

### Contradictions and supersessions between rows

- **Prod lock.** OQ-380, OQ-283, OQ-529 and OQ-770 were written as "a maintainer rules"; each now carries an "Update (OQ-783)" note and their "Closes when" columns still ask for a ruling. OQ-784 and OQ-785 are the live remainder. OQ-770's body still says `connections.create` answers 422; the note below it says it does not.
- **Wiring.** OQ-441, OQ-472, OQ-669 and OQ-733 asked who wires the engine; #278 answered (OQ-764 to OQ-771). OQ-733, OQ-787 (2) and OQ-788 were not updated.
- **Size rule.** OQ-654, OQ-722, OQ-732 and OQ-545 set the default "split into child issues"; OQ-680, OQ-681 and OQ-723 record that you told sessions not to cut or split, and slices landed at 1.5 to 2.8 times budget. The default and the practice disagree; label the parents `oversize-approved` or restate the default.
- **Slice rows replaced by later slices.** OQ-678 (two kinds) by OQ-691; OQ-679 (fixed 60 s) by OQ-687; OQ-686 (2) and (8) by OQ-688; OQ-686 (1) partly by OQ-721 and OQ-730; OQ-688's proposed `maxBodyBytes` by OQ-721 and OQ-712; OQ-677 by OQ-735 and OQ-772.
- **Loop-delay assertion.** OQ-720 (assert on CI), OQ-731 (assert the added delay over a control run) and OQ-775 (assert counts, print the delay) are three successive versions. Only OQ-775 is current. The CI no longer shows a time budget for the stream reader, so D8 rests on the perf harness.
- **Grid chunk size.** OQ-701 and OQ-757 say "the maintainer picks"; OQ-781 (3) already took the exception, with an ADR addendum marked proposed.
- **Browser proofs.** OQ-734 and OQ-756 treat the browser run as waiting for #277 (closed) and for a driver; OQ-787 built the driver, and OQ-782 (2) still says AC-27 stays planned.

Not checked: the figures in OQ-684, OQ-724, OQ-725, OQ-775 and OQ-787 (8) are measurements from other machines and were not rerun. No test or build was run for this digest. A table row without a "Verified" note was read from the row text only.
