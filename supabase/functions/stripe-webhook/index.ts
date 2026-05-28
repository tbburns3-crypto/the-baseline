import Stripe from 'https://esm.sh/stripe@13?target=deno&no-check=true'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
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
      const { error } = await supabase.from('profiles')
        .update({ role: 'paid', stripe_customer_id: s.customer as string })
        .eq('id', s.client_reference_id)
      if (error) console.error('checkout.session.completed DB update failed:', error.message)
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription
    const { error } = await supabase.from('profiles')
      .update({ role: 'free' })
      .eq('stripe_customer_id', sub.customer as string)
    if (error) console.error('subscription.deleted DB update failed:', error.message)
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object as Stripe.Subscription
    const active = sub.status === 'active' || sub.status === 'trialing'
    if (!active) {
      const { error } = await supabase.from('profiles')
        .update({ role: 'free' })
        .eq('stripe_customer_id', sub.customer as string)
      if (error) console.error('subscription.updated DB update failed:', error.message)
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
