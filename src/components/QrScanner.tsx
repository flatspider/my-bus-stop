import { useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";

interface QrScannerProps {
  onScan: (code: string) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}

function extractStopCode(text: string): string | null {
  try {
    const url = new URL(text);
    if (
      url.hostname === "bustime.mta.info" ||
      url.hostname === "bt.mta.info"
    ) {
      const code = url.searchParams.get("q");
      if (code && /^\d{5,6}$/.test(code)) return code;
    }
  } catch {
    // not a URL — try raw digit match
  }
  const trimmed = text.trim();
  if (/^\d{5,6}$/.test(trimmed)) return trimmed;
  return null;
}

export default function QrScanner({ onScan, onClose, onError }: QrScannerProps) {
  const readerRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!readerRef.current) return;

    const scannerId = "qr-reader-" + Date.now();
    readerRef.current.id = scannerId;

    const scanner = new Html5Qrcode(scannerId);
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          if (stoppedRef.current) return;
          const code = extractStopCode(decodedText);
          if (code) {
            stoppedRef.current = true;
            scanner.stop().catch(() => {});
            onScan(code);
          }
        },
        () => {}, // ignore scan failures (no match yet)
      )
      .catch(() => {
        onError("Could not access camera. Check permissions.");
        onClose();
      });

    return () => {
      stoppedRef.current = true;
      scanner.stop().catch(() => {});
    };
  }, [onScan, onClose, onError]);

  return (
    <div className="qr-scanner">
      <div className="qr-scanner__header">
        <button className="qr-scanner__close" type="button" onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M5 5l10 10M15 5L5 15"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <span className="qr-scanner__title">Scan bus stop QR code</span>
      </div>
      <div className="qr-scanner__viewport" ref={readerRef} />
    </div>
  );
}
