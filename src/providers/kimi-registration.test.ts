/**
 * Integration test for the kimi provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel. Importing the
 * barrel runs kimi.ts's top-level registerProviderContainerConfig('kimi', …);
 * without that import line the host never wires the provider's per-spawn mounts
 * (the kimi binary, the session KIMI_CODE_HOME, the OAuth credentials dir).
 *
 * BARREL-ONLY: imports the real barrel (./index.js), never ./kimi.js directly,
 * then asserts the registry actually contains the provider. Goes red if the
 * barrel import is deleted/drifts, or the barrel fails to evaluate.
 */
import { describe, it, expect } from 'vitest';

import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

describe('kimi provider host registration', () => {
  it('registers kimi host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('kimi');
  });
});
