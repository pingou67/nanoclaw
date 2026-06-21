import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { AgyProvider } from './agy.js';

describe('createProvider (agy)', () => {
  it('returns AgyProvider for agy', () => {
    expect(createProvider('agy')).toBeInstanceOf(AgyProvider);
  });
});
