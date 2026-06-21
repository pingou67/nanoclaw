/**
 * Integration test for the agy provider's CONTAINER-side reach-in: the
 * self-registration import in container/agent-runner/src/providers/index.ts.
 * Importing the barrel runs agy.ts's top-level registerProvider('agy', …);
 * without that import line createProvider('agy') throws 'Unknown provider'.
 *
 * BARREL-ONLY: imports the real barrel (./index.js), never ./agy.js directly,
 * then asserts listProviderNames() contains the provider. Goes red if the
 * barrel import is deleted/drifts or the barrel fails to evaluate.
 */
import { describe, it, expect } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('agy provider registration', () => {
  it('registers agy via the provider barrel', () => {
    expect(listProviderNames()).toContain('agy');
  });
});
