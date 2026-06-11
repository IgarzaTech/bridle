/**
 * `SignatureVerifier` — abstrae cómo se recupera el firmante de una firma.
 *
 * Bridle envía una implementación por defecto secp256k1 (`Secp256k1SignatureVerifier`)
 * para que el quickstart funcione out-of-the-box. La interfaz permite enchufar
 * verificadores on-chain (P256/WebAuthn/smart-account) en el futuro sin tocar el core.
 */
export interface SignatureVerifier {
  /**
   * Recupera la dirección (address `0x…` en minúsculas) que firmó `message` con
   * `signature`. El cómputo del hash del mensaje es responsabilidad del verifier
   * (la implementación por defecto usa el esquema EIP-191 personal_sign).
   * Si la firma es inválida/irrecuperable, DEBE lanzar.
   */
  recover(signature: string, message: string): Promise<string>;
}
