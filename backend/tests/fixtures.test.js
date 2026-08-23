import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

describe('sanitized Phase 1 fixtures', () => {
  it('represent cash, equity, short put, short call, orders, and option activity', () => {
    const balances = load('balances.json');
    const positions = load('positions.json').results;
    const orders = load('orders.json');
    const activities = load('activities.json');
    assert.ok(Number(balances[0].cash) > 0);
    assert.ok(positions.some((position) => Number(position.units) > 0));
    assert.ok(positions.some((position) => position.symbol.option_type === 'PUT' && Number(position.units) < 0));
    assert.ok(positions.some((position) => position.symbol.option_type === 'CALL' && Number(position.units) < 0));
    assert.ok(orders.every((order) => order.option_symbol));
    assert.equal(activities.data.length, activities.pagination.total);
  });

  it('contain no account numbers or credential-shaped fields', () => {
    const serialized = ['balances.json', 'positions.json', 'orders.json', 'activities.json']
      .map((name) => JSON.stringify(load(name))).join('');
    assert.doesNotMatch(serialized, /consumer.?key|user.?secret|authorization|account.?number/i);
  });
});
