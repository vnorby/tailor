// Ledger's libraries expect Node's Buffer; must be evaluated before they are imported.
import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
