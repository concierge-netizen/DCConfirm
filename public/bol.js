// ══════════════════════════════════════════════════════════════
//  HANDS BOL GENERATOR  (shared)
//  Exposes window.HANDS_BOL.{ openPreview, buildFullBol, buildCondensedBol }
//  Data shape expected:
//    { direction:'inbound'|'outbound', client, account, email, phone,
//      project, purpose, wbs, handler, date, time, status,
//      carrier, tracking, cartons, pallets, weight,
//      address, contents, instructions }
// ══════════════════════════════════════════════════════════════
(function(){
  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return p[1] + '/' + p[2] + '/' + p[0];
  }

  // ── FULL 8.5 × 11 BOL ────────────────────────────────────────
  function buildFullBol(d, po) {
    d = d || {}; po = po || '—';
    const dir      = d.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND';
    const dirColor = d.direction === 'outbound' ? '#579bfc' : '#fdab3d';
    const hands = {
      name: 'HANDS LOGISTICS LLC',
      addr: '8540 Dean Martin Drive, Suite 160<br>Las Vegas, NV 89139<br>concierge@handslogistics.com &bull; 702.602.7110'
    };
    const clientBlock = {
      name: esc(d.client || '—'),
      addr: esc((d.address || '').replace(/\n/g,'<br>') || '—')
    };
    const shipper   = d.direction === 'outbound' ? hands : clientBlock;
    const consignee = d.direction === 'outbound' ? clientBlock : hands;

    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BOL #' + esc(po) + ' — ' + dir + '</title>' +
'<style>' +
'@page { size: 8.5in 11in; margin: 0.4in; }' +
'* { box-sizing: border-box; margin: 0; padding: 0; }' +
'body { font-family: "Helvetica Neue", Arial, sans-serif; color: #000; background: #fff; font-size: 10px; line-height: 1.35; }' +
'.page { max-width: 7.7in; margin: 0 auto; padding: 12px; }' +
'.top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 12px; }' +
'.brand { font-family: "Bebas Neue", Impact, sans-serif; font-size: 26px; letter-spacing: 3px; font-weight: 700; }' +
'.brand-sub { font-size: 9px; color: #444; margin-top: 2px; letter-spacing: 1px; text-transform: uppercase; }' +
'.title-block { text-align: right; }' +
'.title-block .title { font-size: 20px; font-weight: 700; letter-spacing: 2px; }' +
'.dir-badge { display: inline-block; padding: 4px 14px; background: ' + dirColor + '; color: #000; font-weight: 700; font-size: 11px; letter-spacing: 2px; margin-top: 4px; }' +
'.po-label { font-size: 9px; color: #666; margin-top: 6px; text-transform: uppercase; letter-spacing: 1.5px; }' +
'.po-val { font-family: "Courier New", monospace; font-size: 14px; font-weight: 700; letter-spacing: 1px; }' +
'.meta-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }' +
'.meta-cell { border: 1px solid #000; padding: 5px 7px; }' +
'.meta-cell .lbl { font-size: 7.5px; color: #666; letter-spacing: 1.5px; text-transform: uppercase; }' +
'.meta-cell .val { font-size: 11px; font-weight: 700; margin-top: 1px; }' +
'.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }' +
'.box { border: 1.5px solid #000; padding: 8px 10px; min-height: 90px; }' +
'.box-head { font-weight: 700; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; padding-bottom: 4px; border-bottom: 1px solid #000; margin-bottom: 6px; }' +
'.box-body { font-size: 10px; line-height: 1.45; }' +
'.box-body .name { font-weight: 700; font-size: 11px; margin-bottom: 2px; }' +
'.section-title { font-size: 9px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; background: #000; color: #fff; padding: 3px 8px; margin: 10px 0 4px; }' +
'table.items { width: 100%; border-collapse: collapse; font-size: 9.5px; margin-bottom: 8px; }' +
'table.items th { background: #222; color: #fff; padding: 5px 6px; text-align: left; font-size: 8.5px; letter-spacing: 1px; text-transform: uppercase; }' +
'table.items td { padding: 6px; border: 1px solid #000; vertical-align: top; }' +
'table.items tr.totals td { background: #f0f0f0; font-weight: 700; }' +
'.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 8px; }' +
'.info-cell { border: 1px solid #000; padding: 5px 8px; }' +
'.info-cell .lbl { font-size: 7.5px; color: #555; letter-spacing: 1.5px; text-transform: uppercase; }' +
'.info-cell .val { font-size: 10.5px; font-weight: 600; margin-top: 1px; min-height: 13px; }' +
'.notes { border: 1px solid #000; padding: 6px 9px; min-height: 50px; font-size: 10px; margin-bottom: 8px; }' +
'.terms { border: 1px solid #888; padding: 7px 10px; font-size: 7.5px; color: #333; line-height: 1.5; margin-bottom: 10px; background: #fafafa; }' +
'.sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }' +
'.sig-box { border: 1.5px solid #000; padding: 10px; min-height: 90px; display: flex; flex-direction: column; }' +
'.sig-head { font-weight: 700; font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }' +
'.sig-line { border-bottom: 1px solid #000; margin: 18px 0 4px; }' +
'.sig-lbl { font-size: 8px; color: #555; letter-spacing: 1px; text-transform: uppercase; }' +
'.footer { margin-top: 12px; padding-top: 6px; border-top: 1px solid #000; font-size: 8px; color: #666; display: flex; justify-content: space-between; }' +
'.actions { max-width: 7.7in; margin: 0 auto 12px; display: flex; gap: 8px; padding: 12px; font-family: Arial, sans-serif; }' +
'.pb { padding: 10px 20px; font-size: 12px; font-weight: 700; letter-spacing: 1.5px; cursor: pointer; border: none; }' +
'.pb-print { background: #000; color: #fff; }' +
'.pb-close { background: #ddd; color: #000; }' +
'@media print { .actions { display: none; } body { font-size: 9.5px; } .page { padding: 0; } }' +
'</style></head><body>' +
'<div class="actions">' +
  '<button class="pb pb-print" onclick="window.print()">\uD83D\uDDA8 Print / Save as PDF</button>' +
  '<button class="pb pb-close" onclick="window.close()">Close</button>' +
'</div>' +
'<div class="page">' +
  '<div class="top">' +
    '<div>' +
      '<div class="brand">HANDS LOGISTICS</div>' +
      '<div class="brand-sub">Concierge 3PL &bull; Las Vegas, NV</div>' +
    '</div>' +
    '<div class="title-block">' +
      '<div class="title">BILL OF LADING</div>' +
      '<div class="dir-badge">' + dir + '</div>' +
      '<div class="po-label">PO / Tracking #</div>' +
      '<div class="po-val">' + esc(po) + '</div>' +
    '</div>' +
  '</div>' +
  '<div class="meta-row">' +
    '<div class="meta-cell"><div class="lbl">Date</div><div class="val">' + esc(fmtDate(d.date)) + '</div></div>' +
    '<div class="meta-cell"><div class="lbl">Time</div><div class="val">' + esc(d.time || '—') + '</div></div>' +
    '<div class="meta-cell"><div class="lbl">Direction</div><div class="val">' + dir + '</div></div>' +
    '<div class="meta-cell"><div class="lbl">Account / Brand</div><div class="val">' + esc(d.account || '—') + '</div></div>' +
  '</div>' +
  '<div class="pair">' +
    '<div class="box">' +
      '<div class="box-head">Shipper / From</div>' +
      '<div class="box-body">' +
        '<div class="name">' + shipper.name + '</div>' +
        '<div>' + shipper.addr + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="box">' +
      '<div class="box-head">Consignee / Ship To</div>' +
      '<div class="box-body">' +
        '<div class="name">' + consignee.name + '</div>' +
        '<div>' + consignee.addr + '</div>' +
        (d.email ? '<div style="margin-top:4px;">' + esc(d.email) + '</div>' : '') +
        (d.phone ? '<div>' + esc(d.phone) + '</div>' : '') +
      '</div>' +
    '</div>' +
  '</div>' +
  '<div class="grid3">' +
    '<div class="info-cell"><div class="lbl">Carrier</div><div class="val">' + esc(d.carrier || '—') + '</div></div>' +
    '<div class="info-cell"><div class="lbl">Tracking / PRO #</div><div class="val">' + esc(d.tracking || '—') + '</div></div>' +
    '<div class="info-cell"><div class="lbl">Event / Project</div><div class="val">' + esc(d.project || '—') + '</div></div>' +
  '</div>' +
  '<div class="grid3">' +
    '<div class="info-cell"><div class="lbl">Material Purpose</div><div class="val">' + esc(d.purpose || '—') + '</div></div>' +
    '<div class="info-cell"><div class="lbl">WBS / Invoice Code</div><div class="val">' + esc(d.wbs || '—') + '</div></div>' +
    '<div class="info-cell"><div class="lbl">Handled By</div><div class="val">' + esc(d.handler || '—') + '</div></div>' +
  '</div>' +
  '<div class="section-title">Shipment Contents</div>' +
  '<table class="items">' +
    '<thead><tr>' +
      '<th style="width:15%;">Cartons</th>' +
      '<th style="width:15%;">Pallets</th>' +
      '<th style="width:15%;">Weight (lbs)</th>' +
      '<th>Description / Contents</th>' +
    '</tr></thead>' +
    '<tbody>' +
      '<tr>' +
        '<td>' + esc(d.cartons || '—') + '</td>' +
        '<td>' + esc(d.pallets || '—') + '</td>' +
        '<td>' + esc(d.weight || '—') + '</td>' +
        '<td>' + esc(d.contents || '—').replace(/\n/g,'<br>') + '</td>' +
      '</tr>' +
      '<tr class="totals">' +
        '<td>Total Cartons: ' + esc(d.cartons || '0') + '</td>' +
        '<td>Total Pallets: ' + esc(d.pallets || '0') + '</td>' +
        '<td>Total Weight: ' + esc(d.weight || '0') + ' lbs</td>' +
        '<td style="text-align:right;">Status: <strong>' + esc(d.status || '—') + '</strong></td>' +
      '</tr>' +
    '</tbody>' +
  '</table>' +
  (d.instructions
    ? '<div class="section-title">Special Instructions</div><div class="notes">' + esc(d.instructions).replace(/\n/g,'<br>') + '</div>'
    : '') +
  '<div class="terms">' +
    '<strong>TERMS &amp; CONDITIONS:</strong> Received subject to the classifications and tariffs in effect on the date of issue. ' +
    'The property described above, in apparent good order (contents and condition of contents of packages unknown), is marked, consigned, and destined as indicated. ' +
    'HANDS Logistics LLC agrees to carry to its usual place of delivery at said destination. ' +
    'Any deficiency in count, damaged or missing items must be noted upon receipt. ' +
    'Signature below acknowledges receipt of the goods described and acceptance of these terms. ' +
    'Limitation of liability applies per carrier tariff.' +
  '</div>' +
  '<div class="sig-grid">' +
    '<div class="sig-box">' +
      '<div class="sig-head">Shipper Signature</div>' +
      '<div class="sig-line"></div>' +
      '<div class="sig-lbl">Signature &amp; Date</div>' +
      '<div class="sig-line" style="margin-top:18px;"></div>' +
      '<div class="sig-lbl">Print Name</div>' +
    '</div>' +
    '<div class="sig-box">' +
      '<div class="sig-head">Consignee / Driver Signature</div>' +
      '<div class="sig-line"></div>' +
      '<div class="sig-lbl">Signature &amp; Date</div>' +
      '<div class="sig-line" style="margin-top:18px;"></div>' +
      '<div class="sig-lbl">Print Name</div>' +
    '</div>' +
  '</div>' +
  '<div class="footer">' +
    '<div>HANDS Logistics &bull; 8540 Dean Martin Dr, Ste 160, Las Vegas NV 89139</div>' +
    '<div>BOL #' + esc(po) + ' &bull; Generated ' + new Date().toLocaleString() + '</div>' +
  '</div>' +
'</div>' +
'</body></html>';
  }

  // ── CONDENSED 4 × 6 BOL ──────────────────────────────────────
  function buildCondensedBol(d, po) {
    d = d || {}; po = po || '—';
    const dir = d.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND';
    const toLabel = d.direction === 'outbound' ? 'SHIP TO' : 'RECEIVED AT';

    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BOL ' + esc(po) + '</title>' +
'<style>' +
'@page { size: 4in 6in; margin: 0.12in; }' +
'* { box-sizing: border-box; margin: 0; padding: 0; }' +
'body { font-family: "Helvetica Neue", Arial, sans-serif; color: #000; background: #fff; font-size: 8.5px; line-height: 1.3; }' +
'.label { width: 3.76in; padding: 0; }' +
'.hdr { border-bottom: 2px solid #000; padding-bottom: 3px; margin-bottom: 4px; text-align: center; }' +
'.brand { font-family: "Bebas Neue", Impact, sans-serif; font-size: 15px; font-weight: 700; letter-spacing: 2px; }' +
'.sub { font-size: 7px; letter-spacing: 1px; margin-top: 1px; }' +
'.dir { background: #000; color: #fff; text-align: center; padding: 3px; font-weight: 700; font-size: 11px; letter-spacing: 3px; margin: 3px 0; }' +
'.po { text-align: center; font-family: "Courier New", monospace; font-size: 16px; font-weight: 700; letter-spacing: 1px; border: 2px solid #000; padding: 4px; margin-bottom: 4px; }' +
'.sect { margin-bottom: 4px; }' +
'.sect-h { font-size: 7px; font-weight: 700; letter-spacing: 1.5px; background: #000; color: #fff; padding: 1px 4px; }' +
'.sect-b { border: 1px solid #000; border-top: 0; padding: 3px 5px; font-size: 8.5px; line-height: 1.35; }' +
'.sect-b .name { font-weight: 700; font-size: 9.5px; }' +
'.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 4px; }' +
'.cell { border: 1px solid #000; padding: 2px 4px; }' +
'.cell .l { font-size: 6.5px; color: #444; letter-spacing: 1px; text-transform: uppercase; }' +
'.cell .v { font-size: 9.5px; font-weight: 700; }' +
'.qty-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 3px; margin-bottom: 4px; }' +
'.qty { border: 1.5px solid #000; padding: 2px 4px; text-align: center; }' +
'.qty .l { font-size: 6.5px; letter-spacing: 1px; text-transform: uppercase; }' +
'.qty .v { font-size: 12px; font-weight: 700; font-family: "Courier New", monospace; }' +
'.contents { border: 1px solid #000; padding: 3px 5px; font-size: 8px; min-height: 26px; margin-bottom: 4px; }' +
'.contents .l { font-size: 6.5px; letter-spacing: 1px; text-transform: uppercase; font-weight: 700; margin-bottom: 1px; }' +
'.sig-row { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-top: 3px; }' +
'.sig-cell { border: 1px solid #000; padding: 3px; min-height: 34px; }' +
'.sig-cell .l { font-size: 6.5px; letter-spacing: 1px; text-transform: uppercase; font-weight: 700; }' +
'.sig-cell .line { border-bottom: 1px solid #000; margin-top: 18px; }' +
'.ftr { text-align: center; font-size: 6px; color: #333; margin-top: 3px; }' +
'.actions { padding: 8px; text-align: center; font-family: Arial, sans-serif; }' +
'.pb { padding: 6px 14px; font-size: 10px; font-weight: 700; cursor: pointer; border: none; margin: 0 3px; }' +
'.pb-print { background: #000; color: #fff; }' +
'.pb-close { background: #ddd; }' +
'@media print { .actions { display: none; } }' +
'</style></head><body>' +
'<div class="actions">' +
  '<button class="pb pb-print" onclick="window.print()">\uD83D\uDDA8 Print</button>' +
  '<button class="pb pb-close" onclick="window.close()">Close</button>' +
'</div>' +
'<div class="label">' +
  '<div class="hdr">' +
    '<div class="brand">HANDS LOGISTICS</div>' +
    '<div class="sub">BILL OF LADING</div>' +
  '</div>' +
  '<div class="dir">' + dir + '</div>' +
  '<div class="po">' + esc(po) + '</div>' +
  '<div class="grid">' +
    '<div class="cell"><div class="l">Date</div><div class="v">' + esc(fmtDate(d.date)) + '</div></div>' +
    '<div class="cell"><div class="l">Account</div><div class="v">' + esc(d.account || '—') + '</div></div>' +
  '</div>' +
  '<div class="sect">' +
    '<div class="sect-h">CLIENT</div>' +
    '<div class="sect-b">' +
      '<div class="name">' + esc(d.client || '—') + '</div>' +
      (d.email ? '<div>' + esc(d.email) + '</div>' : '') +
      (d.phone ? '<div>' + esc(d.phone) + '</div>' : '') +
    '</div>' +
  '</div>' +
  '<div class="sect">' +
    '<div class="sect-h">' + toLabel + '</div>' +
    '<div class="sect-b">' + esc((d.address || '—').replace(/\n/g,'<br>')) + '</div>' +
  '</div>' +
  '<div class="grid">' +
    '<div class="cell"><div class="l">Carrier</div><div class="v">' + esc(d.carrier || '—') + '</div></div>' +
    '<div class="cell"><div class="l">Tracking</div><div class="v" style="font-size:8.5px;">' + esc(d.tracking || '—') + '</div></div>' +
  '</div>' +
  '<div class="qty-row">' +
    '<div class="qty"><div class="l">Cartons</div><div class="v">' + esc(d.cartons || '0') + '</div></div>' +
    '<div class="qty"><div class="l">Pallets</div><div class="v">' + esc(d.pallets || '0') + '</div></div>' +
    '<div class="qty"><div class="l">Lbs</div><div class="v">' + esc(d.weight || '0') + '</div></div>' +
  '</div>' +
  '<div class="contents">' +
    '<div class="l">Contents</div>' +
    esc(d.contents || '—').replace(/\n/g,'<br>') +
  '</div>' +
  '<div class="sig-row">' +
    '<div class="sig-cell"><div class="l">Shipper Sign</div><div class="line"></div></div>' +
    '<div class="sig-cell"><div class="l">Receiver Sign</div><div class="line"></div></div>' +
  '</div>' +
  '<div class="ftr">HANDS Logistics &bull; 702.602.7110</div>' +
'</div>' +
'</body></html>';
  }

  // Opens preview in new tab
  function openPreview(type, data, po) {
    const html = type === 'condensed' ? buildCondensedBol(data, po) : buildFullBol(data, po);
    const w = window.open('', '_blank');
    if (!w) {
      alert('Popup blocked — allow popups for this site to open the BOL.');
      return null;
    }
    w.document.write(html);
    w.document.close();
    return w;
  }

  window.HANDS_BOL = {
    buildFullBol: buildFullBol,
    buildCondensedBol: buildCondensedBol,
    openPreview: openPreview
  };
})();
