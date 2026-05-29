const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CACHE_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '24');

async function getCache(competitor) {
  const since = new Date(Date.now() - CACHE_HOURS * 3600000).toISOString();
  const res = await axios.get(
    `${SUPABASE_URL}/rest/v1/analyses?competitor=eq.${encodeURIComponent(competitor.toLowerCase())}&created_at=gte.${since}&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return res.data.length > 0 ? res.data[0].report : null;
}

async function setCache(competitor, report) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/analyses`,
    { competitor: competitor.toLowerCase(), report },
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }
  );
}

async function getJob(jobId) {
  const res = await axios.get(
    `${SUPABASE_URL}/rest/v1/jobs?job_id=eq.${jobId}&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return res.data.length > 0 ? res.data[0] : null;
}

async function setJob(jobId, data) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/jobs`,
    { job_id: jobId, ...data },
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' } }
  );
}

async function updateJob(jobId, data) {
  await axios.patch(
    `${SUPABASE_URL}/rest/v1/jobs?job_id=eq.${jobId}`,
    data,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }
  );
}

async function getProductHuntData(competitor) {
  try {
    const res = await axios.post(
      'https://api.producthunt.com/v2/api/graphql',
      { query: `{ posts(query: "${competitor}", order: VOTES, first: 5) { edges { node { name tagline description } } } }` },
      { headers: { Authorization: `Bearer ${process.env.PH_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const posts = res.data.data.posts.edges.map(e => e.node);
    return posts.map(p => `${p.name} - ${p.tagline} ${p.description || ''}`).join('\n');
  } catch (err) {
    return '';
  }
}

// Fetche le contenu complet d'une URL — retourne null si bloquée ou timeout
async function fetchUrlContent(url) {
  try {
    const res = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      maxContentLength: 500000
    });
    const html = res.data;
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 3000);
  } catch {
    return null;
  }
}

app.post('/analyze', async (req, res) => {
  const { competitor } = req.body;
  if (!competitor) return res.status(400).json({ error: 'competitor required' });

  const jobId = Date.now().toString();
  await setJob(jobId, { status: 'pending', competitor });
  res.json({ job_id: jobId });

  try {
    const cached = await getCache(competitor);
    if (cached) {
      await updateJob(jobId, { status: 'done', report: cached });
      return;
    }

    const [serpRes, phText] = await Promise.all([
      axios.get('https://serpapi.com/search.json', {
        params: { q: `${competitor} reviews complaints problems users feedback`, api_key: process.env.SERP_API_KEY, num: 10, hl: 'en', gl: 'us' },
        timeout: 15000
      }),
      getProductHuntData(competitor)
    ]);

    const results = serpRes.data.organic_results || [];

    // Fetch le contenu complet des 5 premières URLs en parallèle
    const urlsToFetch = results
      .filter(r => r.link)
      .slice(0, 5)
      .map(r => fetchUrlContent(r.link));

    const fetchedContents = await Promise.all(urlsToFetch);

    // Combine snippet + contenu complet par résultat
    const serpText = results.map((r, i) => {
      const fullContent = fetchedContents[i];
      const base = `${r.title}\n${r.snippet || ''}`;
      return fullContent ? `${base}\n${fullContent}` : base;
    }).filter(t => t.length > 20).join('\n\n');

    const rawText = [serpText, phText].filter(Boolean).join('\n').slice(0, 20000);

    if (!rawText || rawText.length < 100) throw new Error('Insufficient data');

    const sources = ['Web reviews', phText ? 'Product Hunt' : null].filter(Boolean).join(', ');

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: 'You are a competitive intelligence analyst helping SaaS founders identify weaknesses in competitor products they can exploit. You must respond with a single valid JSON object only. No markdown. No backticks. No code blocks. Start your response with { and end with }.',
        messages: [{ role: 'user', content: `Analyze this real user feedback about ${competitor}. Only use what is explicitly stated in the sources below. Do not infer or generalize beyond what users actually said.

${rawText}

Return a single valid JSON object with this exact structure:
{
  "competitor": "${competitor}",
  "reviews_analyzed": ${results.length},
  "sources": "${sources}",
  "product_summary": "2 sentences max. What the product does and who it is for, based only on the content above.",
  "top_weakness": "The most frequently mentioned problem in one sentence, grounded in the sources.",
  "what_users_love": [
    "Specific positive point (from [source type])",
    "Specific positive point (from [source type])",
    "Specific positive point (from [source type])"
  ],
  "what_users_hate": [
    "Specific negative point (from [source type])",
    "Specific negative point (from [source type])",
    "Specific negative point (from [source type])"
  ],
  "pain_points": [
    {
      "rank": 1,
      "title": "Short label, 4 words max",
      "category": "UX|Pricing|Support|Performance|Integrations",
      "severity": 75,
      "frequency": 65,
      "evidence": "Direct quote or close paraphrase from the sources (from [source type])",
      "description": "2-3 sentences explaining the problem based strictly on what users said. Be specific, not generic.",
      "opportunity": "One concrete action a SaaS founder could take TODAY to win users who are frustrated by this. Be specific: name the feature, the positioning angle, or the gap to fill. Not generic advice."
    }
  ]
}` }]
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const raw = claudeRes.data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const report = JSON.parse(raw);

    await setCache(competitor, report);
    await updateJob(jobId, { status: 'done', report });

  } catch (err) {
    await updateJob(jobId, { status: 'error', error: err.message });
  }
});

app.get('/status/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/emails`,
      { email },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Lenso API running'));
