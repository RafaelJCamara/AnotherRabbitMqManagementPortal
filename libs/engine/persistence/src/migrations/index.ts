import type { Migration } from '../migrate/types';
import { migration0001Core } from './0001_core';

export const migrations: readonly Migration[] = [migration0001Core];
