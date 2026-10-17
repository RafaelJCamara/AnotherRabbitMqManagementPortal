// Self-test for the graph validator (`nx run work-graph:test`).
// The clean fixture is a tiny, consistent plan under fixtures/clean. Each test plants one
// violation in memory (or, for the two the acceptance criteria name, loads the committed
// fixtures/dangling-dependency and fixtures/forward-dependency trees through the real CLI) and
// asserts on the stable rule id and the offending ids.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyExceptions, parseExceptions } from './exceptions.ts';
import { citedFeatureIds } from './parse.ts';
import {
  COVERAGE_RULES,
  FEATURE_RULES,
  INDEX_RULES,
  ITEM_RULES,
  validateGraph,
} from './validate.ts';
import type { GraphInputs, Violation } from './types.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const cli = join(import.meta.dirname, 'run-validate.ts');

interface Item {
  id: string;
  title: string;
  milestone: string;
  kind: string;
  lane: string;
  size: string;
  wave: string | null;
  depends: string[];
  parent: string | null;
  formerly: string | null;
  trust: boolean;
  amended: string[];
  needsSplit: boolean;
  areas: string[];
  labels: string[];
  body: string;
}
interface Doc {
  repo: string;
  milestones: { key: string; title: string }[];
  labels: { name: string; color: string }[];
  items: Item[];
}

interface Plan {
  json: Doc;
  features: string;
  index: string;
}

function readClean(file: string): string {
  return readFileSync(join(fixtures, 'clean', file), 'utf8');
}

function plan(): Plan {
  return {
    json: JSON.parse(readClean('docs/plan/work-items.json')) as Doc,
    features: readClean('docs/product/features.md'),
    index: readClean('docs/plan/work-items.md'),
  };
}

function inputs(p: Plan): GraphInputs {
  return {
    featuresMd: p.features,
    workItemsJson: JSON.stringify(p.json),
    workItemsMd: p.index,
  };
}

function find(p: Plan, id: string): Item {
  const item = p.json.items.find((i) => i.id === id);
  assert.ok(item, `fixture item ${id} exists`);
  return item;
}

/** Changes a wave consistently across the field, the body header and the label. */
function setWave(item: Item, wave: string): void {
  item.body = item.body.replace(
    `**Wave:** ${item.wave ?? ''}`,
    `**Wave:** ${wave}`,
  );
  item.labels = item.labels.map((l) =>
    l === `wave:${item.wave ?? ''}` ? `wave:${wave}` : l,
  );
  item.wave = wave;
}

function plant(mutate: (p: Plan) => void): Violation[] {
  const p = plan();
  mutate(p);
  return validateGraph(inputs(p)).violations;
}

function rules(violations: readonly Violation[]): string[] {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

/** Asserts the violation exists with exactly this subject (the offending ids). */
function expectFinding(
  violations: readonly Violation[],
  rule: string,
  subject: string,
): void {
  assert.ok(
    violations.some((v) => v.rule === rule && v.subject === subject),
    `expected [${rule}] ${subject}, got:\n${violations.map((v) => `  [${v.rule}] ${v.subject}`).join('\n')}`,
  );
}

function expectOnly(
  violations: readonly Violation[],
  rule: string,
  subject: string,
): void {
  expectFinding(violations, rule, subject);
  assert.deepEqual(rules(violations), [rule], 'no other rule fires');
}

// ---------------------------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------------------------

/** `node:test` runs registered tests itself; the returned promise is not needed. */
function check(name: string, run: () => void): void {
  void test(name, run);
}

check('the clean fixture passes with no violations', () => {
  const result = validateGraph(inputs(plan()));
  assert.deepEqual(result.violations, []);
  assert.equal(result.summary.items, 7);
  assert.equal(result.summary.features, 3);
});

const plantedRules: string[] = [];
function planted(rule: string, name: string, run: () => void): void {
  plantedRules.push(rule);
  check(`${rule}: ${name}`, run);
}

// ---------------------------------------------------------------------------------------------
// Work items: identity, enums, dependencies, waves
// ---------------------------------------------------------------------------------------------

planted('items.json-invalid', 'broken JSON is reported, not thrown', () => {
  const v = validateGraph({
    ...inputs(plan()),
    workItemsJson: '{ nope',
  }).violations;
  assert.ok(v.some((x) => x.rule === 'items.json-invalid'));
});

planted(
  'items.malformed',
  'an item without a depends array is reported by id',
  () => {
    const v = plant((p) => {
      (find(p, 'M0-02') as unknown as Record<string, unknown>).depends =
        'M0-01';
    });
    expectFinding(v, 'items.malformed', 'M0-02');
  },
);

planted('items.duplicate-id', 'two items share an id', () => {
  const v = plant((p) => {
    p.json.items.push({ ...find(p, 'M0-01') });
  });
  expectFinding(v, 'items.duplicate-id', 'M0-01');
});

planted('items.title-prefix', 'the title must start with the id', () => {
  const v = plant((p) => {
    find(p, 'M0-01').title = '[M0-09] Workspace scaffold';
  });
  expectFinding(v, 'items.title-prefix', 'M0-01');
});

planted('items.duplicate-title', 'two items carry the same title', () => {
  const v = plant((p) => {
    find(p, 'M0-02').title = '[M0-02] Workspace scaffold';
  });
  expectFinding(v, 'items.duplicate-title', 'M0-01,M0-02');
});

planted('items.unknown-milestone', 'a milestone that is not declared', () => {
  const v = plant((p) => {
    find(p, 'M0-01').milestone = 'M9';
  });
  expectFinding(v, 'items.unknown-milestone', 'M0-01');
});

planted('items.unknown-kind', 'a kind outside the known set', () => {
  const v = plant((p) => {
    find(p, 'M0-01').kind = 'story';
  });
  expectFinding(v, 'items.unknown-kind', 'M0-01');
});

planted('items.unknown-lane', 'a lane outside the known set', () => {
  const v = plant((p) => {
    find(p, 'M0-01').lane = 'ops';
  });
  expectFinding(v, 'items.unknown-lane', 'M0-01');
});

planted('items.unknown-size', 'a size outside the known set', () => {
  const v = plant((p) => {
    find(p, 'M0-01').size = 'XL';
  });
  expectFinding(v, 'items.unknown-size', 'M0-01');
});

planted(
  'items.dangling-dependency',
  'a dependency on an id that does not exist',
  () => {
    const v = plant((p) => {
      find(p, 'M0-02').depends.push('M0-99');
    });
    expectOnly(v, 'items.dangling-dependency', 'M0-02->M0-99');
  },
);

planted('items.self-dependency', 'an item that depends on itself', () => {
  const v = plant((p) => {
    find(p, 'M0-02').depends.push('M0-02');
  });
  expectFinding(v, 'items.self-dependency', 'M0-02->M0-02');
});

planted(
  'items.duplicate-dependency',
  'the same dependency listed twice',
  () => {
    const v = plant((p) => {
      find(p, 'M0-02').depends.push('M0-01');
    });
    expectFinding(v, 'items.duplicate-dependency', 'M0-02');
  },
);

planted('items.forward-milestone', 'a dependency on a later milestone', () => {
  const v = plant((p) => {
    find(p, 'RC-M0').depends.push('M1-01');
  });
  expectOnly(v, 'items.forward-milestone', 'RC-M0->M1-01');
});

planted(
  'items.wave-order',
  'a dependency scheduled in a later wave of the same milestone',
  () => {
    const v = plant((p) => {
      setWave(find(p, 'M0-01'), 'M0-W2');
      p.json.labels.push({ name: 'wave:M0-W2', color: 'EDEDED' });
    });
    expectOnly(v, 'items.wave-order', 'M0-02->M0-01');
  },
);

planted('items.cycle', 'a dependency cycle names every id on it', () => {
  const v = plant((p) => {
    find(p, 'M0-01').depends.push('M0-03');
  });
  expectFinding(v, 'items.cycle', 'M0-01>M0-03>M0-02>M0-01');
});

planted(
  'items.invalid-parent',
  'a parent that does not exist or is not an epic',
  () => {
    const dangling = plant((p) => {
      find(p, 'M0-02').parent = 'M0-90';
    });
    expectFinding(dangling, 'items.invalid-parent', 'M0-02->M0-90');
    const notEpic = plant((p) => {
      find(p, 'M0-02').parent = 'M0-01';
    });
    expectFinding(notEpic, 'items.invalid-parent', 'M0-02->M0-01');
  },
);

planted(
  'items.wave-milestone',
  'a wave that belongs to another milestone',
  () => {
    const v = plant((p) => {
      setWave(find(p, 'M1-01'), 'M0-W1');
    });
    expectFinding(v, 'items.wave-milestone', 'M1-01');
  },
);

planted(
  'items.wave-missing',
  'an M0/M1 work package with no scheduled wave',
  () => {
    const v = plant((p) => {
      const item = find(p, 'M0-01');
      item.body = item.body.replace(' · **Wave:** M0-W0', '');
      item.labels = item.labels.filter((l) => l !== 'wave:M0-W0');
      item.wave = null;
    });
    expectFinding(v, 'items.wave-missing', 'M0-01');
  },
);

// ---------------------------------------------------------------------------------------------
// Work items: labels and body header
// ---------------------------------------------------------------------------------------------

planted('items.label-mismatch', 'labels must follow the fields', () => {
  const lane = plant((p) => {
    const item = find(p, 'M0-01');
    item.labels = item.labels.filter((l) => l !== 'lane:feature');
  });
  expectFinding(lane, 'items.label-mismatch', 'M0-01:lane:feature');
  const trust = plant((p) => {
    find(p, 'M0-03').labels = find(p, 'M0-03').labels.filter(
      (l) => l !== 'trust:critical',
    );
  });
  expectFinding(trust, 'items.label-mismatch', 'M0-03:trust:critical');
  const area = plant((p) => {
    find(p, 'M0-01').areas = ['ci'];
  });
  expectFinding(area, 'items.label-mismatch', 'M0-01:area');
});

planted(
  'items.label-undeclared',
  'a label missing from the declared list',
  () => {
    const v = plant((p) => {
      p.json.labels = p.json.labels.filter((l) => l.name !== 'size:L');
    });
    expectFinding(v, 'items.label-undeclared', 'M1-01:size:L');
  },
);

planted('items.area-missing', 'a work item with no area label', () => {
  const v = plant((p) => {
    const item = find(p, 'M0-01');
    item.areas = [];
    item.labels = item.labels.filter((l) => !l.startsWith('area:'));
  });
  expectOnly(v, 'items.area-missing', 'M0-01');
});

planted(
  'items.header-mismatch',
  'the body header must agree with the fields',
  () => {
    const size = plant((p) => {
      const item = find(p, 'M0-01');
      item.body = item.body.replace('**Size:** S', '**Size:** L');
    });
    expectFinding(size, 'items.header-mismatch', 'M0-01:Size');
    const trust = plant((p) => {
      const item = find(p, 'M0-03');
      item.body = item.body.replace(' · **Trust-critical**', '');
    });
    expectFinding(trust, 'items.header-mismatch', 'M0-03:Trust-critical');
  },
);

planted(
  'items.duplicate-formerly',
  'two items cannot both be formerly the same id',
  () => {
    const v = plant((p) => {
      for (const id of ['M0-01', 'M0-02']) {
        const item = find(p, id);
        item.formerly = 'M0-55';
        item.body = item.body.replace('**Lane:**', '**Lane:**');
        item.body = item.body.replace(/^(.*?)\n/, '$1 · **Formerly:** M0-55\n');
      }
    });
    expectFinding(v, 'items.duplicate-formerly', 'M0-01,M0-02');
  },
);

planted(
  'items.release-checklist',
  'each milestone has exactly one RC chore',
  () => {
    const v = plant((p) => {
      p.json.items = p.json.items.filter((i) => i.id !== 'RC-M1');
    });
    expectFinding(v, 'items.release-checklist', 'M1');
  },
);

planted(
  'items.dangling-reference',
  'a lab cell lists a work package that does not exist',
  () => {
    const v = plant((p) => {
      const item = find(p, 'U-01');
      item.body = item.body.replace('M0-02, M1-01', 'M0-02, M7-77');
    });
    expectFinding(v, 'items.dangling-reference', 'U-01->M7-77');
  },
);

// ---------------------------------------------------------------------------------------------
// Index (work-items.md)
// ---------------------------------------------------------------------------------------------

planted(
  'index.unparsable-row',
  'a table row that does not match the index format',
  () => {
    const v = plant((p) => {
      p.index += '| M0 | not a link | M0-01 |\n';
    });
    assert.ok(v.some((x) => x.rule === 'index.unparsable-row'));
  },
);

planted(
  'index.unknown-item',
  'an index row for an id that is not in the manifest',
  () => {
    const v = plant((p) => {
      p.index = p.index.replace('| M0-01 |', '| M0-91 |');
    });
    expectFinding(v, 'index.unknown-item', 'M0-91');
  },
);

planted(
  'index.missing-item',
  'a work item with no index row, so no issue number',
  () => {
    const v = plant((p) => {
      p.index = p.index
        .split('\n')
        .filter((l) => !l.includes('| M0-01 |'))
        .join('\n');
    });
    expectFinding(v, 'index.missing-item', 'M0-01');
  },
);

planted('index.duplicate-item', 'the same id listed twice', () => {
  const v = plant((p) => {
    const row = p.index.split('\n').find((l) => l.includes('| M0-01 |')) ?? '';
    p.index += `${row.replace('#1]', '#40]').replace('/issues/1)', '/issues/40)')}\n`;
  });
  expectFinding(v, 'index.duplicate-item', 'M0-01');
});

planted(
  'index.duplicate-issue',
  'one GitHub issue number used by two items',
  () => {
    const v = plant((p) => {
      p.index = p.index.replace(
        '[#2](https://github.com/example/work-graph-fixture/issues/2)',
        '[#1](https://github.com/example/work-graph-fixture/issues/1)',
      );
    });
    expectFinding(v, 'index.duplicate-issue', '#1');
  },
);

planted('index.mismatch', 'index and manifest disagree on a field', () => {
  const title = plant((p) => {
    p.index = p.index.replace('Workspace scaffold', 'Workspace scaffolding');
  });
  expectFinding(title, 'index.mismatch', 'M0-01:title');
  const lane = plant((p) => {
    p.index = p.index.replace(
      '| work-package | feature |',
      '| work-package | platform |',
    );
  });
  assert.ok(
    lane.some(
      (x) => x.rule === 'index.mismatch' && x.subject.endsWith(':lane'),
    ),
  );
  const url = plant((p) => {
    p.index = p.index.replace('/issues/3)', '/issues/33)');
  });
  expectFinding(url, 'index.mismatch', 'M0-03:url');
});

planted(
  'index.count-mismatch',
  'the issue and milestone counts in the intro are stale',
  () => {
    const issues = plant((p) => {
      p.index = p.index.replace(
        '(7 issues, 2 milestones)',
        '(8 issues, 2 milestones)',
      );
    });
    expectFinding(issues, 'index.count-mismatch', 'issues');
    const milestones = plant((p) => {
      p.index = p.index.replace(
        '(7 issues, 2 milestones)',
        '(7 issues, 3 milestones)',
      );
    });
    expectFinding(milestones, 'index.count-mismatch', 'milestones');
  },
);

// ---------------------------------------------------------------------------------------------
// Feature catalogue
// ---------------------------------------------------------------------------------------------

planted(
  'features.unparsable-row',
  'a summary row with the wrong number of cells',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '| CON-02 | Environment chrome | M0 | beyond | S | DEV |',
        '| CON-02 | Environment chrome | M0 | beyond |',
      );
    });
    expectFinding(v, 'features.unparsable-row', 'CON-02');
  },
);

planted('features.duplicate-id', 'a feature id listed twice', () => {
  const v = plant((p) => {
    p.features = p.features.replace(
      '| CON-02 | Environment chrome',
      '| CON-01 | Environment chrome',
    );
  });
  expectFinding(v, 'features.duplicate-id', 'CON-01');
});

planted(
  'features.count-mismatch',
  'the heading and section counts must match the rows',
  () => {
    const total = plant((p) => {
      p.features = p.features.replace('(3 features)', '(4 features)');
    });
    expectFinding(total, 'features.count-mismatch', 'total');
    const section = plant((p) => {
      p.features = p.features.replace(
        '## Connections (2)',
        '## Connections (3)',
      );
    });
    expectFinding(section, 'features.count-mismatch', 'Connections');
  },
);

planted(
  'features.row-without-detail',
  'a summary row with no detail section',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '#### MON-01 Live charts',
        '#### MON-09 Live charts',
      );
    });
    expectFinding(v, 'features.row-without-detail', 'MON-01');
  },
);

planted(
  'features.detail-without-row',
  'a detail section with no summary row',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '#### MON-01 Live charts',
        '#### MON-09 Live charts',
      );
    });
    expectFinding(v, 'features.detail-without-row', 'MON-09');
  },
);

planted(
  'features.row-detail-mismatch',
  'the summary row and detail section disagree',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '**Size:** S · **Parity:** beyond',
        '**Size:** L · **Parity:** beyond',
      );
    });
    expectFinding(v, 'features.row-detail-mismatch', 'CON-02:size');
  },
);

planted(
  'features.unknown-milestone',
  'a feature milestone that the manifest does not declare',
  () => {
    const v = plant((p) => {
      p.features = p.features
        .replaceAll(
          '| MON-01 | Live charts | M1 |',
          '| MON-01 | Live charts | M7 |',
        )
        .replace('**Milestone:** M1 (', '**Milestone:** M7 (');
    });
    expectFinding(v, 'features.unknown-milestone', 'MON-01');
  },
);

planted(
  'features.missing-depends',
  'a detail section with no Depends on line',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '- **Depends on:** CON-01\n- **Acceptance criteria:**\n  - Given a queue',
        '- **Acceptance criteria:**\n  - Given a queue',
      );
    });
    expectFinding(v, 'features.missing-depends', 'MON-01');
  },
);

planted(
  'features.bad-dependency',
  'a Depends on entry that is not a feature id',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '- **Depends on:** CON-01\n- **Acceptance criteria:**\n  - Given a PROD',
        '- **Depends on:** the vault\n- **Acceptance criteria:**\n  - Given a PROD',
      );
    });
    expectFinding(v, 'features.bad-dependency', 'CON-02->the vault');
  },
);

planted(
  'features.dangling-dependency',
  'a dependency on a feature that is not in the catalogue',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '- **Depends on:** CON-01\n- **Acceptance criteria:**\n  - Given a PROD',
        '- **Depends on:** CON-01, CON-77\n- **Acceptance criteria:**\n  - Given a PROD',
      );
    });
    expectFinding(v, 'features.dangling-dependency', 'CON-02->CON-77');
  },
);

planted('features.self-dependency', 'a feature that depends on itself', () => {
  const v = plant((p) => {
    p.features = p.features.replace(
      '- **Depends on:** -\n',
      '- **Depends on:** CON-01\n',
    );
  });
  expectFinding(v, 'features.self-dependency', 'CON-01->CON-01');
});

planted('features.cycle', 'a feature dependency cycle', () => {
  const v = plant((p) => {
    p.features = p.features.replace(
      '- **Depends on:** -\n',
      '- **Depends on:** CON-02\n',
    );
  });
  expectFinding(v, 'features.cycle', 'CON-01>CON-02>CON-01');
});

planted(
  'features.forward-milestone',
  'a feature that depends on one starting in a later milestone',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '- **Depends on:** -\n',
        '- **Depends on:** MON-01\n',
      );
    });
    expectFinding(v, 'features.forward-milestone', 'CON-01->MON-01');
  },
);

check(
  'a parenthetical note on a dependency is tolerated, and multi-milestone cells use the earliest',
  () => {
    const v = plant((p) => {
      p.features = p.features.replace(
        '- **Depends on:** CON-01\n- **Acceptance criteria:**\n  - Given a PROD',
        '- **Depends on:** CON-01 (impact preview per A-4, see note)\n- **Acceptance criteria:**\n  - Given a PROD',
      );
      // CON-01 is listed as "M1 (web); M0 (image)": its earliest start is M0, so CON-02 (M0) is fine.
      p.features = p.features
        .replace(
          '| CON-01 | Connection profiles | M0 |',
          '| CON-01 | Connection profiles | M1 (web); M0 (image) |',
        )
        .replace(
          '**Milestone:** M0 (design-phase tag: M0) · **Size:** M',
          '**Milestone:** M1 (web); M0 (image) (design-phase tag: M0) · **Size:** M',
        );
    });
    assert.deepEqual(v, []);
  },
);

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

planted('coverage.unmapped-feature', 'a feature cited by no work item', () => {
  const v = plant((p) => {
    find(p, 'M0-03').title = '[M0-03] Environment chrome';
    p.index = p.index.replace(
      'Environment chrome (CON-02)',
      'Environment chrome',
    );
  });
  expectOnly(v, 'coverage.unmapped-feature', 'CON-02');
});

planted(
  'coverage.late-feature',
  'a feature that starts before any work item citing it',
  () => {
    const v = plant((p) => {
      p.features = p.features
        .replace(
          '| MON-01 | Live charts | M1 |',
          '| MON-01 | Live charts | M0 |',
        )
        .replace(
          '**Milestone:** M1 (design-phase tag: M1)',
          '**Milestone:** M0 (design-phase tag: M1)',
        );
    });
    expectOnly(v, 'coverage.late-feature', 'MON-01');
  },
);

planted(
  'coverage.unknown-feature',
  'a work item citing a feature id that does not exist',
  () => {
    const v = plant((p) => {
      const item = find(p, 'M0-01');
      item.body += '\n\nAlso covers CON-09.';
    });
    expectOnly(v, 'coverage.unknown-feature', 'M0-01->CON-09');
  },
);

check('citedFeatureIds expands the plan shorthands', () => {
  assert.deepEqual([...citedFeatureIds('Admin parity (ADM-04/05/06)')].sort(), [
    'ADM-04',
    'ADM-05',
    'ADM-06',
  ]);
  assert.deepEqual(
    [...citedFeatureIds('Publish (PUB-03..07, MSG-09)')].sort(),
    ['MSG-09', 'PUB-03', 'PUB-04', 'PUB-05', 'PUB-06', 'PUB-07'],
  );
  assert.deepEqual(
    [...citedFeatureIds('Epic (EXT-01, DLQ-05/07, S-12, U-19/U-20)')].sort(),
    ['DLQ-05', 'DLQ-07', 'EXT-01'],
  );
  assert.deepEqual([...citedFeatureIds('Wave M0-W1, A-22, 12 items')], []);
});

// ---------------------------------------------------------------------------------------------
// Known exceptions
// ---------------------------------------------------------------------------------------------

const exceptionText = JSON.stringify({
  exceptions: [
    {
      rule: 'items.dangling-dependency',
      subject: 'M0-02->M0-99',
      oq: 'OQ-90',
      reason: 'planted',
    },
  ],
});
const dangling: Violation = {
  rule: 'items.dangling-dependency',
  subject: 'M0-02->M0-99',
  message: 'planted',
};

check('a known exception turns a violation into a tracked finding', () => {
  const { exceptions, violations } = parseExceptions(exceptionText);
  assert.deepEqual(violations, []);
  const result = applyExceptions([dangling], exceptions, new Set(['OQ-90']));
  assert.deepEqual(result.failing, []);
  assert.equal(result.known[0]?.exception.oq, 'OQ-90');
});

check('exceptions.stale: an exception whose finding is gone fails', () => {
  const { exceptions } = parseExceptions(exceptionText);
  const result = applyExceptions([], exceptions, new Set(['OQ-90']));
  assert.deepEqual(rules(result.failing), ['exceptions.stale']);
});

check(
  'exceptions.unknown-oq: an exception must point at a real open question',
  () => {
    const { exceptions } = parseExceptions(exceptionText);
    const result = applyExceptions([dangling], exceptions, new Set(['OQ-01']));
    assert.deepEqual(rules(result.failing), ['exceptions.unknown-oq']);
  },
);

check('exceptions.duplicate and exceptions.invalid are reported', () => {
  const { exceptions } = parseExceptions(exceptionText);
  const twice = applyExceptions(
    [dangling],
    [...exceptions, ...exceptions],
    new Set(['OQ-90']),
  );
  assert.ok(twice.failing.some((v) => v.rule === 'exceptions.duplicate'));
  assert.ok(parseExceptions('{ nope').violations.length > 0);
  const bad = parseExceptions(JSON.stringify({ exceptions: [{ rule: 'x' }] }));
  assert.equal(bad.violations[0]?.rule, 'exceptions.invalid');
});

check(
  'an exception does not hide a different subject under the same rule',
  () => {
    const { exceptions } = parseExceptions(exceptionText);
    const other: Violation = { ...dangling, subject: 'M0-03->M0-98' };
    const result = applyExceptions(
      [dangling, other],
      exceptions,
      new Set(['OQ-90']),
    );
    assert.deepEqual(result.failing, [other]);
  },
);

check(
  'every rule id the validator can emit has a planted-violation test',
  () => {
    const covered = new Set(plantedRules);
    const all = [
      ...ITEM_RULES,
      ...INDEX_RULES,
      ...FEATURE_RULES,
      ...COVERAGE_RULES,
      'items.json-invalid',
      'items.malformed',
    ];
    for (const rule of all) {
      assert.ok(
        covered.has(rule),
        `rule ${rule} has no planted-violation test`,
      );
    }
  },
);

// ---------------------------------------------------------------------------------------------
// The CLI, as CI runs it
// ---------------------------------------------------------------------------------------------

function run(args: string[]): {
  status: number | null;
  out: string;
  err: string;
} {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

check('CLI: the clean fixture exits 0', () => {
  const result = run([`--root=${join(fixtures, 'clean')}`]);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /work-graph passed/);
});

check('CLI: a dangling dependency exits 1 and names the offending ids', () => {
  const result = run([`--root=${join(fixtures, 'dangling-dependency')}`]);
  assert.equal(result.status, 1);
  assert.match(result.err, /\[items\.dangling-dependency\] M0-02->M0-99/);
});

check('CLI: a forward dependency exits 1 and names the offending ids', () => {
  const result = run([`--root=${join(fixtures, 'forward-dependency')}`]);
  assert.equal(result.status, 1);
  assert.match(result.err, /\[items\.forward-milestone\] RC-M0->M1-01/);
});

check(
  'CLI: a recorded exception passes and is listed with its open question',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'work-graph-'));
    try {
      cpSync(join(fixtures, 'dangling-dependency'), dir, { recursive: true });
      writeFileSync(
        join(dir, 'docs', 'open-questions.md'),
        '| ID | Question |\n| OQ-90 | planted |\n',
      );
      const exceptions = join(dir, 'exceptions.json');
      writeFileSync(exceptions, exceptionText);
      const ok = run([`--root=${dir}`, `--exceptions=${exceptions}`]);
      assert.equal(ok.status, 0, ok.err);
      assert.match(ok.out, /OQ-90/);
      // Fix the plan but leave the exception behind: the run must fail as stale.
      cpSync(join(fixtures, 'clean', 'docs'), join(dir, 'docs'), {
        recursive: true,
      });
      writeFileSync(
        join(dir, 'docs', 'open-questions.md'),
        '| ID | Question |\n| OQ-90 | planted |\n',
      );
      const stale = run([`--root=${dir}`, `--exceptions=${exceptions}`]);
      assert.equal(stale.status, 1);
      assert.match(stale.err, /exceptions\.stale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
