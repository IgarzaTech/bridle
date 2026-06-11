import { parseAmount, formatAmount, SCALE_DECIMALS } from '../amount';
import { InvalidAmountError } from '../errors';

describe('amount — aritmética decimal exacta (AC-4)', () => {
  it('escala 6 decimales fija (MVP)', () => {
    expect(SCALE_DECIMALS).toBe(6);
  });

  it('parsea decimales a bigint escalado', () => {
    expect(parseAmount('100.00')).toBe(100_000_000n);
    expect(parseAmount('1')).toBe(1_000_000n);
    expect(parseAmount('0.000001')).toBe(1n);
    expect(parseAmount('0')).toBe(0n);
  });

  it('NO pierde precisión donde un float SÍ (acumular 0.1 diez veces == 1.0 exacto)', () => {
    // En float: 0.1 * 10 === 0.9999999999999999 (mal). En bigint: exacto.
    let totalScaled = 0n;
    const oneTenth = parseAmount('0.1');
    for (let i = 0; i < 10; i++) totalScaled += oneTenth;
    expect(totalScaled).toBe(parseAmount('1.0')); // 1_000_000n exacto
    expect(formatAmount(totalScaled)).toBe('1.000000');

    // Evidencia de que el float erraría:
    let floatTotal = 0;
    for (let i = 0; i < 10; i++) floatTotal += 0.1;
    expect(floatTotal).not.toBe(1); // 0.9999999999999999
  });

  it('roundtrip parse/format', () => {
    for (const v of ['0.000000', '1.500000', '999999.999999', '100.000000']) {
      expect(formatAmount(parseAmount(v))).toBe(v);
    }
  });

  it('rechaza formatos inválidos', () => {
    for (const bad of ['abc', '-1', '1.2.3', '', '0.1234567', '1e6', ' 1', '1 ']) {
      expect(() => parseAmount(bad)).toThrow(InvalidAmountError);
    }
  });
});
