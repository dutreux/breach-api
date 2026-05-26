const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const jobs = {};

app.post('/analyze', async (req, res) => {
  const { competitor } = req.body;
  if (!competitor) return res.status(400).json({ error: 'competitor required' });

  const jobId = Date.now().toString();
  jobs[jobId] = { status: 'pending', competitor };
  res.json({ job_id: jobId });

  try {
    const serpRes = await axios.get('https://serpapi.com/search.json', {
      params: {
        q: `${competitor} reviews complaints problems users feedback`,
        api_key: process.env.SERP_API_KEY,
        num: 10,
        hl: 'en',
        gl: 'us'
      },
      timeout: 15000
    });

    const results = serpRes.data.organic_results || [];
    const rawText = results
      .map(r => `${r.title} ${r.snippet || ''}`.trim())
      .filter(t => t.length > 20)
      .join('\n')
      .slice(0, 8000);

    if (!rawText || rawText.length < 100) throw new Error('Insufficient data from search');

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: 'You are a competitive intelligence analyst. You must respond with a single valid JSON object only. No markdown. No backticks. No code blocks. No explanation. Start your response with { and end with }.',
        messages: [{
          role: 'user',
          content: `Analyze this real user feedback about ${competitor}.\n\n${rawText}\n\nReturn JSON:\n{"competitor":"${competitor}","reviews_analyzed":${results.length},"product_summary":"2-sentence description based on the feedback","top_weakness":"single most critical weakness mentioned by users","what_users_love":["string","string","string"],"what_users_hate":["string","string","string"],"pain_points":[{"rank":1,"title":"string","category":"UX|Pricing|Support|Performance|Integrations","severity":80,"frequency":70,"description":"string based on real feedback","opportunity":"how a competitor could exploit this gap"}]}`
        }]
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const raw = claudeRes.data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
const report = JSON.parse(raw);
    jobs[jobId] = { status: 'done', report };

  } catch (err) {
    jobs[jobId] = { status: 'error', error: err.message, detail: err.response?.data || null };
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

app.listen(process.env.PORT || 3000, () => console.log('Lenso API running'));
