import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { maskAccountNumber, redactText, sanitizeError } from '../src/lib/sanitize.js';

describe('maskAccountNumber', () => {
  it('keeps only the last four digits', () => {
    assert.equal(maskAccountNumber('881234567'), '****4567');
  });

  it('handles missing or short values safely', () => {
    assert.equal(maskAccountNumber(''), '****');
    assert.equal(maskAccountNumber(null), '****');
    assert.equal(maskAccountNumber('12'), '****12');
  });
});

describe('sanitizeError', () => {
  it('redacts configured secrets, headers, tokens, and account numbers', () => {
    const text = redactText(
      'consumerKey=abcd-secret userSecret: user-secret Authorization: Bearer token-123 accountNumber=123456789',
      ['abcd-secret', 'user-secret'],
    );
    assert.doesNotMatch(text, /abcd-secret|user-secret|token-123|123456789/);
    assert.match(text, /\[REDACTED\]/);
  });
  it('classifies plain errors as internal', () => {
    const safe = sanitizeError(new Error('disk full'));
    assert.equal(safe.kind, 'internal');
    assert.equal(safe.message, 'disk full');
  });

  it('classifies SnaptradeServiceError by name as upstream', () => {
    const error = new Error('accountInformation.listUserAccounts failed (503): down');
    error.name = 'SnaptradeServiceError';
    error.status = 503;
    const safe = sanitizeError(error);
    assert.equal(safe.kind, 'snaptrade');
    assert.equal(safe.status, 503);
  });

  it('truncates very long messages', () => {
    const safe = sanitizeError(new Error('x'.repeat(500)));
    assert.ok(safe.message.length <= 201);
  });
});
