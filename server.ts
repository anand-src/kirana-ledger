import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WhapiReceiptGateway } from './src/server/whapiService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(gateway = new WhapiReceiptGateway()) {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  // 1. Check whether Whapi.Cloud server-side token is configured (never exposes the token)
  app.get('/api/whatsapp/status', (_req, res) => {
    res.json({
      configured: gateway.isConfigured(),
      provider: 'whapi.cloud',
      pdfSupported: false,
    });
  });

  // 2. Register a newly completed sale in the backend's trusted sale store
  app.post('/api/sales/register', (req, res) => {
    const { sale, settings } = req.body || {};
    const result = gateway.registerTrustedSale(sale, settings);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        errorCode: result.errorCode,
      });
      return;
    }
    res.json({
      success: true,
      saleId: result.saleId,
    });
  });

  // 3. Send or retry an itemized WhatsApp receipt via Whapi.Cloud POST /messages/text
  app.post('/api/whatsapp/send-receipt', async (req, res) => {
    const clientIp =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : req.socket.remoteAddress) || 'local';

    const { saleId, recipientPhone, isRetry, sale, settings } = req.body || {};
    const result = await gateway.sendTextReceipt(
      {
        saleId,
        recipientPhone,
        isRetry: Boolean(isRetry),
        sale,
        settings,
      },
      clientIp
    );

    res.status(result.httpStatus).json({
      success: result.success,
      deliveryRecord: result.deliveryRecord,
      error: result.error,
      errorCode: result.errorCode,
    });
  });

  // 4. Query latest known delivery status for a saleId
  app.get('/api/whatsapp/delivery-status/:saleId', (req, res) => {
    const record = gateway.getDeliveryRecord(req.params.saleId);
    res.json({
      found: Boolean(record),
      deliveryRecord: record || null,
    });
  });

  // 5. Optional Whapi.Cloud delivery webhook receiver
  app.post('/api/whatsapp/webhook', (req, res) => {
    const result = gateway.handleWebhookStatuses(req.body);
    res.json({ ok: true, updatedCount: result.updatedCount });
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Kirana Ledger server listening on http://0.0.0.0:${port}`);
  });
}

// Only start listening when executed directly as the server entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
