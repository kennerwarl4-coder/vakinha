export default async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Pass UTMs to callbackUrl so the webhook can retrieve them later
    const baseUrl = 'https://vakinha-alpha.vercel.app';
    const callbackUrl = new URL(baseUrl + '/api/webhook');
    if (payload.trackingParameters) {
      for (const [key, val] of Object.entries(payload.trackingParameters)) {
        if (val) callbackUrl.searchParams.set(key, val);
      }
    }

    const postData = JSON.stringify({
      amount: Number(payload.amount),
      callbackUrl: callbackUrl.toString()
    });

    try {
      // 1. Fetching from Evopay Cash API
      const response = await fetch('https://pix.evopay.cash/v1/pix/', {
        method: 'POST',
        headers: {
          'API-Key': 'f8055c9e-6a4c-442f-a431-3378adf00528',
          'Content-Type': 'application/json'
        },
        body: postData
      });

      let data;
      let responseText = '';
      try {
        responseText = await response.text();
        data = JSON.parse(responseText);
      } catch (parseErr) {
        console.error('Evopay returned non-JSON:', responseText);
        return res.status(response.status).json({
          error: 'Evopay API returned an invalid response',
          details: responseText
        });
      }

      // 2. Respond to the browser IMMEDIATELY once we have the Evopay result.
      // The Utmify tracking call below must NEVER make the donor wait — if it's
      // slow or unreachable, that's only a lost ad-attribution event, not a
      // failed donation. Reporting it *after* res.json() keeps this Pix from
      // ever showing "erro de conexão" to a donor whose Pix was actually created.
      res.status(response.status).json(data);

      // 3. If Pix generated successfully, send event to Utmify API (best-effort,
      // does not block or affect the response already sent above)
      if (response.ok && data && data.qrCodeText) {
        try {
          const orderId = data.txid || data.id || ('pix_' + Date.now());
          const now = new Date();
          const formattedDate = now.toISOString().replace('T', ' ').substring(0, 19);

          const amountCents = Math.round(Number(payload.amount) * 100);
          const tParams = payload.trackingParameters || {};

          const utmifyPayload = {
            orderId: orderId.toString(),
            platform: 'Evopay',
            paymentMethod: 'pix',
            status: 'waiting_payment',
            createdAt: formattedDate,
            approvedDate: null,
            customer: {
              name: payload.customer?.name || 'Cliente',
              email: payload.customer?.email || 'cliente@email.com',
              phone: payload.customer?.phone || '',
              document: payload.customer?.document || '',
              ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1'
            },
            products: [
              {
                id: '1',
                name: 'Doação',
                quantity: 1,
                priceInCents: amountCents,
                planId: '0',
                planName: 'Único'
              }
            ],
            trackingParameters: {
              src: tParams.src || null,
              sck: tParams.sck || null,
              utm_source: tParams.utm_source || null,
              utm_campaign: tParams.utm_campaign || null,
              utm_medium: tParams.utm_medium || null,
              utm_content: tParams.utm_content || null,
              utm_term: tParams.utm_term || null
            },
            commission: {
              totalPriceInCents: amountCents,
              gatewayFeeInCents: 0,
              userCommissionInCents: amountCents
            }
          };

          // Give Utmify a hard timeout so a hung request can never stretch out
          // this function's execution time unnecessarily.
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          try {
            await fetch('https://api.utmify.com.br/api-credentials/orders', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-token': 'PJU1tp12HMfiP3f4Jebt6AtkBv4CeiSmzM3b'
              },
              body: JSON.stringify(utmifyPayload),
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeoutId);
          }

          console.log('Venda enviada para Utmify com sucesso', orderId);
        } catch (utmErr) {
          console.error('Erro ao enviar para Utmify:', utmErr);
        }
      }
    } catch (err) {
      console.error('Error proxying to Evopay:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  } else {
    res.status(405).json({ error: 'Method Not Allowed' });
  }
}
