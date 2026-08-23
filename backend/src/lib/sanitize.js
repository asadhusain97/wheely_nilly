import { SnaptradeError } from 'snaptrade-typescript-sdk';

const MAX_MESSAGE_LENGTH = 200;

export function maskAccountNumber(number) {
  if (typeof number !== 'string' || number.length === 0) {
    return '****';
  }
  return `****${number.slice(-4)}`;
}

function truncate(value) {
  const text = String(value ?? '');
  return text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
    : text;
}

export function redactText(value, secrets = []) {
  let text = String(value ?? '');
  const candidates = secrets
    .filter((secret) => typeof secret === 'string' && secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of candidates) {
    text = text.split(secret).join('[REDACTED]');
  }
  text = text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:consumer[_ -]?key|user[_ -]?secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:account(?:[_ -]?number)?)\s*[:=]\s*)\d{5,}/gi, '$1[REDACTED]');
  return text;
}

export function sanitizeError(error, { secrets = [] } = {}) {
  const message = truncate(redactText(error?.message ?? String(error), secrets));
  if (error instanceof SnaptradeError || error?.name === 'SnaptradeServiceError') {
    return {
      kind: 'snaptrade',
      status: error.status ?? null,
      statusText: error.statusText ?? null,
      code: error.code ?? null,
      message,
    };
  }
  return {
    kind: 'internal',
    status: typeof error?.status === 'number' ? error.status : null,
    statusText: null,
    code: error?.code ?? null,
    message,
  };
}
