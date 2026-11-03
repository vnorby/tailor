import { slip10, deriveAccount, keypairFromBase58, keypairFromSeed32, sign, verify } from "./derive";
import bs58 from "bs58";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const H = 0; // indices are hardened inside slip10
let fail = 0;
const eq = (name: string, got: string, want: string) => { const ok = got === want; if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `\n  got  ${got}\n  want ${want}`); };

// SLIP-0010 ed25519 test vector 1 (seed 000102…0f)
const seed1 = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
eq("v1 m", hex(slip10(seed1, [])), "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
eq("v1 m/0H", hex(slip10(seed1, [0 + H])), "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
eq("v1 m/0H pub", hex(keypairFromSeed32(slip10(seed1, [0])).publicKey), "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c");
eq("v1 m/0H/1H/2H/2H/1000000000H", hex(slip10(seed1, [0, 1, 2, 2, 1000000000])), "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793");
// SLIP-0010 ed25519 test vector 2
const seed2 = Buffer.from("fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542", "hex");
eq("v2 m", hex(slip10(seed2, [])), "171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012");
eq("v2 m/0H/2147483647H", hex(slip10(seed2, [0, 2147483647])), "ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4");

// Round trips
const a = deriveAccount("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", 0);
const exported = bs58.encode(new Uint8Array([...a.secretKey, ...a.publicKey]));
eq("base58 import round-trip", keypairFromBase58(exported).address, a.address);
const msg = new TextEncoder().encode("hello");
eq("sign/verify", String(verify(sign(msg, a.secretKey), msg, a.publicKey)), "true");
console.log("abandon…about m/44'/501'/0'/0' =", a.address);
process.exit(fail ? 1 : 0);
