/**
 * The reference integration, and the thing the contract is proven against.
 *
 * It is deliberately whole rather than minimal: a wallet that really signs, a
 * browser hand-off that really presents, and the deposit watch running. A demo
 * that stubs the wallet proves the sheet renders and nothing else.
 */
import { useMemo, useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import {
  createWalletClient,
  http,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  DepositSheet,
  EMBED_URL_DEV,
  userRejected,
  type Caip27Params,
  type EmbedConfig,
  type WalletBridge,
  type WalletState,
} from "@rhinestone/deposit-modal-react-native";

/**
 * A demo key, and only ever that. It funds a deposit from a throwaway account
 * so the flow can be driven end to end on a simulator; a real integration hands
 * `request` to its own wallet SDK and never sees a key.
 */
const DEMO_KEY = process.env.EXPO_PUBLIC_DEMO_PRIVATE_KEY as Hex | undefined;

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://your-proxy.example/deposit";

function useDemoWallet(): WalletBridge | undefined {
  return useMemo(() => {
    if (!DEMO_KEY) return undefined;
    const account = privateKeyToAccount(DEMO_KEY);
    const client: WalletClient = createWalletClient({
      account,
      chain: base,
      transport: http(),
    });

    const state: WalletState = {
      isReady: true,
      isConnected: true,
      accounts: [{ caip10: `eip155:${base.id}:${account.address}` }],
      chainId: `eip155:${base.id}`,
      name: "Demo Key",
    };

    return {
      state,
      async request({ chainId, request }: Caip27Params) {
        // The CAIP-2 chain on the request is authoritative — execute there,
        // rather than wherever the client happens to be pointed.
        if (chainId !== state.chainId) {
          throw userRejected("This demo wallet only holds a Base account.");
        }
        switch (request.method) {
          case "eth_chainId":
            return `0x${base.id.toString(16)}`;
          case "eth_accounts":
            return [account.address];
          case "eth_sendTransaction": {
            const [transaction] = (request.params ?? []) as [
              Parameters<typeof client.sendTransaction>[0],
            ];
            return client.sendTransaction(transaction);
          }
          case "eth_signTypedData_v4": {
            const [, typedData] = (request.params ?? []) as [string, string];
            return account.signTypedData(JSON.parse(typedData));
          }
          case "wallet_switchEthereumChain":
            // One chain, and it is already the one selected.
            return null;
          default:
            throw userRejected(`${request.method} is not supported here.`);
        }
      },
    };
  }, []);
}

export default function App() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("Idle");
  const wallet = useDemoWallet();

  const config: EmbedConfig = useMemo(
    () => ({
      mode: "deposit",
      backendUrl: BACKEND_URL,
      recipient:
        wallet?.state.accounts[0]?.caip10.split(":")[2] ??
        "0x0000000000000000000000000000000000000000",
      targetChain: 8453,
      targetToken: "USDC",
      theme: { mode: "system" },
    }),
    [wallet],
  );

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="auto" />
      <View style={styles.body}>
        <Text style={styles.title}>Deposit modal</Text>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.note}>
          {wallet
            ? "Demo wallet loaded."
            : "No demo key set — QR and manual transfer only."}
        </Text>
        <Button title="Add funds" onPress={() => setOpen(true)} />
      </View>

      <DepositSheet
        visible={open}
        onDismiss={() => setOpen(false)}
        config={config}
        embedUrl={EMBED_URL_DEV}
        app={{ name: "DepositExample", version: "0.1.0" }}
        {...(wallet ? { wallet } : {})}
        openUrl={async ({ url }) => {
          // Presents OVER the app, so the user returns with one tap and lands
          // where a redirect would.
          await WebBrowser.openBrowserAsync(url);
        }}
        onReady={() => setStatus("Sheet ready")}
        onLifecycle={(event) =>
          setStatus(`Lifecycle: ${(event as { type?: string })?.type ?? "?"}`)
        }
        onDepositSettled={(deposit) =>
          setStatus(`Deposit ${deposit.status}: ${deposit.txHash}`)
        }
        onFatal={(error) => setStatus(`Failed: ${error.message}`)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  status: { fontSize: 14, opacity: 0.8 },
  note: { fontSize: 12, opacity: 0.6, marginBottom: 8 },
});
