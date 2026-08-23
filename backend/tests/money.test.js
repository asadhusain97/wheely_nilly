import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromMinor, sumMinor, toMinor } from '../src/lib/money.js';

describe('decimal-safe money', () => {
  it('converts decimal strings without binary floating-point accounting', () => {
    assert.equal(toMinor('125.03'), 12503);
    assert.equal(toMinor('-11.00'), -1100);
    assert.equal(fromMinor(sumMinor([12503, -1100, -4])), '113.99');
  });
  it('rejects malformed and unsafe values', () => {
    assert.equal(toMinor('not-money'), null);
    assert.equal(toMinor('99999999999999999999'), null);
  });
});
