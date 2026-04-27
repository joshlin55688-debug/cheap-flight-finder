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

// ─── Skyscanner Deep Link Generator ───────────────────────────────────────────
app.get('/api/flights/skyscanner', async (req, res) => {
  const { originSkyId, destinationSkyId, originEntityId, destinationEntityId, date, returnDate, adults = 1 } = req.query;

  // Build Skyscanner deep link (always works, no API key needed)
  const origin = (originSkyId || '').toLowerCase();
  const dest   = (destinationSkyId || '').toLowerCase();
  const dateShort = (date || '').replace(/-/g, '').slice(2); // 2026-06-01 → 260601
  const retShort  = returnDate ? returnDate.replace(/-/g, '').slice(2) : null;

  const skyscannerUrl = retShort
    ? `https://www.skyscanner.com.tw/transport/flights/${origin}/${dest}/${dateShort}/${retShort}/?adults=${adults}&cabinclass=economy&currency=TWD`
    : `https://www.skyscanner.com.tw/transport/flights/${origin}/${dest}/${dateShort}/?adults=${adults}&cabinclass=economy&currency=TWD`;

  // If Travelpayouts key is available, fetch real prices
  if (process.env.TRAVELPAYOUTS_TOKEN) {
    try {
      const { data } = await axios.get('https://api.travelpayouts.com/v2/prices/latest', {
        params: {
          origin: originSkyId, destination: destinationSkyId,
          period_type: 'specific_date', depart_date: date,
          one_way: !returnDate, currency: 'twd', limit: 20, token: process.env.TRAVELPAYOUTS_TOKEN
        }
      });

      const flights = (data?.data || []).map((item, i) => ({
        id: `tp-${i}`,
        airline: item.airline || '未知航空',
        airlineLogo: `https://pics.avs.io/40/40/${item.airline}.png`,
        price: item.value || 0,
        priceFormatted: `TWD ${(item.value || 0).toLocaleString()}`,
        currency: 'TWD',
        duration: formatMinutes((item.duration || 0)),
        stops: item.transfers || 0,
        departure: item.departure_at?.slice(11, 16) || '',
        arrival: item.return_at?.slice(11, 16) || '',
        source: 'skyscanner',
        bookingUrl: skyscannerUrl
      }));

      if (flights.length > 0) {
        const lowest = Math.min(...flights.map(f => f.price));
        recordPrice(`${originSkyId}-${destinationSkyId}`, lowest, date);
      }

      return res.json({ mock: false, source: 'skyscanner', flights, skyscannerUrl });
    } catch (err) {
      console.error('Travelpayouts error:', err.message);
    }
  }

  // Fallback: return deep link card (no price data, but real booking link)
  res.json({
    mock: false,
    source: 'skyscanner',
    deepLinkOnly: true,
    skyscannerUrl,
    flights: []
  });
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
    { skyId: 'TPE', entityId: '128667054', presentation: { title: '台灣桃園國際機場', subtitle: '台北, 台灣', suggestionTitle: 'TPE' }, _keywords: 'taipei tpe taoyuan 桃園 台北 台灣' },
    { skyId: 'TSA', entityId: '104120388', presentation: { title: '台北松山機場', subtitle: '台北, 台灣', suggestionTitle: 'TSA' }, _keywords: 'taipei tsa songshan 松山 台北' },
    { skyId: 'RMQ', entityId: '95673637', presentation: { title: '台中國際機場', subtitle: '台中, 台灣', suggestionTitle: 'RMQ' }, _keywords: 'taichung rmq 台中' },
    { skyId: 'KHH', entityId: '95673638', presentation: { title: '高雄國際機場', subtitle: '高雄, 台灣', suggestionTitle: 'KHH' }, _keywords: 'kaohsiung khh 高雄' },
    { skyId: 'NRT', entityId: '128668889', presentation: { title: '東京成田國際機場', subtitle: '東京, 日本', suggestionTitle: 'NRT' }, _keywords: 'tokyo narita nrt 成田 東京 日本' },
    { skyId: 'HND', entityId: '95673322',  presentation: { title: '東京羽田機場', subtitle: '東京, 日本', suggestionTitle: 'HND' }, _keywords: 'tokyo haneda hnd 羽田 東京 日本' },
    { skyId: 'KIX', entityId: '128667802', presentation: { title: '大阪關西國際機場', subtitle: '大阪, 日本', suggestionTitle: 'KIX' }, _keywords: 'osaka kansai kix 關西 大阪 日本' },
    { skyId: 'ITM', entityId: '104120225', presentation: { title: '大阪伊丹機場', subtitle: '大阪, 日本', suggestionTitle: 'ITM' }, _keywords: 'osaka itami itm 伊丹 大阪 日本' },
    { skyId: 'CTS', entityId: '95673330', presentation: { title: '北海道新千歲機場', subtitle: '北海道, 日本', suggestionTitle: 'CTS' }, _keywords: 'sapporo hokkaido cts 新千歲 北海道 日本' },
    { skyId: 'FUK', entityId: '95673335', presentation: { title: '福岡機場', subtitle: '福岡, 日本', suggestionTitle: 'FUK' }, _keywords: 'fukuoka fuk 福岡 日本' },
    { skyId: 'OKA', entityId: '95673340', presentation: { title: '沖繩那霸機場', subtitle: '沖繩, 日本', suggestionTitle: 'OKA' }, _keywords: 'okinawa naha oka 那霸 沖繩 日本' },
    { skyId: 'ICN', entityId: '95674071', presentation: { title: '首爾仁川國際機場', subtitle: '首爾, 韓國', suggestionTitle: 'ICN' }, _keywords: 'seoul incheon icn 仁川 首爾 韓國' },
    { skyId: 'GMP', entityId: '95674072', presentation: { title: '首爾金浦機場', subtitle: '首爾, 韓國', suggestionTitle: 'GMP' }, _keywords: 'seoul gimpo gmp 金浦 首爾 韓國' },
    { skyId: 'BKK', entityId: '95673548', presentation: { title: '曼谷素萬那普機場', subtitle: '曼谷, 泰國', suggestionTitle: 'BKK' }, _keywords: 'bangkok suvarnabhumi bkk 素萬那普 曼谷 泰國' },
    { skyId: 'DMK', entityId: '95673549', presentation: { title: '曼谷廊曼機場', subtitle: '曼谷, 泰國', suggestionTitle: 'DMK' }, _keywords: 'bangkok donmueang dmk 廊曼 曼谷 泰國' },
    { skyId: 'SIN', entityId: '95673484', presentation: { title: '新加坡樟宜機場', subtitle: '新加坡', suggestionTitle: 'SIN' }, _keywords: 'singapore changi sin 樟宜 新加坡' },
    { skyId: 'HKG', entityId: '95673529', presentation: { title: '香港國際機場', subtitle: '香港', suggestionTitle: 'HKG' }, _keywords: 'hongkong hkg 香港' },
    { skyId: 'KUL', entityId: '95673510', presentation: { title: '吉隆坡國際機場', subtitle: '吉隆坡, 馬來西亞', suggestionTitle: 'KUL' }, _keywords: 'kuala lumpur klia kul 吉隆坡 馬來西亞' },
    { skyId: 'MNL', entityId: '95673520', presentation: { title: '馬尼拉尼諾伊阿基諾機場', subtitle: '馬尼拉, 菲律賓', suggestionTitle: 'MNL' }, _keywords: 'manila mnl 馬尼拉 菲律賓' },
    { skyId: 'PVG', entityId: '95673366', presentation: { title: '上海浦東國際機場', subtitle: '上海, 中國', suggestionTitle: 'PVG' }, _keywords: 'shanghai pudong pvg 浦東 上海 中國' },
    { skyId: 'PEK', entityId: '95673360', presentation: { title: '北京首都國際機場', subtitle: '北京, 中國', suggestionTitle: 'PEK' }, _keywords: 'beijing pek 北京 中國' },
    { skyId: 'LAX', entityId: '95673616', presentation: { title: '洛杉磯國際機場', subtitle: '洛杉磯, 美國', suggestionTitle: 'LAX' }, _keywords: 'los angeles lax 洛杉磯 美國' },
    { skyId: 'JFK', entityId: '95673620', presentation: { title: '紐約甘迺迪機場', subtitle: '紐約, 美國', suggestionTitle: 'JFK' }, _keywords: 'new york jfk 紐約 美國' },
    { skyId: 'SFO', entityId: '95673618', presentation: { title: '舊金山國際機場', subtitle: '舊金山, 美國', suggestionTitle: 'SFO' }, _keywords: 'san francisco sfo 舊金山 美國' },
    { skyId: 'LHR', entityId: '95565050', presentation: { title: '倫敦希斯洛機場', subtitle: '倫敦, 英國', suggestionTitle: 'LHR' }, _keywords: 'london heathrow lhr 希斯洛 倫敦 英國' },
    { skyId: 'CDG', entityId: '95565041', presentation: { title: '巴黎戴高樂機場', subtitle: '巴黎, 法國', suggestionTitle: 'CDG' }, _keywords: 'paris cdg 戴高樂 巴黎 法國' },
    { skyId: 'SYD', entityId: '95673700', presentation: { title: '雪梨國際機場', subtitle: '雪梨, 澳洲', suggestionTitle: 'SYD' }, _keywords: 'sydney syd 雪梨 澳洲' },
    { skyId: 'DXB', entityId: '95673900', presentation: { title: '杜拜國際機場', subtitle: '杜拜, 阿聯酋', suggestionTitle: 'DXB' }, _keywords: 'dubai dxb 杜拜 阿聯酋' },
  ];
  if (!query) return airports.slice(0, 8);
  const q = query.toLowerCase();
  return airports.filter(a =>
    a._keywords.includes(q) ||
    a.skyId.toLowerCase().includes(q) ||
    a.presentation.title.includes(query) ||
    a.presentation.subtitle.includes(query)
  ).map(({ _keywords, ...rest }) => rest);
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
