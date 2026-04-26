// HANDS Logistics — Google Sheets Budget Proxy
// Fetches Monthly Budget sheet server-side
// Endpoint: GET /.netlify/functions/sheets-budget

const GS_ID  = '1NA2EGqfg-2f-5ZXgHLpND0MKkClDwOAJVF7Zpc-yfKk';
const GS_KEY = process.env.GOOGLE_SHEETS_API_KEY || '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (!GS_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({
      error: 'GOOGLE_SHEETS_API_KEY not set in Netlify environment variables',
      fix: 'Go to Netlify → Site config → Environment variables → add GOOGLE_SHEETS_API_KEY'
    })};
  }

  try {
    // Step 1: Fetch spreadsheet metadata to find the exact sheet names
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${GS_ID}?key=${GS_KEY}&fields=sheets.properties`;
    const metaRes = await fetch(metaUrl);

    if (!metaRes.ok) {
      const errBody = await metaRes.text();
      return { statusCode: metaRes.status, headers: CORS, body: JSON.stringify({
        error: `Sheets API error ${metaRes.status}`,
        detail: errBody.slice(0, 500),
        fix: metaRes.status === 403
          ? 'Share the Google Sheet as "Anyone with the link → Viewer" and ensure the API key has Sheets API enabled'
          : 'Check sheet ID and API key'
      })};
    }

    const meta = await metaRes.json();
    const allSheets = (meta.sheets || []).map(s => s.properties.title);
    console.log('[sheets-budget] Available sheets:', allSheets.join(', '));

    // Find the budget sheet — look for "Monthly Budget" or first non-client sheet
    const budgetKeywords = ['monthly budget', 'budget', 'monthly'];
    let targetSheet = allSheets.find(name =>
      budgetKeywords.some(kw => name.toLowerCase().includes(kw))
    ) || allSheets[0];

    console.log('[sheets-budget] Using sheet:', targetSheet);

    // Step 2: Fetch the budget data
    const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${GS_ID}/values/${encodeURIComponent(targetSheet)}!A1:O90?key=${GS_KEY}&valueRenderOption=UNFORMATTED_VALUE`;
    const dataRes = await fetch(dataUrl);

    if (!dataRes.ok) {
      const errBody = await dataRes.text();
      return { statusCode: dataRes.status, headers: CORS, body: JSON.stringify({
        error: `Failed to fetch sheet data: HTTP ${dataRes.status}`,
        sheet: targetSheet,
        allSheets,
        detail: errBody.slice(0, 300)
      })};
    }

    const data = await dataRes.json();
    const rows = data.values || [];
    console.log(`[sheets-budget] Got ${rows.length} rows from "${targetSheet}"`);

    if (rows.length < 5) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ok: false,
        error: 'Sheet appears empty or has too few rows',
        rowCount: rows.length,
        sheet: targetSheet,
        allSheets,
        preview: rows.slice(0, 5)
      })};
    }

    // Helper: get numeric value — col 0=A, 1=B(label), 2=C(Jan value)
    const n = (rowIdx, colIdx = 2) => {
      const row = rows[rowIdx];
      if (!row) return 0;
      const v = row[colIdx];
      return (v !== undefined && v !== '' && v !== null) ? (parseFloat(v) || 0) : 0;
    };

    // Log key rows for debugging
    const keyRows = [5,6,7,8,9,10,11,12,13,15,19,25,26,39,72,75];
    const debug = {};
    keyRows.forEach(i => {
      const row = rows[i];
      if (row) debug[`row${i+1}`] = { label: row[1]||'', jan: row[2]||'' };
    });
    console.log('[sheets-budget] Key rows:', JSON.stringify(debug));

    // Revenue (0-indexed: row 6 = index 5)
    const ghost    = n(5);
    const wgs      = n(6);
    const campari  = n(7);
    const titos    = n(8);
    const patron   = n(9);
    const mhusa    = n(10);
    const activ    = n(11);
    const prod     = n(12);
    const deliv    = n(13);
    const totalRev = n(15) || (ghost+wgs+campari+titos+patron+mhusa+activ+prod+deliv);

    // COGS
    const cogs = n(25) || n(19);

    // GP
    const gp     = n(26) || (totalRev - cogs);
    const gpPct  = totalRev > 0 ? gp / totalRev : 0;

    // SG&A
    const insurance = n(31)+n(32)+n(33)+n(34)+n(35)+n(36);
    const rent      = n(39);
    const utilities = n(44)+n(46)+n(47);
    const software  = n(49)+n(50)+n(51)+n(52)+n(53)+n(54);
    const autoLoans = n(57)+n(58)+n(59);
    const fuel      = n(60)+n(61)+n(62)+n(63)+n(64);
    const debt      = n(66)+n(67)+n(68)+n(69);
    const other     = n(38)+n(55)+n(71);
    const totalSGA  = n(72) || (insurance+rent+utilities+software+autoLoans+fuel+debt+other);
    const ebit      = n(75) || (gp - totalSGA);
    const breakeven = gpPct > 0 ? Math.ceil(totalSGA / gpPct / 500) * 500 : 39000;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        sheet: targetSheet,
        allSheets,
        rowCount: rows.length,
        debug,
        budget: {
          totalRev, retainerRev: ghost+wgs+campari+titos+patron+mhusa,
          adhocRev: activ+prod+deliv,
          cogs, gp, gpPct, totalSGA, ebit, breakeven,
          rent, autoLoans, debt, software, insurance, utilities, fuel, other,
          ghost, wgs, campari, titos, patron, mhusa
        }
      })
    };

  } catch (err) {
    console.error('[sheets-budget] Unexpected error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({
      error: 'Unexpected server error',
      message: err.message
    })};
  }
};
