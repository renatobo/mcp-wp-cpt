import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveLogData } from '../src/wordpress.js';

test('redacts credentials and tokens recursively without mutating input', () => {
  const input = {
    Authorization: 'Basic dXNlcjpzZWNyZXQ=',
    nested: {
      password: 'secret',
      access_token: 'token',
      safe: 'visible'
    }
  };

  assert.deepEqual(redactSensitiveLogData(input), {
    Authorization: '[REDACTED]',
    nested: {
      password: '[REDACTED]',
      access_token: '[REDACTED]',
      safe: 'visible'
    }
  });
  assert.equal(input.Authorization, 'Basic dXNlcjpzZWNyZXQ=');
});

test('redacts sensitive values inside arrays', () => {
  assert.deepEqual(redactSensitiveLogData([{ cookie: 'session=secret' }]), [
    { cookie: '[REDACTED]' }
  ]);
});
