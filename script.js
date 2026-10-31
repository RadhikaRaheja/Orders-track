// Cute Printed Nightwears by Radhika - Official Tracking Script v2.0
const SHEET_ID = '1UMul8nt25GR8MUM-_EdwAR0q6Ne2ovPv_R-m1-CHeXw';

const SALES_SHEET_NAME = 'Daily Sales record';
const COURIER_SHEET_NAME = 'CourierMapping';
const CACHE_KEY = 'cpn_tracking_cache_v3';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for instant reloads (<0.5s)

let data = [];
let filteredData = [];
let couriers = {};
let courierSlugMap = {};
let currentPage = 1;
const entriesPerPage = 10;
let debounceTimer = null;

// ========== SMART INDIAN DATE PARSER (Handles DD/MM/YY, DD/MM/YYYY, 1-Dec-2023) ==========
function parseSheetDate(rawDate) {
  if (!rawDate) return null;
  const str = String(rawDate).trim();

  // 1. Handle Google gviz Date(YYYY, M, D) format if returned
  const gvizMatch = str.match(/^Date\((\d+),(\d+),(\d+)\)$/);
  if (gvizMatch) {
    return new Date(Number(gvizMatch[1]), Number(gvizMatch[2]), Number(gvizMatch[3]));
  }

  // 2. Handle DD/MM/YY or DD/MM/YYYY or DD.MM.YYYY
  const dmySlash = str.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (dmySlash) {
    const day = parseInt(dmySlash[1], 10);
    const month = parseInt(dmySlash[2], 10) - 1;
    let year = parseInt(dmySlash[3], 10);
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // 3. Handle standard date strings like "1-Dec-2023" or "2026-10-28"
  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(inputDate) {
  const date = inputDate instanceof Date ? inputDate : parseSheetDate(inputDate);
  if (!date) return String(inputDate || '');
  const options = { day: '2-digit', month: 'short', year: 'numeric' };
  return date.toLocaleDateString('en-GB', options).replace(/ /g, '-');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ========== DIRECT GOOGLE GVIZ FETCHER (Only Fetches Public Columns A,B,D,I,J,K,L) ==========
function fetchGoogleSheetGviz(sheetName, selectQuery) {
  return new Promise((resolve, reject) => {
    const callbackName = 'cpnGvizCb_' + Math.random().toString(36).substring(2, 10);
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Google Sheet request timed out'));
    }, 8000);

    function cleanup() {
      clearTimeout(timeout);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = function (response) {
      cleanup();
      if (!response || response.status === 'error' || !response.table) {
        reject(new Error('Invalid gviz response'));
        return;
      }
      resolve(response.table);
    };

    const tq = encodeURIComponent(selectQuery);
    script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&headers=1&tq=${tq}&tqx=responseHandler:${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error('Script load error'));
    };
    document.head.appendChild(script);
  });
}

function getCellValue(row, colIndex) {
  if (!row || !row.c || !row.c[colIndex]) return '';
  const cell = row.c[colIndex];
  if (cell.f !== undefined && cell.f !== null) return String(cell.f).trim();
  if (cell.v !== undefined && cell.v !== null) return String(cell.v).trim();
  return '';
}

// ========== FAST PARALLEL DATA LOADING + BOTTOM-UP 90-DAY FILTER ==========
async function initApp(forceRefresh = false) {
  const loadingEl = document.getElementById('loadingState');
  const tableContainer = document.getElementById('tableContainer');

  if (!forceRefresh) {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
          applyLoadedData(parsed.sales, parsed.courierMap);
          return;
        }
      } catch (e) {
        sessionStorage.removeItem(CACHE_KEY);
      }
    }
  }

  if (loadingEl) loadingEl.style.display = 'block';
  if (tableContainer) tableContainer.style.display = 'none';

  try {
    // Fetch ONLY public columns from Daily Sales record:
    // A: Date, B: Customer Name, D: Location (Pincode), I: Courier Name, J: Tracking ID, K: Category, L: Tracking Link
    const [salesTable, courierTable] = await Promise.all([
      fetchGoogleSheetGviz(SALES_SHEET_NAME, 'SELECT A, B, D, I, J, K, L WHERE B IS NOT NULL'),
      fetchGoogleSheetGviz(COURIER_SHEET_NAME, 'SELECT A, B, C WHERE A IS NOT NULL')
    ]);

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    threeMonthsAgo.setHours(0, 0, 0, 0);

    const rows = salesTable.rows || [];
    const recentSales = [];
    let consecutiveOldRows = 0;

    // Scan from the BOTTOM of the sheet upward (Newest orders first)
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const rawDate = getCellValue(r, 0);
      const customerName = getCellValue(r, 1);

      if (!customerName || customerName.toLowerCase() === 'customer name') continue;

      const parsedDate = parseSheetDate(rawDate);
      if (!parsedDate) continue;

      if (parsedDate >= threeMonthsAgo) {
        consecutiveOldRows = 0;
        recentSales.push({
          Date: formatDate(parsedDate),
          _timestamp: parsedDate.getTime(),
          'Customer Name': customerName,
          'Location (Pincode)': getCellValue(r, 2),
          'Courier Name': getCellValue(r, 3),
          'Tracking ID': getCellValue(r, 4),
          'Category': getCellValue(r, 5),
          'Tracking Link': getCellValue(r, 6)
        });
      } else {
        consecutiveOldRows++;
        if (consecutiveOldRows > 80 && recentSales.length > 0) {
          break;
        }
      }
    }

    recentSales.sort((a, b) => b._timestamp - a._timestamp);

    const courierList = (courierTable.rows || []).map(r => ({
      'Courier Name': getCellValue(r, 0),
      'Courier Website Link': getCellValue(r, 1),
      'AfterShip Slug': getCellValue(r, 2)
    })).filter(c => c['Courier Name'] && c['Courier Name'].toLowerCase() !== 'courier name');

    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        sales: recentSales,
        courierMap: courierList
      }));
    } catch (e) {}

    applyLoadedData(recentSales, courierList);
    if (forceRefresh) showToast('✅ Latest dispatch data loaded!');
  } catch (err) {
    console.warn('Direct gviz fetch failed, falling back to opensheet:', err);
    await fallbackOpenSheetLoad();
  }
}

async function fallbackOpenSheetLoad() {
  try {
    const [salesResp, courierResp] = await Promise.all([
      fetch(`https://opensheet.elk.sh/${SHEET_ID}/${encodeURIComponent(SALES_SHEET_NAME)}`),
      fetch(`https://opensheet.elk.sh/${SHEET_ID}/${encodeURIComponent(COURIER_SHEET_NAME)}`)
    ]);
    const [salesJson, courierJson] = await Promise.all([salesResp.json(), courierResp.json()]);

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const recentSales = [];
    for (let i = salesJson.length - 1; i >= 0; i--) {
      const row = salesJson[i];
      const parsedDate = parseSheetDate(row.Date);
      if (parsedDate && parsedDate >= threeMonthsAgo) {
        recentSales.push({
          Date: formatDate(parsedDate),
          _timestamp: parsedDate.getTime(),
          'Customer Name': row['Customer Name'] || '',
          'Location (Pincode)': row['Location (Pincode)'] || '',
          'Courier Name': row['Courier Name'] || '',
          'Tracking ID': row['Tracking ID'] || '',
          'Category': row['Category'] || '',
          'Tracking Link': row['Tracking Link'] || ''
        });
      }
    }
    recentSales.sort((a, b) => b._timestamp - a._timestamp);
    applyLoadedData(recentSales, courierJson);
  } catch (fallbackErr) {
    document.getElementById('resultsCount').textContent = '⚠️ Unable to load data. Please tap Refresh.';
    document.getElementById('loadingState').style.display = 'none';
  }
}

function refreshData(force) {
  initApp(force);
}

function applyLoadedData(salesRows, courierRows) {
  couriers = {};
  courierSlugMap = {};
  const dropdown = document.getElementById('courierDropdown');
  if (dropdown) dropdown.innerHTML = '<option value="">All Couriers</option>';

  courierRows.forEach(entry => {
    const cName = (entry['Courier Name'] || '').trim();
    if (!cName) return;
    couriers[cName] = entry['Courier Website Link'] || '#';
    courierSlugMap[cName.toLowerCase()] = (entry['AfterShip Slug'] || '').toLowerCase().trim();

    if (dropdown) {
      const option = document.createElement('option');
      option.value = cName;
      option.textContent = cName;
      dropdown.appendChild(option);
    }
  });

  data = salesRows;
  filteredData = data;
  const loadingEl = document.getElementById('loadingState');
  if (loadingEl) loadingEl.style.display = 'none';
  renderResults();
}

// ========== SEARCH & FILTER HANDLERS ==========
function handleSearchFieldChange() {
  const field = document.getElementById('searchField').value;
  document.getElementById('textInputWrapper').style.display =
    (field === 'Date' || field === 'Courier Name') ? 'none' : 'flex';
  document.getElementById('dateInput').style.display = field === 'Date' ? 'block' : 'none';
  document.getElementById('courierDropdown').style.display = field === 'Courier Name' ? 'block' : 'none';
  filterResults();
}

function debouncedFilter() {
  const val = document.getElementById('searchInput').value;
  document.getElementById('clearInputBtn').style.display = val.length > 0 ? 'block' : 'none';
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(filterResults, 200);
}

function resetSearch() {
  document.getElementById('searchField').value = 'ALL';
  document.getElementById('searchInput').value = '';
  document.getElementById('dateInput').value = '';
  document.getElementById('courierDropdown').value = '';
  document.getElementById('clearInputBtn').style.display = 'none';
  handleSearchFieldChange();
}

function filterResults() {
  const field = document.getElementById('searchField').value;
  let query = '';

  if (field === 'Date') {
    const rawDateInput = document.getElementById('dateInput').value;
    query = rawDateInput ? formatDate(rawDateInput).toLowerCase() : '';
  } else if (field === 'Courier Name') {
    query = document.getElementById('courierDropdown').value.toLowerCase().trim();
  } else {
    query = document.getElementById('searchInput').value.toLowerCase().trim();
  }

  if (!query) {
    filteredData = data;
  } else {
    filteredData = data.filter(row => {
      if (field === 'ALL') {
        return (
          (row['Customer Name'] || '').toLowerCase().includes(query) ||
          (row['Location (Pincode)'] || '').toLowerCase().includes(query) ||
          (row['Tracking ID'] || '').toLowerCase().includes(query) ||
          (row['Courier Name'] || '').toLowerCase().includes(query)
        );
      }
      return String(row[field] || '').toLowerCase().includes(query);
    });
  }

  currentPage = 1;
  renderResults();
}

// ========== RENDER TABLE & MOBILE CARDS ==========
function paginate(items, page) {
  const start = (page - 1) * entriesPerPage;
  return items.slice(start, start + entriesPerPage);
}

function renderResults() {
  const tableBody = document.getElementById('resultsTable');
  const tableContainer = document.getElementById('tableContainer');
  const emptyState = document.getElementById('emptyState');
  const paginationControls = document.getElementById('paginationControls');

  if (!tableBody) return;

  tableBody.innerHTML = '';
  document.getElementById('resultsCount').textContent = `🔍 Showing ${filteredData.length} recent orders`;

  if (filteredData.length === 0) {
    tableContainer.style.display = 'none';
    paginationControls.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  tableContainer.style.display = 'block';
  paginationControls.style.display = 'flex';

  const pageItems = paginate(filteredData, currentPage);

  pageItems.forEach((row) => {
    const tr = document.createElement('tr');
    const courierNameOrig = (row['Courier Name'] || '').trim();
    const courierKey = courierNameOrig.toLowerCase();
    const trackingId = (row['Tracking ID'] || '').trim();
    const directTrackingLink = (row['Tracking Link'] || '').trim();
    const slug = courierSlugMap[courierKey] || '';

    let courierHtml = `<span style="color:#9ca3af;">N/A</span>`;
    if (courierNameOrig) {
      const link = couriers[courierNameOrig] || '#';
      courierHtml = `<a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="courier-badge" onclick="event.stopPropagation()">
        <i class="fa-solid fa-truck-fast"></i> ${escapeHtml(courierNameOrig)}
      </a>`;
    } else if (trackingId.toLowerCase().includes('cancelled')) {
      courierHtml = `<span class="status-badge status-cancelled">❌ Cancelled</span>`;
    } else if (trackingId.toLowerCase().includes('delivered')) {
      courierHtml = `<span class="status-badge status-delivered">✅ Delivered</span>`;
    }

    let trackingHtml = `<span style="color:#9ca3af;">—</span>`;
    if (trackingId) {
      trackingHtml = `<span class="awb-pill">
        ${escapeHtml(trackingId.toUpperCase())}
        <button class="mini-copy-btn" title="Copy Tracking ID" onclick="event.stopPropagation(); copyText('${escapeHtml(trackingId.toUpperCase())}')">
          <i class="fa-regular fa-copy"></i>
        </button>
      </span>`;
    }

    let statusActionHtml = `<button class="track-action-btn" onclick="event.stopPropagation(); showPopupByIndex(${filteredData.indexOf(row)})">Details</button>`;
    if (slug && trackingId.length > 4) {
      statusActionHtml = `<button class="track-action-btn" onclick="event.stopPropagation(); openAfterShipMiniTab('${escapeHtml(slug)}', '${escapeHtml(trackingId)}')">
        <i class="fa-solid fa-location-crosshairs"></i> Track Live
      </button>`;
    } else if (directTrackingLink.startsWith('http')) {
      statusActionHtml = `<a href="${escapeHtml(directTrackingLink)}" target="_blank" rel="noopener" class="track-action-btn" onclick="event.stopPropagation()">
        <i class="fa-solid fa-arrow-up-right-from-square"></i> Track Link
      </a>`;
    }

    tr.innerHTML = `
      <td data-label="Dispatch Date">${escapeHtml(row.Date)}</td>
      <td data-label="Customer"><strong>${escapeHtml(row['Customer Name'] || '')}</strong></td>
      <td data-label="Pincode">${escapeHtml(row['Location (Pincode)'] || '—')}</td>
      <td data-label="Courier">${courierHtml}</td>
      <td data-label="Tracking ID">${trackingHtml}</td>
      <td data-label="Category">${escapeHtml(row['Category'] || '—')}</td>
      <td data-label="Action">${statusActionHtml}</td>
    `;

    tr.onclick = () => showPopup(row, trackingId, slug);
    tableBody.appendChild(tr);
  });

  renderPaginationControls();
}

function showPopupByIndex(idx) {
  const row = filteredData[idx];
  if (!row) return;
  const trackingId = (row['Tracking ID'] || '').trim();
  const courierKey = (row['Courier Name'] || '').toLowerCase().trim();
  showPopup(row, trackingId, courierSlugMap[courierKey] || '');
}

// ========== MODAL POPUP & WHATSAPP RECEIPT SHARE ==========
function showPopup(row, trackingId, slug) {
  const formattedDate = row.Date;
  const customerName = row['Customer Name'] || 'Valued Customer';
  const pincode = row['Location (Pincode)'] || 'N/A';
  const courierName = row['Courier Name'] || 'Standard Dispatch';
  const courierUrl = (row['Tracking Link'] || '').startsWith('http')
    ? row['Tracking Link']
    : (couriers[courierName] || '');
  const category = row['Category'] || 'Nightwear';
  const cleanTid = (trackingId || 'N/A').toUpperCase();

  let trackBtnHtml = '';
  if (slug && trackingId.length > 4) {
    trackBtnHtml = `<button class="btn-primary-track" onclick="openAfterShipMiniTab('${escapeHtml(slug)}', '${escapeHtml(trackingId)}')">
      <i class="fa-solid fa-location-dot"></i> Live Status
    </button>`;
  } else if (courierUrl && courierUrl !== '#') {
    trackBtnHtml = `<a href="${escapeHtml(courierUrl)}" target="_blank" rel="noopener" class="btn-primary-track">
      <i class="fa-solid fa-arrow-up-right-from-square"></i> Courier Site
    </a>`;
  }

  const content = `
    <h3 class="modal-title">📦 Order Dispatch Summary</h3>

    <div class="timeline-steps">
      <div class="step">
        <div class="step-dot"><i class="fa-solid fa-check"></i></div>
        Confirmed
      </div>
      <div class="step">
        <div class="step-dot"><i class="fa-solid fa-box"></i></div>
        Packed
      </div>
      <div class="step">
        <div class="step-dot"><i class="fa-solid fa-truck"></i></div>
        Dispatched
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-item">
        <span>Customer Name</span>
        <strong>${escapeHtml(customerName)}</strong>
      </div>
      <div class="detail-item">
        <span>Dispatch Date</span>
        <strong>${escapeHtml(formattedDate)}</strong>
      </div>
      <div class="detail-item">
        <span>Destination Pincode</span>
        <strong>📍 ${escapeHtml(pincode)}</strong>
      </div>
      <div class="detail-item">
        <span>Category</span>
        <strong>${escapeHtml(category)}</strong>
      </div>
      <div class="detail-item">
        <span>Courier Partner</span>
        <strong>${escapeHtml(courierName)}</strong>
      </div>
      <div class="detail-item">
        <span>Tracking Number</span>
        <strong>
          <span id="copyTarget">${escapeHtml(cleanTid)}</span>
          <button class="mini-copy-btn" onclick="copyText('${escapeHtml(cleanTid)}')" title="Copy AWB">
            <i class="fa-regular fa-copy"></i>
          </button>
        </strong>
      </div>
    </div>

    <div class="modal-actions">
      ${trackBtnHtml}
      <button class="btn-whatsapp-share" onclick="shareReceiptMessage({
        date: '${escapeHtml(formattedDate)}',
        name: '${escapeHtml(customerName)}',
        pincode: '${escapeHtml(pincode)}',
        courier: '${escapeHtml(courierName)}',
        trackingId: '${escapeHtml(cleanTid)}',
        category: '${escapeHtml(category)}'
      })">
        <i class="fa-brands fa-whatsapp"></i> Share Receipt
      </button>
    </div>
  `;

  document.getElementById('popupContent').innerHTML = content;
  document.getElementById('popupOverlay').style.display = 'flex';
}

function shareReceiptMessage(details) {
  const text = `✨ *Cute Printed Nightwears by Radhika* ✨\n📦 *Order Dispatch Receipt*\n\n👤 *Name:* ${details.name}\n📅 *Date:* ${details.date}\n📍 *Pincode:* ${details.pincode}\n🚚 *Courier:* ${details.courier}\n🔢 *Tracking ID:* ${details.trackingId}\n🛍️ *Category:* ${details.category}\n\n🔗 *Track Here:* ${window.location.href}`;

  if (navigator.share) {
    navigator.share({ title: 'Order Dispatch Receipt - CPN', text }).catch(() => {});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text)
    .then(() => showToast('📋 Tracking ID copied!'))
    .catch(() => showToast('❌ Failed to copy'));
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerText = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function hidePopup() {
  document.getElementById('popupOverlay').style.display = 'none';
}

function handleOverlayClick(e) {
  if (e.target.id === 'popupOverlay') hidePopup();
}

function openAfterShipMiniTab(slug, trackingId) {
  if (!slug || !trackingId) {
    showToast('⚠️ No courier or tracking ID mapped.');
    return;
  }
  const url = `https://www.aftership.com/track/${slug}/${trackingId}`;
  window.open(url, 'AfterShipStatus', 'width=640,height=680,resizable=yes,scrollbars=yes');
}

// ========== PAGINATION ==========
function renderPaginationControls() {
  const totalPages = Math.max(1, Math.ceil(filteredData.length / entriesPerPage));
  document.getElementById('totalPages').textContent = totalPages;
  document.getElementById('pageNumber').value = currentPage;
  document.getElementById('prevBtn').disabled = currentPage <= 1;
  document.getElementById('nextBtn').disabled = currentPage >= totalPages;
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    renderResults();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function nextPage() {
  const totalPages = Math.ceil(filteredData.length / entriesPerPage);
  if (currentPage < totalPages) {
    currentPage++;
    renderResults();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function jumpToPage() {
  const input = parseInt(document.getElementById('pageNumber').value, 10);
  const totalPages = Math.ceil(filteredData.length / entriesPerPage);
  if (input >= 1 && input <= totalPages) {
    currentPage = input;
    renderResults();
  }
}

// Initialize on page load
initApp();
