const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const BASE_URL = process.env.MIRAKL_BASE_URL;
const API_KEY = process.env.MIRAKL_API_KEY;

async function upload(type, csvPath) {
  const endpoint = type === 'products' ? '/api/products/imports' : '/api/offers/imports';
  const form = new FormData();
  form.append('file', fs.createReadStream(csvPath), { filename: path.basename(csvPath), contentType: 'text/csv' });
  
  const res = await axios.post(`${BASE_URL}${endpoint}`, form, {
    headers: { ...form.getHeaders(), Authorization: API_KEY },
    params: { import_mode: 'NORMAL' },
    timeout: 300000,
  });
  return res.data.import_id;
}

async function pollProducts(importId) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 15000));
    const res = await axios.get(`${BASE_URL}/api/products/imports/${importId}`, {
      headers: { Authorization: API_KEY }, timeout: 30000,
    });
    const d = res.data;
    const elapsed = Math.round((Date.now() - new Date(d.date_created).getTime()) / 60000);
    console.log(`[${elapsed}min] PA01 status=${d.import_status} transform_ok=${d.transform_lines_in_success} transform_err=${d.transform_lines_in_error}`);
    if (d.integration_details) {
      const i = d.integration_details;
      console.log(`  Integration: synced=${i.products_successfully_synchronized} rejected=${i.rejected_products}`);
    }
    if (d.import_status === 'COMPLETE' || d.import_status === 'FAILED') return d;
  }
  return null;
}

async function pollOffers(importId) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const res = await axios.get(`${BASE_URL}/api/offers/imports/${importId}`, {
      headers: { Authorization: API_KEY }, timeout: 30000,
    });
    const s = res.data;
    console.log(`OF01 status=${s.status} read=${s.lines_read} ok=${s.lines_in_success} err=${s.lines_in_error}`);
    if (s.status === 'COMPLETE' || s.status === 'FAILED') {
      if (s.lines_in_error > 0) {
        const errRes = await axios.get(`${BASE_URL}/api/offers/imports/${importId}/error_report`, {
          headers: { Authorization: API_KEY }, timeout: 30000, responseType: 'text',
        });
        console.log('Offer errors:', errRes.data.substring(0, 500));
      }
      return s;
    }
  }
  return null;
}

async function main() {
  console.log('=== Uploading 5 test products (PA01) ===');
  const prodImportId = await upload('products', 'output/test-products.csv');
  console.log('PA01 import ID:', prodImportId);
  
  const prodResult = await pollProducts(prodImportId);
  if (!prodResult || prodResult.import_status !== 'COMPLETE') {
    console.log('PA01 did not complete. Aborting.');
    return;
  }
  
  const synced = prodResult.integration_details?.products_successfully_synchronized || 0;
  console.log(`\nPA01 complete: ${synced} products synced`);
  
  if (synced === 0) {
    console.log('No products accepted — check integration errors');
    // Get error report
    try {
      const errRes = await axios.get(`${BASE_URL}/api/products/imports/${prodImportId}/error_report`, {
        headers: { Authorization: API_KEY }, timeout: 30000, responseType: 'text',
      });
      const lines = errRes.data.split('\n');
      const headers = lines[0].split(';').map(h => h.replace(/"/g, ''));
      const errIdx = headers.findIndex(h => h.toLowerCase() === 'errors');
      for (let i = 1; i < Math.min(lines.length, 6); i++) {
        const cols = lines[i].split(';').map(c => c.replace(/^"|"$/g, ''));
        console.log(`  ${cols[errIdx]}`);
      }
    } catch(e) {}
    return;
  }
  
  console.log('\n=== Uploading test offers (OF01) ===');
  const offerImportId = await upload('offers', 'output/test-offers.csv');
  console.log('OF01 import ID:', offerImportId);
  await pollOffers(offerImportId);
  
  // Check live offers
  console.log('\n=== Checking live offers ===');
  const offersRes = await axios.get(`${BASE_URL}/api/offers`, {
    headers: { Authorization: API_KEY }, params: { max: 20 }, timeout: 30000,
  });
  console.log('Total live offers:', offersRes.data.total_count);
}

main().catch(e => console.error('FATAL:', e.response?.data || e.message));
