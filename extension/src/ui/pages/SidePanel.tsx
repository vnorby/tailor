import type { ReactNode } from "react";
import type { AccountMeta, WalletState } from "~/shared/messages";
import { AccountSwitcher, Logo, mount, Unlock, useWalletState } from "../common";
import { Home } from "../home/Home";

function Panel() {
  const { state, active, refresh } = useWalletState();
  if (!state) return null;
  if (!state.initialized) return (
    <Center><Logo size={44} /><div className="tape w-full" /><button className="btn btn-primary" onClick={() => chrome.tabs.create({ url: "onboarding.html" })}>Set up Tailor</button></Center>
  );
  if (!state.unlocked) return <Center><Unlock onUnlocked={() => void refresh()} /></Center>;
  if (!active) return null;
  return <Home key={active.id} state={state} active={active} header={(balance) => <Header state={state} active={active} refresh={refresh} balance={balance} />} />;
}

function Header({ state, active, refresh, balance }: { state: WalletState; active: AccountMeta; refresh(): Promise<void>; balance: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between px-3 py-2.5 bg-cloth/90 backdrop-blur">
      <AccountSwitcher state={state} active={active} onChanged={() => void refresh()} />
      {balance}
    </header>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-8">{children}</div>;
}

mount(<Panel />);
