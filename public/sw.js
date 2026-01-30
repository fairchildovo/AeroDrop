/* StreamSaver.js Service Worker + PWA Caching */

const CACHE_NAME = 'aerodrop-cache-v1';
const OFFLINE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.svg',
  '/mitm.html',
  '/apple-touch-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// StreamSaver Logic
const map = new Map();

self.onmessage = event => {
  if (event.data === 'ping') return;

  const data = event.data;
  const downloadUrl = data.url || self.registration.scope + Math.random() + '/' + (typeof data === 'string' ? data : data.filename);
  const port = event.ports[0];
  const metadata = new Array(3);
  metadata[1] = data;
  metadata[2] = port;

  if (event.data.readableStream) {
    metadata[0] = event.data.readableStream;
  } else if (event.data.transferringReadable) {
    port.onmessage = evt => {
      port.onmessage = null;
      metadata[0] = evt.data.readableStream;
    };
  } else {
    metadata[0] = createStream(port);
  }

  map.set(downloadUrl, metadata);
  port.postMessage({ download: downloadUrl });
};

function createStream(port) {
  return new ReadableStream({
    start(controller) {
      port.onmessage = ({ data }) => {
        if (data === 'end') return controller.close();
        if (data === 'abort') {
          controller.error('Aborted the download');
          return;
        }
        controller.enqueue(data);
      };
    },
    cancel(reason) {
      console.log('user aborted', reason);
      port.postMessage({ abort: true });
    }
  });
}

self.onfetch = event => {
  const url = event.request.url;

  // StreamSaver Handling
  if (url.endsWith('/ping')) {
    return event.respondWith(new Response('pong'));
  }

  const hijacke = map.get(url);

  if (hijacke) {
    const [ stream, data, port ] = hijacke;
    map.delete(url);

    const responseHeaders = new Headers({
      'Content-Type': 'application/octet-stream; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Security-Policy': "default-src 'none'",
      'X-WebKit-CSP': "default-src 'none'",
      'X-XSS-Protection': '1; mode=block',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });

    let headers = new Headers(data.headers || {});
    if (headers.has('Content-Length')) responseHeaders.set('Content-Length', headers.get('Content-Length'));
    if (headers.has('Content-Disposition')) responseHeaders.set('Content-Disposition', headers.get('Content-Disposition'));

    if (data.size) responseHeaders.set('Content-Length', data.size);

    let fileName = typeof data === 'string' ? data : data.filename;
    if (fileName) {
      fileName = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
      responseHeaders.set('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
    }

    event.respondWith(new Response(stream, { headers: responseHeaders }));
    port.postMessage({ debug: 'Download started' });
    return;
  }

  // PWA Caching Strategy: Network First, fallback to Cache
  if (event.request.method !== 'GET' || !url.startsWith('http')) {
      return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Check if we received a valid response
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        // Clone the response
        const responseToCache = response.clone();

        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });

        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
};
