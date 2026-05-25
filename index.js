const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.post('/analyze', async (req, res) => {
  const { competitor } = req.body;
  if (!competitor) return res.status(400).json({ error: 'competitor required' });
  try {
    const redditRun = await axios.post(
      'https://api.apify.com/v2/acts/crawlerbros~reddit-scraper/runs?token=' + process.env.APIFY_TOKEN,
      { subreddits: ['saas','entrepreneur','productivity'], searchQuery: competitor, maxPosts: 25 }
    );
    const phRun = await axios.post(
      'https://api.apify.com/v2/acts/crawlerbros~product-hunt-scraper/runs?token=' + process.env.APIFY_TOKEN,
      { searchQuery: competitor, maxResults: 20 }
    );
    await new Promise(r => setTimeout(r, 25000));
    const redditData = await axios.get('https://api.apify.com/v2/acts/crawlerbros~reddit-scraper/runs/' + redditRun.data.data.id + '/dataset/items?token=' + process.env.APIFY_TOKEN);
    const phData = await axios.get('https://api.apify.com/v2/acts/crawlerbros~product-hunt-scraper/runs/' + phRun.data.data.id + '/dataset/items?token=' + process.env.APIFY_TOKEN);
    const rawText = [...redditData.data.map(p => p.title + ' ' + (p.selftext || '')), ...phData.data.map(p => p.tagline + ' ' + (p.description || ''))].join('\n').slice(0, 8000);
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: 'You are a competitive intelligence analyst. Respond in JSON only. No markdown, no backticks.', messages: [{ role: 'user', content: 'Analyze this real user feedback about ' + competitor + ' and extract pain points.\n\n' + rawText + '\n\nReturn JSON: {"competitor":"' + competitor + '","global_score":30,"reviews_analyzed":' + (redditData.data.length + phData.data.length) + ',"top_weakness":"string","pain_points":[{"rank":1,"title":"string","category":"UX","severity":85,"sentiment":60,"sources":["Reddit"],"description":"string","attack_angle":"string"}]}' }] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );
    const result = JSON.parse(claudeRes.data.content[0].text);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});
app.listen(process.env.PORT || 3000, () => console.log('Breach API running'));
