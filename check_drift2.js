const axios = require('axios');
const url = process.env.MIRAKL_BASE_URL;
const key = process.env.MIRAKL_API_KEY;

async function main() {
  // Request fresh export
  const exp = await axios.post(`${url}/api/offers/export/async`, {}, { headers: { Authorization: key, 'Content-Type': 'application/json' } });
  const tid = exp.data.tracking_id;
  console.log('Export:', tid);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const s = await axios.get(`${url}/api/offers/export/async/status/${tid}`, { headers: { Authorization: key } });
    if (s.data.status === 'COMPLETED') {
      const csvUrl = s.data.urls[0];
      const csv = await axios.get(csvUrl, { headers: { Authorization: key }, responseType: 'text' });
      const lines = csv.data.split('\n');
      const hdr = lines[0];
      const delim = hdr.includes('\t') ? '\t' : ';';
      const cols = hdr.split(delim).map(h => h.replace(/^"|"$/g, '').toLowerCase().trim());

      const si = cols.indexOf('shop-sku');
      const pi = cols.indexOf('price');
      const di = cols.indexOf('discount-price');
      const opi = cols.indexOf('origin-price');

      console.log(`Columns: shop-sku@${si} price@${pi} discount-price@${di} origin-price@${opi}`);

      // Show diverse samples
      let count = 0;
      let priceEqDisc = 0;
      let priceNeDisc = 0;
      for (let j = 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        const c = lines[j].split(delim).map(v => v.replace(/^"|"$/g, ''));
        const price = parseFloat(c[pi] || '0');
        const disc = parseFloat(c[di] || '0');
        const origin = c[opi] || '';
        if (Math.abs(price - disc) < 0.01) priceEqDisc++;
        else priceNeDisc++;
        count++;
        if (count <= 10) {
          console.log(`${c[si]} | price=${price} | disc=${disc} | origin=${origin}`);
        }
      }
      console.log(`\nTotal: ${count} offers`);
      console.log(`price == discount-price: ${priceEqDisc}`);
      console.log(`price != discount-price: ${priceNeDisc}`);
      return;
    }
    console.log('waiting...', s.data.status);
  }
}
main().catch(e => console.error(e.message));
