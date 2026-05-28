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
    const serpText = results.map(r => `${r.title} ${r.snippet || ''}`.trim()).filter(t => t.length > 20).join('\n');
    const rawText = [serpText, phText].filter(Boolean).join('\n').slice(0, 8000);

    if (!rawText || rawText.length < 100) throw new Error('Insufficient data');

    const sources = ['Web reviews', phText ? 'Product Hunt' : null].filter(Boolean).join(', ');

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: 'You are a competitive intelligence analyst. You must respond with a single valid JSON object only. No markdown. No backticks. No code blocks. Start your response with { and end with }.',
        messages: [{ role: 'user', content: `Analyze this real user feedback about ${competitor}.\n\n${rawText}\n\nReturn JSON:\n{"competitor":"${competitor}","reviews_analyzed":${results.length},"sources":"${sources}","product_summary":"2-sentence description","top_weakness":"most critical weakness","what_users_love":["string","string","string"],"what_users_hate":["string","string","string"],"pain_points":[{"rank":1,"title":"string","category":"UX|Pricing|Support|Performance|Integrations","severity":80,"frequency":70,"description":"string","opportunity":"string"}]}` }]
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
