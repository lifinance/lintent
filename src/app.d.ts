// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
  interface BigInt {
    toJSON(): string;
  }

  interface TronWebDefaultAddress {
    base58: string;
    hex: string;
  }

  interface TronWebContract {
    at(address: string): Promise<TronWebContractInstance>;
  }

  interface TronWebContractFactory {
    (): TronWebContract;
    (abi: Record<string, unknown>[], address: string): Promise<TronWebContractInstance>;
  }

  interface TronWebContractInstance {
    [method: string]: (...args: unknown[]) => {
      send: (opts?: Record<string, unknown>) => Promise<string>;
      call: (opts?: Record<string, unknown>) => Promise<unknown>;
    };
  }

  interface TronWeb {
    ready: boolean;
    defaultAddress: TronWebDefaultAddress;
    trx: {
      getBalance(address: string): Promise<number>;
      getTransactionInfo(txId: string): Promise<Record<string, unknown>>;
      getBlock(blockNumber: number): Promise<{
        block_header: { raw_data: { timestamp: number | string } };
      }>;
      sign(message: string): Promise<string>;
    };
    contract: TronWebContractFactory;
    toHex(value: string): string;
    address: {
      fromHex(hex: string): string;
      toHex(base58: string): string;
    };
  }

  interface TronLink {
    ready: boolean;
    request(args: { method: string }): Promise<{ code: number; message?: string }>;
    tronWeb: TronWeb;
  }

  interface Window {
    tronWeb?: TronWeb;
    tronLink?: TronLink;
  }
}

export {};
