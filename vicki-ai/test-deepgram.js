// Quick test — run with: node test-deepgram.js YOUR_KEY_HERE
const key = process.argv[2] || process.env.DEEPGRAM_API_KEY;
if (!key) { console.error('Pass key as argument: node test-deepgram.js YOUR_KEY'); process.exit(1); }

console.log('Testing Deepgram key prefix:', key.slice(0,8), '...');
console.log('Key length:', key.length);

// Simple REST call to Deepgram — no WebSocket needed
const https = require('https');
const req = https.request({
  hostname: 'api.deepgram.com',
  path: '/v1/projects',
  method: 'GET',
  headers: { 'Authorization': `Token ${key}` }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    console.log('HTTP status:', res.statusCode);
    if (res.statusCode === 200) {
      const data = JSON.parse(body);
      console.log('✅ Key is VALID — Projects:', data.projects?.map(p => p.name).join(', '));
    } else if (res.statusCode === 401) {
      console.log('❌ Key is INVALID or EXPIRED — 401 Unauthorized');
      console.log('→ Go to console.deepgram.com and create a new API key');
    } else {
      console.log('Response body:', body.slice(0, 300));
    }
  });
});
req.on('error', e => console.error('Network error:', e.message));
req.end();
