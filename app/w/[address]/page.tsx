import { notFound } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { isAddress } from "@/lib/core/solana";

export default async function WalletPage({ params }: PageProps<"/w/[address]">) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  return <Dashboard owner={address} />;
}
