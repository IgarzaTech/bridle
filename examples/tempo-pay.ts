/**
 * payFn REAL para el demo en modo `tempo`: envía un `transferWithMemo` de pathUSD en
 * Tempo testnet (Moderato). Es código de EJEMPLO — muestra el patrón "envuelve TU pago
 * con Bridle". NO reusa el TempoRail de NexoPay: un dev externo no lo tendría.
 *
 * Requiere por env: TEMPO_TEST_PRIVATE_KEY (signer fondeado), TEMPO_TEST_RECIPIENT.
 * RPC y chainId por defecto apuntan a Moderato.
 */
import {
  createWalletClient,
  http,
  parseUnits,
  defineChain,
  getAddress,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const TEMPO_MODERATO = defineChain({
  id: 42431,
  name: 'Tempo Moderato (testnet)',
  nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
});

const PATHUSD_ADDRESS = '0x20c0000000000000000000000000000000000000';

// ABI mínimo de transferWithMemo (3 args en Tempo: to, amount, memo).
const TRANSFER_WITH_MEMO_ABI = [
  {
    type: 'function',
    name: 'transferWithMemo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'memo', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export interface TempoPayer {
  signerAddress: string;
  /** Envía el pago real y devuelve el txHash + link al explorer. */
  pay(): Promise<{ txHash: string; explorer: string }>;
}

export function createTempoPayer(opts: { amount: string; memoHex?: `0x${string}` }): TempoPayer {
  const pk = process.env.TEMPO_TEST_PRIVATE_KEY;
  const recipient = process.env.TEMPO_TEST_RECIPIENT;
  const rpcUrl = process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz';
  if (!pk || !recipient) {
    throw new Error(
      'modo tempo requiere TEMPO_TEST_PRIVATE_KEY y TEMPO_TEST_RECIPIENT en el entorno',
    );
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: TEMPO_MODERATO,
    transport: http(rpcUrl),
  });
  // bytes32 de demo (un identificador cualquiera).
  const memo = opts.memoHex ?? (`0x${'00'.repeat(28)}deadbeef` as `0x${string}`);

  return {
    signerAddress: account.address,
    async pay(): Promise<{ txHash: string; explorer: string }> {
      const txHash: Hash = await wallet.writeContract({
        address: PATHUSD_ADDRESS,
        abi: TRANSFER_WITH_MEMO_ABI,
        functionName: 'transferWithMemo',
        args: [getAddress(recipient), parseUnits(opts.amount, 6), memo],
      });
      return { txHash, explorer: `https://explore.testnet.tempo.xyz/tx/${txHash}` };
    },
  };
}
