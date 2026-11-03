import { createHmac } from "node:crypto";
import { isAddress } from "@/lib/core/solana";

/**
 * Card on-ramps with the wallet address prefilled. Only providers whose keys are
 * configured are offered (MoonPay requires prefilled addresses to be signed).
 * GET → { providers: [{ id, name }] }; GET ?provider=moonpay&address=… → { url }.
 */
const configured = () => [
  ...(process.env.MOONPAY_PUBLISHABLE_KEY && process.env.MOONPAY_SECRET_KEY ? [{ id: "moonpay", name: "MoonPay" }] : []),
];

export async function GET(req: Request) {
  const u = new URL(req.url);
  const provider = u.searchParams.get("provider");
  if (!provider) return Response.json({ providers: configured() });
  const address = u.searchParams.get("address") ?? "";
  if (!isAddress(address)) return Response.json({ error: "Not a valid Solana address." }, { status: 400 });
  if (provider === "moonpay" && configured().some((p) => p.id === "moonpay")) {
    const q = new URLSearchParams({ apiKey: process.env.MOONPAY_PUBLISHABLE_KEY!, currencyCode: "sol", walletAddress: address, colorCode: "#e8c547" });
    const query = `?${q.toString()}`;
    const signature = createHmac("sha256", process.env.MOONPAY_SECRET_KEY!).update(query).digest("base64");
    return Response.json({ url: `https://buy.moonpay.com${query}&signature=${encodeURIComponent(signature)}` });
  }
  return Response.json({ error: "That provider isn't set up." }, { status: 400 });
}
