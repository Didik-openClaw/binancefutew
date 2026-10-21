import type { DashboardSnapshot } from '@shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import demo from '../demo/snapshot.json';

export type Connection =
  | { kind: 'demo' }
  | { kind: 'live'; online: boolean }
  | { kind: 'auth' }; // engine ada tapi butuh token

const TOKEN_KEY = 'kairos.token';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // penyimpanan diblokir: token hanya berlaku di sesi ini
  }
}

const STATIC_DEMO = import.meta.env.MODE === 'single';

// Sambung ke engine (REST + WebSocket). Tanpa engine -> snapshot demo sintetis.
export function useSnapshot() {
  const [snap, setSnap] = useState<DashboardSnapshot>(demo as unknown as DashboardSnapshot);
  const [conn, setConn] = useState<Connection>({ kind: 'demo' });
  const [token, setToken] = useState(readToken);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (STATIC_DEMO) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    const openWs = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          setSnap(JSON.parse(e.data));
          setConn({ kind: 'live', online: true });
        } catch {
          // pesan rusak diabaikan
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setConn({ kind: 'live', online: false });
        retry = setTimeout(openWs, 3000);
      };
    };

    fetch('/api/snapshot', { headers, signal: AbortSignal.timeout(2500) })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 401) return setConn({ kind: 'auth' });
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return;
        setSnap(await r.json());
        setConn({ kind: 'live', online: true });
        openWs();
      })
      .catch(() => {
        // tidak ada engine: tetap demo
      });
    return () => {
      cancelled = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [token]);

  const control = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      if (conn.kind !== 'live') throw new Error('Kontrol butuh engine yang berjalan (npm run engine).');
      const r = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Gagal (${r.status})`);
      setSnap(body);
    },
    [conn.kind, token],
  );

  const login = useCallback((t: string) => {
    saveToken(t);
    setToken(t);
  }, []);

  return { snap, conn, control, login };
}
