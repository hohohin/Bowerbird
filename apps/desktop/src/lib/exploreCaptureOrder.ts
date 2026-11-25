import type { CaptureDropTarget } from "./captureDropTarget";

export type ExploreCaptureReceipt = {
  assetId: string;
  target: Pick<CaptureDropTarget, "kind" | "id">;
  revision: number;
};

export function captureForScope(
  receipts: readonly ExploreCaptureReceipt[] | undefined,
  kind: CaptureDropTarget["kind"],
  id: string | null,
) {
  return receipts?.find(receipt => receipt.target.kind === kind && receipt.target.id === id);
}
