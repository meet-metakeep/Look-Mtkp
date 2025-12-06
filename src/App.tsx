/// @notice Imports React helpers to orchestrate state, effects, memoization, and callbacks.
import { useCallback, useEffect, useMemo, useState } from "react";
/// @notice Imports the MoonPay buy widget binding (swap temporarily disabled).
import {
  MoonPayBuyWidget /* , MoonPaySwapWidget */,
} from "@moonpay/moonpay-react";
/// @notice Imports the Solana transaction helper used for MetaKeep signing.
import { VersionedTransaction } from "@solana/web3.js";
/// @notice Pulls in the scoped stylesheet for the enterprise surface.
import "./App.css";

/// @notice Declares the LOOK token Solana mint for illustrative purchases.
const LOOK_TOKEN_MINT = "9223LqDuoJXyhCtvi54DUQPGS8Xf29kUEQRr7Sfhmoon";
/// @notice Declares the canonical USDC mint used for swaps.
const USDC_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// @notice Declares known token decimals for formatting fallbacks.
const TOKEN_DECIMALS: Record<string, number> = {
  [LOOK_TOKEN_MINT]: 3,
  [USDC_TOKEN_MINT]: 6,
};
/// @notice Provides the default Jupiter input mint (USDC for swaps).
const DEFAULT_INPUT_MINT = USDC_TOKEN_MINT;
/// @notice Provides the default Jupiter output mint (LOOK token).
const DEFAULT_OUTPUT_MINT = LOOK_TOKEN_MINT;
/// @notice Provides the default lamport-denominated swap amount.
const DEFAULT_SWAP_AMOUNT = "1";

/// @notice Shapes the MetaKeep wallet state object.
type WalletState = {
  status: "idle" | "loading" | "ready" | "error";
  address?: string;
  message?: string;
};

/// @notice Enumerates async status states for UI surfaces.
type AsyncStatus = "idle" | "loading" | "success" | "error";

/// @notice Formats numeric values without grouping to avoid locale confusion.
const numberFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
  useGrouping: false,
});

/// @notice Safely formats a numeric metric.
const formatNumber = (value?: number | null) =>
  typeof value === "number" ? numberFormatter.format(value) : "—";

/// @notice Decodes a base64 string into the byte representation required by Solana.
const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/// @notice Encodes a byte buffer into base64 for Jupiter's execute API.
const encodeBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)));

/// @notice Normalizes numeric-like API fields into numbers when feasible.
const toNumeric = (value: unknown) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/// @notice Resolves a numeric field from a quote, supporting nested keys.
const resolveNumericField = (
  quote: Record<string, unknown> | null,
  keys: string | string[]
) => {
  if (!quote) return undefined;
  const candidateKeys = Array.isArray(keys) ? keys : [keys];
  for (const key of candidateKeys) {
    const value = key.split(".").reduce<unknown>((acc, segment) => {
      if (acc && typeof acc === "object") {
        return (acc as Record<string, unknown>)[segment];
      }
      return undefined;
    }, quote);
    const numeric = toNumeric(value);
    if (numeric !== undefined) {
      return numeric;
    }
  }
  return undefined;
};

/// @notice Derives a token amount from the Jupiter response for UI display.
const deriveTokenAmount = (
  quote: Record<string, unknown> | null,
  amountKey: string | string[],
  decimalsKey: string | string[],
  fallbackDecimals?: number
) => {
  const raw = resolveNumericField(quote, amountKey);
  if (raw === undefined) {
    return undefined;
  }
  const decimals = resolveNumericField(quote, decimalsKey) ?? fallbackDecimals;
  if (decimals === undefined) {
    return raw;
  }
  return raw / 10 ** decimals;
};

/// @notice Hosts the MoonPay + MetaKeep demonstration interface.
function App() {
  /// @notice Tracks the lifecycle of the MetaKeep wallet handshake.
  const [walletState, setWalletState] = useState<WalletState>({
    status: "idle",
  });
  /// @notice Controls whether the operator is viewing the onramp or swap desk.
  const [activeSurface, setActiveSurface] = useState<"onramp" | "swap">(
    "onramp"
  );
  /// @notice Captures the lamport-denominated notional for the Jupiter order.
  const [swapAmount, setSwapAmount] = useState(DEFAULT_SWAP_AMOUNT);
  /// @notice Captures the taker account that will receive the routed asset.
  const [takerAddress, setTakerAddress] = useState("");
  /// @notice Tracks the Jupiter order status helper text.
  const [orderMessage, setOrderMessage] = useState(
    "Quote a swap by specifying the base-unit amount and taker."
  );
  /// @notice Tracks the async state of the order request.
  const [orderStatus, setOrderStatus] = useState<AsyncStatus>("idle");
  /// @notice Stores the raw order quote payload.
  const [orderQuote, setOrderQuote] = useState<Record<string, unknown> | null>(
    null
  );
  /// @notice Stores the latest request ID surfaced by the order quote.
  const [pendingRequestId, setPendingRequestId] = useState("");
  /// @notice Stores the unsigned transaction returned by Jupiter order.
  const [pendingTransaction, setPendingTransaction] = useState("");
  /// @notice Tracks helper text for the execute section.
  const [executeMessage, setExecuteMessage] = useState(
    "Awaiting an unsigned transaction from Jupiter Ultra."
  );
  /// @notice Tracks the async status for the execute endpoint.
  const [executeStatus, setExecuteStatus] = useState<AsyncStatus>("idle");
  /// @notice Reads the MetaKeep App ID from the environment for secure initialization.
  const metaKeepAppId = import.meta.env.VITE_METAKEEP_APP_ID;

  /// @notice Ensures the MetaKeep App ID exists before any SDK calls execute.
  if (!metaKeepAppId) {
    /// @notice Provides deterministic guidance for developers configuring secrets.
    throw new Error(
      "Missing VITE_METAKEEP_APP_ID. Add it to your .env.local file."
    );
  }

  /// @notice Requests a custodial wallet from MetaKeep and surfaces the Solana address.
  const handleWalletRequest = useCallback(async () => {
    try {
      /// @notice Validates that the CDN SDK is already hydrated on the window object.
      if (!window.MetaKeep) {
        throw new Error("MetaKeep SDK is not available. Refresh and retry.");
      }

      /// @notice Updates UI state while MetaKeep authenticates the user.
      setWalletState({
        status: "loading",
        message: "Securing your wallet session with MetaKeep...",
      });

      /// @notice Creates a MetaKeep SDK instance with the configured App ID.
      const sdk = new window.MetaKeep({ appId: metaKeepAppId });
      /// @notice Awaits the asynchronous wallet lookup.
      const response = await sdk.getWallet();

      /// @notice Verifies that the SDK responded successfully with a Solana address.
      if (response.status !== "SUCCESS" || !response.wallet?.solAddress) {
        throw new Error("MetaKeep did not return a Solana address.");
      }

      /// @notice Stores the Solana address for downstream MoonPay configuration.
      setWalletState({
        status: "ready",
        address: response.wallet.solAddress,
        message: "Wallet secured. You can proceed with the $LOOK purchase.",
      });
    } catch (error) {
      /// @notice Derives a human-readable error description.
      const description =
        error instanceof Error ? error.message : "Unknown MetaKeep error";
      /// @notice Surfaces the failure to the enterprise status banner.
      setWalletState({
        status: "error",
        message: description,
      });
    }
  }, [metaKeepAppId]);

  /// @notice Routes the MoonPay widget URL to the secure signing endpoint.
  const signMoonPayUrl = useCallback(async (url: string) => {
    /// @notice Calls the local API proxy that holds the secret server-side.
    const response = await fetch("/api/sign-moonpay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    /// @notice Raises when the signer endpoint fails.
    if (!response.ok) {
      throw new Error("MoonPay signature endpoint rejected the request.");
    }

    /// @notice Parses the signature payload provided by the backend.
    const payload: { signature?: string; error?: string } =
      await response.json();

    /// @notice Ensures a signature is present before updating the widget.
    if (!payload.signature) {
      throw new Error(payload.error ?? "MoonPay signature payload malformed.");
    }

    /// @notice Supplies the MoonPay SDK with the freshly signed hash.
    return payload.signature;
  }, []);

  /// @notice Requests a Jupiter order quote using the configured form state.
  const handleOrderSubmit = useCallback(async () => {
    if (!swapAmount || !takerAddress) {
      setOrderStatus("error");
      setOrderMessage("Amount (base units) and taker are required.");
      return;
    }

    try {
      setOrderStatus("loading");
      setOrderMessage("Requesting a protected route from Jupiter Ultra...");

      const params = new URLSearchParams({
        inputMint: DEFAULT_INPUT_MINT,
        outputMint: DEFAULT_OUTPUT_MINT,
        amount: swapAmount,
        taker: takerAddress,
      }).toString();
      const response = await fetch(`/api/jupiter/order?${params}`);
      const payload: Record<string, unknown> = await response.json();

      if (!response.ok) {
        const reason =
          typeof payload.error === "string"
            ? payload.error
            : "Jupiter order request failed.";
        throw new Error(reason);
      }

      setOrderQuote(payload);

      const nextRequestId =
        typeof payload.requestId === "string" ? payload.requestId : "";
      const unsignedTransaction =
        typeof payload.swapTransaction === "string"
          ? payload.swapTransaction
          : typeof payload.transaction === "string"
          ? payload.transaction
          : "";

      setPendingRequestId(nextRequestId);
      setPendingTransaction(unsignedTransaction);
      setExecuteStatus("idle");
      setExecuteMessage(
        unsignedTransaction
          ? "Unsigned transaction ready. Sign with MetaKeep to continue."
          : "Route ready. Inspect the JSON payload for serialized data."
      );

      setOrderStatus("success");
      setOrderMessage(
        nextRequestId
          ? `Route secured. Request ID ${nextRequestId} is ready for signing.`
          : "Route secured. Inspect the JSON payload for serialized data."
      );
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "Unknown Jupiter error.";
      setOrderStatus("error");
      setOrderMessage(description);
      setPendingRequestId("");
      setPendingTransaction("");
    }
  }, [swapAmount, takerAddress]);

  /// @notice Executes the Jupiter Ultra transaction after MetaKeep signs it.
  const handleSignAndExecute = useCallback(async () => {
    if (!pendingTransaction || !pendingRequestId) {
      setExecuteStatus("error");
      setExecuteMessage(
        "Request a route and unsigned transaction before executing."
      );
      return;
    }

    if (!walletState.address) {
      setExecuteStatus("error");
      setExecuteMessage("Secure your MetaKeep wallet before signing swaps.");
      return;
    }

    if (!window.MetaKeep) {
      setExecuteStatus("error");
      setExecuteMessage("MetaKeep SDK unavailable. Refresh and retry.");
      return;
    }

    try {
      setExecuteStatus("loading");
      setExecuteMessage("Preparing MetaKeep signature...");

      const transactionBytes = decodeBase64(pendingTransaction);
      const transaction = VersionedTransaction.deserialize(transactionBytes);

      const sdk = new window.MetaKeep({ appId: metaKeepAppId });
      await sdk.signTransaction(
        transaction,
        "Authorize LOOK swap via Jupiter Ultra"
      );

      setExecuteMessage("Broadcasting signed transaction via Jupiter...");
      const signedBase64 = encodeBase64(transaction.serialize());
      const response = await fetch("/api/jupiter/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTransaction: signedBase64,
          requestId: pendingRequestId,
        }),
      });
      const payload: Record<string, unknown> = await response.json();

      if (!response.ok) {
        const reason =
          typeof payload.error === "string"
            ? payload.error
            : "Jupiter execute request failed.";
        throw new Error(reason);
      }

      const statusLabel =
        typeof payload.status === "string" ? payload.status : "Success";
      const signature =
        typeof payload.signature === "string" ? payload.signature : "pending";
      setExecuteStatus("success");
      setExecuteMessage(`${statusLabel} · Signature ${signature}`);
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "Unknown Jupiter error.";
      setExecuteStatus("error");
      setExecuteMessage(description);
    }
  }, [
    metaKeepAppId,
    pendingRequestId,
    pendingTransaction,
    walletState.address,
  ]);

  /// @notice Synchronizes the taker field with the secured MetaKeep wallet.
  useEffect(() => {
    if (walletState.address) {
      setTakerAddress((previous) => previous || walletState.address || "");
    }
  }, [walletState.address]);

  const estimatedOutputAmount = useMemo(
    () =>
      deriveTokenAmount(
        orderQuote,
        "outAmount",
        [
          "outputDecimals",
          "outDecimals",
          "outputToken.decimals",
          "outputTokenDecimals",
        ],
        TOKEN_DECIMALS[DEFAULT_OUTPUT_MINT]
      ),
    [orderQuote]
  );
  const isRouteReady = Boolean(pendingTransaction && pendingRequestId);
  const primaryCtaLabel = isRouteReady ? "Swap USDC with $LOOK" : "Get started";
  const primaryCtaLoading = isRouteReady
    ? executeStatus === "loading"
    : orderStatus === "loading";

  const handlePrimaryCta = useCallback(() => {
    if (pendingTransaction && pendingRequestId) {
      void handleSignAndExecute();
    } else {
      void handleOrderSubmit();
    }
  }, [
    handleOrderSubmit,
    handleSignAndExecute,
    pendingRequestId,
    pendingTransaction,
  ]);

  /// @notice Memorizes the widget parameters so they update only when needed.
  const moonPayParams = useMemo(() => {
    return {
      variant: "embedded" as const,
      colorCode: "#0a0a0a,#f2f2f2",
      theme: "dark" as const,
      paymentMethod: "credit_debit_card",
      redirectURL: "https://example.com/thank-you",
      unsupportedRegionRedirectUrl: "https://example.com/region-support",
      externalCustomerId: walletState.address ?? "anonymous-look-builder",
    };
  }, [walletState.address]);

  /// @notice Indicates whether the MoonPay widget should be rendered.
  const showWidget = Boolean(walletState.address);

  /// @notice Presents either the onramp experience or the Jupiter swap desk.
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-cluster">
          <span className="brand-mark">LOOK</span>
          <div>
            <p className="brand-title">$LOOK Liquidity Desk</p>
            <p className="brand-subtitle">MoonPay x MetaKeep</p>
          </div>
        </div>
        <div className="header-actions">
          <nav className="nav-tabs" aria-label="Experience selector">
            <button
              type="button"
              className={`nav-button ${
                activeSurface === "onramp" ? "is-active" : ""
              }`}
              onClick={() => setActiveSurface("onramp")}
            >
              Onramp
            </button>
            <button
              type="button"
              className={`nav-button ${
                activeSurface === "swap" ? "is-active" : ""
              }`}
              onClick={() => setActiveSurface("swap")}
            >
              Swap
            </button>
          </nav>
          <button
            className="ghost-link nav-wallet-button"
            onClick={handleWalletRequest}
            disabled={walletState.status === "loading"}
          >
            {walletState.address
              ? "Re-sync Wallet"
              : walletState.status === "loading"
              ? "Provisioning..."
              : "Secure Wallet"}
          </button>
        </div>
      </header>

      {activeSurface === "onramp" ? (
        <main className="content-grid content-centered">
          <section className="widget-panel moonpay-panel">
            <div className="widget-header">
              <div>
                <p className="widget-eyebrow">MoonPay Checkout</p>
                <p className="widget-title">Buy $LOOK · Solana Network</p>
              </div>
            </div>
            {!showWidget ? (
              <div className="widget-placeholder">
                <p>
                  Secure a MetaKeep wallet to unlock the embedded MoonPay
                  experience.
                </p>
              </div>
            ) : (
              <div className="moonpay-embed-shell">
                <div className="moonpay-embed-scale">
                  <MoonPayBuyWidget
                    {...moonPayParams}
                    onUrlSignatureRequested={signMoonPayUrl}
                  />
                </div>
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="swap-main">
          <section className="swap-grid">
            <div className="swap-card">
              <div className="panel-card-header">
                <p className="panel-eyebrow">Quoting</p>
                <h3 className="panel-title">Route Request</h3>
              </div>
              <div className="swap-ticket">
                <div className="swap-token-block">
                  <div className="swap-token-label-row">
                    <span>Sell</span>
                  </div>
                  <div className="swap-token-row">
                    <input
                      className="swap-token-input"
                      value={swapAmount}
                      onChange={(event) => setSwapAmount(event.target.value)}
                    />
                    <div className="swap-token-pill">
                      <span className="swap-token-name">USDC</span>
                    </div>
                  </div>
                  <p className="swap-token-mint">Mint · {DEFAULT_INPUT_MINT}</p>
                </div>
                <div className="swap-arrow" aria-hidden="true">
                  ↓
                </div>
                <div className="swap-token-block">
                  <div className="swap-token-label-row">
                    <span>Buy</span>
                  </div>
                  <div className="swap-token-row is-static">
                    <span className="swap-token-amount">
                      {typeof estimatedOutputAmount === "number"
                        ? formatNumber(estimatedOutputAmount)
                        : "—"}
                    </span>
                    <div className="swap-token-pill look-pill">
                      <span className="swap-token-name">LOOK</span>
                    </div>
                  </div>
                  <p className="swap-token-mint">
                    Mint · {DEFAULT_OUTPUT_MINT}
                  </p>
                </div>
              </div>
              <form
                className="swap-ticket-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  handlePrimaryCta();
                }}
              >
                <label className="panel-field">
                  <span>Taker Address</span>
                  <input
                    value={takerAddress}
                    onChange={(event) => setTakerAddress(event.target.value)}
                    placeholder="MetaKeep Solana address"
                  />
                </label>
                <button
                  type="submit"
                  className="swap-primary-button"
                  disabled={primaryCtaLoading}
                >
                  {primaryCtaLoading
                    ? pendingTransaction && pendingRequestId
                      ? "Swapping via MetaKeep..."
                      : "Requesting Route..."
                    : primaryCtaLabel}
                </button>
              </form>
              {(orderStatus === "error" || executeStatus === "error") && (
                <div className="swap-status-stack">
                  {orderStatus === "error" && (
                    <p className="status-pill status-error">{orderMessage}</p>
                  )}
                  {executeStatus === "error" && (
                    <p className="status-pill status-error">{executeMessage}</p>
                  )}
                </div>
              )}
            </div>

            {/* Execution results are logged to the console or telemetry; UI stays clean */}
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
