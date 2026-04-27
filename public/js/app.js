/* ─── State ──────────────────────────────────────────────────────────────────── */
const state = {
  origin: null,
  destination: null,
  allFlights: [],
  visibleCount: 8,
  activeSource: 'all',
  activeSort: 'price',
  priceChart: null,
};

/* ─── DOM refs ───────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const originInput      = $('origin-input');
const destinationInput = $('destination-input');
const originDropdown   = $('origin-dropdown');
const destDropdown     = $('destination-dropdown');
const departDate       = $('depart-date');
const returnDate       = $('return-date');
const returnField      = $('return-date-field');
const adultsSel        = $('adults');
const searchBtn        = $('search-btn');
const flightList       = $('flight-list');
const resultsSection   = $('results-section');
const historySection   = $('history-section');
const loadingOverlay   = $('loading-overlay');
const mockBanner       = $('mock-banner');
const loadMoreWrap     = $('load-more-wrap');
const loadMoreBtn      = $('load-more-btn');

/* ─── Init ───────────────────────────────────────────────────────────────────── */
(function init() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  departDate.min = today.toISOString().split('T')[0];
  departDate.value = tomorrow.toISOString().split('T')[0];
  returnDate.min = departDate.value;

  departDate.addEventListener('change', () => {
    returnDate.min = departDate.value;
    if (returnDate.value && returnDate.value < departDate.value) {
      returnDate.value = departDate.value;
    }
  });

  document.querySelectorAll('input[name="tripType"]').forEach(r => {
    r.addEventListener('change', e => {
      returnField.style.display = e.target.value === 'roundtrip' ? 'block' : 'none';
    });
  });

  $('swap-btn').addEventListener('click', swapAirports);
  searchBtn.addEventListener('click', handleSearch);
  loadMoreBtn.addEventListener('click', renderMore);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeSource = btn.dataset.source;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.visibleCount = 8;
      renderFlights();
    });
  });

  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeSort = btn.dataset.sort;
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.visibleCount = 8;
      renderFlights();
    });
  });

  setupAirportAutocomplete('origin', originInput, originDropdown);
  setupAirportAutocomplete('destination', destinationInput, destDropdown);

  document.addEventListener('click', e => {
    if (!e.target.closest('#origin-field')) originDropdown.classList.remove('open');
    if (!e.target.closest('#destination-field')) destDropdown.classList.remove('open');
  });
})();

/* ─── Airport Autocomplete ───────────────────────────────────────────────────── */
function setupAirportAutocomplete(type, input, dropdown) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 1) { dropdown.classList.remove('open'); return; }
    timer = setTimeout(() => fetchAirports(q, type, dropdown), 280);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 1) dropdown.classList.add('open');
  });
}

async function fetchAirports(query, type, dropdown) {
  try {
    const res = await fetch(`/api/airports?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    renderDropdown(data, type, dropdown);
  } catch (err) {
    console.error('Airport fetch error:', err);
  }
}

function renderDropdown(airports, type, dropdown) {
  dropdown.innerHTML = '';
  if (!airports.length) { dropdown.classList.remove('open'); return; }

  airports.forEach(ap => {
    const iata = ap.skyId || '';
    const name = ap.presentation?.title || ap.name || iata;
    const sub  = ap.presentation?.subtitle || '';

    const div = document.createElement('div');
    div.className = 'airport-option';
    div.innerHTML = `
      <span class="iata">${iata}</span>
      <div class="airport-info">
        <div class="airport-name">${name}</div>
        <div class="airport-sub">${sub}</div>
      </div>`;

    div.addEventListener('click', () => {
      selectAirport(type, ap);
      dropdown.classList.remove('open');
    });
    dropdown.appendChild(div);
  });
  dropdown.classList.add('open');
}

function selectAirport(type, ap) {
  const iata   = ap.skyId || '';
  const name   = ap.presentation?.title || ap.name || iata;
  const sub    = ap.presentation?.subtitle || '';

  $(`${type}-skyId`).value    = ap.skyId || '';
  $(`${type}-entityId`).value = ap.entityId || '';
  $(`${type}-iata`).value     = iata;

  const input = type === 'origin' ? originInput : destinationInput;
  input.value = sub ? `${iata} — ${sub}` : `${iata} — ${name}`;
  input.classList.add('selected');

  state[type] = { skyId: ap.skyId, entityId: ap.entityId, iata, name, sub };
}

function swapAirports() {
  const tmp = { ...state.origin };
  const tmpText = originInput.value;
  const tmpClass = originInput.classList.contains('selected');

  if (state.destination) {
    selectAirport('origin', { skyId: state.destination.skyId, entityId: state.destination.entityId,
      presentation: { title: state.destination.name, subtitle: state.destination.sub } });
  } else {
    originInput.value = ''; originInput.classList.remove('selected'); state.origin = null;
    $('origin-skyId').value = ''; $('origin-entityId').value = ''; $('origin-iata').value = '';
  }

  if (tmp?.skyId) {
    selectAirport('destination', { skyId: tmp.skyId, entityId: tmp.entityId,
      presentation: { title: tmp.name, subtitle: tmp.sub } });
  } else {
    destinationInput.value = ''; destinationInput.classList.remove('selected'); state.destination = null;
    $('destination-skyId').value = ''; $('destination-entityId').value = ''; $('destination-iata').value = '';
  }
}

/* ─── Search ─────────────────────────────────────────────────────────────────── */
async function handleSearch() {
  if (!state.origin || !state.destination) {
    alert('請選擇出發地和目的地');
    return;
  }
  if (!departDate.value) { alert('請選擇出發日期'); return; }

  const tripType  = document.querySelector('input[name="tripType"]:checked').value;
  const retDate   = tripType === 'roundtrip' ? returnDate.value : null;
  const adults    = adultsSel.value;

  loadingOverlay.style.display = 'flex';
  searchBtn.disabled = true;
  resultsSection.style.display = 'none';
  historySection.style.display = 'none';

  try {
    const [ssRes, gRes] = await Promise.allSettled([
      fetch(`/api/flights/skyscanner?originSkyId=${state.origin.skyId}&destinationSkyId=${state.destination.skyId}&originEntityId=${state.origin.entityId}&destinationEntityId=${state.destination.entityId}&date=${departDate.value}${retDate ? `&returnDate=${retDate}` : ''}&adults=${adults}`).then(r => r.json()),
      fetch(`/api/flights/google?origin=${state.origin.iata}&destination=${state.destination.iata}&date=${departDate.value}${retDate ? `&returnDate=${retDate}` : ''}`).then(r => r.json()),
    ]);

    const ssData = ssRes.status === 'fulfilled' ? ssRes.value : { flights: [], mock: true };
    const gData  = gRes.status  === 'fulfilled' ? gRes.value  : { flights: [], mock: true };
    const isMock = ssData.mock || gData.mock;

    state.allFlights   = [...(ssData.flights || []), ...(gData.flights || [])];
    state.visibleCount = 8;
    state.activeSource = 'all';
    state.activeSort   = 'price';

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.source === 'all'));
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === 'price'));

    mockBanner.style.display = isMock ? 'block' : 'none';

    updateSummary();
    renderFlights();
    resultsSection.style.display = 'block';

    // Load history
    const routeKey = `${state.origin.skyId}-${state.destination.skyId}`;
    await loadHistory(routeKey);
  } catch (err) {
    console.error('Search error:', err);
    alert('搜尋失敗，請重試');
  } finally {
    loadingOverlay.style.display = 'none';
    searchBtn.disabled = false;
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ─── Render Flights ─────────────────────────────────────────────────────────── */
function getFilteredSorted() {
  let flights = state.activeSource === 'all'
    ? [...state.allFlights]
    : state.allFlights.filter(f => f.source === state.activeSource);

  if (state.activeSort === 'price')     flights.sort((a, b) => a.price - b.price);
  if (state.activeSort === 'duration')  flights.sort((a, b) => parseDuration(a.duration) - parseDuration(b.duration));
  if (state.activeSort === 'departure') flights.sort((a, b) => a.departure.localeCompare(b.departure));
  return flights;
}

function parseDuration(str) {
  const m = str?.match(/(\d+)h\s*(\d+)m/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999;
}

function renderFlights() {
  const flights = getFilteredSorted();
  const visible = flights.slice(0, state.visibleCount);
  const lowestPrice = flights.length ? flights[0].price : Infinity;

  flightList.innerHTML = '';
  if (!flights.length) {
    flightList.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;">找不到符合條件的航班</div>';
    loadMoreWrap.style.display = 'none';
    return;
  }

  visible.forEach(f => {
    const isCheapest = f.price === lowestPrice;
    flightList.appendChild(createFlightCard(f, isCheapest));
  });

  loadMoreWrap.style.display = state.visibleCount < flights.length ? 'block' : 'none';
}

function renderMore() {
  state.visibleCount += 6;
  renderFlights();
}

function createFlightCard(f, isCheapest) {
  const card = document.createElement('div');
  card.className = `flight-card${isCheapest ? ' cheapest' : ''}`;

  const logoEl = f.airlineLogo
    ? `<img class="airline-logo" src="${f.airlineLogo}" alt="${f.airline}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="airline-logo-placeholder" style="display:none">${f.airline.slice(0,2)}</div>`
    : `<div class="airline-logo-placeholder">${f.airline.slice(0,2)}</div>`;

  const badges = [];
  if (isCheapest) badges.push('<span class="lowest-badge">💰 最低價</span>');

  const stopsText = f.stops === 0
    ? '<span class="stops-text nonstop">直飛</span>'
    : `<span class="stops-text">${f.stops} 次轉機</span>`;

  card.innerHTML = `
    <div class="airline-info">
      ${logoEl}
      <div class="airline-name">${f.airline}</div>
      <span class="source-tag ${f.source}">${f.source === 'skyscanner' ? 'Skyscanner' : 'Google'}</span>
    </div>
    <div class="flight-route">
      <div class="time-block">
        <div class="time">${f.departure}</div>
        <div class="airport-code">${state.origin?.iata || ''}</div>
      </div>
      <div class="route-line">
        <div class="route-line-bar"></div>
        <div class="route-meta">
          <span class="duration-text">${f.duration}</span>
          ${stopsText}
        </div>
      </div>
      <div class="time-block">
        <div class="time">${f.arrival}</div>
        <div class="airport-code">${state.destination?.iata || ''}</div>
      </div>
    </div>
    <div class="price-section">
      <div class="price-badges">${badges.join('')}</div>
      <div class="price-amount">${(f.price || 0).toLocaleString()}</div>
      <div class="price-unit">TWD / 人</div>
      <a href="${f.bookingUrl}" target="_blank" class="book-btn">立即訂票</a>
    </div>`;

  return card;
}

function updateSummary() {
  const all = state.allFlights;
  if (!all.length) return;
  const lowest = Math.min(...all.map(f => f.price));
  const from = state.origin?.sub?.split(',')[1]?.trim() || state.origin?.iata || '';
  const to   = state.destination?.sub?.split(',')[1]?.trim() || state.destination?.iata || '';
  $('result-summary').innerHTML = `
    找到 <strong>${all.length}</strong> 個航班
    （${state.origin?.iata} → ${state.destination?.iata}，${departDate.value}）
    &nbsp;最低價：<strong>TWD ${lowest.toLocaleString()}</strong>
    &nbsp;<span class="lowest-badge">💰 最低票價</span>`;
}

/* ─── Price History ──────────────────────────────────────────────────────────── */
async function loadHistory(routeKey) {
  try {
    const res  = await fetch(`/api/history/${routeKey}`);
    const data = await res.json();
    if (!data.length) { historySection.style.display = 'none'; return; }

    historySection.style.display = 'block';
    $('history-desc').textContent = `${state.origin?.iata} → ${state.destination?.iata} 的歷史最低票價紀錄（最近 90 天）`;

    const labels = data.map(d => d.recordedAt);
    const prices = data.map(d => d.price);
    const minPrice = Math.min(...prices);
    const minDate  = data[prices.indexOf(minPrice)]?.recordedAt || '';

    // Stats
    $('history-stats').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">TWD ${minPrice.toLocaleString()}</div>
        <div class="stat-label">歷史最低票價</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${minDate}</div>
        <div class="stat-label">最低價出現日期</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">TWD ${Math.round(prices.reduce((a,b)=>a+b,0)/prices.length).toLocaleString()}</div>
        <div class="stat-label">平均票價</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.length} 次</div>
        <div class="stat-label">查詢紀錄次數</div>
      </div>`;

    // Chart
    if (state.priceChart) state.priceChart.destroy();
    const ctx = $('price-chart').getContext('2d');
    state.priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '最低票價 (TWD)',
          data: prices,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,.08)',
          pointBackgroundColor: prices.map(p => p === minPrice ? '#16a34a' : '#2563eb'),
          pointRadius: prices.map(p => p === minPrice ? 8 : 4),
          tension: 0.3, fill: true,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `TWD ${ctx.raw.toLocaleString()}${ctx.raw === minPrice ? ' ⭐ 歷史最低' : ''}`
            }
          }
        },
        scales: {
          y: { ticks: { callback: v => `TWD ${v.toLocaleString()}` } }
        }
      }
    });

    historySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('History error:', err);
  }
}
