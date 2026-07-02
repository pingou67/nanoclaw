/**
 * Integration test for the mattermost channel's reach-in: the self-registration
 * import in the src/channels/index.ts barrel. Importing the barrel runs
 * mattermost.ts's top-level registerChannelAdapter('mattermost', …); without
 * that import line the host never discovers the adapter and every Mattermost
 * messaging group goes dark.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel
 * (./index.js), never ./mattermost.js directly, then asserts the registry
 * actually contains the channel. Importing the adapter module directly would
 * self-register it and stay GREEN even if the barrel line were deleted — that
 * would be a unit test, not a registration guard. This test goes red if the
 * barrel import is deleted/drifts, if the barrel fails to evaluate, or if the
 * `ws` dependency the adapter imports at module load is missing.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real channels barrel — triggers each adapter's self-registration

describe('mattermost channel registration', () => {
  it('registers the mattermost adapter via the channels barrel', () => {
    expect(getRegisteredChannelNames()).toContain('mattermost');
  });
});
