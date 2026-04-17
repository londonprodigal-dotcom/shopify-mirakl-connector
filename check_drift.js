const axios = require('axios');
const url = process.env.MIRAKL_BASE_URL;
const key = process.env.MIRAKL_API_KEY;

async function main() {
  const tid = 'cad5595c-bb42-4319-91ec-31f5a51d87eb';
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const s = await axios.get(`${url}/api/offers/export/async/status/${tid}`, { headers: { Authorization: key } });
    if (s.data.status === 'COMPLETED') {
      const csvUrl = s.data.urls[0];
      const csv = await axios.get(csvUrl, { headers: { Authorization: key }, responseType: 'text' });
      const lines = csv.data.split('\n');
      const hdr = lines[0];
      const delim = hdr.includes('\t') ? '\t' : ';';
      const cols = hdr.split(delim).map(h => h.replace(/^"|"$/g, '').toLowerCase().trim());
      console.log('Columns:', cols.join(' | '));
      const si = cols.indexOf('shop-sku');
      const pi = cols.indexOf('price');
      const di = cols.indexOf('discount-price');
      console.log(`sku@${si} price@${pi} discount@${di}`);
      // Show 8 samples
      for (let j = 1; j < Math.min(8, lines.length); j++) {
        const c = lines[j].split(delim).map(v => v.replace(/^"|"$/g, ''));
        console.log(`${c[si]} | price=${c[pi]} | disc=${c[di]}`);
      }
      // Find Halcyon
      for (let j = 1; j < lines.length; j++) {
        if (lines[j].includes('10221723')) {
          const c = lines[j].split(delim).map(v => v.replace(/^"|"$/g, ''));
          console.log(`HALCYON: price=${c[pi]} disc=${c[di]}`);
        }
      }
      return;
    }
    console.log('waiting...', s.data.status);
  }
}
main().catch(e => console.error(e.message));
