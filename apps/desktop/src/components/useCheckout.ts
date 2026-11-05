import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { CheckoutOrder, CheckoutRequest } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";

type Attempt = CheckoutRequest & { order_id?: string };
const storageKey = (userId: string) => `bowerbird.checkout.${userId}`;
function readAttempt(userId: string): Attempt | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null");
    return value && typeof value.product === "string" && typeof value.idempotency_key === "string"
      && (value.order_id === undefined || typeof value.order_id === "string")
      && (value.custom_amount_yuan === undefined || Number.isSafeInteger(value.custom_amount_yuan)) ? value : null;
  } catch { return null; }
}

export function useCheckout(userId: string | null) {
  const [enabled, setEnabled] = useState(false);
  const [maxAmount, setMaxAmount] = useState(21474836);
  const [order, setOrder] = useState<CheckoutOrder | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [error, setError] = useState("");
  const [hasAttempt, setHasAttempt] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const currentOrder = useRef<CheckoutOrder | null>(null);
  const running = useRef(false);
  const generation = useRef(0);
  const refreshed = useRef(new Set<string>());
  const isCurrent = useCallback((version: number) => generation.current === version && !!userId
    && useStore.getState().cloudAuth?.user_id === userId, [userId]);
  const save = useCallback((value: Attempt | null) => {
    attempt.current = value;
    setHasAttempt(!!value);
    if (!userId) return;
    try { if (value) localStorage.setItem(storageKey(userId), JSON.stringify(value)); else localStorage.removeItem(storageKey(userId)); }
    catch { /* Server-side recovery still finds accepted orders. */ }
  }, [userId]);
  const accept = useCallback(async (value: CheckoutOrder, version: number) => {
    if (!isCurrent(version)) return;
    currentOrder.current = value;
    setOrder(value);
    if (value.status === "pending") {
      if (attempt.current) save({ ...attempt.current, order_id: value.order_id });
      else save({ product: value.product, idempotency_key: crypto.randomUUID(), order_id: value.order_id });
    } else save(null);
    if (value.status === "paid" && !refreshed.current.has(value.order_id)) {
      refreshed.current.add(value.order_id);
      try {
        const entitlement = await api.cloudSyncEntitlement();
        if (isCurrent(version) && entitlement.user_id === userId) useStore.setState({ cloudEntitlement: entitlement });
      } catch {
        if (isCurrent(version)) setError("支付已成功，权益暂未同步，请刷新权益。");
      }
    }
  }, [isCurrent, save, userId]);

  useEffect(() => {
    const version = ++generation.current;
    setEnabled(false); setOrder(null); currentOrder.current = null; setOpen(false); setError("");
    running.current = false; setBusy(false); setRestoring(!!userId); setRecoveryFailed(false);
    attempt.current = userId ? readAttempt(userId) : null;
    setHasAttempt(!!attempt.current);
    if (!userId) return;
    void api.cloudCheckoutCapability(userId).then(capability => {
      if (isCurrent(version)) {
        setEnabled(capability.enabled === true);
        if (Number.isSafeInteger(capability.custom_max_yuan) && capability.custom_max_yuan! > 0) setMaxAmount(capability.custom_max_yuan!);
      }
    }).catch(() => { /* Old servers keep the purchase controls closed. */ });
    void api.cloudCheckoutStatus(userId, attempt.current?.order_id).then(async result => {
      if (result.order) await accept(result.order, version);
    }).catch(() => { if (isCurrent(version)) setRecoveryFailed(true); })
      .finally(() => { if (isCurrent(version)) setRestoring(false); });
    return () => { generation.current++; };
  }, [userId, accept, isCurrent]);

  const query = useCallback(async () => {
    if (!userId || running.current) return;
    const version = generation.current;
    running.current = true; setBusy(true); setError("");
    try {
      const result = await api.cloudCheckoutStatus(userId, currentOrder.current?.order_id ?? attempt.current?.order_id);
      if (isCurrent(version)) setRecoveryFailed(false);
      if (result.order) await accept(result.order, version);
      else if (isCurrent(version) && attempt.current) setError("尚未查到订单，请使用原请求重试。");
    } catch (error) {
      if (isCurrent(version)) setError(userErrorMessage(error, "支付状态暂未确认，请查询原订单。"));
    } finally { if (isCurrent(version)) { running.current = false; setBusy(false); } }
  }, [accept, isCurrent, userId]);

  useEffect(() => {
    if (!open || order?.status !== "pending") return;
    const timer = window.setInterval(() => void query(), 3000);
    return () => window.clearInterval(timer);
  }, [open, order?.status, query]);

  const begin = async (product: string, customAmount?: number) => {
    if (!userId || running.current || restoring || recoveryFailed) return;
    setOpen(true);
    if (currentOrder.current?.status === "pending") { void query(); return; }
    if (!enabled) return;
    const version = generation.current;
    const request = attempt.current ?? { product, idempotency_key: crypto.randomUUID(), ...(customAmount === undefined ? {} : { custom_amount_yuan: customAmount }) };
    save(request);
    running.current = true; setBusy(true); setError(""); setOrder(null); currentOrder.current = null;
    try {
      const result = await api.cloudCreateCheckout(userId, { product: request.product, idempotency_key: request.idempotency_key, custom_amount_yuan: request.custom_amount_yuan });
      await accept(result.order, version);
    } catch (error) {
      if (isCurrent(version)) setError(userErrorMessage(error, "订单状态暂未确认，请使用原请求重试。"));
    } finally { if (isCurrent(version)) { running.current = false; setBusy(false); } }
  };
  return { enabled, maxAmount, order, open, setOpen, busy, restoring, recoveryFailed, error, hasAttempt, begin, query };
}
