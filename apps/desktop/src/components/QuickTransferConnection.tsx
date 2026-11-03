import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Monitor } from "lucide-react";

function useUploadQr(url: string | null, onError: (message: string) => void) {
  const [qr, setQr] = useState<{ url: string; data: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    setQr(null);
    if (url) void QRCode.toDataURL(url, { width: 312, margin: 4, errorCorrectionLevel: "M", color: { dark: "#141414", light: "#ffffff" } })
      .then(data => { if (!disposed) setQr({ url, data }); })
      .catch(() => { if (!disposed) onError("二维码暂时无法显示，可以复制地址到手机浏览器打开。"); });
    return () => { disposed = true; };
  }, [url, onError]);
  return qr;
}

function useCopyUploadAddress(url: string | null, onError: (message: string) => void) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setCopied(false); return () => clearTimeout(timer.current); }, [url]);
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { onError("地址未能复制，请使用手机扫码打开。"); }
  }
  return { copied, copy };
}

export function QuickTransferConnection({ url, onError }: { url: string | null; onError: (message: string) => void }) {
  const qr = useUploadQr(url, onError);
  const { copied, copy } = useCopyUploadAddress(url, onError);
  if (!url) return <div className="quick-transfer-offline"><Monitor size={25} /><p>开启后，手机可以扫码上传</p></div>;
  return <div className="quick-transfer-connect">
    <div className="quick-transfer-qr">{qr?.url === url ? <img src={qr.data} alt="扫码上传到 Bowerbird" width={156} height={156} /> : <span>正在生成二维码…</span>}</div>
    <div><h3>手机扫码上传</h3><p>连接同一 Wi-Fi</p><div className="quick-transfer-address"><code>{new URL(url).host}</code>
      <button type="button" aria-label="复制上传地址" title="复制上传地址" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
      <span className="quick-transfer-copy-note" role="status">{copied ? "已复制完整地址" : "也可在其他设备的浏览器打开"}</span>
    </div>
  </div>;
}
