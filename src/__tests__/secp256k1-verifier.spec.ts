import { Secp256k1SignatureVerifier } from '../secp256k1-verifier';
import { addressFromPrivateKey, signEip191, testPrivateKey } from './signing-helpers';

describe('Secp256k1SignatureVerifier (AC-5 default verifier)', () => {
  const verifier = new Secp256k1SignatureVerifier();

  it('recupera la address del firmante (EIP-191 personal_sign)', async () => {
    const pk = testPrivateKey(7);
    const addr = addressFromPrivateKey(pk);
    const message = 'bridle-identity:test:nonce-1:1700000000';
    const sig = signEip191(pk, message);

    const recovered = await verifier.recover(sig, message);
    expect(recovered.toLowerCase()).toBe(addr.toLowerCase());
  });

  it('recupera una address DISTINTA si el mensaje difiere', async () => {
    const pk = testPrivateKey(7);
    const addr = addressFromPrivateKey(pk);
    const sig = signEip191(pk, 'mensaje-A');

    const recovered = await verifier.recover(sig, 'mensaje-B');
    expect(recovered.toLowerCase()).not.toBe(addr.toLowerCase());
  });

  it('lanza con firma malformada', async () => {
    await expect(verifier.recover('0xdeadbeef', 'm')).rejects.toThrow();
  });
});
