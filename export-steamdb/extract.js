const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node extract.js inp/file-name.txt');
  process.exit(1);
}

const html = fs.readFileSync(inputPath, 'utf-8');
const baseName = path.basename(inputPath, path.extname(inputPath));
const outDir = path.join(path.dirname(inputPath), '..', 'out');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}
const outputPath = path.join(outDir, `${baseName}.csv`);
const dom = new JSDOM(html);
const doc = dom.window.document;

const rows = doc.querySelectorAll('tbody tr.app');
const results = [];

for (const row of rows) {
  const appId = row.getAttribute('data-appid');
  const tds = row.querySelectorAll('td');

  // Name is in the 3rd td (index 2), inside an <a class="b">
  const nameEl = tds[2]?.querySelector('a.b');
  const name = nameEl ? nameEl.textContent.trim() : '';

  // Category (e.g. "Application") in span.cat
  const catEl = tds[2]?.querySelector('span.cat');
  const category = catEl ? catEl.textContent.trim() : '';

  // Discount - data-sort on td index 3
  const discountRaw = tds[3]?.getAttribute('data-sort');
  const discount = discountRaw && discountRaw !== '0' ? `-${discountRaw}%` : '';

  // Price - data-sort on td index 4 (in paise/smallest unit)
  const priceRaw = tds[4]?.getAttribute('data-sort');
  const priceText = tds[4]?.textContent.trim() || '';

  // Rating - data-sort on td index 5
  const rating = tds[5]?.getAttribute('data-sort') || '';

  // Release date - text content of td index 6
  const releaseText = tds[6]?.textContent.trim() || '';

  // Followers - data-sort on td index 7
  const followers = tds[7]?.getAttribute('data-sort') || '';

  // Online now - data-sort on td index 8
  const online = tds[8]?.getAttribute('data-sort') || '';

  // Peak - data-sort on td index 9
  const peak = tds[9]?.getAttribute('data-sort') || '';

  results.push({
    appId,
    name,
    category,
    discount,
    price: priceText,
    rating,
    release: releaseText,
    followers,
    online,
    peak
  });
}

// Write CSV
const headers = ['AppID', 'Name', 'Category', 'Discount', 'Price', 'Rating%', 'Release', 'Followers', 'Online', 'Peak'];
const csvLines = [headers.join(',')];

for (const r of results) {
  const line = [
    r.appId,
    `"${r.name.replace(/"/g, '""')}"`,
    `"${r.category}"`,
    r.discount,
    `"${r.price}"`,
    r.rating,
    `"${r.release}"`,
    r.followers,
    r.online,
    r.peak
  ].join(',');
  csvLines.push(line);
}

const csv = csvLines.join('\n');
fs.writeFileSync(outputPath, csv, 'utf-8');
console.log(`Extracted ${results.length} rows to ${outputPath}`);
