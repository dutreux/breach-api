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
    const redditRes = await axios.get(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(competitor)}&limit=25&sort=relevance&t=year`,
      { headers: { 'User-Agent': 'lenso-app/1.0' }, timeout: 10000 }
    );

    const posts = redditRes.data.data.children.map(c => c.data);
    const rawText = posts
      .map(p => `${p.title} ${p.selftext || ''}`.trim())
      .filter(t => t.length > 20)
      .join('\n')
      .slice(0, 8000);

    if (!rawText || rawText.length < 100) throw new Error('Insufficient Reddit data');

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: 'You are a competitive intelligence analyst. Respond in JSON only. No markdown, no backticks. Base your analysis strictly on the provided user feedback text. Do not invent data.',
        messages: [{
          role: 'user',
          content: `Analyze this real Reddit feedback about ${competitor}.\n\n${rawText}\n\nReturn JSON:\n{"competitor":"${competitor}","reviews_analyzed":${posts.length},"product_summary":"2-sentence description of what this product does based on the feedback","top_weakness":"single most critical weakness mentioned by users","what_users_love":["string","string","string"],"what_users_hate":["string","string","string"],"pain_points":[{"rank":1,"title":"string","category":"UX|Pricing|Support|Performance|Integrations","severity":80,"frequency":70,"description":"string based on real feedback","opportunity":"how a competitor could exploit this gap"}]}`
        }]
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const report = JSON.parse(claudeRes.data.content[0].text);
    jobs[jobId] = { status: 'done', report };

  } catch (err) {
    jobs[jobId] = { status: 'error', error: err.message };
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

app.listen(process.env.PORT || 3000, () => console.log('Lenso API running'));
