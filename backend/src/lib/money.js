const SCALE = 100;

export function toMinor(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = `${match[3] ?? ''}00`.slice(0, 2);
  const minor = BigInt(match[2]) * BigInt(SCALE) + BigInt(fraction);
  const signed = match[1] ? -minor : minor;
  const number = Number(signed);
  return Number.isSafeInteger(number) ? number : null;
}

export function fromMinor(value) {
  if (!Number.isSafeInteger(value)) return null;
  return (value / SCALE).toFixed(2);
}

export function sumMinor(values) {
  return values.reduce((total, value) => total + (Number.isSafeInteger(value) ? value : 0), 0);
}
