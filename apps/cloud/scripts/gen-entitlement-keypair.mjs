// 生成 Entitlement 签名密钥对（Ed25519）。
// 用途：P9 离线宽限 —— 私钥进 Supabase Edge Secret，公钥进桌面构建环境。
//
//   node apps/cloud/scripts/gen-entitlement-keypair.mjs
//
// 输出：
//   1) supabase secrets set 命令（ENTITLEMENT_SIGNING_KEY = PKCS#8 DER base64）
//   2) 桌面构建变量 BOWERBIRD_ENTITLEMENT_PUBKEY（原始 32 字节公钥 base64，
//      追加到 apps/cloud/.env.local 即可被 build.rs 自动读取）
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
const publicSpki = publicKey.export({ type: "spki", format: "der" });
const publicRaw = publicSpki.subarray(publicSpki.length - 32);

console.log(`# 1) Edge 私钥（Supabase → Edge Functions → Manage secrets，或 CLI）：
supabase secrets set ENTITLEMENT_SIGNING_KEY=${privatePkcs8.toString("base64")}

# 2) 桌面公钥（追加到 apps/cloud/.env.local，或注入官方构建环境）：
BOWERBIRD_ENTITLEMENT_PUBKEY=${publicRaw.toString("base64")}

# 3) 重新部署 entitlement：
supabase functions deploy entitlement`);
