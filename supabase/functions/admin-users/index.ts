import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return respond({ error: 'Unauthorized' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Verify caller is an admin
  const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
  if (authErr || !user) return respond({ error: 'Unauthorized' }, 401)

  const { data: callerProfile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (callerProfile?.role !== 'admin') return respond({ error: 'Forbidden' }, 403)

  // ── GET: list all users ──
  if (req.method === 'GET') {
    const [authRes, profileRes] = await Promise.all([
      supabase.auth.admin.listUsers({ perPage: 1000 }),
      supabase.from('profiles').select('id, role, stripe_customer_id'),
    ])
    const profileMap = new Map((profileRes.data || []).map((p: any) => [p.id, p]))
    const users = (authRes.data?.users || [])
      .map((u: any) => ({
        id: u.id,
        email: u.email || '',
        created_at: u.created_at,
        last_sign_in: u.last_sign_in_at,
        role: (profileMap.get(u.id) as any)?.role || 'free',
        stripe_customer_id: (profileMap.get(u.id) as any)?.stripe_customer_id || null,
      }))
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    return respond({ users })
  }

  // ── PATCH: update a user's role ──
  if (req.method === 'PATCH') {
    let body: any
    try { body = await req.json() } catch { return respond({ error: 'Invalid request body' }, 400) }
    const { userId, role } = body
    if (!userId || !role) return respond({ error: 'Missing userId or role' }, 400)
    if (!['free', 'paid', 'banned', 'admin'].includes(role)) return respond({ error: 'Invalid role' }, 400)
    if (userId === user.id) return respond({ error: 'Cannot change your own role' }, 400)
    const { error } = await supabase.from('profiles').update({ role }).eq('id', userId)
    if (error) return respond({ error: error.message }, 500)
    return respond({ success: true })
  }

  return respond({ error: 'Method not allowed' }, 405)
})
