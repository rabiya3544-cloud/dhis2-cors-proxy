// api/proxy.js
export default async function handler(req, res) {
  // 1. Set permissive CORS headers for your frontend
  res.setHeader('Access-Control-Allow-Origin', '*'); // Change '*' to your frontend domain in production
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

  // 2. Handle the browser's preflight request
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 3. Get the target URL from the query string
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    const targetUrl = new URL(url);

    // 4. Basic Security: Only allow HTTPS targets
    if (targetUrl.protocol !== 'https:') {
      return res.status(403).json({ error: 'Only HTTPS targets are allowed' });
    }

    // 5. Prepare headers to forward (strip problematic ones)
    const headersToForward = { ...req.headers };
    delete headersToForward.host;
    delete headersToForward.connection;
    // The browser's origin should not be forwarded to the target API
    delete headersToForward.origin;
    delete headersToForward.referer;
    // Vercel adds its own encoding/length headers
    delete headersToForward['accept-encoding'];
    delete headersToForward['content-length'];

    // 6. Forward the request to the target API
    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: headersToForward,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      redirect: 'follow',
    });

    // 7. Copy the response status and content-type
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    // 8. Stream the response body back to the client
    const body = await response.arrayBuffer();
    res.send(Buffer.from(body));

  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy request failed', details: error.message });
  }
}
