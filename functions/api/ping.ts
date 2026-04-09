interface Env {
  // Add environment bindings here if needed.
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'POST',
      },
    });
  }

  const body = await context.request.text();
  if (body !== 'ping') {
    return new Response('Bad Request', { status: 400 });
  }

  return new Response('pong', {
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
};
