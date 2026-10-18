// @app/kernel: primitives shared by every engine module (M0-16): configuration loading, the
// redacting logger, the clock and ids, Problem mapping, and the bounded buffers of I-6.
export {
  BoundedQueue,
  BoundedRing,
  type BoundedOptions,
  type BoundedStats,
  type DropEvent,
  type DropReason,
  type SizeOf,
} from './bounded/index.ts';
export * from './actions/index.ts';
export {
  AUDIT_GENESIS_HASH,
  createAuditChain,
  type AuditBreak,
  type AuditChain,
  type AuditChainOptions,
  type AuditChainStats,
  type AuditVerification,
  type VerifyOptions,
} from './audit/index.ts';
export {
  ARM_ACTION_ID,
  ARM_WINDOW_MS,
  canArm,
  createArmActions,
  createGuardrails,
  DISARM_ACTION_ID,
  PROD_LOCK_GATE,
  type ArmingControl,
  type ArmStatus,
  type Guardrails,
  type GuardrailsOptions,
} from './guardrails/index.ts';
export {
  createReceiptStore,
  MAX_RECEIPT_DETAIL_BYTES,
  type ReceiptStore,
  type ReceiptStoreOptions,
  type ReceiptView,
} from './receipts/index.ts';
export {
  createManualClock,
  systemClock,
  type Clock,
  type ManualClock,
} from './clock/clock.ts';
export { ConfigError, type ConfigIssue } from './config/errors.ts';
export { envVarName } from './config/layers.ts';
export { loadConfig, type LoadConfigOptions } from './config/load-config.ts';
export {
  createIdGenerator,
  isUlid,
  ulidTimestamp,
  type IdGenerator,
  type IdGeneratorOptions,
  type RandomBytes,
} from './ids/ids.ts';
export {
  createLogger,
  withCorrelation,
  type CorrelationFields,
  type Level,
  type LogFields,
  type LogLevel,
  type LogMethod,
  type Logger,
  type LoggerOptions,
  type LogSink,
} from './log/logger.ts';
export {
  isSensitiveKey,
  REDACTED,
  redactText,
  redactValue,
} from './log/redact.ts';
export {
  BrokerScheduler,
  createManualTimers,
  DEFAULT_AIMD,
  isOverloadError,
  scheduleMgmtRead,
  scheduleMgmtWrite,
  schedulePromScrape,
  systemTimers,
  type AimdOptions,
  type BrokerSchedulerOptions,
  type BrokerStats,
  type HeldSlot,
  type ManualTimers,
  type ScheduledWriteOptions,
  type SchedulerDrop,
  type SchedulerRequest,
  type SchedulerStats,
  type Timers,
} from './scheduler/index.ts';
export {
  AppError,
  PROBLEM_STATUS,
  problemType,
  toProblem,
  type AppErrorOptions,
  type ToProblemOptions,
} from './problem/problem.ts';
