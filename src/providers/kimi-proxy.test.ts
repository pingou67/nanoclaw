/**
 * Guard for the kimi provider's one reach-in into shared spawn code. The logic
 * lives here in the provider (skill-owned); container-runner.ts only imports
 * `proxyClearingArgs` and calls it after OneCLI has pushed its proxy env, so
 * the later `-e` wins.
 *
 * This is the failure mode the test exists for: with the OneCLI proxy left in
 * place, kimi (undici + NODE_USE_ENV_PROXY=1) routes LAN traffic through the
 * gateway, a remote MCP server fails with ERR_HPE_INVALID_CONSTANT, and kimi
 * drops it WITHOUT LOGGING ANYTHING — its tools just never appear. Nothing
 * else in the suite would catch the block being dropped by a merge.
 */
import { describe, it, expect } from 'vitest';

import { proxyClearingArgs } from './kimi.js';

describe('proxyClearingArgs', () => {
  it('blanks both the uppercase AND lowercase proxy pair for kimi', () => {
    const args = proxyClearingArgs('kimi');
    // undici reads the lowercase pair, and those are the ones OneCLI sets with
    // credentials — clearing only the uppercase pair changes nothing.
    expect(args).toEqual(['-e', 'HTTPS_PROXY=', '-e', 'HTTP_PROXY=', '-e', 'https_proxy=', '-e', 'http_proxy=']);
  });

  it('leaves every other provider on the gateway proxy', () => {
    // opencode and agy need the gateway to inject their upstream key; clearing
    // it there would strip the auth header and the upstream returns 401.
    for (const provider of ['claude', 'opencode', 'agy', 'mock']) {
      expect(proxyClearingArgs(provider)).toEqual([]);
    }
  });
});
