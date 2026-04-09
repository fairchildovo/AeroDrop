interface Env {
  // Add environment bindings here if needed.
}

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-cache';
const SW_CACHE_CONTROL = 'no-cache';
const MANIFEST_CACHE_CONTROL = 'no-cache';

export const onRequest: PagesFunction<Env> = async (context) => {
  const response = await context.next();
  const method = context.request.method.toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    return response;
  }

  const url = new URL(context.request.url);
  const pathname = url.pathname.toLowerCase();
  const headers = new Headers(response.headers);

  if (pathname === '/sw.js') {
    headers.set('Cache-Control', SW_CACHE_CONTROL);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (pathname === '/manifest.json') {
    headers.set('Cache-Control', MANIFEST_CACHE_CONTROL);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (pathname.endsWith('.js') || pathname.endsWith('.css')) {
    headers.set('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (pathname === '/' || pathname.endsWith('/index.html') || pathname.endsWith('.html')) {
    headers.set('Cache-Control', HTML_CACHE_CONTROL);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
};
