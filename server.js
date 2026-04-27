require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'price_history.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── History helpers ───────────────────────────────────────────────────────────
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  }
  return {};
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function recordPrice(routeKey, price, flightDate) {
  const history = loadHistory();
  if (!history[routeKey]) history[routeKey] = [];
  const today = new Date().toISOString().split('T')[0];
  const existing = history[routeKey].find(r => r.recordedAt === today && r.flightDate === flightDate);
  if (!existing) {
    history[routeKey].push({ recordedAt: today, price, flightDate, currency: 'TWD' });
    history[routeKey] = history[routeKey].slice(-90); // keep 90 days
    saveHistory(history);
  }
}

// ─── Airport Search (Skyscanner / RapidAPI) ────────────────────────────────────
app.get('/api/airports', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json([]);

  if (!process.env.RAPIDAPI_KEY) {
    return res.json(getMockAirports(query));
  }

  try {
    const { data } = await axios.get('https://sky-scrapper.p.rapidapi.com/api/v1/flights/searchAirport', {
      params: { query, locale: 'zh-TW' },
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com'
      }
    });
    res.json(data?.data || []);
  } catch (err) {
    console.error('Airport search error:', err.message);
    res.json(getMockAirports(query));
  }
});

// ─── Skyscanner Flight Search ──────────────────────────────────────────────────
app.get('/api/flights/skyscanner', async (req, res) => {
  const { originSkyId, destinationSkyId, originEntityId, destinationEntityId, date, returnDate, adults = 1 } = req.query;

  if (!process.env.RAPIDAPI_KEY) {
    return res.json({ mock: true, source: 'skyscanner', flights: getMockFlights('skyscanner') });
  }

  try {
    const params = {
      originSkyId, destinationSkyId, originEntityId, destinationEntityId,
      date, cabinClass: 'economy', adults, currency: 'TWD', locale: 'zh-TW', market: 'TW'
    };
    if (returnDate) params.returnDate = returnDate;

    const { data } = await axios.get('https://sky-scrapper.p.rapidapi.com/api/v2/flights/searchFlightsComplete', {
      params,
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com'
      }
    });

    const itineraries = data?.data?.itineraries || [];
    const flights = itineraries.map(it => {
      const leg = it.legs?.[0] || {};
      const carrier = leg.carriers?.marketing?.[0] || {};
      return {
        id: it.id,
        airline: carrier.name || '未知航空',
        airlineLogo: carrier.logoUrl || '',
        price: it.price?.raw || 0,
        priceFormatted: it.price?.formatted || '',
        currency: 'TWD',
        duration: formatMinutes(leg.durationInMinutes),
        stops: leg.stopCount || 0,
        departure: leg.departure?.slice(11, 16) || '',
        arrival: leg.arrival?.slice(11, 16) || '',
        source: 'skyscanner',
        bookingUrl: `https://www.skyscanner.com.tw/`
      };
    });

    if (flights.length > 0) {
      const lowest = Math.min(...flights.map(f => f.price));
      recordPrice(`${originSkyId}-${destinationSkyId}`, lowest, date);
    }

    res.json({ mock: false, source: 'skyscanner', flights });
  } catch (err) {
    console.error('Skyscanner error:', err.message);
    res.json({ mock: true, source: 'skyscanner', flights: getMockFlights('skyscanner') });
  }
});

// ─── Google Flights Search (SerpApi) ──────────────────────────────────────────
app.get('/api/flights/google', async (req, res) => {
  const { origin, destination, date, returnDate } = req.query;

  if (!process.env.SERPAPI_KEY) {
    return res.json({ mock: true, source: 'google', flights: getMockFlights('google') });
  }

  try {
    const isRoundTrip = !!returnDate;
    const params = {
      engine: 'google_flights',
      departure_id: origin,
      arrival_id: destination,
      outbound_date: date,
      type: isRoundTrip ? '1' : '2',  // 1=round-trip, 2=one-way
      currency: 'TWD',
      hl: 'zh-tw',
      api_key: process.env.SERPAPI_KEY
    };
    if (isRoundTrip) params.return_date = returnDate;

    const { data } = await axios.get('https://serpapi.com/search', { params });

    const raw = [...(data?.best_flights || []), ...(data?.other_flights || [])];
    const flights = raw.map((item, i) => {
      const firstSeg = item.flights?.[0] || {};
      const lastSeg  = item.flights?.[item.flights.length - 1] || firstSeg;

      // departure time from first segment, arrival from last segment
      const depTime = firstSeg.departure_airport?.time?.slice(-5) || '';
      const arrTime = lastSeg.arrival_airport?.time?.slice(-5) || '';

      return {
        id: `google-${i}`,
        airline: firstSeg.airline || item.airline || '未知航空',
        airlineLogo: item.airline_logo || firstSeg.airline_logo || '',
        flightNumber: firstSeg.flight_number || '',
        price: item.price || 0,
        priceFormatted: `TWD ${(item.price || 0).toLocaleString()}`,
        currency: 'TWD',
        duration: formatMinutes(item.total_duration),
        stops: (item.flights?.length || 1) - 1,
        departure: depTime,
        arrival: arrTime,
        source: 'google',
        bookingUrl: 'https://www.google.com/travel/flights'
      };
    });

    if (flights.length > 0) {
      const lowest = Math.min(...flights.map(f => f.price));
      recordPrice(`${origin}-${destination}`, lowest, date);
    }

    res.json({ mock: false, source: 'google', flights });
  } catch (err) {
    console.error('Google Flights error:', err.message);
    res.json({ mock: true, source: 'google', flights: getMockFlights('google') });
  }
});

// ─── Price History ─────────────────────────────────────────────────────────────
app.get('/api/history/:route', (req, res) => {
  const history = loadHistory();
  res.json(history[req.params.route] || []);
});

// ─── Utilities ─────────────────────────────────────────────────────────────────
function formatMinutes(mins) {
  if (!mins) return '—';
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function getMockAirports(query) {
  const airports = [
    { skyId: 'TPE', entityId: '95673635', presentation: { title: '台灣桃園國際機場', subtitle: '台北, 台灣', suggestionTitle: 'TPE' } },
    { skyId: 'TSA', entityId: '95673636', presentation: { title: '台北松山機場', subtitle: '台北, 台灣', suggestionTitle: 'TSA' } },
    { skyId: 'NRT', entityId: '95673320', presentation: { title: '東京成田國際機場', subtitle: '東京, 日本', suggestionTitle: 'NRT' } },
    { skyId: 'HND', entityId: '95673322', presentation: { title: '東京羽田機場', subtitle: '東京, 日本', suggestionTitle: 'HND' } },
    { skyId: 'KIX', entityId: '95673327', presentation: { title: '大阪關西國際機場', subtitle: '大阪, 日本', suggestionTitle: 'KIX' } },
    { skyId: 'ICN', entityId: '95674071', presentation: { title: '首爾仁川國際機場', subtitle: '首爾, 韓國', suggestionTitle: 'ICN' } },
    { skyId: 'BKK', entityId: '95673548', presentation: { title: '曼谷素萬那普機場', subtitle: '曼谷, 泰國', suggestionTitle: 'BKK' } },
    { skyId: 'SIN', entityId: '95673484', presentation: { title: '新加坡樟宜機場', subtitle: '新加坡', suggestionTitle: 'SIN' } },
    { skyId: 'HKG', entityId: '95673529', presentation: { title: '香港國際機場', subtitle: '香港', suggestionTitle: 'HKG' } },
    { skyId: 'LAX', entityId: '95673616', presentation: { title: '洛杉磯國際機場', subtitle: '洛杉磯, 美國', suggestionTitle: 'LAX' } },
    { skyId: 'LHR', entityId: '95565050', presentation: { title: '倫敦希斯洛機場', subtitle: '倫敦, 英國', suggestionTitle: 'LHR' } },
    { skyId: 'CDG', entityId: '95565041', presentation: { title: '巴黎戴高樂機場', subtitle: '巴黎, 法國', suggestionTitle: 'CDG' } },
  ];
  if (!query) return airports.slice(0, 6);
  const q = query.toLowerCase();
  return airports.filter(a =>
    a.skyId.toLowerCase().includes(q) ||
    a.presentation.title.includes(query) ||
    a.presentation.subtitle.includes(query)
  );
}

function getMockFlights(source) {
  const skyscannerAirlines = [
    { name: '中華航空', logo: 'https://logos.skyscnr.com/images/airlines/favicon/CI.png' },
    { name: '長榮航空', logo: 'https://logos.skyscnr.com/images/airlines/favicon/BR.png' },
    { name: '日本航空', logo: 'https://logos.skyscnr.com/images/airlines/favicon/JL.png' },
    { name: '全日空', logo: 'https://logos.skyscnr.com/images/airlines/favicon/NH.png' },
    { name: '虎航', logo: 'https://logos.skyscnr.com/images/airlines/favicon/IT.png' },
    { name: '樂桃航空', logo: 'https://logos.skyscnr.com/images/airlines/favicon/MM.png' },
  ];
  const googleAirlines = [
    { name: '星宇航空', logo: '' },
    { name: '國泰航空', logo: '' },
    { name: '韓亞航空', logo: '' },
    { name: '捷星日本', logo: '' },
    { name: '酷航', logo: '' },
    { name: '台灣虎航', logo: '' },
  ];

  const airlines = source === 'skyscanner' ? skyscannerAirlines : googleAirlines;
  const departureTimes = ['06:30', '08:00', '10:15', '13:40', '16:00', '20:30'];
  const durations = [150, 180, 200, 220, 165, 175];

  return airlines.map((airline, i) => {
    const price = Math.floor(Math.random() * 12000) + 4000;
    const depHour = parseInt(departureTimes[i].split(':')[0]);
    const depMin = parseInt(departureTimes[i].split(':')[1]);
    const totalMin = depHour * 60 + depMin + durations[i];
    const arrHour = Math.floor(totalMin / 60) % 24;
    const arrMin = totalMin % 60;

    return {
      id: `${source}-${i}`,
      airline: airline.name,
      airlineLogo: airline.logo,
      price,
      priceFormatted: `TWD ${price.toLocaleString()}`,
      currency: 'TWD',
      duration: formatMinutes(durations[i]),
      stops: i === 2 ? 1 : 0,
      departure: departureTimes[i],
      arrival: `${String(arrHour).padStart(2, '0')}:${String(arrMin).padStart(2, '0')}`,
      source,
      bookingUrl: source === 'skyscanner' ? 'https://www.skyscanner.com.tw/' : 'https://www.google.com/travel/flights'
    };
  });
}

app.listen(PORT, () => {
  console.log(`✈️  Cheap Flight Finder running at http://localhost:${PORT}`);
  console.log(`📊 API Keys: Skyscanner=${!!process.env.RAPIDAPI_KEY ? '✅' : '❌ (mock mode)'} | Google=${!!process.env.SERPAPI_KEY ? '✅' : '❌ (mock mode)'}`);
});
