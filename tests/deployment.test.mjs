import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

test('HTTPS is published only on the configurable LAN host port', () => {
  assert.match(compose, /- "\$\{LAN_HOST\}:\$\{HTTPS_PORT:-8443\}:443"/);
  assert.doesNotMatch(compose, /- "(?:\$\{LAN_HOST\}:)?(?:80|443):(?:80|443)"/);
  assert.match(example, /^HTTPS_PORT=8443$/m);
});
