import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

/**
 * Helpers de FIRMA solo para tests (el verifier del paquete solo RECUPERA).
 * Producen firmas EIP-191 personal_sign compatibles con `Secp256k1SignatureVerifier`.
 */

export function addressFromPrivateKey(privKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1); // sin el 0x04
  const addr = keccak_256(pub).slice(-20);
  return `0x${bytesToHex(addr)}`;
}

export function signEip191(privKey: Uint8Array, message: string): string {
  const msgBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const digest = keccak_256(concatBytes(prefix, msgBytes));
  const sig = secp256k1.sign(digest, privKey); // lowS por defecto (canónico)
  const full = new Uint8Array(65);
  full.set(sig.toCompactRawBytes(), 0);
  full[64] = sig.recovery + 27;
  return `0x${bytesToHex(full)}`;
}

/** Clave privada determinista de 32 bytes para tests (no usar fuera de tests). */
export function testPrivateKey(seed: number): Uint8Array {
  const k = new Uint8Array(32);
  k[31] = seed & 0xff;
  k[30] = (seed >> 8) & 0xff;
  k[0] = 1; // asegura != 0 y dentro del orden de la curva
  return k;
}
