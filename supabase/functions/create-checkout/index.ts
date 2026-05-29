import Stripe from 'https://esm.sh/stripe@13?target=deno&no-check=true'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PRICE_IDS: Record<string, string> = {
  weekly:  'price_1TaQcNA9SWTJVWGtDGufDvxL',
  monthly: 'price_1TaQcNA9SWTJVWGtHpwEwUZQ',
  yearly:  'price_1TaQcNA9SWTJVWGtzsIFabSe',
}

const APP_URL = 'https://thebaseline.pro/'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Unauthorized')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
    )
    const { data: { user }, error } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (error || !user) throw new Error('Unauthorized')

    const { plan, promoCode } = await req.json()
    const priceId = PRICE_IDS[plan]
    if (!priceId) throw new Error('Invalid plan')

    // Auto-apply promo code if provided — look up promotion code ID by human-readable code
    let discounts: { promotion_code: string }[] | undefined
    if (promoCode) {
      try {
        const promos = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 })
        if (promos.data.length > 0) discounts = [{ promotion_code: promos.data[0].id }]
      } catch {}
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: APP_URL + '?checkout=success',
      cancel_url:  APP_URL + '?checkout=cancel',
      customer_email: user.email,
      client_reference_id: user.id,
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
