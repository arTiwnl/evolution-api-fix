import { instanceController, waMonitor } from '@api/server.module';
import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import path from 'path';

const DEFAULT_PASSWORD = 'Scale@2026';
const MAX_FAILS = 8;
const BLOCK_MS = 10 * 60 * 1000;

const fails = new Map<string, { count: number; until: number }>();

const sha = (v: string) =>
  createHash('sha256')
    .update(String(v ?? ''))
    .digest();

function checkPassword(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = fails.get(ip);

  if (entry && entry.until > now && entry.count >= MAX_FAILS) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  }

  const expected = process.env.CONNECT_PAGE_PASSWORD || DEFAULT_PASSWORD;
  if (!timingSafeEqual(sha(req.body?.password), sha(expected))) {
    const count = entry && entry.until > now ? entry.count + 1 : 1;
    fails.set(ip, { count, until: now + BLOCK_MS });
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  fails.delete(ip);
  next();
}

function getInstance(req: Request, res: Response) {
  const name = String(req.body?.instance ?? '').trim();
  const instance = name ? waMonitor.waInstances[name] : undefined;
  if (!instance) {
    res.status(404).json({ error: 'Instância não encontrada.' });
    return null;
  }
  return { name, instance };
}

function payload(instance: any) {
  const state = instance?.connectionStatus?.state ?? 'close';
  const qr = state === 'connecting' ? instance.qrCode : undefined;
  return {
    state,
    hasNumber: !!String(instance?.number ?? '').replace(/\D/g, ''),
    number: state === 'open' ? String(instance.wuid ?? '').split('@')[0] : undefined,
    pairingCode: qr?.pairingCode ?? null,
    qrcode: qr?.base64 ?? null,
  };
}

export class ConnectRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router.get('/', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(process.cwd(), 'public', 'connect.html'));
    });

    this.router.post('/api/status', checkPassword, (req, res) => {
      const found = getInstance(req, res);
      if (!found) return;
      res.json(payload(found.instance));
    });

    this.router.post('/api/start', checkPassword, async (req, res) => {
      const found = getInstance(req, res);
      if (!found) return;
      const { name, instance } = found;

      try {
        const number =
          String(req.body?.number ?? '').replace(/\D/g, '') ||
          String(instance?.number ?? '').replace(/\D/g, '') ||
          null;
        const state = instance?.connectionStatus?.state;

        if (state === 'open') return res.json(payload(instance));

        if (state === 'connecting') {
          // Already showing a QR: restart the socket if a pairing code was requested now.
          if (number && !instance.qrCode?.pairingCode) {
            instance.phoneNumber = number;
            instance.client?.ws?.close();
            await new Promise((r) => setTimeout(r, 3000));
          }
        } else {
          await instanceController.connectToWhatsapp({ instanceName: name, number });
        }

        res.json(payload(instance));
      } catch (error) {
        res.status(500).json({ error: String(error?.message ?? error) });
      }
    });
  }
}
