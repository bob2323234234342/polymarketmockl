import { createClient } from '@supabase/supabase-js';

// Utility: parse route parameters
function getRouteParams(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patParts = pattern.split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      const key = patParts[i].slice(1);
      params[key] = pathParts[i];
    }
  }
  return params;
}

export default {
  async fetch(request, env) {
    try {
      // Construct supabase client with Service Key for DB ops
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

      // Parse URL
      const url = new URL(request.url);
      const { pathname } = url;

      // Basic router
      if (pathname === '/markets' && request.method === 'GET') {
        return this.listMarkets(supabase);
      }
      // e.g. POST /markets/:marketId/trade
      else if (pathname.match(/^\/markets\/[^/]+\/trade$/) && request.method === 'POST') {
        return this.handleTrade(supabase, request);
      }
      else {
        return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  },

  // GET /markets
  async listMarkets(supabase) {
    // Query all markets + their outcomes
    const { data: markets, error: mError } = await supabase
      .from('markets')
      .select('id, question, status, created_at, outcomes (id, name, price)')
      .order('created_at', { ascending: false });

    if (mError) {
      return new Response(JSON.stringify({ error: mError.message }), { status: 400 });
    }
    return new Response(JSON.stringify({ markets }), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  // POST /markets/:marketId/trade
  async handleTrade(supabase, request) {
    // Step 1: Verify user auth from the request
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No Authorization header' }), { status: 401 });
    }
    const token = authHeader.replace('Bearer ', '');
    // Attempt to get user from token
    const { data: userCheck, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userCheck?.user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 });
    }
    const userId = userCheck.user.id;

    // Step 2: Parse request body
    const body = await request.json();
    const { marketId } = getRouteParams(new URL(request.url).pathname, '/markets/:marketId/trade');
    const { outcomeId, side, shares } = body;
    if (!outcomeId || !['BUY','SELL'].includes(side) || !shares || shares <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid trade params' }), { status: 400 });
    }

    // Step 3: Fetch the outcome & its market
    const { data: outcomeData, error: outErr } = await supabase
      .from('outcomes')
      .select('id, market_id, price')
      .eq('id', outcomeId)
      .single();
    if (outErr || !outcomeData) {
      return new Response(JSON.stringify({ error: 'Outcome not found' }), { status: 400 });
    }
    if (outcomeData.market_id !== marketId) {
      return new Response(JSON.stringify({ error: 'Outcome does not belong to that market' }), { status: 400 });
    }

    // Step 4: Check user balance if BUY
    // For simplicity, we assume final cost = shares * price * 100 (if we treat price as fraction of 1).
    // Example: 0.55 price => 0.55 * shares => cost in "dollars"
    // This is a simplistic approach. Real markets use an AMM formula or orderbook. 
    const tradePrice = Number(outcomeData.price);
    const cost = shares * tradePrice; // or multiply by 1 if we treat 1 as $1

    // Get user profile
    const { data: profile, error: profErr } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (profErr || !profile) {
      return new Response(JSON.stringify({ error: 'User profile not found' }), { status: 400 });
    }

    // If it's a BUY, check balance
    let newBalance = profile.balance;
    if (side === 'BUY') {
      if (profile.balance < cost) {
        return new Response(JSON.stringify({ error: 'Insufficient balance' }), { status: 400 });
      }
      newBalance = profile.balance - cost;
    } else {
      // side === 'SELL' => a real app would check user holdings. We'll skip for brevity.
      // For demonstration, let’s just credit them (like they had infinite shares).
      newBalance = profile.balance + cost;
    }

    // Step 5: Record trade in DB
    const { data: tradeData, error: tradeErr } = await supabase
      .from('trades')
      .insert({
        user_id: userId,
        outcome_id: outcomeId,
        side,
        shares,
        price: tradePrice
      })
      .select()
      .single();
    if (tradeErr) {
      return new Response(JSON.stringify({ error: tradeErr.message }), { status: 400 });
    }

    // Update user balance
    const { error: balErr } = await supabase
      .from('user_profiles')
      .update({ balance: newBalance })
      .eq('id', userId);
    if (balErr) {
      return new Response(JSON.stringify({ error: balErr.message }), { status: 400 });
    }

    // Return success
    return new Response(JSON.stringify({ success: true, trade: tradeData }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
