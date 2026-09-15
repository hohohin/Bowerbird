import { requireUser } from "../_shared/auth.ts";
import { handleCodeAdmin } from "../_shared/pro-code-admin.ts";

Deno.serve((request) => handleCodeAdmin(request, requireUser));
