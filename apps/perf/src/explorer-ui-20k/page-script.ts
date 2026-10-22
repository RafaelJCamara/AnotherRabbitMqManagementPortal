// The script that runs INSIDE the page under test (AC-27). It is installed before any script of the page
// (`Page.addScriptToEvaluateOnNewDocument`), so it sees the whole life of the page: the long tasks
// (PerformanceObserver 'longtask', buffered) and every `securitypolicyviolation` event. After that it offers the
// timing primitives the Node side calls through `Runtime.evaluate`.
//
// WHAT "AN INTERACTION" IS HERE. The Node side arms an expectation (the rows that must be on screen, the match
// count, the sort mark), then sends the input; the page takes t0 from the input itself (`event.timeStamp` of the
// click or the Enter key, or `performance.now()` just before a programmatic scroll jump) and checks the
// expectation in every animation frame. The interaction ends in the frame whose DOM satisfies it: the end is taken
// after that frame's main-thread work (a message posted from the frame callback runs after the rendering update),
// so "painted" means committed by the main thread, not photons on a screen. The check is by content (the names of
// the rows the oracle says belong there), never "something changed".
export const PAGE_SCRIPT = String.raw`
(() => {
  const perf = (window.__perf = {
    longTasks: [],
    violations: [],
    current: null,
    rowHeight: 0,
    viewportHeight: 0,
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
      perf.violations.push({
        directive: event.effectiveDirective,
        blocked: String(event.blockedURI).slice(0, 120),
        source: String(event.sourceFile).slice(0, 120) + ':' + String(event.lineNumber),
        sample: String(event.sample).slice(0, 120),
        disposition: event.disposition,
      });
    },
    true,
  );


  // The live channel. The explorer subscribes to the explorer.window topic over a WebSocket to the engine; this build of the
  // engine has no explorer topic (OQ-441) and ends the subscription with "no such connection", which would put the
  // page in its "live updates ended" state and make it refetch. A page under test is better served by the state a
  // working topic gives it, so the socket is replaced by one that speaks the live protocol minimally: it answers
  // hello, ping and sub (subok, then a snapshot holding only the version marker) and ignores credit and unsub. It
  // is a stand-in for the topic's frames, not a measurement of them.
  const RealWebSocket = window.WebSocket;
  class LiveStub {
    constructor(url, protocols) {
      if (!String(url).endsWith('/api/v1/live')) return new RealWebSocket(url, protocols);
      this.url = url;
      this.readyState = 0;
      this.protocol = Array.isArray(protocols) ? protocols[0] : protocols;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
      }, 0);
    }
    send(text) {
      const frame = JSON.parse(text);
      const reply = (answer) =>
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(answer) }), 0);
      if (frame.t === 'hello') {
        reply({ t: 'welcome', v: 1, session: 'perf-stub', engineVersion: '0.0.0', limits: { maxSubs: 64, outboxBytes: 8388608, maxFrameBytes: 1048576 } });
      } else if (frame.t === 'ping') {
        reply({ t: 'pong', ts: frame.ts });
      } else if (frame.t === 'sub') {
        reply({ t: 'subok', sid: frame.sid, qos: 'latest' });
        reply({ t: 'snapshot', sid: frame.sid, seq: 0, items: [{ key: '~version', version: 7 }] });
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ type: 'close', code: 1000 }), 0);
    }
  }
  LiveStub.CONNECTING = 0;
  LiveStub.OPEN = 1;
  LiveStub.CLOSING = 2;
  LiveStub.CLOSED = 3;
  window.WebSocket = LiveStub;
  perf.lastClicks = [];
  window.addEventListener('click', (event) => { perf.lastClicks.push(String(event.target.className).slice(0, 40) + '@' + event.clientX + ',' + event.clientY + (event.isTrusted ? '' : ' synthetic')); if (perf.lastClicks.length > 4) perf.lastClicks.shift(); }, true);

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const viewport = () => q('app-data-grid .ag-grid-viewport');
  const cellText = (row, column) => (q('[col-id="' + column + '"]', row)?.textContent ?? '').trim();
  const rowAt = (index) => q('app-data-grid .ag-row[row-index="' + index + '"]');

  /** Reads the geometry once; the per-frame check never touches layout. */
  perf.measureGrid = () => {
    const first = q('app-data-grid .ag-row');
    const view = viewport();
    perf.rowHeight = first ? parseFloat(first.style.height) || first.getBoundingClientRect().height : 0;
    perf.viewportHeight = view ? view.clientHeight : 0;
    return { rowHeight: perf.rowHeight, viewportHeight: perf.viewportHeight, scrollHeight: view ? view.scrollHeight : 0 };
  };

  /** The sortable columns whose header is wholly inside the page at this size, left to right. */
  perf.visibleHeaders = () =>
    qa('app-data-grid .ag-header-cell')
      .map((cell) => ({ id: cell.getAttribute('col-id'), sortable: cell.classList.contains('ag-header-cell-sortable'), box: cell.getBoundingClientRect() }))
      .filter((cell) => cell.id && cell.sortable && cell.box.left >= 0 && cell.box.right <= window.innerWidth - 8)
      .map((cell) => cell.id);

  /** Where to aim the mouse for a selector: the centre of its box. */
  perf.centre = (selector) => {
    const element = q(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, covered: top === null || !element.contains(top) ? String(top && top.outerHTML).slice(0, 160) : null };
  };

  /** The checkbox of an option in the open panel of the n-th facet picker (1-based), or null. */
  perf.optionBox = (picker, value) => {
    const label = qa('app-facet-picker:nth-of-type(' + picker + ') .panel label.option').find(
      (candidate) => candidate.textContent.trim() === value,
    );
    const box = label?.querySelector('input')?.getBoundingClientRect();
    if (!box) return null;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    const input = label.querySelector('input');
    return { x, y, covered: top === null || !(input.contains(top) || label.contains(top)) ? String(top && top.outerHTML).slice(0, 160) : null };
  };

  const matchedOf = () => {
    const text = q('.counts')?.textContent ?? '';
    const match = /([0-9][0-9,.\s  ]*)\s+of\b/.exec(text);
    return match ? Number(match[1].replace(/[^0-9]/g, '')) : null;
  };

  /** True when the page shows what the expectation says; reads attributes and text only. */
  const satisfied = (expect) => {
    if (matchedOf() !== expect.matched) return false;
    if (Math.abs(viewport().scrollTop - expect.scrolledRows * perf.rowHeight) > 1) return false;
    if (expect.sort) {
      const header = q('app-data-grid .ag-header-cell[col-id="' + expect.sort.column + '"]');
      if ((header?.getAttribute('aria-sort') ?? 'none') !== expect.sort.aria) return false;
    }
    if (expect.rows.length === 0) {
      return q('.no-match') !== null && qa('app-data-grid .ag-row').every((row) => cellText(row, 'name') === '');
    }
    for (const wanted of expect.rows) {
      const row = rowAt(wanted.index);
      if (!row || row.classList.contains('ag-row-loading')) return false;
      if (cellText(row, 'name') !== wanted.name) return false;
    }
    return true;
  };

  perf.describe = () => ({
    matched: matchedOf(),
    firstRows: qa('app-data-grid .ag-row')
      .slice(0, 6)
      .map((row) => row.getAttribute('row-index') + ':' + cellText(row, 'name') + (row.classList.contains('ag-row-loading') ? '(loading)' : '')),
    sorted: qa('app-data-grid .ag-header-cell')
      .map((cell) => cell.getAttribute('col-id') + ':' + cell.getAttribute('aria-sort'))
      .filter((mark) => !mark.endsWith(':none')),
    noMatchShown: q('.no-match') !== null,
    scrollTop: viewport()?.scrollTop ?? null,
  });

  /** Is the expectation already true? A plan whose step is already true would time nothing. */
  perf.alreadyTrue = (expect) => satisfied(expect);

  const afterFrame = (callback) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => callback(performance.now());
    channel.port2.postMessage(null);
  };

  /**
   * Arms one interaction. 'click' takes t0 from the next click, 'enter' from the next Enter key, 'now' is set by
   * the caller through perf.begin(). Resolves {ms, frames} when the expectation holds, or rejects after timeoutMs
   * with what the page showed.
   */
  perf.arm = (expect, trigger, timeoutMs) =>
    new Promise((resolve, reject) => {
      const run = { t0: null, frames: 0, cleanup: [] };
      perf.current = run;
      const finish = (action) => {
        for (const undo of run.cleanup) undo();
        perf.current = null;
        action();
      };
      const begin = (time) => {
        if (run.t0 === null) run.t0 = time;
      };
      run.begin = begin;
      if (trigger === 'click' || trigger === 'enter') {
        const type = trigger === 'click' ? 'click' : 'keydown';
        const listener = (event) => {
          if (trigger === 'enter' && event.key !== 'Enter') return;
          begin(event.timeStamp);
        };
        window.addEventListener(type, listener, true);
        run.cleanup.push(() => window.removeEventListener(type, listener, true));
      }
      const deadline = performance.now() + timeoutMs;
      const tick = () => {
        if (perf.current !== run) return;
        if (run.t0 !== null) {
          run.frames += 1;
          if (satisfied(expect)) {
            afterFrame((end) => finish(() => resolve({ ms: end - run.t0, t0: run.t0, end, frames: run.frames })));
            return;
          }
        }
        if (performance.now() > deadline) {
          finish(() => reject(new Error('the expected rows never appeared: ' + JSON.stringify(perf.describe()) + ' expected ' + JSON.stringify(expect))));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  /** A programmatic scroll jump: t0 is the moment before the assignment. */
  perf.scrollTo = (top) => {
    perf.current?.begin(performance.now());
    viewport().scrollTop = top;
  };

  /**
   * Types a text into an input and presses Enter in one task, so the filter's 200 ms pause cannot elapse
   * between them: Enter applies the filter at once and cancels the pause (the pause is excluded by construction).
   */
  perf.typeAndEnter = (selector, text) => {
    const input = q(selector);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  };

  /**
   * Brings the viewport back to the first row and waits until those rows are loaded. NOT a timed interaction: a new
   * filter keeps the scroll position the grid had (clamped to the new length), so a filter step starts from the top
   * to land on rows the plan knows (see the README of apps/perf).
   */
  perf.toTop = (timeoutMs) =>
    new Promise((resolve, reject) => {
      const view = viewport();
      if (view.scrollTop === 0) {
        resolve(false);
        return;
      }
      view.scrollTop = 0;
      const deadline = performance.now() + timeoutMs;
      const tick = () => {
        const wanted = Math.min(Math.max(1, Math.floor(perf.viewportHeight / perf.rowHeight) - 1), matchedOf() ?? 1);
        let loaded = viewport().scrollTop === 0;
        for (let index = 0; loaded && index < wanted; index++) {
          const row = rowAt(index);
          loaded = row !== null && !row.classList.contains('ag-row-loading') && cellText(row, 'name') !== '';
        }
        if (loaded) resolve(true);
        else if (performance.now() > deadline) reject(new Error('the first rows did not come back: ' + JSON.stringify(perf.describe())));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  perf.debug = () => ({ active: document.activeElement ? document.activeElement.outerHTML.slice(0, 160) : null, headers: qa('app-data-grid .ag-header-cell').map((cell) => cell.getAttribute('col-id') + ':' + cell.getAttribute('aria-sort') + ':' + cell.className.replace(/ag-header-/g, '').slice(0, 80)), open: qa('app-facet-picker .panel').length, lastClicks: perf.lastClicks });

  /** Waits until the layout has stopped moving (the header's position is the same for several frames). */
  perf.settle = (frames, timeoutMs) =>
    new Promise((resolve, reject) => {
      let last = null;
      let stable = 0;
      const deadline = performance.now() + timeoutMs;
      const tick = () => {
        const header = q('app-data-grid .ag-header-cell');
        const top = header ? header.getBoundingClientRect().top : null;
        if (top !== null && top === last) stable += 1;
        else {
          stable = 0;
          last = top;
        }
        if (stable >= frames) resolve(true);
        else if (performance.now() > deadline) reject(new Error('the layout never settled'));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  /** Self-check: blocks the main thread in a task of its own (the long-task API does not see a DevTools evaluation). */
  perf.busy = (ms) => {
    setTimeout(() => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* spin */
      }
    }, 0);
  };

  /** Self-check: an inline script is refused by the page's policy, which must be reported. */
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

  perf.longTasksSince = (from) => perf.longTasks.filter((task) => task.start >= from);
  perf.now = () => performance.now();
})();
`;
