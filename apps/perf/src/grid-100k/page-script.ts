// The script that runs INSIDE the harness page (M0-53 AC-1, AC-4, AC-16). The driver installs it before any script
// of the page (`Page.addScriptToEvaluateOnNewDocument`), so it sees the whole life of the page: every long task
// (PerformanceObserver `longtask`, buffered) and every `securitypolicyviolation` event. It also offers what the
// driver cannot do from outside: a frame recorder (one `requestAnimationFrame` timestamp per frame while it runs),
// content checks of the rows on screen (by name, never "something changed") and the self-checks that prove the two
// detectors can fire. The page's own hooks (`window.__grid`, harness-app.ts) read the grid's counts.
export const PAGE_SCRIPT = String.raw`
(() => {
  const perf = (window.__perf = {
    longTasks: [],
    violations: [],
    frames: null,
  });

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (error) {
    perf.longTaskError = String(error);
  }

  window.addEventListener(
    'securitypolicyviolation',
    (event) => {
      perf.violations.push(
        event.disposition + ' ' + event.effectiveDirective + ' blocked=' + String(event.blockedURI).slice(0, 120) +
          ' at ' + String(event.sourceFile).slice(0, 120) + ':' + String(event.lineNumber) + ' sample=' + String(event.sample).slice(0, 120),
      );
    },
    true,
  );

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const viewport = () => q('app-root .ag-grid-viewport');
  const cellText = (row, column) => (q('[col-id="' + column + '"]', row)?.textContent ?? '').trim();
  const rowAt = (index) => q('app-root .ag-row[row-index="' + index + '"]');

  perf.now = () => performance.now();

  /** Where to aim the mouse for a selector: the centre of its box, and what covers it if it is not the target. */
  perf.centre = (selector) => {
    const element = q(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, covered: top === null || !element.contains(top) ? String(top && top.outerHTML).slice(0, 160) : null };
  };

  perf.geometry = () => {
    const first = rowAt(0) ?? q('app-root .ag-row');
    const view = viewport();
    return {
      rowHeight: first ? first.getBoundingClientRect().height : 0,
      viewportHeight: view ? view.clientHeight : 0,
      scrollHeight: view ? view.scrollHeight : 0,
    };
  };

  /** True when every wanted row is on screen with its name, loaded. */
  const satisfied = (wanted) => {
    for (const want of wanted) {
      const row = rowAt(want.index);
      if (!row || row.classList.contains('ag-row-loading')) return false;
      if (cellText(row, 'name') !== want.name) return false;
    }
    return true;
  };

  perf.describe = () => ({
    firstRows: qa('app-root .ag-row')
      .slice(0, 6)
      .map((row) => row.getAttribute('row-index') + ':' + cellText(row, 'name') + (row.classList.contains('ag-row-loading') ? '(loading)' : '')),
    sorted: qa('app-root .ag-header-cell').map((cell) => cell.getAttribute('col-id') + ':' + cell.getAttribute('aria-sort')).filter((mark) => !mark.endsWith(':none')),
    scrollTop: viewport()?.scrollTop ?? null,
  });

  const afterFrame = (callback) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => callback(performance.now());
    channel.port2.postMessage(null);
  };

  /** Resolves {ms, frames} when the wanted rows are on screen, rejects after timeoutMs with what the page showed. */
  perf.waitFor = (wanted, timeoutMs, t0 = performance.now()) =>
    new Promise((resolve, reject) => {
      let frames = 0;
      const deadline = performance.now() + timeoutMs;
      const tick = () => {
        frames += 1;
        if (satisfied(wanted)) {
          afterFrame((end) => resolve({ ms: end - t0, frames }));
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error('the wanted rows never appeared: ' + JSON.stringify(perf.describe()) + ' wanted ' + JSON.stringify(wanted)));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  /** A programmatic scroll jump (the scrollbar's jump), then wait for the rows it must show. */
  perf.jump = (top, wanted, timeoutMs) => {
    const t0 = performance.now();
    viewport().scrollTop = top;
    return perf.waitFor(wanted, timeoutMs, t0);
  };

  /** Records one timestamp per animation frame until stopFrames(). */
  perf.startFrames = () => {
    const run = { stamps: [], stopped: false };
    perf.frames = run;
    const tick = (time) => {
      if (run.stopped) return;
      run.stamps.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return performance.now();
  };
  perf.stopFrames = () => {
    const run = perf.frames;
    if (!run) return { stamps: [], to: performance.now() };
    run.stopped = true;
    perf.frames = null;
    return { stamps: run.stamps, to: performance.now() };
  };

  perf.longTasksSince = (from) => perf.longTasks.filter((task) => task.start >= from);

  /** The open menu: its role, its items, and which one holds focus. */
  perf.menu = () => {
    const menu = q('[role="menu"]');
    if (!menu) return null;
    const items = qa('[role="menuitem"]', menu);
    return {
      items: items.length,
      focusedIndex: items.findIndex((item) => item === document.activeElement),
      name: menu.getAttribute('aria-label'),
    };
  };

  /** Self-check: blocks the main thread in a task of its own (the long-task API does not see a DevTools evaluation). */
  perf.busy = (ms) => {
    setTimeout(() => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* spin */
      }
    }, 0);
  };

  /** Self-check: an inline script is refused by the page's policy (and by Trusted Types), which must be reported. */
  perf.provokeViolation = () => {
    try {
      const script = document.createElement('script');
      script.textContent = 'window.__provoked = true';
      document.head.appendChild(script);
    } catch (error) {
      perf.provoked = String(error);
    }
  };

  perf.clearReports = () => {
    perf.longTasks.length = 0;
    perf.violations.length = 0;
  };
})();
`;
