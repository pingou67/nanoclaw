/**
 * Integration test for the agy provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel. Importing the
 * barrel runs agy.ts's top-level registerProviderContainerConfig('agy', …);
 * without that import line the host never wires the provider's per-spawn mounts
 * (the agy binary + ~/.gemini token dir).
 *
 * BARREL-ONLY: imports the real barrel (./index.js), never ./agy.js directly,
 * then asserts the registry actually contains the provider. Goes red if the
 * barrel import is deleted/drifts, or the barrel fails to evaluate.
 */
import { describe, it, expect } from 'vitest';

import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

describe('agy provider host registration', () => {
  it('registers agy host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('agy');
  });
});
