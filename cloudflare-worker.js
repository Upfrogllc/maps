/**
 * Upfrog Lawn Mowing — Cloudflare Worker Proxy
 * ═══════════════════════════════════════════════════════════════
 * Handles 3 endpoints:
 *   GET  /autocomplete?input=123+Oak+St   → Google Places autocomplete
 *   GET  /satellite?lat=XX&lon=XX         → Google Maps Static satellite image
 *   POST /analyze                         → Anthropic Claude Vision lawn analysis
 *
 * SETUP:
 *   1. Paste this entire file into your Cloudflare Worker
 *   2. Go to Settings → Variables → add these secrets:
 *        GOOGLE_API_KEY     = your Google Maps API key
 *        ANTHROPIC_API_KEY  = your Anthropic API key
 *   3. Deploy → copy your worker URL
 *   4. Paste the worker URL into PAGE1-sizer.html as WORKER_URL
 * ═══════════════════════════════════════════════════════════════
 */ 

// CORS headers — allows your GHL pages to call this worker
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ── Main handler ───────────────────────────────────────────────
export default {
  async fetch(request, env) {

    // Handle preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url      = new URL(request.url);
    const endpoint = url.pathname.replace(/^\//, ''); // strip leading slash

    // ── /autocomplete ────────────────────────────────────────────
    if (endpoint === 'autocomplete' && request.method === 'GET') {
      const input = url.searchParams.get('input') || '';
      if (input.length < 3) {
        return corsResponse(JSON.stringify({ predictions: [] }));
      }

      const googleUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
        `?input=${encodeURIComponent(input)}` +
        `&types=address` +
        `&components=country:us` +
        `&key=${env.GOOGLE_API_KEY}`;

      try {
        const res  = await fetch(googleUrl);
        const data = await res.json();
        return corsResponse(JSON.stringify({
          predictions: (data.predictions || []).map(p => ({
            place_id:     p.place_id,
            description:  p.description,
            main_text:    p.structured_formatting?.main_text    || p.description,
            secondary_text: p.structured_formatting?.secondary_text || '',
          })),
        }));
      } catch (e) {
        return corsResponse(JSON.stringify({ error: e.message, predictions: [] }), 500);
      }
    }

    // ── /geocode ─────────────────────────────────────────────────
    // Converts a place_id to lat/lon
    if (endpoint === 'geocode' && request.method === 'GET') {
      const placeId = url.searchParams.get('place_id') || '';
      if (!placeId) return corsResponse(JSON.stringify({ error: 'Missing place_id' }), 400);

      const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json` +
        `?place_id=${encodeURIComponent(placeId)}` +
        `&key=${env.GOOGLE_API_KEY}`;

      try {
        const res  = await fetch(googleUrl);
        const data = await res.json();
        const loc  = data.results?.[0]?.geometry?.location;
        if (!loc) return corsResponse(JSON.stringify({ error: 'No results' }), 404);
        return corsResponse(JSON.stringify({ lat: loc.lat, lon: loc.lng, formatted: data.results[0].formatted_address }));
      } catch (e) {
        return corsResponse(JSON.stringify({ error: e.message }), 500);
      }
    }

    // ── /satellite ───────────────────────────────────────────────
    // Returns satellite image as base64 (so Claude can analyze it)
    // AND streams it back for display
    if (endpoint === 'satellite' && request.method === 'GET') {
      const lat    = url.searchParams.get('lat');
      const lon    = url.searchParams.get('lon');
      const size   = url.searchParams.get('size') || '640x400';
      const zoom   = url.searchParams.get('zoom') || '19';

      if (!lat || !lon) return corsResponse(JSON.stringify({ error: 'Missing lat/lon' }), 400);

      // Google Maps Static API — satellite imagery
      const googleUrl = `https://maps.googleapis.com/maps/api/staticmap` +
        `?center=${lat},${lon}` +
        `&zoom=${zoom}` +
        `&size=${size}` +
        `&scale=2` +
        `&maptype=satellite` +
        `&key=${env.GOOGLE_API_KEY}`;

      try {
        const res = await fetch(googleUrl);
        if (!res.ok) throw new Error(`Google returned ${res.status}`);

        // Return the image directly so the browser can display it
        const imageBuffer = await res.arrayBuffer();
        return new Response(imageBuffer, {
          headers: {
            ...CORS,
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      } catch (e) {
        return corsResponse(JSON.stringify({ error: e.message }), 500);
      }
    }

    // ── /analyze ─────────────────────────────────────────────────
    // Accepts { lat, lon } → fetches satellite → sends to Claude Vision
    if (endpoint === 'analyze' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400); }

      const { lat, lon } = body;
      if (!lat || !lon) return corsResponse(JSON.stringify({ error: 'Missing lat/lon' }), 400);

      // Step 1: fetch satellite image from Google
      const satelliteUrl = `https://maps.googleapis.com/maps/api/staticmap` +
        `?center=${lat},${lon}` +
        `&zoom=19` +
        `&size=640x400` +
        `&scale=2` +
        `&maptype=satellite` +
        `&key=${env.GOOGLE_API_KEY}`;

      let imageBase64;
      try {
        const imgRes    = await fetch(satelliteUrl);
        if (!imgRes.ok) throw new Error(`Satellite fetch failed: ${imgRes.status}`);
        const imgBuffer = await imgRes.arrayBuffer();
        imageBase64     = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
      } catch (e) {
        // Return fallback analysis if image fetch fails
        return corsResponse(JSON.stringify({
          lawn_acres:          0.20,
          lawn_sqft:           8700,
          obstacle_count:      3,
          trimming_complexity: 'medium',
          complexity_reason:   'Estimated — satellite image unavailable.',
          lawn_condition:      'cond_normal',
          findings:            'We estimated your lawn based on typical properties in this area. Our specialist will confirm exact measurements at your free in-home evaluation.',
          fallback:            true,
        }));
      }

      // Step 2: send to Claude Vision
      const claudePrompt = `You are an expert lawn care estimator. Analyze this satellite image of a residential property and respond ONLY with valid JSON — no markdown, no explanation, just the JSON object:

{
  "lawn_acres": <number, estimated mowable lawn area in acres to 1 decimal>,
  "lawn_sqft": <number, lawn_acres * 43560 rounded to nearest 100>,
  "obstacle_count": <number, trees + garden beds + structures requiring mowing around>,
  "trimming_complexity": <"low" | "medium" | "high">,
  "complexity_reason": <string, one sentence explaining complexity rating>,
  "lawn_condition": <"cond_maintained" | "cond_normal" | "cond_overgrown">,
  "findings": <string, 2-3 sentences describing what you see: lawn size, notable features, trimming challenges. Be specific — mention trees, garden beds, fences, curves, slopes if visible.>
}

Guidelines:
- Typical suburban lot has 0.15–0.25 acres of mowable lawn
- Exclude house footprint, driveway, patios, and garden beds from lawn area
- Low complexity: open flat lawn, few obstacles, straight edges
- Medium complexity: some trees or beds, moderate edging
- High complexity: many obstacles, curved beds, tight spaces, or slopes`;

      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
                { type: 'text',  text: claudePrompt },
              ],
            }],
          }),
        });

        const claudeData = await claudeRes.json();
        const rawText    = claudeData.content?.[0]?.text || '';
        const clean      = rawText.replace(/```json|```/g, '').trim();
        const result     = JSON.parse(clean);
        return corsResponse(JSON.stringify({ ...result, fallback: false }));

      } catch (e) {
        // Fallback if Claude call fails
        return corsResponse(JSON.stringify({
          lawn_acres:          0.20,
          lawn_sqft:           8700,
          obstacle_count:      3,
          trimming_complexity: 'medium',
          complexity_reason:   'AI analysis unavailable — using property estimate.',
          lawn_condition:      'cond_normal',
          findings:            'We estimated your lawn based on typical properties in this area. Our specialist will confirm exact measurements at your free in-home evaluation.',
          fallback:            true,
        }));
      }
    }

    // ── 404 for unknown routes ────────────────────────────────────
    return corsResponse(JSON.stringify({ error: 'Unknown endpoint', path: endpoint }), 404);
  },
};
