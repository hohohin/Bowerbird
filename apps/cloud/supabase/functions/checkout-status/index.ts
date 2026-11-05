import { requireUser } from "../_shared/auth.ts";
import { handleCheckoutStatus } from "../_shared/wechatpay-service.ts";
Deno.serve((request) => handleCheckoutStatus(request, requireUser));
