import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";

export interface AuthContext {
  user: User;
  admin: SupabaseClient;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `${name} 未配置`);
  return value;
}

function namedKey(objectEnv: string, directEnv: string, legacyEnv: string): string {
  const direct = Deno.env.get(directEnv)?.trim();
  if (direct) return direct;
  const objectValue = Deno.env.get(objectEnv)?.trim();
  if (objectValue) {
    try {
      const value = (JSON.parse(objectValue) as Record<string, string>).default?.trim();
      if (value) return value;
    } catch {
      throw new ApiError("not_configured", `${objectEnv} 格式无效`);
    }
  }
  const legacy = Deno.env.get(legacyEnv)?.trim();
  if (legacy) return legacy;
  throw new ApiError("not_configured", `${directEnv} 未配置`);
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new ApiError("unauthorized", "请先登录");
  return match[1];
}

export async function requireUser(request: Request): Promise<AuthContext> {
  const url = requiredEnv("SUPABASE_URL");
  const publishableKey = namedKey(
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  );
  const secretKey = namedKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const token = bearerToken(request);

  // Validate the caller token with Auth. The admin client is created only after a real user exists.
  const authClient = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new ApiError("unauthorized", "登录已失效，请重新登录");

  const admin = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { user: data.user, admin };
}
