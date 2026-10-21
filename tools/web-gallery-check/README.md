# web-gallery-check

Proves that the dev-only gallery of the web app (M0-50, blueprint 10: the gallery replaces Storybook) is not in a production build. The gallery route is behind a build-time constant (`__DEV_GALLERY__`, set by `define` in the `web` project: true for `development`, false for `production`); this tool checks the result instead of trusting the constant.

Tags: `type:tooling`, `runtime:node`. Plain Node, no dependencies.

## What it checks

`check-no-gallery.mjs <production-dir> <development-dir>` fails when:

- a production file is named after the gallery, or contains one of its markers (`MARKERS`: its component selector and its title);
- the development output does **not** contain them (a scan that cannot see the gallery proves nothing);
- the production directory is empty.

## Proof commands

| Command                                         | What it proves                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm nx test web-gallery-check`                | The scan itself: each marker, file names, nested folders, the development control, an empty output.  |
| `pnpm nx run web-gallery-check:gallery-absent`  | Builds `web` for production and for development into `dist/gallery-check/` and scans both.           |

`explorer-i18n-source.test.mjs` is the source half of M0-54 AC-25 (no browser code may read files, so the scan lives in a node tool): every `explorer.*` key literal in `libs/ui/feature-explorer` is a key of its English file, every key is asked for, and neither the file nor the source makes a forbidden claim or writes `innerHTML`. It runs with `pnpm nx test web-gallery-check`.

If you rename the gallery component or its title, update `MARKERS`; the development control then fails until you do.
