import type { VersionedTransaction } from '@solana/web3.js'

declare class MetaKeep {
  /// @notice Configures the MetaKeep SDK with the provided application identifier.
  constructor(options: { appId: string });

  /// @notice Retrieves the wallet details bound to the current MetaKeep user session.
  getWallet(): Promise<{
    status: 'SUCCESS' | 'ERROR';
    wallet: {
      ethAddress?: string;
      solAddress?: string;
      eosAddress?: string;
    };
  }>;

  /// @notice Requests the user to sign a serialized Solana transaction with contextual intent.
  signTransaction(
    transaction: VersionedTransaction,
    reason: string
  ): Promise<{
    status: 'SUCCESS' | 'ERROR';
    signature?: string;
  }>;
}

declare global {
  interface Window {
    /// @notice Exposes the MetaKeep constructor injected through the CDN script tag.
    MetaKeep?: typeof MetaKeep;
  }
}

export {};

