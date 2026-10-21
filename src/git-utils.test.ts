import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  formatCommandArgs,
  httpsCredentialContext,
  redactSensitiveText,
  remoteTransport
} from './git-utils';

test('classifies supported remote transports', () => {
  assert.equal(remoteTransport('https://github.com/org/repo.git'), 'https');
  assert.equal(remoteTransport('git@github.com:org/repo.git'), 'ssh');
  assert.equal(remoteTransport('ssh://git@example.com/org/repo.git'), 'ssh');
  assert.equal(remoteTransport('../repo'), 'other');
});

test('creates a host-level HTTPS credential context without changing the URL', () => {
  assert.equal(
    httpsCredentialContext('https://github.com/org/repo.git'),
    'https://github.com'
  );
  assert.equal(httpsCredentialContext('git@github.com:org/repo.git'), undefined);
});

test('redacts credentials from URLs, query strings, and authorization headers', () => {
  const input = 'https://user:secret@example.com/repo?access_token=abc Authorization: Bearer xyz';
  const output = redactSensitiveText(input);
  assert.equal(output.includes('secret'), false);
  assert.equal(output.includes('abc'), false);
  assert.equal(output.includes('xyz'), false);
  assert.match(output, /https:\/\/\*\*\*@example\.com/);
});

test('redacts SSH identity paths in logged command arguments', () => {
  assert.equal(
    formatCommandArgs(['-i', 'C:/Users/name/.ssh/private key', '-T', 'git@github.com']),
    '-i <key-path> -T git@github.com'
  );
});
