import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';
import type { SignatureVerifier } from './signature-verifier';

/**
 * Implementación por defecto de `SignatureVerifier` para signers EOA estándar
 * (MetaMask, viem, ethers) usando el esquema **EIP-191 `personal_sign`**:
 *
 *   digest = keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)
 *
 * Recupera la address Ethereum del firmante a partir de una firma `0x{r}{s}{v}`
 * de 65 bytes. Out-of-the-box para el quickstart — sin que el usuario escriba
 * código de criptografía.
 */
export class Secp256k1SignatureVerifier implements SignatureVerifier {
  recover(signature: string, message: string): Promise<string> {
    // why: todo el cómputo es síncrono (noble), pero el contrato de la interfaz es
    // una Promise — envolvemos en try/catch para que cualquier fallo sea un REJECT
    // (no un throw síncrono que un `await ...catch` no atraparía).
    try {
      const sigBytes = this.parseSignature(signature);
      const r = sigBytes.slice(0, 32);
      const s = sigBytes.slice(32, 64);
      const v = sigBytes[64];
      const recovery = v >= 27 ? v - 27 : v;
      if (recovery !== 0 && recovery !== 1) {
        throw new Error(`invalid signature recovery byte: ${v}`);
      }

      const digest = this.eip191Digest(message);
      const sig = secp256k1.Signature.fromCompact(concatBytes(r, s)).addRecoveryBit(recovery);

      const point = sig.recoverPublicKey(bytesToHex(digest));
      // Clave pública sin comprimir: 0x04 || X(32) || Y(32). La address es los
      // últimos 20 bytes de keccak256(X || Y).
      const pubUncompressed = point.toRawBytes(false).slice(1);
      const address = keccak_256(pubUncompressed).slice(-20);
      return Promise.resolve(`0x${bytesToHex(address)}`);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private eip191Digest(message: string): Uint8Array {
    const msgBytes = utf8ToBytes(message);
    const prefix = utf8ToBytes(
      `\x19Ethereum Signed Message:\n${msgBytes.length}`,
    );
    return keccak_256(concatBytes(prefix, msgBytes));
  }

  private parseSignature(signature: string): Uint8Array {
    const hex = signature.startsWith('0x') ? signature.slice(2) : signature;
    if (hex.length !== 130) {
      throw new Error(
        `invalid signature length: expected 65 bytes (130 hex chars), got ${hex.length}`,
      );
    }
    return hexToBytes(hex);
  }
}
