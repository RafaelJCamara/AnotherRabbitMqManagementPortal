// A small Dockerfile reader for the static checks of the image (M0-64). It understands what the
// checks need and nothing more: comments, line continuations, instruction names, stages, the
// exec (JSON array) form and `--flag=value` options. It is not a validator; the daemon is.

/**
 * @typedef {{ name: string, args: string, flags: Record<string, string>, exec: string[] | undefined, line: number }} Instruction
 * @typedef {{ index: number, image: string, alias: string | undefined, instructions: Instruction[] }} Stage
 */

/** Splits the text into logical lines: comments dropped, continuations joined. */
function logicalLines(text) {
  const lines = [];
  let buffer = '';
  let startedAt = 0;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    if (buffer === '' && line === '') return;
    if (buffer === '') startedAt = index + 1;
    const continued = line.endsWith('\\');
    buffer += `${buffer === '' ? '' : ' '}${continued ? line.slice(0, -1).trim() : line}`;
    if (!continued) {
      lines.push({ text: buffer, line: startedAt });
      buffer = '';
    }
  });
  if (buffer !== '') lines.push({ text: buffer, line: startedAt });
  return lines;
}

/** `--chown=1:1 a b` to its flags and the rest. */
function takeFlags(args) {
  const flags = {};
  let rest = args;
  for (;;) {
    const match = /^--([a-z-]+)(?:=(\S*))?\s*/.exec(rest);
    if (match === null) break;
    flags[match[1]] = match[2] ?? 'true';
    rest = rest.slice(match[0].length);
  }
  return { flags, rest };
}

function execForm(rest) {
  if (!rest.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(rest);
    return Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** @returns {{ stages: Stage[], globalArgs: Instruction[] }} */
export function parseDockerfile(text) {
  /** @type {Stage[]} */
  const stages = [];
  /** @type {Instruction[]} */
  const globalArgs = [];
  for (const { text: logical, line } of logicalLines(text)) {
    const match = /^([A-Za-z]+)\s*(.*)$/s.exec(logical);
    if (match === null) continue;
    const name = match[1].toUpperCase();
    const { flags, rest } = takeFlags(match[2]);
    const instruction = {
      name,
      args: rest,
      flags,
      exec: execForm(rest),
      line,
    };
    if (name === 'FROM') {
      const from = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(rest);
      stages.push({
        index: stages.length,
        image: from?.[1] ?? rest,
        alias: from?.[2],
        instructions: [instruction],
      });
    } else if (stages.length === 0) {
      globalArgs.push(instruction);
    } else {
      stages[stages.length - 1].instructions.push(instruction);
    }
  }
  return { stages, globalArgs };
}

/** The instructions of one name in a stage. */
export const of = (stage, name) =>
  stage.instructions.filter((instruction) => instruction.name === name);

/** The `KEY=value` pairs of every ENV and ARG instruction of a stage (and `KEY` alone as ''). */
export function declaredVariables(stage) {
  const found = [];
  for (const instruction of stage.instructions) {
    if (instruction.name !== 'ENV' && instruction.name !== 'ARG') continue;
    const pairs = instruction.args.match(
      /[A-Za-z_][A-Za-z0-9_]*(?:=(?:"[^"]*"|\S*))?/g,
    );
    for (const pair of pairs ?? []) {
      const at = pair.indexOf('=');
      found.push(
        at < 0
          ? { key: pair, value: '', kind: instruction.name }
          : {
              key: pair.slice(0, at),
              value: pair.slice(at + 1).replace(/^"|"$/g, ''),
              kind: instruction.name,
            },
      );
    }
  }
  return found;
}
