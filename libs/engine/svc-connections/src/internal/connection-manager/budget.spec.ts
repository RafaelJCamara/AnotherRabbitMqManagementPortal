import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_MAX,
  DEFAULT_TOOL_CONNECTION_CAP,
  deriveBudget,
} from './budget.ts';

describe('connection-manager budget', () => {
  it('A-10 takes 2 or 3 connections on a tight broker and never more than a quarter of connection_max', () => {
    expect(deriveBudget({ limits: { connectionMax: 10 } }).toolMax).toBe(2);
    expect(deriveBudget({ limits: { connectionMax: 12 } }).toolMax).toBe(3);
    expect(deriveBudget({ limits: { connectionMax: 20 } }).toolMax).toBe(5);
    expect(deriveBudget({ limits: { connectionMax: 1000 } }).toolMax).toBe(
      DEFAULT_TOOL_CONNECTION_CAP,
    );
  });

  it('uses the default cap when the broker states no limit', () => {
    expect(deriveBudget({ limits: {} })).toEqual({
      toolMax: DEFAULT_TOOL_CONNECTION_CAP,
      roleMax: DEFAULT_ROLE_MAX,
      brokerMax: null,
    });
  });

  it('a preset sets the cap, but never above the broker connection_max', () => {
    expect(deriveBudget({ limits: {}, toolConnectionCap: 3 }).toolMax).toBe(3);
    expect(
      deriveBudget({ limits: { connectionMax: 2 }, toolConnectionCap: 9 })
        .toolMax,
    ).toBe(2);
    expect(deriveBudget({ limits: { connectionMax: 1 } }).toolMax).toBe(1);
  });

  it('holds every role to the tool cap', () => {
    const budget = deriveBudget({
      limits: {},
      toolConnectionCap: 2,
      roleMax: { peek: 5, publish: 1 },
    });

    expect(budget.roleMax).toEqual({
      peek: 2,
      source: 2,
      publish: 1,
      observe: 2,
    });
  });

  it('holds observe to consumers_per_channel when the broker states one', () => {
    const amazon = deriveBudget({
      limits: { consumersPerChannelMax: 10 },
      toolConnectionCap: 20,
    });
    expect(amazon.roleMax.observe).toBe(10);

    // A preset may lower it, never raise it above what a channel holds.
    expect(
      deriveBudget({
        limits: { consumersPerChannelMax: 10 },
        toolConnectionCap: 20,
        roleMax: { observe: 30 },
      }).roleMax.observe,
    ).toBe(10);
    expect(
      deriveBudget({
        limits: { consumersPerChannelMax: 10 },
        toolConnectionCap: 20,
        roleMax: { observe: 3 },
      }).roleMax.observe,
    ).toBe(3);
  });

  it('ignores limits that are not whole numbers of at least 1', () => {
    const budget = deriveBudget({
      limits: {
        connectionMax: 0,
        consumersPerChannelMax: Number.NaN,
      },
      toolConnectionCap: -4,
      roleMax: { peek: Number.POSITIVE_INFINITY },
    });

    expect(budget.toolMax).toBe(DEFAULT_TOOL_CONNECTION_CAP);
    expect(budget.roleMax).toEqual(DEFAULT_ROLE_MAX);
    expect(budget.brokerMax).toBeNull();
  });
});
