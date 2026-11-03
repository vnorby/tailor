import { allTools } from "@/lib/adapters";

/** Tool definitions (send, swap, stake…) for clients that need forms without a full snapshot. */
export function GET() {
  return Response.json({ tools: allTools().map(({ adapter: _a, ...t }) => t) });
}
