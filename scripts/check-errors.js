const axios = require('axios');

const b = process.env.MIRAKL_BASE_URL;
const k = process.env.MIRAKL_API_KEY;

async function main() {
  const { data } = await axios.get(b + '/api/offers/imports/46198411/error_report', {
    headers: { Authorization: k },
    responseType: 'text',
  });

  const lines = String(data).split('\n');
  const headers = lines[0].split(';').map(x => x.replace(/"/g, ''));
  const ei = headers.indexOf('error-message');
  console.log('error-message column index:', ei);
  console.log('Total error lines:', lines.length - 2); // minus header and trailing newline

  const errs = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cols = lines[i].split(';').map(x => x.replace(/^"|"$/g, ''));
    const msg = cols[ei] || '(empty)';
    if (errs[msg] === undefined) errs[msg] = 0;
    errs[msg]++;
  }

  const sorted = Object.entries(errs).sort((a, b) => b[1] - a[1]);
  console.log('\nUnique error types:', sorted.length);
  console.log('');
  for (const [msg, count] of sorted) {
    console.log(`[${count}x] ${msg.substring(0, 300)}`);
  }
}

main().catch(e => {
  console.error('Failed:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).substring(0, 500) : e.message);
});
