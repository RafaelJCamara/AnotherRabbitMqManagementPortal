// The engine logger (blueprint 13): pino 10.4.0, structured JSON, one line per event. pino is
// imported here and nowhere else (I-11); the rest of the engine sees the `Logger` interface.
//
// Redaction happens on the finished line, just before it reaches the sink (see ./redact.ts), so
// it covers everything pino serialised: bindings, fields, the message and error stacks. Message
// bodies are never logged; the `body` and `payload` fields are masked.
import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';

import { systemClock, type Clock } from '../clock/clock.ts';
import { redactLine } from './redact.ts';

export type LogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'silent';

/** A level a line can be written at (`silent` only switches logging off). */
export type Level = Exclude<LogLevel, 'silent'>;

/** Structured fields of one event. Put an error under `err`: it is serialised with its stack. */
export type LogFields = Record<string, unknown>;

/** The correlation ids that tie log lines to a request, action, plan, job, peek or receipt. */
export interface CorrelationFields {
  requestId?: string;
  actionId?: string;
  planId?: string;
  jobId?: string;
  peekId?: string;
  receiptId?: string;
}

export interface LogMethod {
  (fields: LogFields, message?: string): void;
  (message: string): void;
}

export interface Logger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  /** A logger whose lines carry `bindings` (for example correlation ids). */
  child(bindings: LogFields): Logger;
  readonly level: string;
  isLevelEnabled(level: Level): boolean;
}

/** Where finished lines go. A line is one JSON object ending in a newline. */
export interface LogSink {
  write(line: string): void;
}

export interface LoggerOptions {
  /** Default `info`. */
  level?: LogLevel;
  /** Fields on every line, next to `pid`. */
  bindings?: LogFields;
  /** Default: standard output, written asynchronously. Desktop file sinks are supplied by the host. */
  sink?: LogSink;
  /** The `time` of each line comes from here. Default: the system clock. */
  clock?: Clock;
}

function adapt(logger: PinoLogger): Logger {
  const method =
    (level: Level): LogMethod =>
    (first: LogFields | string, message?: string): void => {
      if (typeof first === 'string') logger[level](first);
      else logger[level](first, message);
    };
  return {
    trace: method('trace'),
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
    child: (bindings) => adapt(logger.child(bindings)),
    get level() {
      return logger.level;
    },
    isLevelEnabled: (level) => logger.isLevelEnabled(level),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const clock = options.clock ?? systemClock;
  const sink = options.sink ?? pino.destination({ dest: 1, sync: false });
  const destination: DestinationStream = {
    write: (line) => {
      sink.write(redactLine(line));
    },
  };
  const logger = pino(
    {
      level: options.level ?? 'info',
      base: { pid: process.pid, ...options.bindings },
      timestamp: () => `,"time":${String(clock.now())}`,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err },
    },
    destination,
  );
  return adapt(logger);
}

/** A child logger that stamps the given correlation ids on every line. */
export function withCorrelation(
  logger: Logger,
  fields: CorrelationFields,
): Logger {
  return logger.child({ ...fields });
}
