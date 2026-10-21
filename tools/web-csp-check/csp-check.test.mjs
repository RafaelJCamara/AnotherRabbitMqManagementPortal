import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findBrowser } from './cdp.mjs';
import { judge, run } from './csp-check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const GOOD = {
  appRootChildren: 3,
  shell: {
    display: 'grid',
    columns: ['72px', '284px', '4px', '920px'],
    box: { x: 0, y: 0, width: 1280, height: 720 },
    activity: { x: 0, y: 0, width: 72, height: 692 },
    main: { x: 360, y: 0, width: 920, height: 692 },
  },
  scrollWidth: 1280,
  clientWidth: 1280,
  metaNonce: 'abc==',
  nonceOfRoot: 'abc==',
  violations: [],
};

describe('judge', () => {
  it('passes a styled shell without reports', () => {
    assert.deepEqual(judge(GOOD), []);
  });

  it('fails the collapsed, unstyled shell (one column, same x position)', () => {
    const failures = judge({
      ...GOOD,
      shell: {
        ...GOOD.shell,
        display: 'block',
        columns: [],
        main: { x: 0, y: 40, width: 1280, height: 600 },
      },
    });
    assert.equal(failures.length, 3);
    assert.match(failures.join('\n'), /not grid/);
    assert.match(failures.join('\n'), /0 column/);
    assert.match(failures.join('\n'), /not to the right of the activity bar/);
  });

  it('fails a grid with a single column', () => {
    const failures = judge({
      ...GOOD,
      shell: { ...GOOD.shell, columns: ['1280px'] },
    });
    assert.match(failures.join('\n'), /1 column/);
  });

  it('fails when the shell did not render, and when it is not expected it does not need to', () => {
    assert.match(judge({ ...GOOD, shell: null }).join('\n'), /did not render/);
    assert.deepEqual(
      judge({ ...GOOD, shell: null }, { expectShell: false }),
      [],
    );
  });

  it('fails a page that scrolls sideways', () => {
    assert.match(
      judge({ ...GOOD, scrollWidth: 1400 }).join('\n'),
      /scrolls sideways/,
    );
  });

  it('fails a missing meta nonce and a root nonce that differs from it', () => {
    assert.match(
      judge({ ...GOOD, metaNonce: null, nonceOfRoot: null }).join('\n'),
      /no csp-nonce meta/,
    );
    assert.match(
      judge({ ...GOOD, nonceOfRoot: 'other==' }).join('\n'),
      /differs from the csp-nonce meta/,
    );
  });

  it('fails on every CSP or Trusted Types report', () => {
    const failures = judge({
      ...GOOD,
      violations: ['log: This document requires TrustedScript', 'issue: x'],
    });
    assert.equal(failures.length, 2);
    assert.match(failures[0], /TrustedScript/);
  });
});

describe('findBrowser', () => {
  const exists = (known) => (path) => known.includes(path);

  it('takes the first environment variable that is set, and does not fall back when its path is missing', () => {
    assert.equal(
      findBrowser(
        { PERF_BROWSER: '/opt/chrome' },
        'linux',
        exists(['/opt/chrome']),
      ),
      '/opt/chrome',
    );
    assert.equal(
      findBrowser(
        { CSP_CHECK_BROWSER: '/gone', PERF_BROWSER: '/opt/chrome' },
        'linux',
        exists(['/opt/chrome']),
      ),
      undefined,
    );
  });

  it('searches the default locations, and answers undefined when there is none', () => {
    const edge =
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    assert.equal(findBrowser({}, 'win32', exists([edge])), edge);
    const chromium = join('/usr/bin', 'chromium');
    assert.equal(
      findBrowser(
        { PATH: ['/bin', '/usr/bin'].join(delimiter) },
        'linux',
        exists([chromium]),
      ),
      chromium,
    );
    assert.equal(findBrowser({ PATH: '/bin' }, 'linux', exists([])), undefined);
  });
});

describe('run without a browser', () => {
  function withEnv(vars, body) {
    const saved = {};
    for (const [key, value] of Object.entries(vars)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return body().finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it('says that nothing was proved and exits 0, or exits 1 when a browser is required', async () => {
    const warn = mock.method(console, 'warn', () => undefined);
    const error = mock.method(console, 'error', () => undefined);
    try {
      const missing = { CSP_CHECK_BROWSER: '/no/such/browser' };
      const optional = await withEnv(
        { ...missing, CSP_CHECK_REQUIRE_BROWSER: undefined },
        () => run(root),
      );
      assert.equal(optional, 0);
      assert.match(
        String(warn.mock.calls[0]?.arguments[0]),
        /SKIPPED.*Nothing was proved/,
      );
      const required = await withEnv(
        { ...missing, CSP_CHECK_REQUIRE_BROWSER: '1' },
        () => run(root),
      );
      assert.equal(required, 1);
      assert.match(String(error.mock.calls[0]?.arguments[0]), /SKIPPED/);
    } finally {
      warn.mock.restore();
      error.mock.restore();
    }
  });
});

describe('the page the engine fills in', () => {
  const html = readFileSync(`${root}apps/web/src/index.html`, 'utf8');
  const source = readFileSync(
    `${root}libs/engine/transport/src/static-ui.ts`,
    'utf8',
  );
  const placeholder = /NONCE_PLACEHOLDER = '([^']+)'/.exec(source)?.[1];

  it('knows the placeholder that the transport replaces', () => {
    assert.match(placeholder ?? '', /^__[A-Z_]+__$/);
  });

  it('has it in the csp-nonce meta tag and in the ngCspNonce attribute of the app root, nowhere else', () => {
    assert.ok(
      html.includes(`<meta name="csp-nonce" content="${placeholder}" />`),
      'the csp-nonce meta tag',
    );
    assert.ok(
      html.includes(`<app-root ngCspNonce="${placeholder}"></app-root>`),
      'the ngCspNonce attribute on the app root',
    );
    assert.equal(html.split(placeholder).length - 1, 2);
  });
});
