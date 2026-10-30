// api/proxy.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });

  try {
    const targetUrl = new URL(url);
    if (targetUrl.protocol !== 'https:') {
      return res.status(403).json({ error: 'Only HTTPS targets are allowed' });
    }

    const headersToForward = { ...req.headers };
    delete headersToForward.host;
    delete headersToForward.connection;
    delete headersToForward.origin;
    delete headersToForward.referer;
    delete headersToForward['accept-encoding'];
    delete headersToForward['content-length'];

    // Add a user-agent just in case DHIS2 is blocking empty UAs
    headersToForward['user-agent'] = headersToForward['user-agent'] || 'Vercel-Proxy';

    // Create a timeout controller (8.5 seconds to stay under Vercel's 10s limit)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: headersToForward,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const body = await response.arrayBuffer();
    
    // If DHIS2 returned an empty body for some reason, send a JSON warning
    if (body.byteLength === 0) {
      return res.status(204).end(); 
    }

    res.send(Buffer.from(body));

  } catch (error) {
    console.error('Proxy error:', error);
    
    // Handle the timeout explicitly
    if (error.name === 'AbortError') {
      return res.status(504).json({ 
        error: 'Gateway Timeout', 
        details: 'The DHIS2 server took too long to respond. It might be rebuilding its analytics tables.' 
      });
    }
    
    res.status(500).json({ error: 'Proxy request failed', details: error.message });
  }
}
