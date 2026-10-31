const SHEET_ID = '1UMul8nt25GR8MUM-_EdwAR0q6Ne2ovPv_R-m1-CHeXw';
const SALES_URL = `https://opensheet.elk.sh/${SHEET_ID}/Daily%20Sales%20record`;
const COURIER_URL = `https://opensheet.elk.sh/${SHEET_ID}/CourierMapping`;
const CACHE_KEY = 'cpn_tracking_cache_v2';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for instant reloads

let data = [];
let filteredData = [];
let couriers = {};
let courierSlugMap = {};
let currentPage = 1;
const entriesPerPage = 10;
let debounceTimer = null;

// ========== DATE & TEXT HELPERS ==========
function formatDate(inputDate) {
  if (!inputDate) return '';
  const date = new Date(inputDate);
  if (isNaN(date)) return inputDate;
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

// ========== SEARCH BAR HANDLERS ==========
function handleSearchFieldChange() {
  const field = document.getElementById('searchField').value;
  const textWrapper = document.getElementById('textInputWrapper');
  const dateInput = document.getElementById('dateInput');
  const courierDropdown = document.getElementById('courierDropdown');

  textWrapper.style.display = (field === 'Date' || field === 'Courier Name') ? 'none' : 'flex';
  dateInput.style.display = field === 'Date' ? 'block' : 'none';
  courierDropdown.style.display = field === 'Courier Name' ? 'block' : 'none';

  filterResults();
}

function debouncedFilter() {
  const val = document.getElementById('searchInput').value;
  document.getElementById('clearInputBtn').style.display = val.length > 0 ? 'block' : 'none';
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    filterResults();
  }, 220);
}

function resetSearch() {
  document.getElementById('searchField').value = 'ALL';
  document.getElementById('searchInput').value = '';
  document.getElementById('dateInput').value = '';
  document.getElementById('courierDropdown').value = '';
  document.getElementById('clearInputBtn').style.display = 'none';
  handleSearchFieldChange();
}

// ========== FAST PARALLEL DATA FETCHING + CACHING ==========
async function initApp(forceRefresh = false) {
  const loadingEl = document.getElementById('loadingState');
  const tableContainer = document.getElementById('tableContainer');

  // 1. Check sessionStorage cache first for instant load
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

  loadingEl.style.display = 'block';
  tableContainer.style.display = 'none';

  try {
    // 2. Fetch both tabs in parallel so Courier Slugs are always ready before rendering
    const [salesResp, courierResp] = await Promise.all([
      fetch(SALES_URL),
      fetch(COURIER_URL)
    ]);

    const [salesJson, courierJson] = await Promise.all([
      salesResp.json(),
      courierResp.json()
    ]);

    // Filter to last 3 months and sort newest first
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const recentSales = salesJson
      .filter(row => {
        const d = new Date(row.Date);
        return !isNaN(d) && d >= threeMonthsAgo;
      })
      .sort((a, b) => new Date(b.Date) - new Date(a.Date));

    // Save to sessionStorage
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        sales: recentSales,
        courierMap: courierJson
      }));
    } catch (e) {
      // Ignore storage quota errors
    }

    applyLoadedData(recentSales, courierJson);
    if (forceRefresh) showToast('✅ Latest dispatch data loaded!');
  } catch (err) {
    console.error('Error loading tracking data:', err);
    document.getElementById('resultsCount').textContent = '⚠️ Unable to load data. Please tap Refresh.';
    loadingEl.style.display = 'none';
  }
}

function refreshData(force) {
  initApp(force);
}

function applyLoadedData(salesRows, courierRows) {
  // Populate courier maps & dropdown
  couriers = {};
  courierSlugMap = {};
  const dropdown = document.getElementById('courierDropdown');
  dropdown.innerHTML = '<option value="">All Couriers</option>';

  courierRows.forEach(entry => {
    const cName = (entry['Courier Name'] || '').trim();
    if (!cName) return;
    couriers[cName] = entry['Courier Website Link'] || '#';
    courierSlugMap[cName.toLowerCase()] = (entry['AfterShip Slug'] || '').toLowerCase().trim();

    const option = document.createElement('option');
    option.value = cName;
    option.textContent = cName;
    dropdown.appendChild(option);
  });

  data = salesRows;
  filteredData = data;
  document.getElementById('loadingState').style.display = 'none';
  renderResults();
}

// ========== FILTERING ==========
function filterResults() {
  const field = document.getElementById('searchField').value;
  let query = '';

  if (field === 'Date') {
    query = formatDate(document.getElementById('dateInput').value).toLowerCase();
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
        const name = (row['Customer Name'] || '').toLowerCase();
        const pin = (row['Location (Pincode)'] || '').toLowerCase();
        const tid = (row['Tracking ID'] || '').toLowerCase();
        const cour = (row['Courier Name'] || '').toLowerCase();
        return name.includes(query) || pin.includes(query) || tid.includes(query) || cour.includes(query);
      }
      if (field === 'Date') {
        return formatDate(row.Date).toLowerCase().includes(query);
      }
      const val = String(row[field] || '').toLowerCase();
      return val.includes(query);
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
    const slug = courierSlugMap[courierKey] || '';

    // Courier display
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

    // Tracking ID pill with quick copy
    let trackingHtml = `<span style="color:#9ca3af;">—</span>`;
    if (trackingId) {
      trackingHtml = `<span class="awb-pill">
        ${escapeHtml(trackingId.toUpperCase())}
        <button class="mini-copy-btn" title="Copy Tracking ID" onclick="event.stopPropagation(); copyText('${escapeHtml(trackingId.toUpperCase())}')">
          <i class="fa-regular fa-copy"></i>
        </button>
      </span>`;
    }

    // Live Track Button
    let statusActionHtml = `<button class="track-action-btn" onclick="event.stopPropagation(); showPopupByIndex(${filteredData.indexOf(row)})">Details</button>`;
    if (slug && trackingId.length > 4) {
      statusActionHtml = `<button class="track-action-btn" onclick="event.stopPropagation(); openAfterShipMiniTab('${escapeHtml(slug)}', '${escapeHtml(trackingId)}')">
        <i class="fa-solid fa-location-crosshairs"></i> Track Live
      </button>`;
    }

    tr.innerHTML = `
      <td data-label="Dispatch Date">${escapeHtml(formatDate(row.Date))}</td>
      <td data-label="Customer"><strong>${escapeHtml(row['Customer Name'] || '')}</strong></td>
      <td data-label="Pincode">${escapeHtml(row['Location (Pincode)'] || '')}</td>
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

// ========== MODAL POPUP & WHATSAPP SHARE ==========
function showPopup(row, trackingId, slug) {
  const formattedDate = formatDate(row.Date);
  const customerName = row['Customer Name'] || 'Valued Customer';
  const pincode = row['Location (Pincode)'] || 'N/A';
  const courierName = row['Courier Name'] || 'Standard Dispatch';
  const courierUrl = couriers[courierName] || '';
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
    navigator.share({
      title: 'Order Dispatch Receipt - CPN',
      text: text
    }).catch(() => {});
  } else {
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank');
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text)
    .then(() => showToast('📋 Tracking ID copied!'))
    .catch(() => showToast('❌ Failed to copy'));
}

function showToast(message) {
  const toast = document.getElementById('toast');
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

// Initialize
initApp();
