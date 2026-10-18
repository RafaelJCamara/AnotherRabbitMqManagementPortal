// The local guardrails (M0-30): the prod lock and the two actions that open and close it.
export { createArmActions } from './ops-actions.ts';
export {
  ARM_ACTION_ID,
  ARM_WINDOW_MS,
  canArm,
  createGuardrails,
  DISARM_ACTION_ID,
  PROD_LOCK_GATE,
  type ArmingControl,
  type ArmStatus,
  type Guardrails,
  type GuardrailsOptions,
} from './policy.ts';
