const test = require('node:test');
const assert = require('node:assert');
const { parseFilm, ValidationError } = require('../src/services/filmService');

const valid = { title: 'ACADEMY DINOSAUR', stock: '5', rental_rate: '0.99', rental_duration: '6' };

test('accepts a valid film and converts the numbers', () => {
  assert.deepStrictEqual(parseFilm({ ...valid, film_id: '12' }), {
    film_id: 12, title: 'ACADEMY DINOSAUR', stock: 5, rental_rate: 0.99, rental_duration: 6,
  });
});

test('film_id is optional on create', () => {
  assert.strictEqual(parseFilm(valid).film_id, undefined);
});

test('rejects out-of-range values with one message per field', () => {
  try {
    parseFilm({ film_id: '-3', title: ' ', stock: '1.5', rental_rate: '100', rental_duration: '0' });
    assert.fail('expected a ValidationError');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.deepStrictEqual(Object.keys(err.errors).sort(),
      ['film_id', 'rental_duration', 'rental_rate', 'stock', 'title']);
  }
});

test('rental rate fits DECIMAL(4,2)', () => {
  assert.strictEqual(parseFilm({ ...valid, rental_rate: '99.99' }).rental_rate, 99.99);
  assert.throws(() => parseFilm({ ...valid, rental_rate: '1.999' }), ValidationError);
});
