import { requireUser } from "../_shared/auth.ts";
import { handlePaymentAdmin } from "../_shared/wechatpay-service.ts";
Deno.serve((request) => handlePaymentAdmin(request, requireUser));
