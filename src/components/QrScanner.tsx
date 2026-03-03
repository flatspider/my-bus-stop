import { useEffect, useRef } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

interface QrScannerProps {
  onScan: (code: string) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}

function extractStopCode(text: string): string | null {
  const trimmed = text.trim();
  const parseUrlForCode = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      if (
        url.hostname === "bustime.mta.info" ||
        url.hostname === "bt.mta.info"
      ) {
        const code = url.searchParams.get("q");
        if (code && /^\d{5,6}$/.test(code)) return code;

        const pathMatch = url.pathname.match(/(?:^|\/)(\d{6}|\d{5})(?:\/|$)/);
        if (pathMatch) return pathMatch[1];
      }
    } catch {
      // ignore invalid URL
    }
    return null;
  };

  const directUrlCode = parseUrlForCode(trimmed);
  if (directUrlCode) return directUrlCode;

  const embeddedUrl = trimmed.match(/https?:\/\/[^\s]+/i)?.[0];
  if (embeddedUrl) {
    const embeddedUrlCode = parseUrlForCode(embeddedUrl);
    if (embeddedUrlCode) return embeddedUrlCode;
  }

  const sixDigit = trimmed.match(/(?:^|\D)(\d{6})(?:\D|$)/);
  if (sixDigit) return sixDigit[1];

  const fiveDigit = trimmed.match(/(?:^|\D)(\d{5})(?:\D|$)/);
  if (fiveDigit) return fiveDigit[1];

  if (/^\d{5,6}$/.test(trimmed)) return trimmed;
  return null;
}

export default function QrScanner({ onScan, onClose, onError }: QrScannerProps) {
  const readerRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);
  const stoppedRef = useRef(false);
  const invalidNotifiedRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    onScanRef.current = onScan;
    onCloseRef.current = onClose;
    onErrorRef.current = onError;
  }, [onScan, onClose, onError]);

  useEffect(() => {
    if (!readerRef.current) return;

    let cancelled = false;
    const scannerId = `qr-reader-${Date.now()}`;
    readerRef.current.id = scannerId;

    async function stopScanner() {
      const scanner = scannerRef.current;
      if (!scanner) return;
      if (runningRef.current) {
        await scanner.stop().catch(() => {});
        runningRef.current = false;
      }
      scanner.clear();
    }

    async function startScanner() {
      try {
        const scanner = new Html5Qrcode(scannerId, {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false,
        });
        scannerRef.current = scanner;

        const onDecode = (decodedText: string) => {
          if (stoppedRef.current) return;
          const code = extractStopCode(decodedText);
          if (!code) {
            if (!invalidNotifiedRef.current) {
              invalidNotifiedRef.current = true;
              onErrorRef.current("QR detected, but no valid stop code was found.");
            }
            return;
          }

          invalidNotifiedRef.current = false;
          stoppedRef.current = true;
          stopScanner().catch(() => {});
          onScanRef.current(code);
        };

        const config = {
          fps: 6,
          // Focus decode work in the center to improve recognition of small signs.
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.75);
            const size = Math.max(220, Math.min(edge, 340));
            return { width: size, height: size };
          },
          disableFlip: true,
        };
        const tryStart = async (camera: string | MediaTrackConstraints) => {
          await scanner.start(
            camera,
            config,
            onDecode,
            () => {}, // ignore scan failures (no match yet)
          );
          runningRef.current = true;
        };

        try {
          await tryStart({ facingMode: "environment" });
          return;
        } catch {
          const devices = await Html5Qrcode.getCameras();
          if (!devices.length) throw new Error("No camera devices found.");
          const preferred = devices.find((d) =>
            /(back|rear|environment)/i.test(d.label),
          );
          const orderedDevices = preferred
            ? [preferred, ...devices.filter((d) => d.id !== preferred.id)]
            : devices;

          let started = false;
          for (const device of orderedDevices) {
            try {
              await tryStart(device.id);
              started = true;
              break;
            } catch {
              // try next camera
            }
          }

          if (!started) throw new Error("Could not start any available camera.");
        }
      } catch {
        if (cancelled) return;
        onErrorRef.current("Could not access camera. Check permissions.");
        onCloseRef.current();
      }
    }

    startScanner();

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      stopScanner().catch(() => {});
    };
  }, []);

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
