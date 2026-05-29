const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { email, token } = await req.json();
    if (!email || !token) {
      return new Response(JSON.stringify({ error: 'Missing email or token' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const sbUrl     = Deno.env.get('SUPABASE_URL') ?? '';
    const sbAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    // Server-side verify — bypasses mobile network routing issues
    const res = await fetch(`${sbUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': sbAnonKey },
      body: JSON.stringify({ email, token, type: 'email', gotrue_meta_security: {} }),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
