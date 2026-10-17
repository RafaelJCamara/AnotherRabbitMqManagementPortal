// Vocabularies shared by actions, receipts and runtime configuration.
import { z } from 'zod';

/** Environment class of a connection; an unset class means `prod` (fail closed). */
export const EnvClassSchema = z.enum([
  'prod',
  'staging',
  'test',
  'dev',
  'local',
]);
export type EnvClass = z.infer<typeof EnvClassSchema>;

export const RiskSchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export type Risk = z.infer<typeof RiskSchema>;

export const EngineModeSchema = z.enum(['desktop', 'local', 'team']);
export type EngineMode = z.infer<typeof EngineModeSchema>;

export const QosSchema = z.enum(['lossless', 'latest', 'sampled']);
export type Qos = z.infer<typeof QosSchema>;
