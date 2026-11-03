"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import { connect as connectWallet, onWalletsChange, signTx, solanaWallets, type SolWallet } from "./wallet";

interface Ctx {
  wallets: SolWallet[];
  wallet: SolWallet | null;
  account: WalletAccount | null;
  connect(w: SolWallet): Promise<string>;
  disconnect(): void;
  sign(base64Tx: string): Promise<string>;
}

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<SolWallet[]>([]);
  const [wallet, setWallet] = useState<SolWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);

  useEffect(() => {
    const refresh = () => setWallets(solanaWallets());
    refresh();
    return onWalletsChange(refresh);
  }, []);

  const connect = useCallback(async (w: SolWallet) => {
    const acct = await connectWallet(w);
    setWallet(w); setAccount(acct);
    return acct.address;
  }, []);

  const sign = useCallback(async (tx: string) => {
    if (!wallet || !account) throw new Error("Connect your wallet first.");
    return signTx(wallet, account, tx);
  }, [wallet, account]);

  return (
    <WalletCtx.Provider value={{ wallets, wallet, account, connect, disconnect: () => { setWallet(null); setAccount(null); }, sign }}>
      {children}
    </WalletCtx.Provider>
  );
}

export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
};
