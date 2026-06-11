import { InvalidAmountError } from './errors';

/**
 * Escala de decimales fija del MVP: 6 (stablecoins USD — pathUSD, USDC).
 * Decimales por moneda (configurables) es post-MVP (ver spec 0004, AC-4 / Riesgos).
 * Es una CONSTANTE del paquete, no un parámetro por `currency`.
 */
export const SCALE_DECIMALS = 6;
const SCALE = 10n ** BigInt(SCALE_DECIMALS);

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Parsea un monto decimal string (ej. "100.00", "0.000001") a `bigint` escalado a
 * 6 decimales — la representación INTERNA de cómputo. Rechaza negativos, notación
 * científica, y más de 6 decimales (precisión no representable).
 *
 * @throws {InvalidAmountError} si el formato no es un decimal no-negativo válido.
 */
export function parseAmount(amount: string): bigint {
  if (typeof amount !== 'string' || !DECIMAL_RE.test(amount)) {
    throw new InvalidAmountError(`invalid amount: ${JSON.stringify(amount)}`);
  }
  const [whole, frac = ''] = amount.split('.');
  if (frac.length > SCALE_DECIMALS) {
    throw new InvalidAmountError(
      `amount has more than ${SCALE_DECIMALS} decimals: ${amount}`,
    );
  }
  const fracPadded = frac.padEnd(SCALE_DECIMALS, '0');
  return BigInt(whole) * SCALE + BigInt(fracPadded);
}

/**
 * Formatea un `bigint` escalado de vuelta a decimal string con 6 decimales.
 * Inverso de `parseAmount` (sin pérdida).
 */
export function formatAmount(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(SCALE_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}
