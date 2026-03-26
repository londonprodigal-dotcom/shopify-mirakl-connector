const axios = require('axios');
const c = require('../dist/config').loadConfig();
const h = {Authorization: c.mirakl.apiKey, Accept: 'application/json'};

const targets = [
  'category2_dresses','sleeve_length','style_womensdresses',
  'range_womensclothingacc','occasion_womensclothingacc',
  'category2_skirts','style_skirts',
  'category2_trousers','style_womenstrousers',
  'category2_jumperscardigans','style_womensjumperscardigans',
  'category2_shorts','style_womensshorts',
  'category2_jumpsuits','style_womensjumpsuits',
  'category2_shirts','style_womensshirts',
  'category2_hoodiessweatshirts','style_hoodiessweatshirts',
  'category2_jacketscoats','style_womensjacketscoats',
  'category2_jewellery','style_womensjewellery','size_jewellery',
  'category2_bagspurses','style_womensbagspurses','size_onesize',
  'category2_tops','style_womenstops',
  'category2_belts','category2_sunglasses','category2_hats',
  'category2_accessories',
  'category2_glovesscarves',
  'style_womensglovesscarves','style_womensbelts','style_womenssunglasses','style_womenshats',
  'category2_hairaccessories','style_womenshairaccessories',
  'category2_playsuits','style_womensplaysuits',
  'category2_co-ords','style_womensco-ords',
];

async function go() {
  const r = await axios.get(c.mirakl.baseUrl + '/api/values_lists', {
    headers: h, params: {max: 1000}
  });
  const all = r.data.values_lists || [];
  for (const t of targets) {
    const found = all.find(x => x.code === t);
    if (found) {
      const vals = found.values.map(v => v.code || v.label);
      // Truncate to first 10 values for readability
      const display = vals.length > 10 ? vals.slice(0,10).join(', ') + '...(+' + (vals.length-10) + ')' : vals.join(', ');
      process.stdout.write(t + ' (' + vals.length + '): ' + display + '\n');
    } else {
      process.stdout.write(t + ': NOT FOUND\n');
    }
  }
}
go().catch(e => process.stderr.write('ERR: ' + e.message + '\n'));
