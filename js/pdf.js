// Monthly report as a PDF, built in the browser from data the user can already see.
// jsPDF and its table plugin are bundled in vendor/ and only loaded when a report is exported.
import { S } from './app.js';
import { fmtDate, fmtNum, fmtMonthLong } from './ui.js';

const NAVY = [13, 47, 87]; const GOLD = [232, 185, 49]; const INK = [30, 30, 30]; const MUTED = [110, 110, 105]; const LINE = [215, 215, 208];

const loaded = {};
const loadScript = (src) => (loaded[src] ||= new Promise((resolve, reject) => {
  const s = document.createElement('script'); s.src = src; s.onload = resolve;
  s.onerror = () => { delete loaded[src]; reject(new Error('Could not load the PDF tools. Connect to the network once and try again.')); };
  document.head.append(s);
}));
async function jsPDF() {
  await loadScript('./vendor/jspdf-2.5.2.umd.min.js');
  await loadScript('./vendor/jspdf.plugin.autotable-3.8.4.min.js');
  return window.jspdf.jsPDF;
}
async function crest() {
  try {
    const blob = await (await fetch('./icons/customs-logo.png')).blob();
    return await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
  } catch { return null; }
}
const nowBelize = () => new Date().toLocaleString('en-GB', { timeZone: 'America/Belize', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-').replace(',', '');

export async function monthReport(d, calls) {
  const [PDF, logo] = await Promise.all([jsPDF(), crest()]);
  const doc = new PDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight(); const M = 36;
  const scope = d.station ? (S.lookups.stations.find((s) => s.code === d.station) || {}).name || d.station : 'All stations';
  const t = d.totals; const a = d.attention;

  // Letterhead
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, 78, 'F'); doc.setFillColor(...GOLD); doc.rect(0, 78, W, 3, 'F');
  if (logo) doc.addImage(logo, 'PNG', M, 10, 58, 58);
  const x0 = logo ? M + 70 : M;
  doc.setTextColor(...GOLD); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text('BELIZE CUSTOMS & EXCISE DEPARTMENT', x0, 28, { charSpace: 0.8 });
  doc.setTextColor(255, 255, 255); doc.setFontSize(19); doc.text('Monthly Vessel Movements Report', x0, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(210, 222, 238);
  doc.text(`${fmtMonthLong(d.month)} · ${scope} · by arrival date`, x0, 66);
  doc.setFontSize(8.5); doc.text([`National Ships Ledger`, `Generated ${nowBelize()}`, `by ${S.me.user.initials}`], W - M, 30, { align: 'right', lineHeightFactor: 1.4 });

  // Summary figures
  let y = 104;
  const tiles = [['Vessel calls', t.calls], ['Departed', t.departed], ['Still in port', t.in_port], ['Extensions granted', t.extensions],
    ['Crew', t.crew], ['Passengers', t.passengers], ['Gross tonnage', t.gross_tonnage]];
  const gap = 8; const tw = (W - 2 * M - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach(([label, n], i) => {
    const x = M + i * (tw + gap);
    doc.setDrawColor(...LINE); doc.setFillColor(250, 250, 248); doc.roundedRect(x, y, tw, 48, 4, 4, 'FD');
    doc.setFillColor(...NAVY); doc.rect(x, y + 6, 2.5, 36, 'F');
    doc.setTextColor(...NAVY); doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text(fmtNum(n) || '0', x + 10, y + 24);
    doc.setTextColor(...MUTED); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(label, x + 10, y + 38);
  });
  y += 66;

  const heading = (text, yy) => {
    doc.setFillColor(...GOLD); doc.rect(M, yy - 9, 3, 12, 'F');
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.text(text, M + 9, yy + 1);
    return yy + 10;
  };
  const table = (opts) => doc.autoTable({
    margin: { top: 52, left: M, right: M, bottom: 44 }, theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, textColor: INK, lineColor: LINE, lineWidth: 0.5 },
    headStyles: { fillColor: NAVY, textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [247, 247, 244] },
    ...opts,
  });

  // By station, beside the attention summary
  y = heading('By customs station', y);
  const half = (W - 2 * M - 18) / 2;
  table({ startY: y, tableWidth: half * 1.25,
    head: [['Station', 'Calls', 'Departed', 'In port', 'Crew', 'Pax', 'GT', 'Ext.']],
    body: d.by_station.map((s) => [s.name, s.calls, s.departed, s.in_port, fmtNum(s.crew), fmtNum(s.passengers), fmtNum(s.gross_tonnage), s.extensions]),
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'right', fontStyle: 'bold' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } } });
  const afterStations = doc.lastAutoTable.finalY;
  const ax = M + half * 1.25 + 18;
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
  doc.setFillColor(...GOLD); doc.rect(ax, y - 19, 3, 12, 'F'); doc.text('Needs attention (all dates, as of today)', ax + 9, y - 9);
  table({ startY: y, margin: { top: 52, left: ax, right: M, bottom: 44 },
    head: [['', 'Vessels']],
    body: [['Overdue, still in port', a.overdue], ['  of which urgent (3+ extensions)', a.urgent], ['Approved stay ending soon', a.expiring_soon],
      ['Long stay, no EDD or extension', a.long_stay], ['Extensions awaiting decision', a.pending_extensions], ['Records failing data check', a.data_check],
      ['Departed, not yet verified', a.unverified_departed], ['Vessels currently in port', a.in_port]],
    columnStyles: { 1: { halign: 'right', fontStyle: 'bold', cellWidth: 60 } },
    didParseCell: (c) => { if (c.section === 'body' && c.row.index === 0 && c.column.index === 1 && a.overdue) c.cell.styles.textColor = [176, 38, 38]; } });
  y = Math.max(afterStations, doc.lastAutoTable.finalY) + 26;

  // Every vessel call that arrived in the month
  if (y > H - 120) { doc.addPage(); y = 50; }
  y = heading(`Vessel calls arriving in ${fmtMonthLong(d.month)} (${calls.length})`, y);
  table({ startY: y,
    head: [['Rotation No.', 'Vessel', 'Type', 'Flag', 'Shipping agent', 'Station', 'Arrived', 'EDD', 'Departed', 'Crew', 'Pax', 'Ext.', 'Status']],
    body: calls.length ? calls.map((c) => [c.rotation_no, c.vessel_name, c.vessel_type, c.flag || '', c.agent || '', c.station_name, fmtDate(c.arrival_date),
      fmtDate(c.estimated_departure), fmtDate(c.departure_date), c.crew ?? '', c.passengers ?? '', c.extension_count,
      c.status === 'DEPARTED' ? 'Departed' : c.overstay_status === 'OVERDUE' ? 'OVERDUE' : c.overstay_status === 'EXPIRING SOON' ? 'In port, ending soon' : 'In port'])
      : [[{ content: 'No vessel calls arrived this month.', colSpan: 13, styles: { halign: 'center', textColor: MUTED } }]],
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 3.5, textColor: INK, lineColor: LINE, lineWidth: 0.5, overflow: 'linebreak' },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 68 }, 1: { fontStyle: 'bold' }, 6: { cellWidth: 52 }, 7: { cellWidth: 52 }, 8: { cellWidth: 52 },
      9: { halign: 'right', cellWidth: 30 }, 10: { halign: 'right', cellWidth: 30 }, 11: { halign: 'right', cellWidth: 26 }, 12: { cellWidth: 62 } },
    didParseCell: (c) => { if (c.section === 'body' && c.column.index === 12 && c.cell.raw === 'OVERDUE') { c.cell.styles.textColor = [176, 38, 38]; c.cell.styles.fontStyle = 'bold'; } } });

  // Footer on every page
  const pages = doc.getNumberOfPages(); const foot = S.lookups.settings.office_footer || '';
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.line(M, H - 30, W - M, H - 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(foot, M, H - 18); doc.text(`Page ${i} of ${pages}`, W - M, H - 18, { align: 'right' });
    if (i > 1) {
      doc.setFillColor(...GOLD); doc.rect(M, 24, 3, 11, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...NAVY);
      doc.text(`Monthly Vessel Movements Report · ${fmtMonthLong(d.month)} · ${scope}`, M + 9, 33);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTED); doc.text('Belize Customs & Excise Department', W - M, 33, { align: 'right' });
    }
  }
  const file = `vessel-movements-${d.month}${d.station ? `-${d.station}` : ''}.pdf`;
  doc.save(file);
  return file;
}
