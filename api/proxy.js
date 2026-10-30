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
    
    // 👇 ADD THIS: Inject default auth if none is provided by the browser 👇
    if (!headersToForward.authorization) {
      headersToForward.authorization = "Basic " + Buffer.from("admin:district").toString("base64");
    }
    // 👆 ----------------------------------------------------------------- 👆

    headersToForward['user-agent'] = headersToForward['user-agent'] || 'Vercel-Proxy';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: headersToForward,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      redirect: 'follow', // This is what caused the HTML to be returned
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    res.status(response.status);
    
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    if (response.ok) {
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    }

    const body = await response.arrayBuffer();
    
    if (body.byteLength === 0) {
      return res.status(204).end(); 
    }

    res.send(Buffer.from(body));

  } catch (error) {
    console.error('Proxy error:', error);
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Gateway Timeout' });
    }
    res.status(500).json({ error: 'Proxy request failed', details: error.message });
  }
}
