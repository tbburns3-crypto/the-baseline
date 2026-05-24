import Stripe from 'https://esm.sh/stripe@14?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return new Response('Missing signature', { status: 400 })

  const body = await req.text()
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig, Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    )
  } catch (err) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object as Stripe.Checkout.Session
    if (s.client_reference_id && s.payment_status === 'paid') {
      await supabase.from('profiles')
        .update({ role: 'paid', stripe_customer_id: s.customer as string })
        .eq('id', s.client_reference_id)
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription
    await supabase.from('profiles')
      .update({ role: 'free' })
      .eq('stripe_customer_id', sub.customer as string)
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object as Stripe.Subscription
    const active = sub.status === 'active' || sub.status === 'trialing'
    if (!active) {
      await supabase.from('profiles')
        .update({ role: 'free' })
        .eq('stripe_customer_id', sub.customer as string)
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
